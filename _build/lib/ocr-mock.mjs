import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createZip } from "./zip.mjs";

const MINERU_MARKDOWN = "# MinerU 结果\n\nMinerU 识别内容。\n\n![图1](images/page-1.jpg)\n";
const BAIDU_PARAGRAPH = "百度 OCR 识别结果第二行内容";

/**
 * Local stand-in for MinerU and Baidu OCR endpoints. Tokens choose the mode:
 * good-token (success), slow-token (polling never finishes), badzip-token
 * (result archive without full.md), anything else (auth failure).
 */
export async function startOcrMock(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const state = {
    applyBodies: [],
    uploaded: [],
    baiduCalls: [],
    batches: new Map(),
    polls: new Map(),
  };
  let zipSequence = 0;
  const buildZip = (entries) => {
    const target = path.join(workDir, `ocr-zip-${zipSequence += 1}.zip`);
    createZip(target, entries);
    const buffer = fs.readFileSync(target);
    fs.rmSync(target, { force: true });
    return buffer;
  };
  const mineruZip = buildZip([{ name: "full.md", data: MINERU_MARKDOWN }]);
  const emptyZip = buildZip([{ name: "readme.txt", data: "no markdown here\n" }]);
  const validTokens = new Set(["good-token", "slow-token", "badzip-token"]);
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");

    if (req.method === "POST" && url.pathname === "/api/v4/file-urls/batch") {
      const body = await readBody(req);
      if (!validTokens.has(token)) return send(200, { code: "A0202", msg: "token is invalid" });
      const parsed = JSON.parse(body.toString("utf8"));
      state.applyBodies.push(parsed);
      const batchId = `batch-${state.applyBodies.length}`;
      state.batches.set(batchId, token);
      return send(200, {
        code: 0,
        data: {
          batch_id: batchId,
          file_urls: [`http://127.0.0.1:${server.address().port}/upload/${batchId}`],
        },
      });
    }

    if (req.method === "PUT" && url.pathname.startsWith("/upload/")) {
      state.uploaded.push(await readBody(req));
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/v4/extract-results/batch/")) {
      const batchId = decodeURIComponent(url.pathname.split("/").pop());
      if (!validTokens.has(token)) return send(200, { code: "A0202", msg: "token is invalid" });
      if (batchId === "00000000-0000-0000-0000-000000000000") {
        return send(200, { code: 0, data: { extract_result: [] } });
      }
      const seen = (state.polls.get(batchId) || 0) + 1;
      state.polls.set(batchId, seen);
      const mode = state.batches.get(batchId) || token;
      if (mode === "slow-token" && seen < 40) {
        return send(200, {
          code: 0,
          data: { extract_result: [{ state: "running", extract_progress: { extracted_pages: 1, total_pages: 2 } }] },
        });
      }
      return send(200, {
        code: 0,
        data: {
          extract_result: [{
            state: "done",
            full_zip_url: `http://127.0.0.1:${server.address().port}/download/result.zip?batch=${encodeURIComponent(batchId)}`,
          }],
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/download/result.zip") {
      const batchId = url.searchParams.get("batch") || "";
      const mode = state.batches.get(batchId) || "";
      const payload = mode === "badzip-token" ? emptyZip : mineruZip;
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": payload.length });
      res.end(payload);
      return;
    }

    if (req.method === "POST" && url.pathname === "/oauth/2.0/token") {
      if (url.searchParams.get("client_id") === "bad-key") {
        return send(200, { error: "invalid_client", error_description: "unknown client id" });
      }
      return send(200, { access_token: "baidu-token", expires_in: 3600 });
    }

    if (req.method === "POST" && url.pathname === "/rest/2.0/ocr/v1/accurate_basic") {
      const body = await readBody(req);
      const form = new URLSearchParams(body.toString("utf8"));
      state.baiduCalls.push({
        token: url.searchParams.get("access_token"),
        imageLength: (form.get("image") || "").length,
        languageType: form.get("language_type"),
      });
      if (url.searchParams.get("access_token") !== "baidu-token") {
        return send(200, { error_code: 110, error_msg: "Access token invalid or no longer valid" });
      }
      return send(200, {
        words_result: [{ words: "百度 OCR 识别结果" }, { words: "第二行内容" }],
        paragraphs_result: [{ words_result_idx: [0, 1] }],
      });
    }

    send(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

export const OCR_MOCK_EXPECTATIONS = {
  mineruMarkdown: MINERU_MARKDOWN,
  baiduParagraph: BAIDU_PARAGRAPH,
};
