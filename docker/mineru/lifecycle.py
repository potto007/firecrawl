"""Lazy-lifecycle state machine for the MinerU gate.

Pure logic, no I/O - the clock is injected by the caller (``now`` is a monotonic
seconds value). The supervisor in ``entrypoint.py`` drives this: it (re)starts
the upstream ``mineru-api`` child when a real request arrives and shuts it down
after an idle period, so the VLM's GPU memory is only held while PDFs are
actually being processed (letting the llama-server teacher use the card the rest
of the time).

Deliberately tracks only three things: whether the child is running, how many
real requests are in flight, and the last activity time. Health-check pings are
NOT activity and must be answered by the proxy without going through here, or the
30s docker healthcheck would keep the child alive forever and defeat the idle
unload.
"""


class LifecycleController:
    def __init__(self, idle_timeout: float, *, now: float):
        self.idle_timeout = idle_timeout
        self._running = False
        self._in_flight = 0
        self._last_activity = now

    @property
    def running(self) -> bool:
        return self._running

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def mark_started(self) -> None:
        self._running = True

    def mark_stopped(self) -> None:
        self._running = False

    def begin_request(self, now: float) -> bool:
        """Record the start of a real (non-health) request. Returns True if the
        child must be (re)started before the request can be forwarded."""
        self._in_flight += 1
        self._last_activity = now
        return not self._running

    def end_request(self, now: float) -> None:
        """Record the completion of a real request and reset the idle clock from
        its completion time (a long parse should not count as idle while it ran)."""
        self._in_flight = max(0, self._in_flight - 1)
        self._last_activity = now

    def should_shutdown(self, now: float) -> bool:
        """True when the child is up, nothing is in flight, and the idle window
        has elapsed - i.e. it is safe to kill the child and free the GPU."""
        return (
            self._running
            and self._in_flight == 0
            and (now - self._last_activity) >= self.idle_timeout
        )
