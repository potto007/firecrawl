import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const fetchMock = jest.fn();
jest.mock("undici", () => ({
  fetch: (...args: any[]) => fetchMock(...args),
  FormData: class {
    entries: [string, any][] = [];
    append(k: string, v: any) {
      this.entries.push([k, v]);
    }
  },
}));
jest.mock("../../../../../config", () => ({
  config: { DOCLING_LOCAL_URL: "http://docling:5001/" },
}));
jest.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: async (md: string) => `<p>${md}</p>`,
}));

import { scrapePDFWithDoclingLocal } from "../doclingLocal";

function jsonResponse(body: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function fakeMeta() {
  return {
    id: "test",
    url: "https://example.com/a.pdf",
    logger: { info: jest.fn(), warn: jest.fn(), child: jest.fn() },
    abort: { asSignal: () => undefined },
  } as any;
}

describe("scrapePDFWithDoclingLocal", () => {
  let dir: string;
  let pdfPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docling-test-"));
    pdfPath = path.join(dir, "doc");
    await writeFile(pdfPath, "%PDF-1.4 fake");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  beforeEach(() => fetchMock.mockReset());

  it("submits, polls until success, and returns md_content", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ task_id: "t1", task_status: "pending" }),
      )
      .mockResolvedValueOnce(jsonResponse({ task_status: "started" }))
      .mockResolvedValueOnce(jsonResponse({ task_status: "success" }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "success",
          errors: [],
          processing_time: 1.2,
          document: { filename: "doc.pdf", md_content: "# Hello" },
        }),
      );

    const result = await scrapePDFWithDoclingLocal(fakeMeta(), pdfPath, 3);

    expect(result.markdown).toBe("# Hello");
    expect(result.html).toBe("<p># Hello</p>");
    const urls = fetchMock.mock.calls.map(c => c[0]);
    expect(urls).toEqual([
      "http://docling:5001/v1/convert/file/async",
      "http://docling:5001/v1/status/poll/t1",
      "http://docling:5001/v1/status/poll/t1",
      "http://docling:5001/v1/result/t1",
    ]);
    const form = fetchMock.mock.calls[0][1].body;
    expect(form.entries).toEqual(
      expect.arrayContaining([
        ["to_formats", "md"],
        ["do_ocr", "false"],
        ["page_range", "1"],
        ["page_range", "3"],
      ]),
    );
  }, 15000);

  it("throws when the task reports failure", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ task_id: "t2", task_status: "pending" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ task_status: "failure", error_message: "bad pdf" }),
      );

    await expect(
      scrapePDFWithDoclingLocal(fakeMeta(), pdfPath),
    ).rejects.toThrow("docling task failed: bad pdf");
  }, 15000);

  it("throws on a non-2xx submit response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: "nope" }, false, 503),
    );

    await expect(
      scrapePDFWithDoclingLocal(fakeMeta(), pdfPath),
    ).rejects.toThrow("docling submit returned 503");
  });

  it("throws when the result has no markdown", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ task_id: "t3", task_status: "success" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: "success", errors: [], document: {} }),
      );

    await expect(
      scrapePDFWithDoclingLocal(fakeMeta(), pdfPath),
    ).rejects.toThrow("docling returned no markdown content");
  });
});
