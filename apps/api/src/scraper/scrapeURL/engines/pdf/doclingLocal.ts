import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fetch, FormData } from "undici";
import { Meta } from "../..";
import { config } from "../../../../config";
import { safeMarkdownToHtml } from "./markdownToHtml";
import type { PDFProcessorResult } from "./types";

// docling-serve async contract (https://github.com/docling-project/docling-serve):
//   POST /v1/convert/file/async  -> { task_id, task_status: "pending" | ... }
//   GET  /v1/status/poll/{id}    -> { task_status: "pending" | "started" | "success" | ... }
//   GET  /v1/result/{id}         -> { document: { md_content }, status, errors }
// The sync endpoint (/v1/convert/file) returns 504 after DOCLING_SERVE_MAX_SYNC_WAIT
// (120 s default) and a CPU conversion regularly takes longer, so we only use async.

const TERMINAL_STATES = new Set([
  "success",
  "partial_success",
  "failure",
  "skipped",
]);

const POLL_INTERVAL_MS = 2000;

async function readJson(
  response: Awaited<ReturnType<typeof fetch>>,
  what: string,
): Promise<Record<string, any>> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `docling ${what} returned ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await response.json()) as Record<string, any>;
}

export async function scrapePDFWithDoclingLocal(
  meta: Meta,
  tempFilePath: string,
  maxPages?: number,
): Promise<PDFProcessorResult> {
  const startedAt = Date.now();
  const baseUrl = config.DOCLING_LOCAL_URL!.replace(/\/+$/, "");
  const signal = meta.abort.asSignal();

  meta.logger.info("Processing PDF with local docling-serve", {
    url: meta.rewrittenUrl ?? meta.url,
  });

  const pdfBuffer = await readFile(tempFilePath);
  const filename = path.basename(tempFilePath) + ".pdf";

  const form = new FormData();
  form.append(
    "files",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    filename,
  );
  form.append("to_formats", "md");
  form.append("image_export_mode", "placeholder");
  // OCR is on by default; it is slow on CPU and we only want the text layer here.
  form.append("do_ocr", "false");
  form.append("table_mode", "fast");
  if (maxPages !== undefined) {
    // page_range is a [start, end] pair, sent as a repeated form field.
    form.append("page_range", "1");
    form.append("page_range", String(maxPages));
  }

  const submitted = await readJson(
    await fetch(`${baseUrl}/v1/convert/file/async`, {
      method: "POST",
      body: form,
      signal,
    }),
    "submit",
  );
  const taskId: string | undefined = submitted.task_id;
  if (!taskId) {
    throw new Error("docling submit returned no task_id");
  }

  let status: string = submitted.task_status ?? "pending";
  while (!TERMINAL_STATES.has(status)) {
    await sleep(POLL_INTERVAL_MS, undefined, { signal });
    const poll = await readJson(
      await fetch(`${baseUrl}/v1/status/poll/${taskId}`, { signal }),
      "poll",
    );
    status = poll.task_status ?? status;
    if (status === "failure") {
      throw new Error(
        `docling task failed: ${poll.error_message ?? "unknown error"}`,
      );
    }
  }

  const body = await readJson(
    await fetch(`${baseUrl}/v1/result/${taskId}`, { signal }),
    "result",
  );

  if (body.status === "failure") {
    throw new Error(
      `docling conversion failed: ${JSON.stringify(body.errors ?? []).slice(0, 500)}`,
    );
  }

  const markdown: string | undefined = body.document?.md_content ?? undefined;

  if (!markdown) {
    meta.logger.warn("docling returned no markdown", {
      responseKeys: Object.keys(body),
      status: body.status,
      url: meta.rewrittenUrl ?? meta.url,
    });
    throw new Error("docling returned no markdown content");
  }

  const durationMs = Date.now() - startedAt;
  meta.logger.info("Local docling-serve succeeded", {
    durationMs,
    processingTime: body.processing_time,
    markdownLength: markdown.length,
    url: meta.rewrittenUrl ?? meta.url,
  });

  const html = await safeMarkdownToHtml(markdown, meta.logger, meta.id);
  return { markdown, html };
}
