# Browser-Service CDP & Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable authenticated scraping of subscription-gated content by adding CDP remote debugging URLs and true session persistence between scrape and interact.

**Architecture:** Browser-service launches Chromium with `--remote-debugging-port=0`, discovers per-page CDP URLs via the `/json` debug endpoint, and returns real `cdpUrl` in session responses. A new `browser-service` scrape engine routes interact-eligible scrapes (profile/interactable flag) through browser-service so the BrowserContext survives for subsequent interact calls. TTL is configurable via env vars.

**Tech Stack:** TypeScript, Playwright, Express, Docker Compose

**Spec:** `docs/superpowers/specs/2026-05-12-browser-service-cdp-and-session-persistence-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/browser-service/server.ts` | Modify | CDP port discovery, real cdpUrl, TTL env vars |
| `apps/browser-service/Dockerfile` | Modify | Expose CDP debug port |
| `docker-compose.yaml` | Modify | Port mapping, env vars |
| `apps/api/src/config.ts` | Modify | Add TTL config vars |
| `apps/api/src/scraper/scrapeURL/engines/index.ts` | Modify | Register browser-service engine |
| `apps/api/src/scraper/scrapeURL/engines/browser-service/index.ts` | Create | Engine handler |
| `apps/api/src/controllers/v2/scrape-browser.ts` | Modify | Skip replay when session exists |
| `apps/api/src/controllers/v2/browser.ts` | Modify | Dynamic TTL max |

---

### Task 1: Browser-Service CDP Port Discovery

**Files:**
- Modify: `apps/browser-service/server.ts:7-11` (env vars), `server.ts:267-278` (chromium.launch), `server.ts:107-114` (response)

- [ ] **Step 1: Add env vars and CDP port tracking at top of server.ts**

After the existing `PORT` and `API_KEY` constants (line 9-10), add:

```typescript
const DEFAULT_TTL = Number(process.env.BROWSER_SESSION_DEFAULT_TTL || 600);
const MAX_TTL = Number(process.env.BROWSER_SESSION_MAX_TTL || 3600);
const CDP_HOST = process.env.BROWSER_CDP_HOST || "localhost";

let debugPort: number = 0;
```

- [ ] **Step 2: Add `--remote-debugging-port=0` to chromium.launch and discover port**

Replace the `start()` function (lines 267-290) with:

```typescript
async function start() {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-debugging-port=0",
    ],
  });

  // Discover the auto-assigned CDP debug port from Playwright's wsEndpoint.
  // Format: ws://127.0.0.1:<port>/... 
  const wsEndpoint = browser.wsEndpoint();
  const wsUrl = new URL(wsEndpoint);
  debugPort = Number(wsUrl.port);

  console.log(`Browser launched (CDP debug port: ${debugPort})`);

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
```

- [ ] **Step 3: Add helper to discover page target ID via CDP `/json` endpoint**

Add this function before the `POST /browsers` route (before line 58):

```typescript
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
```

- [ ] **Step 4: Update POST /browsers TTL defaults and response to include real cdpUrl**

Replace the destructuring at line 61:

```typescript
    const {
      ttl = DEFAULT_TTL,
      activityTtl = Math.min(300, DEFAULT_TTL),
      persistentStorage,
    } = req.body;

    const clampedTtl = Math.min(Math.max(ttl, 30), MAX_TTL);
    const clampedActivityTtl = Math.min(Math.max(activityTtl, 10), clampedTtl);
```

Then after `const page = await context.newPage();` (line 82), add CDP URL discovery:

```typescript
    const targetId = await getPageTargetId(page);
    const cdpUrl = targetId && debugPort
      ? `ws://${CDP_HOST}:${debugPort}/devtools/page/${targetId}`
      : "";
```

Update the timers to use clamped values (replace lines 83-89):

```typescript
    const expiresAt = new Date(Date.now() + clampedTtl * 1000).toISOString();

    const timer = setTimeout(() => destroySession(id), clampedTtl * 1000);
    const activityTimer = setTimeout(
      () => destroySession(id),
      clampedActivityTtl * 1000,
    );
