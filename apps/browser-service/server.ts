import express from "express";
import http from "http";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { execSync, spawn, ChildProcess } from "child_process";
import net from "net";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.BROWSER_SERVICE_API_KEY || "";
const DEFAULT_TTL = Number(process.env.BROWSER_SESSION_DEFAULT_TTL || 600);
const MAX_TTL = Number(process.env.BROWSER_SESSION_MAX_TTL || 3600);
const CDP_HOST = process.env.BROWSER_CDP_HOST || "localhost";
const CDP_PORT = Number(process.env.BROWSER_CDP_PORT || 9222);
// Hard cap on live sessions. Each session is one Chromium context; a busy page
// fans out to several renderer processes, and 8 parallel sessions filled the
// 4 GiB cgroup and left ~30 orphan renderers behind (2026-09-10).
const MAX_SESSIONS = Number(process.env.BROWSER_MAX_SESSIONS || 4);
// Refuse new sessions above this share of the cgroup memory limit; restart the
// whole service when idle above it.
const MEMORY_HIGH_WATER = Number(process.env.BROWSER_MEMORY_HIGH_WATER || 0.85);
const CLOSE_TIMEOUT_MS = 5000;
const REAP_INTERVAL_MS = 30000;

let debugPort: number = 0;
let chromiumProcess: ChildProcess | null = null;
let shuttingDown = false;

interface Session {
  id: string;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  ttl: number;
  activityTtl: number;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout>;
  activityTimer: ReturnType<typeof setTimeout> | null;
  persistentStorage?: { uniqueId: string; write: boolean };
  targetIds: Set<string>;
}

const sessions = new Map<string, Session>();
let pendingSessions = 0;
let browser: Browser;

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  if (auth === `Bearer ${API_KEY}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function cdpTargetId(page: Page): Promise<string | null> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const info = await cdp.send("Target.getTargetInfo");
    await cdp.detach().catch(() => {});
    return info.targetInfo.targetId;
  } catch {
    return null;
  }
}

async function recordTargets(session: Session): Promise<void> {
  for (const p of session.context.pages()) {
    const id = await cdpTargetId(p);
    if (id) session.targetIds.add(id);
  }
}

async function closeTargets(ids: Iterable<string>): Promise<number> {
  let closed = 0;
  let cdp;
  try {
    cdp = await browser.newBrowserCDPSession();
    for (const targetId of ids) {
      try {
        await withTimeout(cdp.send("Target.closeTarget", { targetId }), 2000, "closeTarget");
        closed++;
      } catch {}
    }
  } catch {} finally {
    await cdp?.detach().catch(() => {});
  }
  return closed;
}

async function destroySession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.timer);
  if (session.activityTimer) clearTimeout(session.activityTimer);
  sessions.delete(id);
  try {
    await withTimeout(session.context.close(), CLOSE_TIMEOUT_MS, "context.close");
  } catch (err) {
    // Playwright could not close the context (Chromium starved or wedged).
    // Kill the page targets directly so no renderer outlives the session.
    const closed = await closeTargets(session.targetIds);
    console.warn(
      `Session ${id}: context.close failed (${err instanceof Error ? err.message : err}); ` +
      `force-closed ${closed}/${session.targetIds.size} targets`,
    );
  }
  console.log(`Session ${id} destroyed (${sessions.size} remaining)`);
}

function cgroupMemoryFraction(): number | null {
  try {
    const fs = require("fs") as typeof import("fs");
    const cur = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf-8"));
    const maxRaw = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
    if (maxRaw === "max") return null;
    return cur / Number(maxRaw);
  } catch {
    return null;
  }
}

// Every REAP_INTERVAL_MS: close page targets that no live session owns (seen
// unowned on two consecutive passes, so a session mid-creation is spared), and
// restart the service when memory is high and nothing is running.
const unownedSeen = new Set<string>();
async function reap(): Promise<void> {
  if (shuttingDown) return;
  try {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json`);
    const targets = (await res.json()) as Array<{ id: string; type: string; url: string }>;
    const owned = new Set<string>();
    for (const s of sessions.values()) for (const t of s.targetIds) owned.add(t);
    const orphans: string[] = [];
    for (const t of targets) {
      if (t.type !== "page" || owned.has(t.id)) continue;
      if (unownedSeen.has(t.id)) orphans.push(t.id);
      else unownedSeen.add(t.id);
    }
    for (const id of Array.from(unownedSeen)) {
      if (!targets.some((t) => t.id === id)) unownedSeen.delete(id);
    }
    if (orphans.length) {
      const closed = await closeTargets(orphans);
      for (const id of orphans) unownedSeen.delete(id);
      console.warn(`Reaper closed ${closed}/${orphans.length} orphan page targets`);
    }
  } catch (err) {
    console.warn(`Reaper: target listing failed: ${err instanceof Error ? err.message : err}`);
  }

  const mem = cgroupMemoryFraction();
  if (mem !== null && mem > MEMORY_HIGH_WATER && sessions.size === 0) {
    console.error(`Memory at ${(mem * 100).toFixed(0)}% of cgroup limit with no sessions; exiting for a clean restart`);
    process.exit(1);
  }
}

