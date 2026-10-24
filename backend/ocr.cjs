"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const MINERU_BASE_URL = (process.env.DOCLITE_MINERU_BASE_URL || "https://mineru.net").replace(/\/+$/, "");
const BAIDU_BASE_URL = (process.env.DOCLITE_BAIDU_BASE_URL || "https://aip.baidubce.com").replace(/\/+$/, "");
const POLL_INTERVAL_MS = Math.max(50, Number(process.env.DOCLITE_OCR_POLL_MS) || 3000);
const POLL_TIMEOUT_MS = Math.max(1000, Number(process.env.DOCLITE_OCR_TIMEOUT_MS) || 20 * 60 * 1000);
const BAIDU_CONCURRENCY = 3;
const MINERU_MAX_BYTES = 200 * 1024 * 1024;
const BAIDU_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const BAIDU_MAX_EDGE = 8000;
const RENDER_SCALE = 2;

const DEFAULT_OCR_CONFIG = {
  provider: "mineru",
  enabled: false,
  maxPages: 100,
  language: "ch",
  mineru: { token: "", modelVersion: "vlm" },
  baidu: { apiKey: "", secretKey: "" },
};

class OcrError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail ? String(detail).slice(0, 600) : "";
  }
}

function logOcr(...args) {
  process.stderr.write(`[doclite:ocr] ${args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ")}\n`);
}

function configPath(dataDir) {
  return path.join(dataDir, "ocr.json");
}

function blank(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProvider(value) {
  return value === "baidu" ? "baidu" : "mineru";
}

function normalizeMaxPages(value, provider) {
  const fallback = provider === "baidu" ? 100 : 200;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.round(parsed)));
}

function credentialValue(input, previous) {
  if (input === undefined) return blank(previous);
  const text = blank(input);
  // The UI shows masked hints; treat a mask as "unchanged" instead of a real credential.
  if (text.startsWith("••••")) return blank(previous);
  return text;
}

function normalizeOcrConfig(input, previous) {
  const source = input && typeof input === "object" ? input : {};
  const base = previous && typeof previous === "object" ? previous : DEFAULT_OCR_CONFIG;
  const provider = normalizeProvider(source.provider !== undefined ? source.provider : base.provider);
  const mineru = source.mineru && typeof source.mineru === "object" ? source.mineru : {};
  const baidu = source.baidu && typeof source.baidu === "object" ? source.baidu : {};
  const previousMineru = base.mineru && typeof base.mineru === "object" ? base.mineru : {};
  const previousBaidu = base.baidu && typeof base.baidu === "object" ? base.baidu : {};
  const mineruToken = credentialValue(mineru.token, previousMineru.token);
  const apiKey = credentialValue(baidu.apiKey, previousBaidu.apiKey);
  const secretKey = credentialValue(baidu.secretKey, previousBaidu.secretKey);
  return {
    provider,
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : Boolean(base.enabled),
    maxPages: normalizeMaxPages(source.maxPages !== undefined ? source.maxPages : base.maxPages, provider),
    language: /^[a-z]{2,3}$/.test(blank(source.language)) ? blank(source.language) : "ch",
    mineru: {
      token: mineruToken.slice(0, 4096),
      modelVersion: mineru.modelVersion === "pipeline" ? "pipeline" : "vlm",
    },
    baidu: {
      apiKey: apiKey.slice(0, 512),
      secretKey: secretKey.slice(0, 512),
    },
  };
}

function readOcrConfig(dataDir) {
  const file = configPath(dataDir);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") logOcr("ignoring unreadable config:", error.message);
  }
  return normalizeOcrConfig(parsed || {});
}