```

Update the session object to use clamped TTLs (lines 91-102):

```typescript
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
```

Update the response (replace lines 107-114):

```typescript
    res.json({
      sessionId: id,
      cdpUrl,
      viewUrl: "",
      iframeUrl: "",
      interactiveIframeUrl: "",
      expiresAt,
    });
```

- [ ] **Step 5: Test manually**

```bash
cd apps/browser-service && npx tsx server.ts &
curl -s -X POST http://localhost:3001/browsers -H 'Content-Type: application/json' -d '{"ttl": 120}' | jq .
```

Expected: `cdpUrl` field contains a non-empty `ws://localhost:<port>/devtools/page/<id>` URL.

Kill the server after verification.

- [ ] **Step 6: Commit**

```bash
git add apps/browser-service/server.ts
git commit -m "feat(browser-service): add CDP remote debugging and configurable TTL

Launch Chromium with --remote-debugging-port=0, discover per-page CDP
websocket URLs via /json endpoint, return real cdpUrl in session response.
Add BROWSER_SESSION_DEFAULT_TTL, BROWSER_SESSION_MAX_TTL, BROWSER_CDP_HOST
env vars."
```

---

### Task 2: Docker & Compose Changes

**Files:**
- Modify: `apps/browser-service/Dockerfile`
- Modify: `docker-compose.yaml:91-108`

- [ ] **Step 1: Expose CDP port range in Dockerfile**

Replace the existing `EXPOSE` line (line 15) in `apps/browser-service/Dockerfile`:

```dockerfile
ENV PORT=3001
EXPOSE 3001
# CDP remote debugging port (auto-assigned, typically 30000-60000 range)
EXPOSE 9222
```

Note: The actual port is auto-assigned by `--remote-debugging-port=0`, but we expose 9222 as a conventional fallback. In practice, Docker's `--network=host` or compose networking handles this.

- [ ] **Step 2: Update docker-compose.yaml browser-service section**

Replace lines 91-108:

```yaml
  browser-service:
    build: apps/browser-service
    environment:
      PORT: 3001
      BROWSER_SERVICE_API_KEY: ${BROWSER_SERVICE_API_KEY:-}
      BROWSER_CDP_HOST: ${BROWSER_CDP_HOST:-browser-service}
      BROWSER_SESSION_DEFAULT_TTL: ${BROWSER_SESSION_DEFAULT_TTL:-600}
      BROWSER_SESSION_MAX_TTL: ${BROWSER_SESSION_MAX_TTL:-3600}
    networks:
      - backend
    cpus: 2.0
    mem_limit: 4G
    memswap_limit: 4G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
        compress: "true"
    tmpfs:
      - /tmp/.cache:noexec,nosuid,size=1g
```

- [ ] **Step 3: Add TTL env vars to API common-env section**

In the `x-common-env` anchor, add alongside the existing `BROWSER_SERVICE_URL`:

```yaml
    BROWSER_SESSION_DEFAULT_TTL: ${BROWSER_SESSION_DEFAULT_TTL:-600}
    BROWSER_SESSION_MAX_TTL: ${BROWSER_SESSION_MAX_TTL:-3600}
```

- [ ] **Step 4: Commit**

```bash
git add apps/browser-service/Dockerfile docker-compose.yaml
git commit -m "feat(docker): expose CDP port and add TTL env vars to compose"
```

---

### Task 3: API Config - TTL Environment Variables

**Files:**
- Modify: `apps/api/src/config.ts:264-267`

- [ ] **Step 1: Add TTL config vars to the config schema**

After the existing `BROWSER_SERVICE_WEBHOOK_SECRET` line (267), add:

```typescript
  BROWSER_SESSION_DEFAULT_TTL: z.coerce.number().optional(),
  BROWSER_SESSION_MAX_TTL: z.coerce.number().optional(),
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/config.ts
git commit -m "feat(config): add BROWSER_SESSION_DEFAULT_TTL and MAX_TTL"
```

---

### Task 4: Dynamic TTL Max in Zod Schemas