function resetActivityTimer(session: Session) {
  if (session.activityTimer) clearTimeout(session.activityTimer);
  session.lastActivity = Date.now();
  session.activityTimer = setTimeout(
    () => destroySession(session.id),
    session.activityTtl * 1000,
  );
}

// POST /browsers - create session
app.post("/browsers", authMiddleware, async (req, res) => {
  try {
    const {
      ttl = DEFAULT_TTL,
      activityTtl = Math.min(300, DEFAULT_TTL),
      persistentStorage,
    } = req.body;

    const clampedTtl = Math.min(Math.max(ttl, 30), MAX_TTL);
    const clampedActivityTtl = Math.min(Math.max(activityTtl, 10), clampedTtl);

    // Reserve the slot before the first await, or parallel requests all pass
    // the check and the cap does nothing.
    if (sessions.size + pendingSessions >= MAX_SESSIONS) {
      return res.status(429).json({
        error: `Session limit reached (${MAX_SESSIONS}); retry later`,
      });
    }
    pendingSessions++;
    const mem = cgroupMemoryFraction();
    if (mem !== null && mem > MEMORY_HIGH_WATER) {
      return res.status(503).json({
        error: `Browser memory at ${(mem * 100).toFixed(0)}% of limit; refusing new session`,
      });
    }

    if (persistentStorage?.write) {
      for (const s of sessions.values()) {
        if (
          s.persistentStorage?.uniqueId === persistentStorage.uniqueId &&
          s.persistentStorage?.write
        ) {
          return res.status(409).json({
            error: "Profile is locked by another writer.",
          });
        }
      }
    }

    const id = uuidv4();
    let context: BrowserContext;
    let page: Page;
    let targetId: string | null;
    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });
      page = await context.newPage();
      targetId = await cdpTargetId(page);
    } finally {
      pendingSessions--;
    }
    const cdpUrl = targetId && debugPort
      ? `ws://${CDP_HOST}:${debugPort}/devtools/page/${targetId}`
      : "";

    const expiresAt = new Date(Date.now() + clampedTtl * 1000).toISOString();

    const timer = setTimeout(() => destroySession(id), clampedTtl * 1000);
    const activityTimer = setTimeout(
      () => destroySession(id),
      clampedActivityTtl * 1000,
    );

    const session: Session = {
      id,
      context,
      page,
      createdAt: Date.now(),
      ttl: clampedTtl,
      activityTtl: clampedActivityTtl,
      lastActivity: Date.now(),
      timer,
      activityTimer,
      persistentStorage,
      targetIds: new Set(targetId ? [targetId] : []),
    };
    sessions.set(id, session);

    console.log(`Session ${id} created (ttl=${clampedTtl}s, cdpUrl=${cdpUrl}, ${sessions.size} active)`);

    res.json({
      sessionId: id,
      cdpUrl,
      viewUrl: "",
      iframeUrl: "",
      interactiveIframeUrl: "",
      expiresAt,
    });
  } catch (err) {
    console.error("Failed to create session:", err);
    res.status(500).json({ error: "Failed to create browser session" });
  }
});

