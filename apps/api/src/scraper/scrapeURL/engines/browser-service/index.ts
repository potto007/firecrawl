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

  const url = meta.rewrittenUrl ?? meta.url;
  const waitForMs = meta.options.waitFor ?? 0;
  const actions = meta.options.actions ?? [];

  const replayContext = { targetUrl: url, waitForMs, actions };
  const replayCode = buildReplayScript(replayContext);

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
    await browserServiceRequest("DELETE", `/browsers/${svcResponse.sessionId}`).catch(() => {});
    throw new Error(
      execResult.stderr?.trim() || "Browser-service scrape exec failed",
    );
  }

  let html = "";
  let finalUrl = url;
  try {
    const parsed = JSON.parse(execResult.result || execResult.stdout);
    html = parsed.html ?? "";
    finalUrl = parsed.url ?? url;
  } catch {
    html = execResult.stdout || "";
  }

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