**Files:**
- Modify: `apps/api/src/controllers/v2/browser.ts:41-43`
- Modify: `apps/api/src/controllers/v2/scrape-browser.ts:62-64`

- [ ] **Step 1: Update TTL schema in browser.ts**

Replace the `browserCreateRequestSchema` (lines 41-52) in `apps/api/src/controllers/v2/browser.ts`:

```typescript
const maxTtl = config.BROWSER_SESSION_MAX_TTL ?? 3600;
const defaultTtl = config.BROWSER_SESSION_DEFAULT_TTL ?? 600;

const browserCreateRequestSchema = z.object({
  ttl: z.number().min(30).max(maxTtl).default(defaultTtl),
  activityTtl: z.number().min(10).max(maxTtl).default(300),
  streamWebView: z.boolean().default(true),
  integration: integrationSchema.optional().transform(val => val || null),
  profile: z
    .object({
      name: z.string().min(1).max(128),
      saveChanges: z.boolean().default(true),
    })
    .optional(),
});
```

- [ ] **Step 2: Update TTL schema in scrape-browser.ts**

Replace the `browserCreateRequestSchema` (lines 62-73) in `apps/api/src/controllers/v2/scrape-browser.ts`:

```typescript
const maxTtl = config.BROWSER_SESSION_MAX_TTL ?? 3600;
const defaultTtl = config.BROWSER_SESSION_DEFAULT_TTL ?? 600;

const browserCreateRequestSchema = z.object({
  ttl: z.number().min(30).max(maxTtl).default(defaultTtl),
  activityTtl: z.number().min(10).max(maxTtl).default(300),
  streamWebView: z.boolean().default(true),
  integration: integrationSchema.optional().transform(val => val || null),
  profile: z
    .object({
      name: z.string().min(1).max(128),
      saveChanges: z.boolean().default(true),
    })
    .optional(),
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/controllers/v2/browser.ts apps/api/src/controllers/v2/scrape-browser.ts
git commit -m "feat(api): use configurable TTL max in browser session schemas"
```

---

### Task 5: Browser-Service Scrape Engine

**Files:**
- Create: `apps/api/src/scraper/scrapeURL/engines/browser-service/index.ts`

- [ ] **Step 1: Create the engine handler file**

Create `apps/api/src/scraper/scrapeURL/engines/browser-service/index.ts`:

