"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { buildDocumentModel } = require("./markdown-model.cjs");
const { buildDocx } = require("./docx-writer.cjs");
const {
  OcrError,
  readOcrConfig,
  saveOcrConfig,
  normalizeOcrConfig,
  publicOcrConfig,
  isOcrConfigured,
  testOcrConfig,
  runCloudOcr,
} = require("./ocr.cjs");

const PLUGIN_ID = "com.gongjin.doclite";
const PLUGIN_VERSION = "0.1.14";
const ANYDOC_VERSION = "0.2.4";
const PDF_INSPECTOR_VERSION = "1.17.0";

const DATA_DIR = process.env.DBX_PLUGIN_DATA_DIR
  ? path.resolve(process.env.DBX_PLUGIN_DATA_DIR)
  : path.resolve(process.cwd(), ".dbx-dev-data");
const OUTPUT_DIR = path.join(DATA_DIR, "output");
const TEMP_DIR = path.join(DATA_DIR, "temp");
const PICKER_EXE = process.env.DBX_PICKER_EXE
  ? path.resolve(process.env.DBX_PICKER_EXE)
  : path.resolve(__dirname, "..", "bin", "windows-x64", "dbx-doclite-picker.exe");

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_WORD_BYTES = 6 * 1024 * 1024;
const WORD_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SCAN_FILES = 2000;
const MAX_SCAN_DEPTH = 8;
const MAX_JOBS = 32;
const TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const SUPPORTED_EXTENSIONS = new Set([
  "doc", "docx", "docm", "pdf", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
  "xls", "xlsx", "xlsm", "xlsb", "csv", "md", "markdown", "txt",
  "odt", "ods", "odp", "rtf", "epub",
]);

const jobs = new Map();
const pickers = new Map();
let nativeAnydoc;
let nativePdfInspector;
let shuttingDown = false;

function log(...args) {
  process.stderr.write(`[doclite] ${args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ")}\n`);
}

function writeMessage(message) {
  if (process.stdout.destroyed) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emit(method, params) {
  writeMessage({ jsonrpc: "2.0", method, params });
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function badParams(message) {
  return new RpcError(-32602, message, { code: "badRequest", message });
}

function resolveCustomDir(raw) {
  const dir = String(raw || "").trim();
  if (!dir) throw badParams("请先设置保存目录。");
  if (dir.includes("\0")) throw badParams("保存目录包含无效字符。");
  if (!path.isAbsolute(dir)) throw badParams("保存目录需要是绝对路径，例如 D:\\文档\\转换结果。");
  return path.resolve(dir);
}

function resolveInputDir(raw) {
  const dir = String(raw || "").trim();
  if (!dir) throw badParams("缺少文件夹路径。");
  if (dir.includes("\0")) throw badParams("文件夹路径包含无效字符。");
  if (!path.isAbsolute(dir)) throw badParams("文件夹需要是绝对路径。");
  const resolved = path.resolve(dir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw badParams("文件夹不存在或无法访问。");
  }
  if (!stat.isDirectory()) throw badParams("所选路径不是文件夹。");
  return resolved;
}

function scanInputFolder(root) {
  const files = [];
  let skipped = 0;
  let truncated = false;
  const walk = (dir, depth, prefix) => {
    if (files.length >= MAX_SCAN_FILES) {
      truncated = true;
      return;
    }
    if (depth >= MAX_SCAN_DEPTH) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, depth + 1, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = (entry.name.split(".").pop() || "").toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        skipped += 1;
        continue;
      }
      let size;
      try {
        size = fs.statSync(absolute).size;
      } catch {
        continue;
      }
      files.push({ name: entry.name, path: absolute, relativePath: relative, ext: extension, size });
    }
  };
  walk(root, 0, "");
  return { files, skipped, truncated };
}

function ensureOutputDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new RpcError(-32000, `无法创建保存目录：${dir}`, {
      code: "io",
      detail: String((error && error.message) || error),
    });
  }
}

