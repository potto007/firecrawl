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

let debugPort: number = 0;
let chromiumProcess: ChildProcess | null = null;

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
}

const sessions = new Map<string, Session>();
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

function destroySession(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.timer);
  if (session.activityTimer) clearTimeout(session.activityTimer);
  session.context.close().catch(() => {});
  sessions.delete(id);
  console.log(`Session ${id} destroyed (${sessions.size} remaining)`);
}

function resetActivityTimer(session: Session) {
  if (session.activityTimer) clearTimeout(session.activityTimer);
  session.lastActivity = Date.now();
  session.activityTimer = setTimeout(
    () => destroySession(session.id),
    session.activityTtl * 1000,
  );
}

async function getPageTargetId(page: Page): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json`);
    const targets = (await res.json()) as Array<{ id: string; url: string; type: string }>;
    const pageUrl = page.url();
    const target = targets.find(
      (t) => t.type === "page" && t.url === pageUrl,
    );
    return target?.id ?? null;
  } catch {
    return null;
  }
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Wait briefly for the page target to register in CDP
    await new Promise(r => setTimeout(r, 500));
    const targetId = await getPageTargetId(page);
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
  destroySession(req.params.id as string);

  res.json({ ok: true, sessionDurationMs: durationMs });
});

// GET /health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    activeSessions: sessions.size,
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
    console.log("Shutting down...");
    for (const id of sessions.keys()) destroySession(id);
    await browser.close().catch(() => {});
    chromiumProcess?.kill("SIGTERM");
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