```typescript
import { createHash } from "crypto";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import {
  browserServiceRequest,
  BrowserServiceCreateResponse,
  BrowserServiceExecResponse,
} from "../../../../lib/scrape-interact/browser-service-client";
import {
  buildReplayScript,
  estimateReplayTimeoutSeconds,
} from "../../../../lib/scrape-interact/scrape-replay";
import { insertBrowserSession } from "../../../../lib/browser-sessions";
import {
  pushConcurrencyLimitActiveJob,
} from "../../../../lib/concurrency-limit";

export async function scrapeURLWithBrowserService(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const logger = meta.logger.child({ engine: "browser-service" });

  if (!config.BROWSER_SERVICE_URL) {
    throw new Error("BROWSER_SERVICE_URL is not configured");
  }

  const profile = meta.options.profile;
  const ttl = config.BROWSER_SESSION_DEFAULT_TTL ?? 600;

  // Build persistentStorage from profile
  let persistentStorage: { uniqueId: string; write: boolean } | undefined;
  if (profile) {
    const teamHash = createHash("sha256")
      .update(meta.internalOptions.teamId ?? "anonymous")
      .digest("hex")
      .slice(0, 16);
    persistentStorage = {
      uniqueId: `${teamHash}_${profile.name}`,
      write: profile.saveChanges !== false,
    };
  }

  // 1. Create browser session
  const svcResponse = await browserServiceRequest<BrowserServiceCreateResponse>(
    "POST",
    "/browsers",
    {
      ttl,
      activityTtl: Math.min(300, ttl),
      ...(persistentStorage ? { persistentStorage } : {}),
    },
  );

  logger.info("Browser-service session created", {
    browserId: svcResponse.sessionId,
    cdpUrl: svcResponse.cdpUrl,
    ttl,
  });

  // 2. Navigate and run scrape logic via exec using buildReplayScript
  const url = meta.rewrittenUrl ?? meta.url;
  const waitForMs = meta.options.waitFor ?? 0;
  const actions = meta.options.actions ?? [];

  const replayContext = { targetUrl: url, waitForMs, actions };
  const replayCode = buildReplayScript(replayContext);

  // After replay completes, extract page content
  const scrapeCode = `
    ${replayCode}
    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();
    return JSON.stringify({ html, title, url: finalUrl });
  `;

  const timeoutSec = estimateReplayTimeoutSeconds(replayContext);

  const execResult = await browserServiceRequest<BrowserServiceExecResponse>(
    "POST",
    `/browsers/${svcResponse.sessionId}/exec`,
    {
      code: scrapeCode,
      language: "node",
      timeout: timeoutSec,
      origin: "browser_service_engine",
    },
  );

  if (execResult.exitCode !== 0 || execResult.killed) {
    // Clean up session on failure
    await browserServiceRequest("DELETE", `/browsers/${svcResponse.sessionId}`).catch(() => {});
    throw new Error(
      execResult.stderr?.trim() || "Browser-service scrape exec failed",
    );
  }

  // 3. Parse extracted content
  let html = "";
  let finalUrl = url;
  try {
    const parsed = JSON.parse(execResult.result || execResult.stdout);
    html = parsed.html ?? "";
    finalUrl = parsed.url ?? url;
  } catch {
    html = execResult.stdout || "";
  }

  // 4. Persist browser session in DB so interact can find it
  const sessionId = uuidv7();
  const teamId = meta.internalOptions.teamId ?? "bypass";

  try {
    await insertBrowserSession({
      id: sessionId,
      team_id: teamId,
      scrape_id: meta.id,
      browser_id: svcResponse.sessionId,
      workspace_id: "",
      context_id: "",
      cdp_url: svcResponse.cdpUrl,
      cdp_path: svcResponse.iframeUrl,
      cdp_interactive_path: svcResponse.interactiveIframeUrl,
      stream_web_view: true,
      status: "active",
      ttl_total: ttl,
      ttl_without_activity: Math.min(300, ttl),
      credits_used: null,
    });

    pushConcurrencyLimitActiveJob(teamId, sessionId, ttl * 1000).catch(() => {});

    logger.info("Browser session persisted for interact reuse", {
      sessionId,
      scrapeId: meta.id,
      browserId: svcResponse.sessionId,
    });
  } catch (err) {
    logger.error("Failed to persist browser session, session stays alive but interact lookup will fail", { error: err });
  }

  // 5. Return result - do NOT destroy session
  return {
    url: finalUrl,
    html,
    statusCode: 200,
    proxyUsed: "basic",
  };
}

export function browserServiceMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + 60000;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/api && npx tsc --noEmit --pretty 2>&1 | head -30
```

Expected: No errors related to `browser-service/index.ts`. Other pre-existing errors may appear.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/scraper/scrapeURL/engines/browser-service/index.ts
git commit -m "feat(api): add browser-service scrape engine

Creates browser-service sessions for interact-eligible scrapes, runs
scrape via exec, persists session in DB for interact reuse. Does not
destroy session after scrape completes."
```

---

### Task 6: Register Browser-Service Engine

**Files:**
- Modify: `apps/api/src/scraper/scrapeURL/engines/index.ts`

- [ ] **Step 1: Add import**

At the top of the file, after the wikipedia import (line 21), add:

```typescript
import {
  scrapeURLWithBrowserService,
  browserServiceMaxReasonableTime,
} from "./browser-service";
```

- [ ] **Step 2: Add to Engine union type**

Add `"browser-service"` to the `Engine` type (after line 42, before the semicolon):

```typescript
export type Engine =
  | "fire-engine;chrome-cdp"
  | "fire-engine(retry);chrome-cdp"
  | "fire-engine;chrome-cdp;stealth"
  | "fire-engine(retry);chrome-cdp;stealth"
  | "fire-engine;tlsclient"
  | "fire-engine;tlsclient;stealth"
  | "playwright"
  | "fetch"
  | "pdf"
  | "document"
  | "index"
  | "index;documents"
  | "wikipedia"
  | "browser-service";