function saveOcrConfig(dataDir, input) {
  const previous = readOcrConfig(dataDir);
  const next = normalizeOcrConfig(input, previous);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = configPath(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  return next;
}

function hint(value) {
  const text = blank(value);
  if (!text) return "";
  if (text.length <= 4) return "••••";
  return `••••${text.slice(-4)}`;
}

function providerConfigured(config, provider) {
  if (provider === "baidu") return Boolean(config.baidu.apiKey && config.baidu.secretKey);
  return Boolean(config.mineru.token);
}

function isOcrConfigured(config, provider) {
  const target = normalizeProvider(provider || (config && config.provider));
  return Boolean(config && providerConfigured(config, target));
}

function publicOcrConfig(config) {
  const provider = normalizeProvider(config.provider);
  return {
    provider,
    enabled: Boolean(config.enabled),
    configured: providerConfigured(config, provider),
    ready: Boolean(config.enabled) && providerConfigured(config, provider),
    maxPages: config.maxPages,
    language: config.language,
    mineru: {
      configured: Boolean(config.mineru.token),
      tokenHint: hint(config.mineru.token),
      modelVersion: config.mineru.modelVersion,
    },
    baidu: {
      configured: Boolean(config.baidu.apiKey && config.baidu.secretKey),
      apiKeyHint: hint(config.baidu.apiKey),
      secretKeyHint: hint(config.baidu.secretKey),
    },
  };
}

async function fetchWithTimeout(url, init, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new OcrError("ocrTimeout", "OCR 服务响应超时，请稍后重试。", error.message);
    }
    throw new OcrError("ocrNetwork", "无法连接 OCR 服务，请检查网络或接口地址。", error && error.message);
  }
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { response, body, text };
}

function parseErrorMessage(code, body, fallback) {
  const message = body && (body.msg || body.message || body.error_msg || body.error_description || body.error);
  if (typeof message === "string" && message.trim()) return message.trim();
  return fallback || `服务返回错误码 ${code === undefined ? "未知" : code}。`;
}

function providerCodeError(provider, code, message) {
  const codeText = String(code === undefined || code === null ? "" : code);
  if (provider === "mineru") {
    if (codeText === "A0202" || codeText === "A0211") {
      return new OcrError("ocrAuth", "MinerU Token 无效或已过期，请重新填写。", message);
    }
  }
  if (provider === "baidu") {
    if (["110", "111"].includes(codeText)) {
      return new OcrError("ocrAuth", "百度 OCR 凭据无效或已过期，请重新填写。", message);
    }
    if (["17", "18", "19"].includes(codeText)) {
      return new OcrError("ocrQuota", "百度 OCR 请求额度或并发已超限，请稍后重试。", message);
    }
    if (["216201", "216202", "216203"].includes(codeText)) {
      return new OcrError("ocrMalformed", "百度 OCR 无法识别该页图片，请重试或换一份文件。", message);
    }
  }
  return new OcrError("ocrFailed", message || "OCR 服务处理失败，请稍后重试。");
}

async function waitStep(ms, isCancelled) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isCancelled()) throw new OcrError("ocrCancelled", "已取消云端 OCR。");
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, end - Date.now()))));
  }
  if (isCancelled()) throw new OcrError("ocrCancelled", "已取消云端 OCR。");
}

