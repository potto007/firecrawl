import express from "express";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { execSync } from "child_process";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.BROWSER_SERVICE_API_KEY || "";

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

// POST /browsers - create session
app.post("/browsers", authMiddleware, async (req, res) => {
  try {
    const { ttl = 600, activityTtl = 300, persistentStorage } = req.body;

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
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const timer = setTimeout(() => destroySession(id), ttl * 1000);
    const activityTimer = setTimeout(
      () => destroySession(id),
      activityTtl * 1000,
    );

    const session: Session = {
      id,
      context,
      page,
      createdAt: Date.now(),
      ttl,
      activityTtl,
      lastActivity: Date.now(),
      timer,
      activityTimer,
      persistentStorage,
    };
    sessions.set(id, session);

    console.log(`Session ${id} created (ttl=${ttl}s, ${sessions.size} active)`);

    res.json({
      sessionId: id,
      cdpUrl: "",
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
      // Execute JS with `page` in scope
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

      // Update page reference in case code navigated or switched tabs
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
  });
});

async function start() {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  console.log("Browser launched");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Browser service listening on port ${PORT}`);
  });

  process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    for (const id of sessions.keys()) destroySession(id);
    await browser.close();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