```

- [ ] **Step 3: Add availability flag and to engines array**

After the `useWikipedia` const (line 54), add:

```typescript
const useBrowserService =
  config.BROWSER_SERVICE_URL !== "" &&
  config.BROWSER_SERVICE_URL !== undefined;
```

In the `engines` array (after the playwright line, before `"fetch"`), add:

```typescript
  ...(useBrowserService ? ["browser-service" as const] : []),
```

- [ ] **Step 4: Add to engineHandlers map**

After the `wikipedia` entry in `engineHandlers` (line 168), add:

```typescript
  "browser-service": scrapeURLWithBrowserService,
```

- [ ] **Step 5: Add to engineMRTs map**

After the `wikipedia` entry in `engineMRTs` (line 192), add:

```typescript
  "browser-service": browserServiceMaxReasonableTime,
```

- [ ] **Step 6: Add to engineOptions map**

After the `wikipedia` entry in `engineOptions` (before the closing `};`), add:

```typescript
  "browser-service": {
    features: {
      actions: true,
      waitFor: true,
      screenshot: false,
      "screenshot@fullScreen": false,
      pdf: false,
      document: false,
      audio: false,
      atsv: false,
      location: false,
      mobile: false,
      skipTlsVerification: true,
      useFastMode: false,
      stealthProxy: false,
      branding: false,
      disableAdblock: false,
    },
    quality: 55, // above fire-engine;chrome-cdp (50) when forced
  },