function formatPageProgress(done, total) {
  return `${done}/${total} 页`;
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/* ---------- MinerU ---------- */

async function applyMineruUpload(config, fileName) {
  const data = {
    files: [{ name: fileName, is_ocr: true, data_id: `doclite-${Date.now()}` }],
    model_version: config.mineru.modelVersion,
    language: config.language,
  };
  const { response, body, text } = await fetchWithTimeout(
    `${MINERU_BASE_URL}/api/v4/file-urls/batch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Authorization: `Bearer ${config.mineru.token}`,
      },
      body: JSON.stringify(data),
    },
    { timeoutMs: 60000 },
  );
  const code = body && body.code;
  if (!response.ok || !body || code !== 0) {
    const message = parseErrorMessage(code, body, `MinerU 申请上传地址失败（HTTP ${response.status}）。`);
    throw providerCodeError("mineru", code, message);
  }
  const batchId = body.data && body.data.batch_id;
  const fileUrl = body.data && Array.isArray(body.data.file_urls) ? body.data.file_urls[0] : "";
  if (!batchId || !fileUrl) {
    throw new OcrError("ocrMalformed", "MinerU 没有返回上传地址，请稍后重试。", text.slice(0, 300));
  }
  return { batchId, fileUrl };
}

async function uploadToMineru(fileUrl, buffer, isCancelled) {
  if (isCancelled()) throw new OcrError("ocrCancelled", "已取消云端 OCR。");
  let response;
  try {
    response = await fetch(fileUrl, {
      method: "PUT",
      body: buffer,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch (error) {
    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new OcrError("ocrTimeout", "上传到 MinerU 超时，请检查网络后重试。", error.message);
    }
    throw new OcrError("ocrNetwork", "无法上传到 MinerU，请检查网络后重试。", error && error.message);
  }
  if (!response.ok) {
    throw new OcrError("ocrFailed", `上传到 MinerU 失败（HTTP ${response.status}）。`);
  }
}

async function pollMineru(config, batchId, progress, isCancelled) {
  const startedAt = Date.now();
  while (true) {
    if (isCancelled()) throw new OcrError("ocrCancelled", "已取消云端 OCR。");
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new OcrError("ocrTimeout", "MinerU 解析等待超时，请稍后重试或改用百度 OCR。");
    }
    const { response, body } = await fetchWithTimeout(
      `${MINERU_BASE_URL}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
      { method: "GET", headers: { Accept: "*/*", Authorization: `Bearer ${config.mineru.token}` } },
      { timeoutMs: 60000 },
    );
    const code = body && body.code;
    if (!response.ok || !body || code !== 0) {
      const message = parseErrorMessage(code, body, `MinerU 查询结果失败（HTTP ${response.status}）。`);
      throw providerCodeError("mineru", code, message);
    }
    const items = body.data && Array.isArray(body.data.extract_result) ? body.data.extract_result : [];
    const item = items[0] || null;
    if (!item) {
      await waitStep(POLL_INTERVAL_MS, isCancelled);
      continue;
    }
    const state = String(item.state || "");
    const extractProgress = item.extract_progress || {};
    const extracted = Number(extractProgress.extracted_pages) || 0;
    const total = Number(extractProgress.total_pages) || 0;
    if (state === "done") {
      const zipUrl = String(item.full_zip_url || "");
      if (!zipUrl) throw new OcrError("ocrMalformed", "MinerU 返回完成但缺少结果下载地址。");
      return zipUrl;
    }
    if (state === "failed") {
      throw new OcrError("ocrFailed", String(item.err_msg || "MinerU 解析失败，请检查文件后重试。"));
    }
    if (total > 0) {
      const ratio = Math.min(1, extracted / total);
      progress(30 + Math.round(ratio * 48), `MinerU 正在解析 ${formatPageProgress(extracted, total)}`);
    } else {
      progress(32, "MinerU 正在解析文档");
    }
    await waitStep(POLL_INTERVAL_MS, isCancelled);
  }
}

