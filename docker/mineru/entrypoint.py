"""MinerU lazy-lifecycle gate.

Owns the public port (default 8000) and reverse-proxies to a locally-managed
``mineru-api`` child on an internal port (default 8001). The child - and the
~20GB vLLM GPU pool it holds - is started lazily on the first real request and
killed after ``MINERU_IDLE_TIMEOUT`` seconds of inactivity, so MinerU only
occupies the GPU while PDFs are actually being parsed and otherwise leaves the
card free for the llama-server teacher.

Why a gate instead of MinerU's own option: MinerU 3.x has no idle-unload, and
its vLLM backend grabs most of the card on load and never releases it. Killing
the child process tears down the CUDA context and returns all the VRAM; the
proxy keeps the public port continuously bound so the ``mineru:8000`` contract
never breaks. ``/health`` is answered locally (container liveness) and is NOT
treated as activity, otherwise the 30s docker healthcheck would pin the child up
forever.
"""

import asyncio
import contextlib
import logging
import os
import signal
import subprocess
import time

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.routing import Route

from lifecycle import LifecycleController

log = logging.getLogger("mineru-gate")

PUBLIC_PORT = int(os.environ.get("MINERU_PUBLIC_PORT", "8000"))
UPSTREAM_PORT = int(os.environ.get("MINERU_UPSTREAM_PORT", "8001"))
IDLE_TIMEOUT = float(os.environ.get("MINERU_IDLE_TIMEOUT", "300"))
START_TIMEOUT = float(os.environ.get("MINERU_START_TIMEOUT", "180"))
HEALTH_PATH = os.environ.get("MINERU_HEALTH_PATH", "/health")
UPSTREAM = f"http://127.0.0.1:{UPSTREAM_PORT}"

# Hop-by-hop headers must not be forwarded (RFC 7230 6.1); httpx recomputes
# content-length/host for the rewritten request.
_HOP = {b"host", b"content-length", b"connection", b"keep-alive",
        b"transfer-encoding", b"te", b"trailer", b"upgrade",
        b"proxy-authenticate", b"proxy-authorization"}


class Supervisor:
    def __init__(self):
        self.ctl = LifecycleController(IDLE_TIMEOUT, now=time.monotonic())
        self.proc: subprocess.Popen | None = None
        self.lock = asyncio.Lock()
        self.client = httpx.AsyncClient(base_url=UPSTREAM, timeout=None)

    def _alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _spawn(self) -> None:
        cmd = ["mineru-api", "--host", "127.0.0.1", "--port", str(UPSTREAM_PORT)]
        log.info("starting mineru-api child: %s", " ".join(cmd))
        self.proc = subprocess.Popen(cmd)

    async def _wait_healthy(self) -> None:
        deadline = time.monotonic() + START_TIMEOUT
        while time.monotonic() < deadline:
            if not self._alive():
                raise RuntimeError("mineru-api child exited during startup")
            try:
                r = await self.client.get(HEALTH_PATH, timeout=5.0)
                if r.status_code < 500:
                    log.info("mineru-api child ready")
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)
        raise TimeoutError("mineru-api child did not become healthy in time")

    async def ensure_started(self) -> None:
        if self.ctl.running and self._alive():
            return
        async with self.lock:
            if self.ctl.running and self._alive():
                return
            self._spawn()
            await self._wait_healthy()
            self.ctl.mark_started()

    async def _terminate(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            log.info("stopping idle mineru-api child (freeing GPU)")
            self.proc.terminate()
            for _ in range(100):                    # up to ~10s for a clean exit
                if self.proc.poll() is not None:
                    break
                await asyncio.sleep(0.1)
            if self.proc.poll() is None:
                log.warning("child did not exit on SIGTERM; sending SIGKILL")
                self.proc.kill()
                self.proc.wait()                # reap; the gate is PID 1
        self.proc = None
        self.ctl.mark_stopped()

    async def idle_loop(self) -> None:
        interval = max(5.0, min(IDLE_TIMEOUT, 30.0))
        while True:
            await asyncio.sleep(interval)
            if not self.ctl.should_shutdown(time.monotonic()):
                continue
            async with self.lock:
                if self.ctl.should_shutdown(time.monotonic()):   # re-check under lock
                    await self._terminate()

    async def shutdown(self) -> None:
        async with self.lock:
            await self._terminate()
        await self.client.aclose()


sup = Supervisor()


async def health(_request: Request) -> PlainTextResponse:
    # Local liveness only - the container is healthy whether or not the child is
    # currently loaded. NOT counted as activity (see module docstring).
    return PlainTextResponse("ok")


async def proxy(request: Request) -> StreamingResponse:
    sup.ctl.begin_request(time.monotonic())     # in_flight++ guards against idle-kill mid-start
    try:
        await sup.ensure_started()
        target = request.url.path
        if request.url.query:
            target += "?" + request.url.query
        fwd_headers = [(k, v) for k, v in request.headers.raw if k.lower() not in _HOP]
        upstream_req = sup.client.build_request(
            request.method, target, headers=fwd_headers, content=request.stream()
        )
        upstream_resp = await sup.client.send(upstream_req, stream=True)
        resp_headers = {
            k.decode(): v.decode()
            for k, v in upstream_resp.headers.raw if k.lower() not in _HOP
        }

        async def _stream():
            try:
                async for chunk in upstream_resp.aiter_raw():
                    yield chunk
            finally:
                await upstream_resp.aclose()
                sup.ctl.end_request(time.monotonic())

        return StreamingResponse(
            _stream(), status_code=upstream_resp.status_code, headers=resp_headers,
        )
    except BaseException:
        sup.ctl.end_request(time.monotonic())   # streaming never started; settle the counter
        raise


@contextlib.asynccontextmanager
async def lifespan(_app: Starlette):
    task = asyncio.create_task(sup.idle_loop())
    log.info("mineru-gate up on :%d -> %s (idle timeout %.0fs)",
             PUBLIC_PORT, UPSTREAM, IDLE_TIMEOUT)
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await sup.shutdown()


app = Starlette(
    lifespan=lifespan,
    routes=[
        Route(HEALTH_PATH, health, methods=["GET"]),
        Route("/{path:path}", proxy,
              methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]),
    ],
)


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=PUBLIC_PORT, log_level="warning")


if __name__ == "__main__":
    main()