```

- [ ] **Step 7: Add force-engine logic in buildFallbackList**

In `buildFallbackList()`, after the `lockdown` and `agentIndexOnly` checks (after line 531, before `} else if (!shouldUseIndex(meta))`), add a new branch:

```typescript
  } else if (useBrowserService && meta.options.profile) {
    _engines.length = 0;
    _engines.push("browser-service" as Engine);
    meta.internalOptions.forceEngine = "browser-service";
```

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd apps/api && npx tsc --noEmit --pretty 2>&1 | head -30
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/scraper/scrapeURL/engines/index.ts
git commit -m "feat(api): register browser-service in engine pipeline

Add browser-service to Engine type, handlers, MRTs, options. Force
browser-service engine when profile option is set and BROWSER_SERVICE_URL
is configured."
```

---

### Task 7: Skip Replay in Interact Controller

**Files:**
- Modify: `apps/api/src/controllers/v2/scrape-browser.ts:147-209`

- [ ] **Step 1: Restructure scrapeInteractController to skip replay when session exists**

In `scrapeInteractController()`, replace lines 147-209 (from `// --- Build replay context` through the end of the session creation block) with:

```typescript
  // --- Check for existing browser session (created by browser-service engine) ---

  let session = await getBrowserSessionFromScrape(scrapeId);

  if (session && session.status === "active") {
    // Session persisted from browser-service scrape engine - skip replay entirely.
    logger = logger.child({
      sessionId: session.id,
      browserId: session.browser_id,
    });
    logger.info("Reusing existing browser session from scrape (no replay needed)", {
      scrapeId,
      sessionId: session.id,
      browserId: session.browser_id,
    });
  } else {
    // No persisted session - fall back to existing replay-based flow.
    session = null;

    const replay = buildReplayContextFromScrape(scrape);
    if (!replay.context) {
      return res.status(409).json({
        success: false,
        error:
          replay.error ??
          "Replay context is unavailable for this scrape job. Please rerun the scrape.",
      });
    }
    const replayContext = replay.context;

    logger = logger.child({
      replayTargetUrl: replayContext.targetUrl,
      replayWaitForMs: replayContext.waitForMs,
      replayActions: replayContext.actions.length,
    });

    if (req.body.existingSessionId) {
      const existing = await getBrowserSession(req.body.existingSessionId);
      if (
        existing &&
        existing.team_id === req.auth.team_id &&
        existing.status === "active"
      ) {
        await updateBrowserSessionScrapeId(existing.id, scrapeId);
        session = { ...existing, scrape_id: scrapeId };
        logger.info("Adopted pre-created browser session for scrape", {
          scrapeId,
          sessionId: session.id,
          browserId: session.browser_id,
        });
      }
    }

    if (!session) {
      const created = await createSessionForScrape(
        req,
        scrapeId,
        replayContext,
        logger,
        (scrape.options as ScrapeOptions).profile,
      );
      if ("error" in created) {
        return res.status(created.status).json(created.body);
      }
      session = created.session;

      logger = logger.child({
        sessionId: session.id,
        browserId: session.browser_id,
      });
      logger.info("Browser session created for scrape", {
        scrapeId,
        sessionId: session.id,
        browserId: session.browser_id,
      });
    }
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/api && npx tsc --noEmit --pretty 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/controllers/v2/scrape-browser.ts
git commit -m "feat(api): skip replay when browser session persists from scrape

When getBrowserSessionFromScrape finds an active session (created by
browser-service scrape engine), reuse it directly without replay. Falls
back to existing replay-based flow otherwise."
```

---

### Task 8: Verify internalOptions.teamId Availability

**Files:**
- Read: `apps/api/src/scraper/scrapeURL/index.ts` (check InternalOptions type)

The browser-service engine (Task 5) uses `meta.internalOptions.teamId` for session persistence. Verify this field exists.

- [ ] **Step 1: Check InternalOptions has teamId**

```bash
grep -n "teamId\|team_id" apps/api/src/scraper/scrapeURL/index.ts | head -10
```

If `teamId` is not on `InternalOptions`, find where it's available. The scrape worker passes team context - trace it:

```bash
grep -rn "internalOptions.*team\|teamId" apps/api/src/scraper/ --include="*.ts" | head -10
```

- [ ] **Step 2: If teamId is missing from InternalOptions, add it**

If not present, add to the `InternalOptions` interface in `apps/api/src/scraper/scrapeURL/index.ts`:

```typescript
  teamId?: string;
```

And ensure callers pass it. Search for where `internalOptions` is constructed:

```bash
grep -rn "internalOptions:" apps/api/src/services/worker/ --include="*.ts" | head -10
```

- [ ] **Step 3: Commit if changes needed**

```bash
git add -A
git commit -m "fix(api): ensure teamId available in InternalOptions for browser-service engine"
```

---

### Task 9: End-to-End Smoke Test

- [ ] **Step 1: Build and start stack**

```bash
docker compose build browser-service api
docker compose up -d
```

- [ ] **Step 2: Verify CDP URL returned**

```bash
# Create a browser session directly
curl -s -X POST http://localhost:3002/v2/browser \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-api-key>' \
  -d '{"ttl": 120}' | jq '.cdpUrl'
```

Expected: Non-empty `ws://` URL.

- [ ] **Step 3: Verify session persistence with profile scrape**

```bash
# Scrape with profile flag
curl -s -X POST http://localhost:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-api-key>' \
  -d '{"url": "https://example.com", "profile": {"name": "test"}}' | jq '.id'
```

Then check browser_sessions table for a row with that scrape_id and status "active".

- [ ] **Step 4: Verify interact reuses session**

```bash
SCRAPE_ID=<id-from-step-3>
curl -s -X POST "http://localhost:3002/v2/scrape/${SCRAPE_ID}/interact" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-api-key>' \
  -d '{"prompt": "What is on this page?"}' | jq '.success'
```

Expected: `true`. Logs should show "Reusing existing browser session from scrape (no replay needed)".

- [ ] **Step 5: Verify configurable TTL**

Set env vars and restart:

```bash
BROWSER_SESSION_MAX_TTL=86400 docker compose up -d browser-service api
curl -s -X POST http://localhost:3002/v2/browser \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-api-key>' \
  -d '{"ttl": 7200}' | jq '.expiresAt'
```

Expected: Expiry ~2 hours from now (previously would have been clamped to 3600).

- [ ] **Step 6: Commit test notes or cleanup**

```bash
git add -A
git commit -m "test: verify CDP URLs, session persistence, and configurable TTL"
```