async function downloadMineruZip(zipUrl) {
  let response;
  try {
    response = await fetch(zipUrl, { signal: AbortSignal.timeout(3 * 60 * 1000) });
  } catch (error) {
    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new OcrError("ocrTimeout", "下载 MinerU 结果超时，请稍后重试。", error.message);
    }
    throw new OcrError("ocrNetwork", "无法下载 MinerU 结果，请检查网络后重试。", error && error.message);
  }
  if (!response.ok) throw new OcrError("ocrFailed", `下载 MinerU 结果失败（HTTP ${response.status}）。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 512 * 1024 * 1024) throw new OcrError("ocrMalformed", "MinerU 结果包过大，已停止处理。");
  return buffer;
}

function readZipEntries(data) {
  let eocd = -1;
  const stop = Math.max(0, data.length - 22 - 0xffff);
  for (let offset = data.length - 22; offset >= stop; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new OcrError("ocrMalformed", "MinerU 返回的结果不是有效的 ZIP 包。");
  const count = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (!count || count === 0xffff || centralOffset === 0xffffffff) {
    throw new OcrError("ocrMalformed", "MinerU 结果包格式暂不支持（ZIP64）。");
  }
  if (centralOffset + centralSize > eocd) throw new OcrError("ocrMalformed", "MinerU 结果包目录越界。");
  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new OcrError("ocrMalformed", "MinerU 结果包目录损坏。");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    if (flags & 0x0001) throw new OcrError("ocrMalformed", `MinerU 结果包包含加密条目：${name}`);
    if (![0, 8].includes(method)) throw new OcrError("ocrMalformed", `MinerU 结果包使用了不支持的压缩方式：${name}`);
    if (compressedSize === 0xffffffff || size === 0xffffffff) {
      throw new OcrError("ocrMalformed", `MinerU 结果包条目过大：${name}`);
    }
    if (localOffset + 30 + nameLength > centralOffset) throw new OcrError("ocrMalformed", "MinerU 结果包数据越界。");
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new OcrError("ocrMalformed", "MinerU 结果包本地目录损坏。");
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const localName = decoder.decode(data.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) throw new OcrError("ocrMalformed", "MinerU 结果包文件名不一致。");
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) throw new OcrError("ocrMalformed", "MinerU 结果包数据段越界。");
    const payload = data.subarray(dataOffset, dataOffset + compressedSize);
    entries.push({ name, method, payload, size });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractMineruMarkdown(zipBuffer) {
  const entries = readZipEntries(zipBuffer);
  const candidates = entries.filter((entry) => /(^|\/)full\.md$/i.test(entry.name) && entry.size <= 64 * 1024 * 1024);
  if (!candidates.length) throw new OcrError("ocrMalformed", "MinerU 返回的结果包里没有 full.md。");
  const entry = candidates.find((item) => !item.name.includes("/")) || candidates[0];
  const raw = entry.method === 8 ? zlib.inflateRawSync(entry.payload) : Buffer.from(entry.payload);
  if (raw.length !== entry.size) throw new OcrError("ocrMalformed", "MinerU 的 full.md 解压后大小不符。");
  return raw.toString("utf8");
}

function cleanMineruMarkdown(markdown) {
  let removed = 0;
  const cleaned = markdown.replace(/!\[([^\]]*)\]\((?:\.\/)?images?\/[^)]*\)/g, (match, alt) => {
    removed += 1;
    return String(alt || "").trim();
  });
  return { markdown: cleaned, removedImages: removed };
}

async function runMineru(options) {
  const { config, sourcePath, fileName, buffer, pageCount, progress, isCancelled } = options;
  if (!config.mineru.token) throw new OcrError("ocrNotConfigured", "请先配置 MinerU Token。");
  if (buffer.length > MINERU_MAX_BYTES) {
    throw new OcrError("ocrPageLimit", "文件超过 MinerU 的 200 MB 上限，无法使用云端解析。");
  }
  if (pageCount && pageCount > config.maxPages) {
    throw new OcrError(
      "ocrPageLimit",
      `这份文档有 ${pageCount} 页，超过当前 OCR 上限 ${config.maxPages} 页。请在设置里调高上限后重试。`,
    );
  }
  progress(12, "正在申请 MinerU 上传地址");
  const { batchId, fileUrl } = await applyMineruUpload(config, fileName);
  progress(20, "正在上传到 MinerU");
  await uploadToMineru(fileUrl, buffer, isCancelled);
  progress(28, "MinerU 正在排队解析");
  const zipUrl = await pollMineru(config, batchId, progress, isCancelled);
  progress(84, "正在下载 MinerU 结果");
  const zipBuffer = await downloadMineruZip(zipUrl);
  const raw = extractMineruMarkdown(zipBuffer);
  const cleaned = cleanMineruMarkdown(raw);
  const warnings = [];
  if (cleaned.removedImages > 0) {
    warnings.push(`云端 OCR 结果中的 ${cleaned.removedImages} 处图片未导出，已从 Markdown 中移除图片引用。`);
  }
  return { markdown: cleaned.markdown, warnings, provider: "mineru" };
}

async function testMineru(config) {
  if (!config.mineru.token) throw new OcrError("ocrNotConfigured", "请先填写 MinerU Token。");
  const probe = "00000000-0000-0000-0000-000000000000";
  const { response, body } = await fetchWithTimeout(
    `${MINERU_BASE_URL}/api/v4/extract-results/batch/${probe}`,
    { method: "GET", headers: { Accept: "*/*", Authorization: `Bearer ${config.mineru.token}` } },
    { timeoutMs: 20000 },
  );
  const code = body && body.code;
  if (String(code) === "A0202" || String(code) === "A0211" || response.status === 401 || response.status === 403) {
    throw providerCodeError("mineru", code, parseErrorMessage(code, body, "MinerU Token 无效或已过期。"));
  }
  return { ok: true, message: "MinerU Token 有效，接口可访问。" };
}

/* ---------- Baidu ---------- */

let baiduTokenCache = null;

function baiduCredentialHash(config) {
  return crypto
    .createHash("sha256")
    .update(`${config.baidu.apiKey}\0${config.baidu.secretKey}`)
    .digest("hex");
}

async function getBaiduToken(config, isCancelled) {
  if (isCancelled()) throw new OcrError("ocrCancelled", "已取消云端 OCR。");
  if (!config.baidu.apiKey || !config.baidu.secretKey) {
    throw new OcrError("ocrNotConfigured", "请先填写百度 OCR 的 API Key 与 Secret Key。");
  }
  const hash = baiduCredentialHash(config);
  if (baiduTokenCache && baiduTokenCache.hash === hash && baiduTokenCache.expiresAt > Date.now() + 60000) {
    return baiduTokenCache.accessToken;
  }
  const url = `${BAIDU_BASE_URL}/oauth/2.0/token?grant_type=client_credentials`
    + `&client_id=${encodeURIComponent(config.baidu.apiKey)}`
    + `&client_secret=${encodeURIComponent(config.baidu.secretKey)}`;
  const { response, body } = await fetchWithTimeout(url, { method: "POST" }, { timeoutMs: 30000 });
  if (!response.ok || !body || !body.access_token) {
    const code = body && (body.error_code || body.error);
    const message = parseErrorMessage(code, body, `获取百度 access_token 失败（HTTP ${response.status}）。`);
    if (["invalid_client", "unauthorized_client"].includes(String(code))) {
      throw new OcrError("ocrAuth", "百度 OCR 的 API Key 或 Secret Key 无效，请重新填写。", message);
    }
    throw providerCodeError("baidu", code, message);
  }
  const expiresIn = Number(body.expires_in);
  baiduTokenCache = {
    hash,
    accessToken: String(body.access_token),
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 2592000) * 1000,
  };
  return baiduTokenCache.accessToken;
}

function joinBaiduLines(lines) {
  let output = "";
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;
    if (!output) {
      output = line;
      continue;
    }
    const previous = output[output.length - 1];
    const next = line[0];
    if (/[\u4e00-\u9fff]/.test(previous) && /[\u4e00-\u9fff]/.test(next)) {
      output += line;
    } else if (output.endsWith("-") && /[a-z0-9]/i.test(next)) {
      output = `${output.slice(0, -1)}${line}`;
    } else {
      output += ` ${line}`;
    }
  }
  return output;
}

function baiduResultMarkdown(body) {
  const words = Array.isArray(body && body.words_result)
    ? body.words_result.map((item) => String((item && item.words) || "").trim())
    : [];
  const paragraphs = Array.isArray(body && body.paragraphs_result) ? body.paragraphs_result : [];
  if (!paragraphs.length) {
    return words.filter(Boolean).join("\n\n");
  }
  const blocks = [];
  for (const paragraph of paragraphs) {
    const indexes = Array.isArray(paragraph && paragraph.words_result_idx) ? paragraph.words_result_idx : [];
    const lines = indexes.map((index) => words[Number(index)]).filter(Boolean);
    const text = joinBaiduLines(lines);
    if (text) blocks.push(text);
  }
  return blocks.join("\n\n");
}

async function recognizeBaiduPage(jpeg, config, isCancelled) {
  const token = await getBaiduToken(config, isCancelled);
  if (isCancelled()) throw new OcrError("ocrCancelled", "已取消云端 OCR。");
  const form = new URLSearchParams();
  form.set("image", jpeg.toString("base64"));
  form.set("language_type", "CHN_ENG");
  form.set("detect_direction", "true");
  form.set("paragraph", "true");
  form.set("probability", "true");
  const { response, body } = await fetchWithTimeout(
    `${BAIDU_BASE_URL}/rest/2.0/ocr/v1/accurate_basic?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    { timeoutMs: 90000 },
  );
  if (!response.ok || !body) {
    throw new OcrError("ocrFailed", `百度 OCR 请求失败（HTTP ${response.status}）。`);
  }
  if (body.error_code !== undefined && body.error_code !== null) {
    const code = body.error_code;
    throw providerCodeError("baidu", code, parseErrorMessage(code, body, "百度 OCR 识别失败。"));
  }
  return baiduResultMarkdown(body);
}