// POST /browsers/:id/exec - execute code
app.post("/browsers/:id/exec", authMiddleware, async (req, res) => {
  const session = sessions.get(req.params.id as string);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  resetActivityTimer(session);

  const { code, language = "node", timeout = 30 } = req.body;

  if (!code) {
    return res.status(400).json({ error: "code is required" });
  }

  try {
    let stdout = "";
    let stderr = "";
    let result = "";
    let exitCode = 0;
    let killed = false;

    if (language === "node") {
      const asyncFn = new Function(
        "page",
        "context",
        "console",
        `return (async () => { ${code} })()`,
      );

      const logs: string[] = [];
      const customConsole = {
        log: (...args: unknown[]) =>
          logs.push(args.map(String).join(" ")),
        error: (...args: unknown[]) =>
          logs.push(args.map(String).join(" ")),
        warn: (...args: unknown[]) =>
          logs.push(args.map(String).join(" ")),
        info: (...args: unknown[]) =>
          logs.push(args.map(String).join(" ")),
      };

      const timer = setTimeout(() => {
        killed = true;
      }, timeout * 1000);

      try {
        const ret = await asyncFn(session.page, session.context, customConsole);
        if (ret !== undefined) result = String(ret);
        stdout = logs.join("\n");
      } catch (err: unknown) {
        stderr = err instanceof Error ? err.message : String(err);
        exitCode = 1;
        stdout = logs.join("\n");
      } finally {
        clearTimeout(timer);
      }

      const pages = session.context.pages();
      if (pages.length > 0) {
        session.page = pages[pages.length - 1];
      }
      await recordTargets(session);
    } else if (language === "bash") {
      try {
        const output = execSync(code, {
          timeout: timeout * 1000,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        stdout = output;
      } catch (err: unknown) {
        if (err && typeof err === "object" && "killed" in err) {
          killed = (err as { killed: boolean }).killed;
        }
        if (err && typeof err === "object" && "status" in err) {
          exitCode = (err as { status: number }).status ?? 1;
        }
        if (err && typeof err === "object" && "stdout" in err) {
          stdout = String((err as { stdout: unknown }).stdout || "");
        }
        if (err && typeof err === "object" && "stderr" in err) {
          stderr = String((err as { stderr: unknown }).stderr || "");
        }
      }
    } else if (language === "python") {
      try {
        const output = execSync(`python3 -c ${JSON.stringify(code)}`, {
          timeout: timeout * 1000,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        stdout = output;
      } catch (err: unknown) {
        if (err && typeof err === "object" && "killed" in err) {
          killed = (err as { killed: boolean }).killed;
        }
        if (err && typeof err === "object" && "status" in err) {
          exitCode = (err as { status: number }).status ?? 1;
        }
        if (err && typeof err === "object" && "stdout" in err) {
          stdout = String((err as { stdout: unknown }).stdout || "");
        }
        if (err && typeof err === "object" && "stderr" in err) {
          stderr = String((err as { stderr: unknown }).stderr || "");
        }
      }
    } else {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    res.json({ stdout, result, stderr, exitCode, killed });
  } catch (err) {
    console.error(`Exec failed in session ${req.params.id as string}:`, err);
    res.status(500).json({
      stdout: "",
      result: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      killed: false,
    });
  }
});

// DELETE /browsers/:id - destroy session
app.delete("/browsers/:id", authMiddleware, async (req, res) => {
  const session = sessions.get(req.params.id as string);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const durationMs = Date.now() - session.createdAt;
  await destroySession(req.params.id as string);

  res.json({ ok: true, sessionDurationMs: durationMs });
});

// GET /health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    activeSessions: sessions.size,
    maxSessions: MAX_SESSIONS,
    memoryFraction: cgroupMemoryFraction(),
    cdpPort: debugPort,
  });
});

// CDP proxy: forward /json and /json/* HTTP requests to Chromium
app.get("/json/version", async (req, res) => cdpProxy(req, res));
app.get("/json/list", async (req, res) => cdpProxy(req, res));
app.get("/json", async (req, res) => cdpProxy(req, res));

async function cdpProxy(req: express.Request, res: express.Response) {
  if (!debugPort) return res.status(503).json({ error: "CDP not ready" });
  try {
    const upstream = await fetch(`http://127.0.0.1:${debugPort}${req.originalUrl}`);
    const text = await upstream.text();
    // Rewrite internal URLs so external clients can connect via this proxy
    const rewritten = text.replace(
      new RegExp(`(ws://)[^:]+:${debugPort}`, "g"),
      `$1${CDP_HOST}:${PORT}`,
    );
    res.status(upstream.status).type("application/json").send(rewritten);
  } catch (err) {
    res.status(502).json({ error: "CDP proxy failed" });
  }
}

function findChromiumPath(): string {
  const candidates = [
    "/usr/local/share/playwright/chromium-*/chrome-linux*/chrome",
    "/ms-playwright/chromium-*/chrome-linux*/chrome",
  ];
  for (const pattern of candidates) {
    try {
      const result = execSync(`ls ${pattern} 2>/dev/null | head -1`, { encoding: "utf-8" }).trim();
      if (result) return result;
    } catch {}
  }
  try {
    const result = execSync("which chromium || which chromium-browser || which google-chrome", { encoding: "utf-8" }).trim();
    if (result) return result;
  } catch {}
  throw new Error("No Chromium binary found");
}

async function waitForCDP(port: number, maxWaitMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`CDP not ready after ${maxWaitMs}ms`);
}