function cleanupPicker(token, entry) {
  pickers.delete(token);
  try {
    if (entry && entry.child && entry.child.exitCode === null) entry.child.kill();
  } catch {
    /* the picker already exited */
  }
  try {
    fs.rmSync(entry.workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function cleanupAllPickers() {
  for (const token of [...pickers.keys()]) {
    cleanupPicker(token, pickers.get(token));
  }
}

function nowIsoDate() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function sanitizeBaseName(name) {
  const withoutExtension = String(name || "").replace(/\.[^.]+$/, "");
  const safe = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return safe || "document";
}

function outputBaseName(job) {
  const base = sanitizeBaseName(job.name);
  if (job.options.naming === "dated") return `${base}-${nowIsoDate()}`;
  if (job.options.naming === "indexed") {
    const index = Math.max(1, Number(job.options.index) || 1);
    return `doc-${String(index).padStart(3, "0")}`;
  }
  return base;
}

function normalizeMarkdown(markdown) {
  return `${String(markdown)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()}\n`;
}

function requireAnydoc() {
  const engine = loadAnydoc();
  if (!engine) {
    const error = new Error("Conversion engine is unavailable.");
    error.code = "engineUnavailable";
    throw error;
  }
  return engine;
}

function loadAnydoc() {
  if (nativeAnydoc !== undefined) return nativeAnydoc;
  try {
    nativeAnydoc = require("./vendor/anydoc/anydoc.js");
  } catch (error) {
    nativeAnydoc = null;
    log("failed to load anydoc:", error && error.message);
  }
  return nativeAnydoc;
}

function loadPdfInspector() {
  if (nativePdfInspector !== undefined) return nativePdfInspector;
  try {
    nativePdfInspector = require("./vendor/pdf-inspector/index.js");
  } catch (error) {
    nativePdfInspector = null;
    log("failed to load pdf-inspector:", error && error.message);
  }
  return nativePdfInspector;
}

function ensureDirectories() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function removeIfOld(target, cutoff) {
  try {
    const stat = fs.statSync(target);
    if (stat.mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

function sweepOldFiles() {
  try {
    const now = Date.now();
    for (const entry of fs.readdirSync(TEMP_DIR, { withFileTypes: true })) {
      removeIfOld(path.join(TEMP_DIR, entry.name), now - TEMP_RETENTION_MS);
    }
    for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
      removeIfOld(path.join(OUTPUT_DIR, entry.name), now - OUTPUT_RETENTION_MS);
    }
  } catch (error) {
    log("cleanup failed:", error && error.message);
  }
}

function evictOldJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const candidates = [...jobs.values()]
    .filter((job) => job.status !== "uploading" && job.status !== "running")
    .sort((left, right) => left.createdAt - right.createdAt);
  while (jobs.size > MAX_JOBS && candidates.length) {
    const job = candidates.shift();
    discardJob(job);
  }
}

function discardJob(job) {
  if (!job) return;
  jobs.delete(job.id);
  try {
    fs.rmSync(job.tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function emitProgress(job, progress, stage) {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  job.progress = value;
  job.stage = stage;
  emit("doc/progress", { jobId: job.id, progress: value, stage });
}

function startProgressCreep(job, from, to, stage) {
  emitProgress(job, from, stage);
  const timer = setInterval(() => {
    if (job.cancelRequested || job.progress >= to) return;
    emitProgress(job, job.progress + 1, stage);
  }, 900);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

function needsOcrError(pageCount, pages) {
  const error = new Error("This document needs OCR.");
  error.code = "needsOcr";
  error.pageCount = pageCount || null;
  error.pages = Array.isArray(pages) ? pages : [];
  return error;
}

function mapConversionError(error) {
  const code = error && typeof error.code === "string" ? error.code : "internal";
  const pages = Array.isArray(error && error.pages) ? error.pages.filter((page) => Number.isInteger(page)) : [];
  const pageCount = Number.isInteger(error && error.pageCount) ? error.pageCount : null;
  let message;
  switch (code) {
    case "needsOcr":
      message = pages.length
        ? `这份 PDF 有 ${pages.length} 页是扫描或图片内容，需要 OCR 才能转换。`
        : "这份 PDF 是扫描件或图片型文档，需要 OCR 才能转换。";
      break;
    case "ocrNotConfigured":
      message = "请先启用并配置云端 OCR，再重新转换这份扫描件。";
      break;
    case "ocrAuth":
      message = "云端 OCR 凭据无效或已过期，请在设置中重新填写。";
      break;
    case "ocrQuota":
      message = "云端 OCR 请求额度或并发已超限，请稍后重试。";
      break;
    case "ocrTimeout":
      message = "云端 OCR 处理超时，请稍后重试。";
      break;
    case "ocrNetwork":
      message = "无法连接云端 OCR 服务，请检查网络后重试。";
      break;
    case "ocrMalformed":
      message = "云端 OCR 返回的结果无法解析，请重试或换一份文件。";
      break;
    case "ocrEngine":
      message = "PDF 页面渲染组件不可用，无法使用百度 OCR。";
      break;
    case "ocrPageLimit":
    case "ocrFailed":
      message = String((error && error.message) || "云端 OCR 处理失败，请稍后重试。");
      break;
    case "encrypted":
      message = "文件已加密，需要密码才能读取。";
      break;
    case "unsupported":
      message = "暂不支持此文件格式，或文件扩展名与实际内容不符。";
      break;
    case "malformed":
      message = "文档结构无法解析，或没有可提取的内容。";
      break;
    case "resourceLimit":
      message = "文档超出了转换引擎的安全限制（体积、嵌套层级或节点数量）。";
      break;
    case "engineUnavailable":
      message = "转换引擎加载失败，请重新安装插件后再试。";
      break;
    case "missingPart":
      message = "文档缺少必要内容，可能已经损坏。";
      break;
    case "io":
      message = "无法读取文件，请重新添加后再试。";
      break;
    default:
      message = "转换引擎出错，请重试或换一份文件。";
  }
  return {
    code: ["needsOcr", "encrypted", "unsupported", "malformed", "resourceLimit", "missingPart", "io", "engineUnavailable",
      "ocrNotConfigured", "ocrAuth", "ocrQuota", "ocrTimeout", "ocrNetwork", "ocrMalformed", "ocrEngine", "ocrPageLimit", "ocrFailed"].includes(code) ? code : "internal",
    message,
    detail: String((error && error.message) || error || "").slice(0, 600),
    pages,
    pageCount,
  };
}

const OCR_RETRY_CODES = new Set([
  "needsOcr", "ocrNotConfigured", "ocrAuth", "ocrQuota", "ocrTimeout",
  "ocrNetwork", "ocrMalformed", "ocrEngine", "ocrPageLimit", "ocrFailed",
]);

function keepsSourceForRetry(job) {
  if (job.status === "needsOcr") return true;
  return job.status === "error" && OCR_RETRY_CODES.has(job.error && job.error.code);
}

function asRpcError(error, fallbackMessage) {
  if (error instanceof RpcError) return error;
  if (error instanceof OcrError) {
    return new RpcError(-32000, error.message || fallbackMessage, { code: error.code, detail: error.detail || "" });
  }
  return new RpcError(-32000, fallbackMessage, { code: "internal", detail: String((error && error.message) || error) });
}

async function inspectPdf(job, buffer) {
  const inspector = loadPdfInspector();
  if (!inspector) {
    return {
      pageCount: null,
      warnings: ["PDF 检查组件未加载，已跳过扫描件检测。"],
      pdfType: "Unknown",
      needsOcrPages: [],
      needsOcrIndexes: [],
    };
  }
  const warnings = [];
  let classification;
  try {
    classification = await inspector.classifyPdfAsync(buffer);
  } catch (error) {
    log("pdf classification failed:", error && error.message);
    return { pageCount: null, warnings, pdfType: "Unknown", needsOcrPages: [], needsOcrIndexes: [] };
  }
  const pageCount = Number(classification && classification.pageCount) || null;
  const confidence = Number(classification && classification.confidence);
  if (Number.isFinite(confidence) && confidence > 0 && confidence < 0.72) {
    warnings.push("PDF 文本层置信度较低，建议核对转换结果。");
  }
  const pdfType = String((classification && classification.pdfType) || "");
  const needsOcrIndexes = Array.isArray(classification && classification.pagesNeedingOcr)
    ? classification.pagesNeedingOcr.map((page) => Number(page)).filter((page) => Number.isInteger(page) && page >= 0)
    : [];
  const scanned = ["Mixed", "Scanned", "ImageBased"].includes(pdfType);
  const needsOcrPages = needsOcrIndexes.map((page) => page + 1);
  return { pageCount, warnings, pdfType, needsOcrPages, needsOcrIndexes, scanned };
}

function writeUniquePair(targetDir, base, contents) {
  const entries = Object.entries(contents).filter(([, content]) => content !== null && content !== undefined);
  for (let sequence = 1; sequence <= 500; sequence += 1) {
    const candidateBase = sequence === 1 ? base : `${base}-${sequence}`;
    const written = [];
    let conflict = false;
    for (const [extension, content] of entries) {
      const filePath = path.join(targetDir, `${candidateBase}.${extension}`);
      try {
        fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "wx" });
        written.push({ extension, name: `${candidateBase}.${extension}`, path: filePath, size: Buffer.byteLength(content, "utf8") });
      } catch (error) {
        if (error && error.code === "EEXIST") {
          conflict = true;
          break;
        }
        for (const file of written) {
          try {
            fs.rmSync(file.path, { force: true });
          } catch {
            /* best effort */
          }
        }
        throw error;
      }
    }
    if (!conflict) return written;
    for (const file of written) {
      try {
        fs.rmSync(file.path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
  throw new Error("Could not allocate a unique output file name.");
}

async function runConversion(job) {
  const startedAt = Date.now();
  let stopCreep = () => {};
  try {
    job.status = "running";
    emitProgress(job, 32, "正在识别文档格式");
    let markdown = "";
    let pageCount = null;
    const warnings = [];

    if (TEXT_EXTENSIONS.has(job.extension)) {
      stopCreep = startProgressCreep(job, 40, 55, "正在读取文本");
      markdown = await fsp.readFile(job.sourcePath, "utf8");
    } else if (PDF_EXTENSIONS.has(job.extension)) {
      const buffer = await fsp.readFile(job.sourcePath);
      stopCreep = startProgressCreep(job, 40, 48, "正在分析 PDF 页面");
      const inspection = await inspectPdf(job, buffer);
      pageCount = inspection.pageCount;
      warnings.push(...inspection.warnings);
      stopCreep();
      const needsCloudOcr = inspection.scanned || inspection.needsOcrIndexes.length > 0;
      if (needsCloudOcr) {
        const ocrConfig = readOcrConfig(DATA_DIR);
        if (!ocrConfig.enabled || !isOcrConfigured(ocrConfig)) {
          throw needsOcrError(pageCount, inspection.needsOcrPages);
        }
        const providerLabel = ocrConfig.provider === "baidu" ? "百度 OCR" : "MinerU";
        const ocrIndexes = inspection.needsOcrIndexes.length
          ? inspection.needsOcrIndexes
          : Array.from({ length: pageCount || 0 }, (_, index) => index);
        emitProgress(job, 30, `正在调用${providerLabel}`);
        const ocrResult = await runCloudOcr({
          config: ocrConfig,
          sourcePath: job.sourcePath,
          fileName: job.name,
          buffer,
          pageCount,
          needsOcrIndexes: ocrIndexes,
          progress: (progress, stage) => {
            if (job.cancelRequested) return;
            emitProgress(job, progress, stage);
          },
          isCancelled: () => Boolean(job.cancelRequested),
        });
        if (job.cancelRequested) {
          finishCancelled(job);
          return;
        }
        markdown = ocrResult.markdown;
        warnings.push(...ocrResult.warnings);
        warnings.push(`已通过${ocrResult.provider === "baidu" ? "百度 OCR" : "MinerU"}识别扫描页。`);
      } else {
        stopCreep = startProgressCreep(job, 50, 82, "正在提取 PDF 文本");
        markdown = await requireAnydoc().toMarkdown(job.sourcePath);
      }
    } else {
      stopCreep = startProgressCreep(job, 40, 82, "正在转换文档");
      markdown = await requireAnydoc().toMarkdown(job.sourcePath);
    }
    stopCreep();

    if (job.cancelRequested) {
      finishCancelled(job);
      return;
    }

    markdown = normalizeMarkdown(markdown || "");
    if (!markdown.trim()) {
      const error = new Error("No extractable text.");
      error.code = "malformed";
      throw error;
    }

    emitProgress(job, 84, "正在生成结构化模型");
    const model = buildDocumentModel(markdown, {
      name: job.name,
      ext: job.extension,
      size: job.size,
      pages: pageCount,
    }, { warnings, engineVersion: ANYDOC_VERSION });

    if (job.cancelRequested) {
      finishCancelled(job);
      return;
    }

    emitProgress(job, 92, "正在写入结果");
    const previewMarkdownPath = path.join(job.tempDir, "preview.md");
    const previewModelPath = path.join(job.tempDir, "preview.json");
    const modelText = `${JSON.stringify(model, null, 2)}\n`;
    fs.writeFileSync(previewMarkdownPath, markdown, "utf8");
    fs.writeFileSync(previewModelPath, modelText, "utf8");

    const formats = job.options.formats || {};
    const outputs = {};
    const base = outputBaseName(job);
    const targetDir = job.options.location === "custom" ? job.options.outputDir : OUTPUT_DIR;
    if (job.options.location === "custom") ensureOutputDir(targetDir);
    if (job.options.location !== "ask" && (formats.markdown || formats.json)) {
      const written = writeUniquePair(targetDir, base, {
        md: formats.markdown ? markdown : null,
        json: formats.json ? modelText : null,
      });
      for (const file of written) {
        if (file.extension === "md") outputs.markdown = { name: file.name, size: file.size };
        if (file.extension === "json") outputs.json = { name: file.name, size: file.size };
      }
    }

    job.status = "done";
    job.result = {
      jobId: job.id,
      source: {
        name: job.name,
        format: String(job.extension || "").toUpperCase(),
        size: job.size,
        pages: pageCount,
      },
      stats: model.stats,
      warnings,
      outputs,
      outputDir: targetDir,
      names: {
        markdown: formats.markdown ? `${base}.md` : null,
        json: formats.json ? `${base}.json` : null,
      },
      preview: {
        markdownSize: Buffer.byteLength(markdown, "utf8"),
        modelSize: Buffer.byteLength(modelText, "utf8"),
      },
      durationMs: Date.now() - startedAt,
    };
    job.outputPaths = {
      preview: previewMarkdownPath,
      model: previewModelPath,
      markdown: outputs.markdown ? path.join(targetDir, outputs.markdown.name) : null,
      json: outputs.json ? path.join(targetDir, outputs.json.name) : null,
    };
    emitProgress(job, 100, "转换完成");
    emit("doc/done", job.result);
  } catch (error) {
    stopCreep();
    if (job.cancelRequested) {
      finishCancelled(job);
      return;
    }
    const mapped = mapConversionError(error);
    job.status = mapped.code === "needsOcr" ? "needsOcr" : "error";
    job.error = mapped;
    if (mapped.code === "internal") log("conversion failed:", (error && error.stack) || error);
    emit("doc/error", { jobId: job.id, ...mapped, durationMs: Date.now() - startedAt });
  } finally {
    stopCreep();
    const keepForRetry = keepsSourceForRetry(job);
    // Keep the uploaded PDF while it waits for OCR so the user can retry without re-uploading.
    if (!job.externalSource && !keepForRetry) {
      try {
        fs.rmSync(job.sourcePath, { force: true });
      } catch {
        /* best effort */
      }
    }
    if (job.status !== "done" && !keepForRetry) {
      try {
        fs.rmSync(job.tempDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    evictOldJobs();
  }
}

function finishCancelled(job) {
  job.status = "cancelled";
  try {
    fs.rmSync(job.tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  emit("doc/cancelled", { jobId: job.id });
}

function getJob(id) {
  const job = typeof id === "string" ? jobs.get(id) : null;
  if (!job) throw badParams("转换任务不存在或已过期。");
  return job;
}

async function readChunk(filePath, offset, length) {
  if (!filePath) throw badParams("该任务没有可读取的输出文件。");
  const stat = await fsp.stat(filePath);
  const start = Math.max(0, Math.min(Number(offset) || 0, stat.size));
  const requested = Number(length) || MAX_READ_BYTES;
  const size = Math.max(0, Math.min(requested, MAX_READ_BYTES, stat.size - start));
  const buffer = Buffer.alloc(size);
  if (size > 0) {
    const handle = await fsp.open(filePath, "r");
    try {
      await handle.read(buffer, 0, size, start);
    } finally {
      await handle.close();
    }
  }
  return {
    dataBase64: buffer.toString("base64"),
    length: size,
    offset: start,
    eof: start + size >= stat.size,
    size: stat.size,
  };
}

function wordDocxPath(fileId) {
  if (!WORD_FILE_ID.test(fileId)) throw badParams("无效的 Word 文件标识。");
  return path.join(TEMP_DIR, `word-${fileId}.docx`);
}

function wordMarkdownPath(fileId) {
  if (!WORD_FILE_ID.test(fileId)) throw badParams("无效的 Word 文件标识。");
  return path.join(TEMP_DIR, `word-${fileId}.md`);
}

function wordDocxName(title) {
  const safe = String(title).replace(/[\\/:*?"<>|\r\n]+/g, "-").trim().slice(0, 80) || "文档";
  return `${safe}.docx`;
}

// The dictionary export and the converted-document export share one pipeline:
// the UI uploads Markdown, the sidecar builds the .docx and hands the bytes back.
const WORD_LABELS = {
  dictionary: {
    empty: "数据字典内容为空，请先生成数据字典。",
    tooLarge: "数据字典过大，请减少导出的表后重试。",
    expired: "上传的数据字典已过期，请重试。",
    fallbackTitle: "数据字典",
  },
  document: {
    empty: "文档内容为空，请先完成转换。",
    tooLarge: "文档内容过大，请拆分后再试。",
    expired: "上传的文档已过期，请重试。",
    fallbackTitle: "文档",
  },
};

function beginWordDocx(params, label) {
  const size = Number(params && params.size) || 0;
  if (!(size > 0)) throw badParams(label.empty);
  if (size > MAX_WORD_BYTES) throw badParams(label.tooLarge);
  ensureDirectories();
  const fileId = crypto.randomUUID();
  fs.writeFileSync(wordMarkdownPath(fileId), Buffer.alloc(0));
  return { fileId, maxBytes: MAX_WORD_BYTES };
}

function chunkWordDocx(params, label) {
  const fileId = String((params && params.fileId) || "");
  const filePath = wordMarkdownPath(fileId);
  const data = typeof (params && params.dataBase64) === "string" ? Buffer.from(params.dataBase64, "base64") : null;
  if (!data || !data.length) throw badParams("缺少数据块。");
  const offset = Number(params && params.offset) || 0;
  let currentSize;
  try {
    currentSize = fs.statSync(filePath).size;
  } catch {
    throw badParams(label.expired);
  }
  if (offset !== currentSize) throw badParams("数据块顺序不正确，请重试。");
  if (currentSize + data.length > MAX_WORD_BYTES) throw badParams(label.tooLarge);
  fs.appendFileSync(filePath, data);
  return { offset: currentSize + data.length, size: currentSize + data.length };
}

function writeUniqueFile(targetDir, name, buffer) {
  const extension = path.extname(name);
  const base = extension ? name.slice(0, name.length - extension.length) : name;
  for (let sequence = 1; sequence <= 500; sequence += 1) {
    const candidate = sequence === 1 ? name : `${base}-${sequence}${extension}`;
    const filePath = path.join(targetDir, candidate);
    try {
      fs.writeFileSync(filePath, buffer, { flag: "wx" });
      return { name: candidate, path: filePath };
    } catch (error) {
      if (error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new RpcError(-32000, "目标目录中同名文件过多，请换一个目录保存。", { code: "io" });
}

function commitWordDocx(params, label) {
  const fileId = String((params && params.fileId) || "");
  const markdownPath = wordMarkdownPath(fileId);
  let markdown;
  try {
    markdown = fs.readFileSync(markdownPath, "utf8");
  } catch {
    throw badParams(label.expired);
  }
  if (!markdown.trim()) throw badParams(label.empty);
  const title = String((params && params.title) || label.fallbackTitle).slice(0, 120);
  let buffer;
  try {
    buffer = buildDocx(markdown, { title, emptyMessage: label.empty });
  } catch (error) {
    throw asRpcError(error, "生成 Word 失败。");
  }
  const name = wordDocxName(title);
  const outputDir = String((params && params.outputDir) || "").trim();
  let written = null;
  if (outputDir) {
    const dir = resolveCustomDir(outputDir);
    ensureOutputDir(dir);
    try {
      written = writeUniqueFile(dir, name, buffer);
    } catch (error) {
      throw new RpcError(-32000, `无法写入保存目录：${dir}`, {
        code: "io",
        detail: String((error && error.message) || error),
      });
    }
  } else {
    fs.writeFileSync(wordDocxPath(fileId), buffer);
  }
  try {
    fs.rmSync(markdownPath, { force: true });
  } catch {
    /* best effort */
  }
  return {
    fileId,
    size: buffer.length,
    name: written ? written.name : name,
    path: written ? written.path : null,
  };
}

function readWordDocx(fileId) {
  const filePath = wordDocxPath(fileId);
  if (!fs.existsSync(filePath)) throw badParams("Word 文件已过期，请重新保存。");
  return filePath;
}

function discardWordDocx(fileId) {
  try {
    fs.rmSync(wordDocxPath(fileId), { force: true });
    fs.rmSync(wordMarkdownPath(fileId), { force: true });
  } catch {
    /* already gone */
  }
  return { discarded: true };
}

async function handle(method, params) {
  switch (method) {
    case "plugin/initialize":
      return {
        protocolVersion: 1,
        capabilities: [],
        plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
      };

    case "plugin/shutdown":
      cleanupAllPickers();
      return { ok: true };

    case "doc/status":
      return {
        ready: Boolean(loadAnydoc()),
        engine: {
          anydoc: ANYDOC_VERSION,
          pdfInspector: PDF_INSPECTOR_VERSION,
          anydocLoaded: Boolean(loadAnydoc()),
          pdfInspectorLoaded: Boolean(loadPdfInspector()),
        },
        outputDir: OUTPUT_DIR,
        limits: { maxFileBytes: MAX_FILE_BYTES, maxReadBytes: MAX_READ_BYTES },
        supportedExtensions: [...SUPPORTED_EXTENSIONS],
        ocr: publicOcrConfig(readOcrConfig(DATA_DIR)),
      };

    case "doc/begin": {
      const name = String((params && params.name) || "").trim();
      const rawSource = params && typeof params.sourcePath === "string" ? params.sourcePath.trim() : "";
      let size = Number(params && params.size);
      let displayName = name;
      let externalSource = "";
      if (rawSource) {
        if (rawSource.includes("\0") || !path.isAbsolute(rawSource)) throw badParams("文件路径需要是绝对路径。");
        const resolved = path.resolve(rawSource);
        let stat;
        try {
          stat = fs.statSync(resolved);
        } catch {
          throw badParams("文件已不存在或无法访问。");
        }
        if (!stat.isFile()) throw badParams("所选路径不是文件。");
        displayName = path.basename(resolved);
        size = stat.size;
        externalSource = resolved;
      }
      if (!displayName) throw badParams("缺少文件名。");
      if (!Number.isFinite(size) || size < 0) throw badParams("缺少文件大小。");
      if (size > MAX_FILE_BYTES) {
        throw new RpcError(-32602, `单个文件不能超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB。`, { code: "tooLarge", maxFileBytes: MAX_FILE_BYTES });
      }
      const extension = (displayName.split(".").pop() || "").toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new RpcError(-32602, `不支持的文件类型：.${extension || "未知"}`, { code: "unsupported" });
      }
      const id = crypto.randomUUID();
      const tempDir = path.join(TEMP_DIR, id);
      fs.mkdirSync(tempDir, { recursive: true });
      const sourcePath = externalSource || path.join(tempDir, `source.${extension}`);
      if (!externalSource) fs.writeFileSync(sourcePath, Buffer.alloc(0));
      const job = {
        id,
        name: displayName,
        extension,
        size,
        sourcePath,
        externalSource: Boolean(externalSource),
        tempDir,
        received: externalSource ? size : 0,
        status: "uploading",
        cancelRequested: false,
        progress: 0,
        stage: externalSource ? "正在准备文件" : "正在接收文件",
        createdAt: Date.now(),
        options: { formats: { markdown: true, json: true }, naming: "original", index: 1 },
        outputPaths: {},
        result: null,
      };
      jobs.set(id, job);
      emitProgress(job, externalSource ? 30 : 0, job.stage);
      return { jobId: id, maxFileBytes: MAX_FILE_BYTES };
    }

    case "doc/chunk": {
      const job = getJob(params && params.jobId);
      if (job.externalSource) throw badParams("该任务直接读取原文件，不能再接收文件数据。");
      if (job.status !== "uploading") throw badParams("该任务当前不接受文件数据。");
      const offset = Number(params && params.offset);
      if (!Number.isInteger(offset) || offset !== job.received) throw badParams("文件分块顺序不正确，请重试。");
      let chunk;
      try {
        chunk = Buffer.from(String((params && params.dataBase64) || ""), "base64");
      } catch {
        throw badParams("文件分块数据无效，请重试。");
      }
      if (job.received + chunk.length > Math.max(job.size, 0) + 1024 * 1024) throw badParams("文件分块超出了声明的大小。");
      fs.appendFileSync(job.sourcePath, chunk);
      job.received += chunk.length;
      return { received: job.received, size: job.size };
    }

    case "doc/commit": {
      const job = getJob(params && params.jobId);
      if (job.status !== "uploading") throw badParams("该任务当前不能开始转换。");
      if (!job.externalSource && job.size && job.received !== job.size) throw badParams(`文件大小不一致：应为 ${job.size} 字节，实际收到 ${job.received} 字节。`);
      const options = (params && params.options) || {};
      const formats = options.formats || {};
      const location = options.location === "ask" || options.location === "custom" ? options.location : "plugin";
      job.options = {
        formats: { markdown: formats.markdown !== false, json: formats.json !== false },
        naming: ["original", "dated", "indexed"].includes(options.naming) ? options.naming : "original",
        location,
        outputDir: location === "custom" ? resolveCustomDir(options.outputDir) : "",
        index: Math.max(1, Number(options.index) || 1),
      };
      if (!job.options.formats.markdown && !job.options.formats.json) throw badParams("至少需要选择一种输出格式。");
      void runConversion(job);
      return { jobId: job.id, accepted: true };
    }

    case "doc/cancel": {
      const job = getJob(params && params.jobId);
      job.cancelRequested = true;
      if (job.status === "uploading") {
        finishCancelled(job);
        return { cancelled: true };
      }
      if (job.status === "running") return { cancelled: false, cancelling: true };
      return { cancelled: job.status === "cancelled" };
    }

    case "doc/readOutput": {
      const job = getJob(params && params.jobId);
      const kind = String((params && params.kind) || "");
      const filePath = kind === "preview" ? job.outputPaths.preview
        : kind === "markdown" ? job.outputPaths.markdown
        : kind === "json" ? job.outputPaths.model
        : null;
      if (!filePath) throw badParams(`未知的输出类型：${kind}`);
      return readChunk(filePath, params && params.offset, params && params.length);
    }

    case "doc/dictionaryDocxBegin":
      return beginWordDocx(params, WORD_LABELS.dictionary);

    case "doc/dictionaryDocxChunk":
      return chunkWordDocx(params, WORD_LABELS.dictionary);

    case "doc/dictionaryDocxCommit":
      return commitWordDocx(params, WORD_LABELS.dictionary);

    case "doc/readDictionaryDocx":
      return readChunk(readWordDocx(String((params && params.fileId) || "")), params && params.offset, params && params.length);

    case "doc/discardDictionaryDocx":
      return discardWordDocx(String((params && params.fileId) || ""));

    case "doc/wordBegin":
      return beginWordDocx(params, WORD_LABELS.document);

    case "doc/wordChunk":
      return chunkWordDocx(params, WORD_LABELS.document);

    case "doc/wordCommit":
      return commitWordDocx(params, WORD_LABELS.document);

    case "doc/readWord":
      return readChunk(readWordDocx(String((params && params.fileId) || "")), params && params.offset, params && params.length);

    case "doc/discardWord":
      return discardWordDocx(String((params && params.fileId) || ""));

    case "doc/discard": {
      const job = getJob(params && params.jobId);
      if (job.status === "running") throw badParams("转换进行中，暂时不能移除该任务。");
      discardJob(job);
      return { discarded: true };
    }

    case "doc/ocrConfig":
      return { config: publicOcrConfig(readOcrConfig(DATA_DIR)) };

    case "doc/setOcrConfig": {
      try {
        const saved = saveOcrConfig(DATA_DIR, (params && params.config) || params || {});
        return { config: publicOcrConfig(saved) };
      } catch (error) {
        throw asRpcError(error, "无法保存 OCR 设置。");
      }
    }

    case "doc/testOcr": {
      const previous = readOcrConfig(DATA_DIR);
      const draft = normalizeOcrConfig((params && params.config) || {}, previous);
      try {
        const result = await testOcrConfig(draft);
        return { ok: Boolean(result && result.ok), message: String((result && result.message) || ""), config: publicOcrConfig(draft) };
      } catch (error) {
        throw asRpcError(error, "无法连接 OCR 服务。");
      }
    }

    case "doc/retryOcr": {
      const job = getJob(params && params.jobId);
      const retryable = job.status === "needsOcr"
        || (job.status === "error" && OCR_RETRY_CODES.has(job.error && job.error.code));
      if (!retryable) throw badParams("该任务当前不需要 OCR 重试。");
      if (!fs.existsSync(job.sourcePath)) {
        throw new RpcError(-32000, "原始文件已清理，请重新添加这份文件。", { code: "needsUpload" });
      }
      const ocrConfig = readOcrConfig(DATA_DIR);
      if (!ocrConfig.enabled || !isOcrConfigured(ocrConfig)) {
        throw new RpcError(-32602, "请先在设置中启用并配置云端 OCR。", { code: "ocrNotConfigured" });
      }
      job.status = "running";
      job.cancelRequested = false;
      job.error = null;
      job.result = null;
      job.outputPaths = {};
      emitProgress(job, 0, "正在重新转换");
      void runConversion(job);
      return { jobId: job.id, accepted: true };
    }

    case "doc/checkOutputDir": {
      const dir = resolveCustomDir(params && params.dir);
      const exists = fs.existsSync(dir);
      let writable = false;
      if (exists) {
        try {
          fs.accessSync(dir, fs.constants.W_OK);
          writable = true;
        } catch {
          writable = false;
        }
      }
      return { path: dir, exists, writable };
    }

    case "doc/reveal": {
      ensureDirectories();
      const requested = String((params && params.dir) || "").trim();
      const target = requested ? resolveCustomDir(requested) : OUTPUT_DIR;
      if (requested) ensureOutputDir(target);
      try {
        if (process.platform === "win32") {
          spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: false }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
        } else {
          spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
        }
        return { opened: true, path: target };
      } catch (error) {
        throw new RpcError(-32000, "无法打开输出目录。", { code: "revealFailed", detail: String(error && error.message) });
      }
    }

    case "doc/scanFolder": {
      const dir = resolveInputDir(params && params.dir);
      const scan = scanInputFolder(dir);
      return { dir, files: scan.files, skipped: scan.skipped, truncated: scan.truncated };
    }

    case "doc/pickOutputDir":
    case "doc/pickFolder": {
      if (process.platform !== "win32") {
        throw new RpcError(-32000, "当前系统暂不支持图形化选择目录，请直接把文件夹拖进来。", { code: "unsupported" });
      }
      if (!fs.existsSync(PICKER_EXE)) {
        throw new RpcError(-32000, "目录选择器不可用，请直接把文件夹拖进来。", { code: "pickerMissing" });
      }
      const token = crypto.randomUUID();
      const workDir = path.join(TEMP_DIR, `picker-${token}`);
      fs.mkdirSync(workDir, { recursive: true });
      const resultFile = path.join(workDir, "result.json");
      const initial = String((params && params.initial) || "").trim();
      const args = ["--result", resultFile, "--title", method === "doc/pickFolder" ? "选择文件夹" : "选择保存目录"];
      if (initial) args.push("--initial", initial);
      let child;
      try {
        child = spawn(PICKER_EXE, args, { stdio: "ignore", windowsHide: false });
      } catch (error) {
        fs.rmSync(workDir, { recursive: true, force: true });
        throw new RpcError(-32000, "无法启动目录选择器，请直接填写绝对路径。", {
          code: "pickerFailed",
          detail: String((error && error.message) || error),
        });
      }
      const entry = { child, resultFile, workDir, exited: false, error: "" };
      pickers.set(token, entry);
      child.on("error", (error) => {
        entry.exited = true;
        entry.error = String((error && error.message) || error);
      });
      child.on("exit", () => {
        entry.exited = true;
      });
      return { token };
    }

    case "doc/pickOutputDirResult":
    case "doc/pickFolderResult": {
      const token = String((params && params.token) || "");
      const entry = pickers.get(token);
      if (!entry) throw badParams("选择器会话不存在或已结束。");
      if (fs.existsSync(entry.resultFile)) {
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(entry.resultFile, "utf8"));
        } catch {
          parsed = null;
        }
        cleanupPicker(token, entry);
        if (parsed && parsed.ok && typeof parsed.path === "string" && parsed.path) {
          return { done: true, path: parsed.path };
        }
        return { done: true, canceled: true, error: String((parsed && parsed.error) || "") };
      }
      if (entry.exited) {
        cleanupPicker(token, entry);
        return { done: true, canceled: true, error: entry.error || "目录选择器没有返回结果。" };
      }
      return { done: false };
    }

    default:
      throw new RpcError(-32601, `未知方法：${method}`, { code: "methodNotFound" });
  }
}

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    log("ignored invalid JSON request");
    return;
  }
  if (!request || typeof request !== "object") return;
  const isNotification = !Object.prototype.hasOwnProperty.call(request, "id");
  const id = request.id;
  const method = String(request.method || "");
  if (!method) {
    if (!isNotification) writeMessage({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  try {
    const result = await handle(method, request.params || {});
    if (!isNotification) writeMessage({ jsonrpc: "2.0", id, result });
    if (method === "plugin/shutdown") {
      shuttingDown = true;
      setTimeout(() => process.exit(0), 20);
    }
  } catch (error) {
    if (isNotification) {
      log("notification failed:", method, (error && error.message) || error);
      return;
    }
    const code = error instanceof RpcError ? error.code : -32603;
    const message = error instanceof RpcError ? error.message : "转换服务内部错误。";
    const data = error instanceof RpcError ? error.data : { code: "internal", message: "转换服务内部错误。", detail: String((error && error.message) || error) };
    if (code === -32603) log("request failed:", method, (error && error.stack) || error);
    writeMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
  }
}

function startInputLoop() {
  const queue = Promise.resolve();
  let chain = queue;
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(() => handleLine(line)).catch((error) => log("line handler failed:", (error && error.stack) || error));
  });
  reader.on("close", () => {
    if (!shuttingDown) process.exit(0);
  });
}

process.on("uncaughtException", (error) => {
  log("uncaught exception:", (error && error.stack) || error);
  try {
    for (const job of jobs.values()) {
      if (job.status === "running" || job.status === "uploading") {
        emit("doc/error", { jobId: job.id, code: "internal", message: "转换服务意外退出。", detail: String((error && error.message) || error) });
      }
    }
  } catch {
    /* best effort */
  }
  setTimeout(() => process.exit(1), 50);
});

process.on("unhandledRejection", (reason) => {
  log("unhandled rejection:", (reason && reason.stack) || reason);
});

ensureDirectories();
sweepOldFiles();
startInputLoop();