let pdfiumLibraryPromise = null;

async function getPdfiumLibrary() {
  if (!pdfiumLibraryPromise) {
    pdfiumLibraryPromise = (async () => {
      const { PDFiumLibrary } = require("./vendor/pdfium/dist/index.cjs");
      return PDFiumLibrary.init();
    })().catch((error) => {
      pdfiumLibraryPromise = null;
      throw new OcrError("ocrEngine", "PDF 页面渲染组件加载失败，无法使用百度 OCR。", error && error.message);
    });
  }
  return pdfiumLibraryPromise;
}

async function renderPdfPage(buffer, pageIndex) {
  const jpeg = require("./vendor/jpeg-js");
  const library = await getPdfiumLibrary();
  let document;
  try {
    document = await library.loadDocument(buffer);
  } catch (error) {
    throw new OcrError("ocrMalformed", "无法渲染这份 PDF 的页面，请确认文件没有加密或损坏。", error && error.message);
  }
  try {
    if (pageIndex < 0 || pageIndex >= document.getPageCount()) {
      throw new OcrError("ocrMalformed", `PDF 页面索引超出范围：${pageIndex + 1}`);
    }
    const page = document.getPage(pageIndex);
    try {
      const size = page.getOriginalSize();
      const longest = Math.max(size.originalWidth, size.originalHeight) * RENDER_SCALE;
      const renderOptions = longest > BAIDU_MAX_EDGE
        ? { scale: BAIDU_MAX_EDGE / Math.max(size.originalWidth, size.originalHeight), render: "bitmap" }
        : { scale: RENDER_SCALE, render: "bitmap" };
      const image = await page.render(renderOptions);
      let quality = 85;
      let encoded = jpeg.encode({ data: Buffer.from(image.data), width: image.width, height: image.height }, quality);
      const tooLarge = () => encoded.data.toString("base64").length * 1.04 > BAIDU_MAX_REQUEST_BYTES;
      if (tooLarge() && quality > 65) {
        quality = 65;
        encoded = jpeg.encode({ data: Buffer.from(image.data), width: image.width, height: image.height }, quality);
      }
      if (tooLarge()) {
        throw new OcrError("ocrMalformed", "该页渲染后超过百度 OCR 的 10 MB 限制，请降低页数或换用 MinerU。");
      }
      return Buffer.from(encoded.data);
    } finally {
      page.close();
    }
  } finally {
    document.destroy();
  }
}