async function start() {
  const chromiumPath = findChromiumPath();
  console.log(`Chromium binary: ${chromiumPath}`);

  // Launch Chromium directly with raw CDP
  chromiumProcess = spawn(chromiumPath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    // One renderer per page instead of one per cross-origin frame. Ad and
    // embed iframes otherwise spawn a renderer each and multiply memory use.
    "--disable-features=IsolateOrigins,site-per-process",
    "--renderer-process-limit=16",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=0.0.0.0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--mute-audio",
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  chromiumProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line.includes("DevTools listening")) {
      console.log(line);
    }
  });

  chromiumProcess.on("exit", (code) => {
    console.error(`Chromium exited with code ${code}`);
    process.exit(1);
  });

  await waitForCDP(CDP_PORT);
  debugPort = CDP_PORT;

  // Connect Playwright over CDP to manage sessions
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  console.log(`Playwright connected over CDP on port ${CDP_PORT}`);
  browser.on("disconnected", () => {
    if (shuttingDown) return;
    console.error("Playwright lost the CDP connection; exiting for a clean restart");
    process.exit(1);
  });
  setInterval(() => { reap().catch(() => {}); }, REAP_INTERVAL_MS).unref();

  // Close the default about:blank page that Chromium opened
  const defaultPages = browser.contexts()[0]?.pages() ?? [];
  for (const p of defaultPages) {
    if (p.url() === "about:blank") await p.close().catch(() => {});
  }

  const server = http.createServer(app);

  // WebSocket proxy: raw TCP pipe to Chromium's CDP
  server.on("upgrade", (req, socket, head) => {
    const path = req.url || "";
    if (!path.startsWith("/devtools/")) {
      socket.destroy();
      return;
    }

    const upstream = net.connect(debugPort, "127.0.0.1", () => {
      // Replay the original HTTP upgrade request to Chromium
      const rawHeaders = `${req.method} ${path} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
      upstream.write(rawHeaders);
      if (head.length) upstream.write(head);

      // Bidirectional raw pipe
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Browser service listening on port ${PORT}`);
    console.log(`CDP proxied via port ${PORT} (e.g. chrome://inspect -> localhost:${PORT})`);
  });

  process.on("SIGTERM", async () => {
    shuttingDown = true;
    console.log("Shutting down...");
    await Promise.all(Array.from(sessions.keys()).map((id) => destroySession(id)));
    await browser.close().catch(() => {});
    chromiumProcess?.kill("SIGTERM");
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
