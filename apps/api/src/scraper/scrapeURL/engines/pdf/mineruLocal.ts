import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetch, FormData } from "undici";
import { Meta } from "../..";
import { config } from "../../../../config";
import { safeMarkdownToHtml } from "./markdownToHtml";
import type { PDFProcessorResult } from "./types";

export async function scrapePDFWithMinerULocal(
  meta: Meta,
  tempFilePath: string,
  maxPages?: number,
): Promise<PDFProcessorResult> {
  const startedAt = Date.now();
  meta.logger.info("Processing PDF with local MinerU", {
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
  form.append("return_md", "true");
  if (maxPages !== undefined) {
    form.append("max_pages", String(maxPages));
  }

  const response = await fetch(`${config.MINERU_LOCAL_URL}/file_parse`, {
    method: "POST",
    body: form,
    signal: meta.abort.asSignal(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `MinerU returned ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  const body = (await response.json()) as Record<string, any>;

  // MinerU /file_parse returns { results: { "<filename>": { md_content: "..." } } }
  const firstResult =
    body.results && typeof body.results === "object"
      ? (Object.values(body.results)[0] as Record<string, any> | undefined)
      : undefined;

  const markdown: string | undefined =
    body.markdown ??
    body.md_content ??
    firstResult?.md_content ??
    firstResult?.markdown;

  if (!markdown) {
    meta.logger.warn("MinerU returned no markdown", {
      responseKeys: Object.keys(body),
      url: meta.rewrittenUrl ?? meta.url,
    });
    throw new Error("MinerU returned no markdown content");
  }

  const durationMs = Date.now() - startedAt;
  meta.logger.info("Local MinerU succeeded", {
    durationMs,
    markdownLength: markdown.length,
    url: meta.rewrittenUrl ?? meta.url,
  });

  const html = await safeMarkdownToHtml(markdown, meta.logger, meta.id);
  return { markdown, html };
}