async function extractNativePages(buffer) {
  try {
    const inspector = require("./vendor/pdf-inspector");
    const result = await inspector.extractPagesMarkdownAsync(buffer);
    return Array.isArray(result && result.pages) ? result.pages : [];
  } catch (error) {
    logOcr("native page extraction failed:", error && error.message);
    return [];
  }
}

async function runBaidu(options) {
  const { config, buffer, pageCount, needsOcrIndexes, progress, isCancelled } = options;
  if (!config.baidu.apiKey || !config.baidu.secretKey) {
    throw new OcrError("ocrNotConfigured", "请先填写百度 OCR 的 API Key 与 Secret Key。");
  }
  let totalPages = pageCount;
  if (!totalPages) {
    const library = await getPdfiumLibrary();
    const document = await library.loadDocument(buffer);
    totalPages = document.getPageCount();
    document.destroy();
  }
  await getBaiduToken(config, isCancelled);
  const wanted = new Set((needsOcrIndexes || []).filter((index) => Number.isInteger(index) && index >= 0 && index < totalPages));
  const nativePages = await extractNativePages(buffer);
  const nativeByPage = new Map();
  for (const page of nativePages) {
    const index = Number(page && page.page);
    if (Number.isInteger(index)) nativeByPage.set(index, String((page && page.markdown) || ""));
  }
  const ocrPages = [];
  for (let index = 0; index < totalPages; index += 1) {
    const native = (nativeByPage.get(index) || "").trim();
    if (wanted.has(index) || !native) ocrPages.push(index);
  }
  if (!ocrPages.length) {
    return { markdown: nativePages.map((page) => String((page && page.markdown) || "")).join("\n\n"), warnings: [], provider: "baidu" };
  }
  if (ocrPages.length > config.maxPages) {
    throw new OcrError(
      "ocrPageLimit",
      `需要识别 ${ocrPages.length} 页，超过当前 OCR 上限 ${config.maxPages} 页。请在设置里调高上限后重试。`,
    );
  }
  const results = new Map();
  let done = 0;
  progress(30, `百度 OCR 准备识别 ${ocrPages.length} 页`);
  await mapLimit(ocrPages, BAIDU_CONCURRENCY, async (pageIndex) => {
    if (isCancelled()) throw new OcrError("ocrCancelled", "已取消云端 OCR。");
    const jpeg = await renderPdfPage(buffer, pageIndex);
    const text = await recognizeBaiduPage(jpeg, config, isCancelled);
    results.set(pageIndex, text);
    done += 1;
    progress(30 + Math.round((done / ocrPages.length) * 50), `百度 OCR 正在识别 ${done}/${ocrPages.length} 页`);
  });
  const blocks = [];
  const missing = [];
  for (let index = 0; index < totalPages; index += 1) {
    const text = results.has(index) ? results.get(index) : (nativeByPage.get(index) || "");
    if (String(text || "").trim()) blocks.push(String(text).trim());
    else missing.push(index + 1);
  }
  const warnings = [];
  if (missing.length) warnings.push(`第 ${missing.slice(0, 8).join("、")}${missing.length > 8 ? " 等" : ""} 页没有识别出文字。`);
  if (!nativePages.length && ocrPages.length < totalPages) {
    warnings.push("部分页面未能读取原生文本，已按扫描页处理。");
  }
  return { markdown: blocks.join("\n\n"), warnings, provider: "baidu" };
}

async function testBaidu(config) {
  await getBaiduToken(config, () => false);
  return { ok: true, message: "百度 OCR 凭据有效，access_token 获取成功。" };
}

async function testOcrConfig(config) {
  const provider = normalizeProvider(config.provider);
  if (!providerConfigured(config, provider)) {
    throw new OcrError("ocrNotConfigured", provider === "baidu" ? "请先填写百度 OCR 的 API Key 与 Secret Key。" : "请先填写 MinerU Token。");
  }
  return provider === "baidu" ? testBaidu(config) : testMineru(config);
}

async function runCloudOcr(options) {
  const provider = normalizeProvider(options.config.provider);
  if (provider === "baidu") return runBaidu(options);
  return runMineru(options);
}

module.exports = {
  DEFAULT_OCR_CONFIG,
  OcrError,
  normalizeOcrConfig,
  readOcrConfig,
  saveOcrConfig,
  publicOcrConfig,
  isOcrConfigured,
  testOcrConfig,
  runCloudOcr,
  baiduResultMarkdown,
  joinBaiduLines,
};
