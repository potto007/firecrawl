# Browser-Service: CDP Live View & Session Persistence

## Status: Design Approved (2026-05-12)

## Problem

Self-hosted Firecrawl interact pipeline creates a fresh browser context for each interact call, losing server-side session state (e.g. ASP.NET Session). Cookie injection transfers identity but not subscription authorization. Additionally, `liveViewUrl` returns empty string - no way for users to manually interact with the headless browser for credential entry or MFA.

## Decisions

| Decision | Choice |
|----------|--------|
| Live view mechanism | CDP remote debugging (`--remote-debugging-port=0`) |
| Session persistence | True persistence - same BrowserContext survives scrape to interact |
| Live view consumer | Raw CDP URL only (no web viewer) |
| Scrape routing scope | Interact-eligible scrapes only (profile or interactable flag) |
| TTL | Configurable via env vars, overridable per-request |

## Architecture

### 1. Browser-Service CDP Changes

**File:** `apps/browser-service/server.ts`

Launch Chromium with `--remote-debugging-port=0` (auto-assigns port). On startup, discover debug port from `browser.wsEndpoint()`. For each new session, after creating page, query `http://localhost:<debugPort>/json` to get per-page CDP websocket URL.

Return real `cdpUrl` in POST /browsers response:

```typescript
{
  sessionId: id,
  cdpUrl: `ws://${cdpHost}:${debugPort}/devtools/page/${pageTargetId}`,
  viewUrl: "",
  iframeUrl: "",
  interactiveIframeUrl: "",
  expiresAt,
}
```

**Docker changes:**
- Expose debug port in compose
- `BROWSER_CDP_HOST` env var for returned URLs (defaults to container hostname, overridable for external access)

### 2. Session Persistence for Interact-Eligible Scrapes

When `options.profile` or `options.interactable` flag is set on a scrape:

1. Scrape worker calls `POST /browsers` on browser-service to create session
2. Runs scrape logic via `POST /browsers/:id/exec` (navigate, wait, actions, extract HTML)
3. Scrape completes, returns results - session stays alive in browser-service
4. Session ID stored in scrape record via `browser_id` column
5. When interact comes in, `scrapeInteractController` finds existing session via `getBrowserSessionFromScrape` - skips replay entirely

**What gets skipped on interact when session exists:**
- No `buildReplayContextFromScrape`
- No `buildReplayScript`
- No fresh `POST /browsers`
- No tab sync dance

### 3. TTL Configuration

**Environment-level defaults:**
- `BROWSER_SESSION_DEFAULT_TTL` - overrides 600s default (both browser-service and API)
- `BROWSER_SESSION_MAX_TTL` - overrides 3600s max (default 3600s, self-hosted can raise to 86400 for 24hr deep dives)

**Compose example:**
```yaml
browser-service:
  environment:
    BROWSER_SESSION_DEFAULT_TTL: 1800
    BROWSER_SESSION_MAX_TTL: 86400

api:
  environment:
    BROWSER_SESSION_DEFAULT_TTL: 1800
    BROWSER_SESSION_MAX_TTL: 86400
```

API request `ttl` param still wins if provided explicitly. Activity TTL stays separate - each exec resets activity timer.

### 4. Browser-Service Scrape Engine

**New file:** `apps/api/src/scraper/scrapeURL/engines/browser-service/index.ts`

Responsibilities:
1. Create browser-service session (`POST /browsers` with TTL, profile, persistentStorage)
2. Navigate to URL via exec (`page.goto(url)`)
3. Execute waitFor + actions via exec (reuse `buildReplayScript` logic)
4. Extract page content via exec (`page.content()`, `page.title()`, etc.)
5. Return scrape result in same format as other engines
6. Do NOT destroy session - leave alive for interact

Engine selection in scrape pipeline:
```typescript
if (options.profile || options.interactable) {
  return 'browser-service';
}
// ... existing engine selection
```

**Reuses:** `buildReplayScript`, `browserServiceRequest`, `BrowserServiceCreateResponse`/`BrowserServiceExecResponse`, browser session DB functions.

**Does not provide:** Fire-engine stealth/proxy (irrelevant for self-hosted - these features don't exist without fire-engine).

### 5. End-to-End Flow

```
1. POST /v2/scrape { url: "https://aapc.com/codes/H0015", profile: { name: "aapc" } }

2. Engine selection: profile set -> engine = 'browser-service'

3. Browser-service engine:
   POST /browsers { ttl: 1800, persistentStorage: {...} }
   -> Returns { sessionId, cdpUrl: "ws://host:9222/devtools/page/ABC" }

4. User connects via chrome://inspect
   Manually logs into site via DevTools
   Server-side session now has subscription state

5. Scrape engine runs via exec:
   page.goto(url) -> wait -> actions -> page.content()
   Returns scrape result with premium content
   Session stays alive

6. POST /v2/scrape/:jobId/interact { prompt: "Extract fee schedule" }

7. scrapeInteractController finds existing session
   No replay needed - context already there, authenticated
   Agent executes on live page with full premium access

8. DELETE /v2/scrape/:jobId/interact (or TTL expires)
```

### Error Cases

- No interact within TTL: session auto-destroys, no leak
- Browser-service down: returns error, no silent fallback to broken replay
- Profile locked by another writer: 409 (already implemented)
- CDP port unavailable: session creation fails with clear error

## Files to Change

### browser-service
- `apps/browser-service/server.ts` - Add `--remote-debugging-port=0` to chromium.launch args, discover debug port from `browser.wsEndpoint()`, query `/json` endpoint for per-page target ID, return real cdpUrl. Add `BROWSER_SESSION_DEFAULT_TTL` and `BROWSER_SESSION_MAX_TTL` env var support.
- `apps/browser-service/Dockerfile` - Expose CDP debug port
- `docker-compose.yaml` - Add port mapping for CDP debug port, add `BROWSER_CDP_HOST`, `BROWSER_SESSION_DEFAULT_TTL`, `BROWSER_SESSION_MAX_TTL` env vars

### API - engine registration
- `apps/api/src/scraper/scrapeURL/engines/index.ts` - Add `"browser-service"` to `Engine` union type, add to `engines` array (gated on `config.BROWSER_SERVICE_URL`), register in `engineHandlers`, `engineMRTs`, `engineOptions` maps
- `apps/api/src/scraper/scrapeURL/engines/browser-service/index.ts` - New file: engine handler that creates browser-service session, runs scrape via exec, extracts content, returns `EngineScrapeResult`. Does NOT destroy session.

### API - engine selection
- `apps/api/src/scraper/scrapeURL/engines/index.ts` `buildFallbackList()` - When `meta.options.profile` or `meta.options.interactable` is set, force engine to `"browser-service"`

### API - interact controller
- `apps/api/src/controllers/v2/scrape-browser.ts` `scrapeInteractController()` - When `getBrowserSessionFromScrape` returns an existing session with status "active", skip replay (no `buildReplayContextFromScrape`, no `createSessionForScrape`). Use existing session directly.

### API - config
- `apps/api/src/config.ts` - Add `BROWSER_SESSION_DEFAULT_TTL` (number, optional) and `BROWSER_SESSION_MAX_TTL` (number, optional, default 3600) to config schema

### API - schemas
- `apps/api/src/controllers/v2/browser.ts` - Change `browserCreateRequestSchema` TTL `.max(3600)` to use `config.BROWSER_SESSION_MAX_TTL`
- `apps/api/src/controllers/v2/scrape-browser.ts` - Same TTL max change in its copy of `browserCreateRequestSchema`
