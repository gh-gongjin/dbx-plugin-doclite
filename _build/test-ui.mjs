import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFakePicker } from "./fake-picker.mjs";
import { startOcrMock } from "./lib/ocr-mock.mjs";

const require = createRequire("D:/nvm/node_global/node_modules/rea-agents/package.json");
const { chromium } = require("playwright-core");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = path.join(root, "_build", "samples");
const workDir = path.join(root, "_build", ".tmp", "ui-test");
const dataDir = path.join(workDir, "data");
const saveDir = path.join(workDir, "saved");
const shots = path.join(root, "_build", "shots");
const uiUrl = pathToFileURL(path.join(root, "ui", "index.html")).href;

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(saveDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const badExe = path.join(workDir, "bad.exe");
fs.writeFileSync(badExe, "MZ not a real executable\n");
const retryTxt = path.join(workDir, "retry.txt");
{
  const line = "DocLite retry line — the quick brown fox jumps over the lazy dog 0123456789.\n";
  const target = 4 * 1024 * 1024 + 64 * 1024;
  fs.writeFileSync(retryTxt, line.repeat(Math.ceil(target / Buffer.byteLength(line))).slice(0, target));
}

const knownFiles = new Map([
  ["sample.md", path.join(samples, "sample.md")],
  ["sample.docx", path.join(samples, "sample.docx")],
  ["sample.pdf", path.join(samples, "sample.pdf")],
  ["scanned.pdf", path.join(samples, "scanned.pdf")],
  ["sample.csv", path.join(samples, "sample.csv")],
  ["sample.txt", path.join(samples, "sample.txt")],
  ["bad.exe", badExe],
  ["retry.txt", retryTxt],
]);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

class Sidecar {
  constructor(command, args, extraEnv = {}) {
    this.child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir, DBX_PLUGIN_ID: "com.gongjin.doclite", DBX_PLUGIN_VERSION: "0.1.8", ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.sequence = 0;
    this.eventHook = null;
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message);
          error.code = message.error.data && message.error.data.code;
          error.data = message.error.data;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        this.events.push(message);
        if (this.eventHook) this.eventHook(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        }
      }
    });
    this.child.on("exit", (code, signal) => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`sidecar exited (${code ?? signal})`));
      }
      for (const entry of this.pending.values()) entry.reject(new Error(`sidecar exited (${code ?? signal})`));
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } resolve(); }, 3000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

const pickerModeFile = path.join(workDir, "picker-mode.txt");
const fakePicker = buildFakePicker();
if (fakePicker) fs.writeFileSync(pickerModeFile, "ok", "utf8");
const ocrMock = await startOcrMock(path.join(workDir, "ocr-mock"));
const sidecar = new Sidecar(process.execPath, [path.join(root, "backend", "sidecar.cjs")], {
  ...(fakePicker ? { DBX_PICKER_EXE: fakePicker, FAKE_PICKER_MODE_FILE: pickerModeFile } : {}),
  DOCLITE_MINERU_BASE_URL: ocrMock.baseUrl,
  DOCLITE_BAIDU_BASE_URL: ocrMock.baseUrl,
  DOCLITE_OCR_POLL_MS: "50",
  DOCLITE_OCR_TIMEOUT_MS: "30000",
});
const terminalEvents = [];
sidecar.eventHook = (message) => {
  if (message.params && message.params.jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(message.method)) {
    terminalEvents.push(message);
  }
};

const handles = new Map();
const closedHandles = new Set();
const saves = new Map();
let handleSequence = 0;
let revealCalls = 0;
const revealParams = [];
const storage = {};
const copied = [];
const readDelays = new Map([["retry.txt", 700]]);

const browser = await chromium.launch({
  executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1243/chrome-win64/chrome.exe"),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error" && !/favicon/i.test(message.text())) consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

function createHandle(name, filePath, size) {
  const handleId = `handle-${++handleSequence}`;
  handles.set(handleId, { name, path: filePath, size, closed: false });
  return handleId;
}

await page.exposeFunction("__dbxInvoke", async (method, params, options) => {
  if (method === "doc/reveal") {
    revealCalls += 1;
    revealParams.push(params || {});
    return { opened: true, path: path.join(dataDir, "output") };
  }
  return sidecar.request(method, params || {}, options && options.timeoutMs ? Math.min(options.timeoutMs, 60000) : 60000);
});
await page.exposeFunction("__dbxPick", async (names) => {
  return (names || []).map((name) => {
    const filePath = knownFiles.get(name);
    if (!filePath) throw new Error(`unknown fixture: ${name}`);
    const size = fs.statSync(filePath).size;
    return { handleId: createHandle(name, filePath, size), name, size, contentType: "application/octet-stream" };
  });
});
await page.exposeFunction("__dbxRead", async (handleId, offset, length) => {
  const handle = handles.get(handleId);
  if (!handle || handle.closed) throw new Error("文件句柄已关闭。");
  const delay = readDelays.get(handle.name) || 0;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const take = Math.max(0, Math.min(Number(length) || 4 * 1024 * 1024, handle.size - offset));
  const buffer = Buffer.alloc(take);
  const fd = fs.openSync(handle.path, "r");
  try {
    fs.readSync(fd, buffer, 0, take, offset);
  } finally {
    fs.closeSync(fd);
  }
  return { dataBase64: buffer.toString("base64"), length: take, offset, eof: offset + take >= handle.size, size: handle.size };
});
await page.exposeFunction("__dbxClose", async (handleId) => {
  const handle = handles.get(handleId);
  if (handle) handle.closed = true;
  closedHandles.add(handleId);
  return null;
});
await page.exposeFunction("__dbxBeginSave", async (options) => {
  const name = path.basename(String(options && options.name ? options.name : "document"));
  const handleId = createHandle(name, null, 0);
  saves.set(handleId, { name, chunks: [], length: 0 });
  return { handleId, chunkBytes: 4 * 1024 * 1024 };
});
await page.exposeFunction("__dbxWrite", async (handleId, offset, dataBase64) => {
  const save = saves.get(handleId);
  if (!save) throw new Error("保存句柄不存在。");
  const bytes = Buffer.from(dataBase64, "base64");
  if (offset !== save.length) throw new Error("写入偏移不连续。");
  save.chunks.push(bytes);
  save.length += bytes.length;
  return null;
});
await page.exposeFunction("__dbxFinishSave", async (handleId) => {
  const save = saves.get(handleId);
  if (!save) throw new Error("保存句柄不存在。");
  fs.writeFileSync(path.join(saveDir, save.name), Buffer.concat(save.chunks));
  saves.delete(handleId);
  return null;
});
await page.exposeFunction("__dbxCancelSave", async (handleId) => {
  saves.delete(handleId);
  return null;
});
await page.exposeFunction("__dbxCopy", async (text) => {
  copied.push(String(text));
  return null;
});
await page.exposeFunction("__dbxStorageGet", async (key) => (key in storage ? storage[key] : null));
await page.exposeFunction("__dbxStorageSet", async (key, value) => { storage[key] = value; return null; });
await page.exposeFunction("__dbxStorageDelete", async (key) => { delete storage[key]; return null; });

await page.addInitScript(() => {
  window.__dbxStatus = false;
  // Mirror the real SDK: `capabilities` stays empty until the host answers
  // the SDK's "ready" message, and that round trip always lands after the
  // plugin's own script ran. A stub that pre-fills capabilities hides
  // ordering bugs in the plugin.
  window.__dbxCapabilities = {};
  let resolveReady;
  window.__dbxReady = new Promise((resolve) => { resolveReady = resolve; });
  window.addEventListener("load", () => {
    window.__dbxCapabilities = {
      storage: true,
      clipboardWrite: true,
      fileTransfer: { pick: true, read: true, beginSave: true, drop: true, folderExpansion: true },
    };
    resolveReady(window.__dbxCapabilities);
  });
  window.__dbxTest = {
    pickQueue: [],
    bridgeStats: { maxChunkParams: 0 },
    setPick(names) { this.pickQueue = names.slice(); },
    async drop(items) {
      const files = [];
      for (const item of items) {
        if (typeof item === "string") {
          files.push(...await window.__dbxPick([item]));
        } else {
          const [file] = await window.__dbxPick([item.name]);
          files.push(item.relativePath ? { ...file, relativePath: item.relativePath } : file);
        }
      }
      if (!window.__dbxDropCb) return false;
      window.__dbxDropCb(files, { truncated: false });
      return true;
    },
    drag(active) { if (window.__dbxDragCb) window.__dbxDragCb(Boolean(active)); },
    theme(appearance) {
      document.dispatchEvent(new CustomEvent("dbx-plugin-env", { detail: { type: "env", locale: "zh-CN", theme: { appearance, tokens: {} } } }));
    },
  };
  window.__dbxDeliverEvent = (message) => { if (window.__dbxEventCb) window.__dbxEventCb(message); };

  const encode = (bytes) => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  };

  window.dbxPlugin = Object.freeze({
    ready: window.__dbxReady,
    get capabilities() { return window.__dbxCapabilities; },
    theme: { appearance: "light", tokens: {} },
    invoke: (method, params, options) => {
      if (params !== undefined) {
        const size = new TextEncoder().encode(JSON.stringify(params)).byteLength;
        if (method === "doc/chunk" && size > window.__dbxTest.bridgeStats.maxChunkParams) {
          window.__dbxTest.bridgeStats.maxChunkParams = size;
        }
        // The real host bridge rejects request params above 2 MiB.
        if (size > 2 * 1024 * 1024) return Promise.reject(new Error("Plugin bridge request is too large"));
      }
      return window.__dbxInvoke(method, params, options).then((result) => {
        if (method === "doc/status") window.__dbxStatus = true;
        return result;
      });
    },
    copy: (text) => window.__dbxCopy(text),
    storage: Object.freeze({
      get: (key) => window.__dbxStorageGet(key),
      set: (key, value) => window.__dbxStorageSet(key, value),
      delete: (key) => window.__dbxStorageDelete(key),
    }),
    fileTransfer: Object.freeze({
      pick: async () => ({ files: await window.__dbxPick(window.__dbxTest.pickQueue) }),
      read: (handleId, offset, length) => window.__dbxRead(handleId, offset, length),
      beginSave: (options) => window.__dbxBeginSave(options),
      write: (handleId, offset, data) => {
        if (typeof data === "string") return window.__dbxWrite(handleId, offset, data);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        return window.__dbxWrite(handleId, offset, encode(bytes));
      },
      finish: (handleId) => window.__dbxFinishSave(handleId),
      cancel: (handleId) => window.__dbxClose(handleId),
      onDragState: (listener) => { window.__dbxDragCb = listener; return () => { window.__dbxDragCb = null; }; },
      onDrop: (listener) => { window.__dbxDropCb = listener; return () => { window.__dbxDropCb = null; }; },
    }),
    onEvent: (listener) => { window.__dbxEventCb = listener; return () => { window.__dbxEventCb = null; }; },
    decodeBase64: (value) => {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    },
  });
});

sidecar.eventHook = (message) => {
  if (message.params && message.params.jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(message.method)) {
    terminalEvents.push(message);
  }
  page
    .evaluate((payload) => window.__dbxDeliverEvent(payload), { type: "event", method: message.method, params: message.params })
    .catch(() => {});
};

async function waitReady() {
  await page.waitForFunction(() => window.__dbxStatus === true, null, { timeout: 30000 });
  await page.waitForTimeout(150);
}

async function waitIdle() {
  try {
    await page.waitForFunction(() => {
      const items = Array.from(document.querySelectorAll(".file-item"));
      if (!items.length) return false;
      return items.every((item) => !["converting"].includes(item.dataset.status))
        && !document.querySelector("#conversionStrip").classList.contains("active");
    }, null, { timeout: 120000 });
  } catch (error) {
    const diag = await page.evaluate(() => ({
      statuses: Array.from(document.querySelectorAll(".file-item")).map((item) => ({
        name: item.querySelector(".file-name").textContent.trim(),
        status: item.dataset.status,
        meta: item.querySelector(".file-meta").textContent.trim(),
      })),
      strip: document.querySelector("#stripText").textContent,
      toasts: document.querySelector("#toastWrap").innerText,
    }));
    console.error("waitIdle timed out", JSON.stringify(diag));
    console.error("sidecar stderr:", sidecar.stderr.slice(-2000));
    console.error("console errors:", consoleErrors.join(" | "));
    throw error;
  }
  await page.waitForTimeout(150);
}

async function fileStatuses() {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".file-item").forEach((item) => {
      out[item.querySelector(".file-name").textContent.trim()] = item.dataset.status;
    });
    return out;
  });
}

async function checkStates() {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".file-item").forEach((item) => {
      const input = item.querySelector("input[data-check]");
      out[item.querySelector(".file-name").textContent.trim()] = {
        checked: Boolean(input && input.checked),
        disabled: Boolean(input && input.disabled),
      };
    });
    return out;
  });
}

async function itemId(name) {
  return page.evaluate((target) => {
    const item = Array.from(document.querySelectorAll(".file-item"))
      .find((node) => node.querySelector(".file-name").textContent.trim() === target);
    return item ? item.dataset.id : null;
  }, name);
}

async function selectItem(name) {
  const id = await itemId(name);
  if (!id) throw new Error(`missing queue item: ${name}`);
  await page.click(`.file-item[data-id="${id}"]`);
  await page.waitForTimeout(120);
}

async function openDrawer() {
  await page.click("#settingsBtn");
  await page.waitForTimeout(320);
}

async function closeDrawer() {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

await page.goto(uiUrl);
await waitReady();

check("初始队列为空", (await page.locator("#queueCount").textContent()) === "0");
check("初始空态提示拖入文档", (await page.locator("#previewBody").innerText()).includes("把文档拖进来"));
check("初始主按钮没有待转换文件", (await page.locator("#convertBtn").innerText()) === "没有待转换文件");
check("转换引擎就绪", (await page.locator("#convertBtn").innerText()) !== "引擎未就绪");
check("宿主能力就绪后已注册拖放监听", await page.evaluate(() => Boolean(window.__dbxDropCb)));
await page.screenshot({ path: path.join(shots, "ui-01-empty.png") });

// 1. 选择文件（含不支持类型）
await page.evaluate(() => window.__dbxTest.setPick(["sample.md", "sample.docx", "sample.pdf", "scanned.pdf", "sample.csv", "bad.exe"]));
await page.click("#addBtn");
await page.waitForTimeout(250);
let statuses = await fileStatuses();
check("选择 6 个文件进入队列", Object.keys(statuses).length === 6, JSON.stringify(statuses));
check("不支持的 .exe 立即标记失败", statuses["bad.exe"] === "failed", statuses["bad.exe"]);
check("其余文件进入待转换", ["sample.md", "sample.docx", "sample.pdf", "scanned.pdf", "sample.csv"].every((name) => statuses[name] === "ready"), JSON.stringify(statuses));
check("失败文件句柄已关闭", closedHandles.size >= 1, `closed=${closedHandles.size}`);
let queuedChecks = await checkStates();
check(
  "待转换文件默认勾选",
  ["sample.md", "sample.docx", "sample.pdf", "scanned.pdf", "sample.csv"].every((name) => queuedChecks[name]?.checked && !queuedChecks[name]?.disabled),
  JSON.stringify(queuedChecks),
);
check("不支持的文件不可勾选", queuedChecks["bad.exe"] && !queuedChecks["bad.exe"].checked && queuedChecks["bad.exe"].disabled, JSON.stringify(queuedChecks["bad.exe"]));
check("队列底部显示已选数量", (await page.locator("#queueFootText").innerText()).includes("已选 5"), await page.locator("#queueFootText").innerText());
const previewBeforeCheck = await page.locator("#previewIdentity .identity-name").innerText();
await page.locator(".file-item", { hasText: "sample.docx" }).locator("input[data-check]").uncheck();
check("勾选不会切换当前预览", (await page.locator("#previewIdentity .identity-name").innerText()) === previewBeforeCheck);
check("部分勾选时全选框为半选", await page.evaluate(() => document.querySelector("#checkAll").indeterminate === true));
await page.locator(".file-item", { hasText: "sample.docx" }).locator("input[data-check]").check();
const csvCheck = page.locator(".file-item", { hasText: "sample.csv" }).locator("input[data-check]");
await csvCheck.focus();
await page.keyboard.press("Space");
check(
  "空格只切换勾选且不切换预览",
  !(await csvCheck.isChecked()) && (await page.locator("#previewIdentity .identity-name").innerText()) === previewBeforeCheck,
);
await page.keyboard.press("Space");
await page.locator("#checkAll").uncheck();
check("全不选后主按钮禁用并提示未勾选", (await page.locator("#convertBtn").isDisabled()) && (await page.locator("#convertBtn").innerText()) === "未勾选待转换文件");
await page.locator("#checkAll").check();
check("全选后主按钮可用", !(await page.locator("#convertBtn").isDisabled()) && (await page.locator("#convertBtn").innerText()) === "开始转换");
await page.screenshot({ path: path.join(shots, "ui-02-queued.png") });

// 2. 批量转换
await page.click("#convertBtn");
await waitIdle();
statuses = await fileStatuses();
check("Markdown 转换完成", statuses["sample.md"] === "done", statuses["sample.md"]);
check("Word 转换完成", statuses["sample.docx"] === "done", statuses["sample.docx"]);
check("PDF 转换完成", statuses["sample.pdf"] === "done", statuses["sample.pdf"]);
check("CSV 转换完成", statuses["sample.csv"] === "done", statuses["sample.csv"]);
check("扫描 PDF 标记需要 OCR", statuses["scanned.pdf"] === "needsOcr", statuses["scanned.pdf"]);
check("失败项仍为失败", statuses["bad.exe"] === "failed", statuses["bad.exe"]);
check("插件输出模式打开输出目录", revealCalls === 1, `reveals=${revealCalls}`);
check("完成后主按钮无待转换", (await page.locator("#convertBtn").innerText()) === "没有待转换文件");
const settledChecks = await checkStates();
check("完成后勾选自队列清除", Object.values(settledChecks).every((state) => !state.checked), JSON.stringify(settledChecks));
check("无待转换时全选框禁用", await page.locator("#checkAll").isDisabled());
const doneEvents = terminalEvents.filter((event) => event.method === "doc/done");
check(
  "完成事件回报耗时",
  doneEvents.length >= 4 && doneEvents.every((event) => Number.isFinite(event.params.durationMs) && event.params.durationMs >= 0),
  doneEvents.map((event) => event.params.durationMs).join(",")
);

// 3. 预览 / Markdown / JSON / 结构
await selectItem("sample.md");
check("默认选中首个文件", (await page.locator("#previewIdentity").innerText()).includes("sample.md"));
const identityMeta = await page.locator("#previewIdentity .identity-meta").innerText();
check("预览文件头显示耗时", /耗时 \d+(\.\d+)? (毫秒|秒)/.test(identityMeta) || /耗时 \d+ 分 \d+ 秒/.test(identityMeta), identityMeta);
const previewText = await page.locator("#previewBody").innerText();
check("渲染 Markdown 预览", previewText.includes("项目周会纪要"), previewText.slice(0, 60));
check("预览区渲染表格", (await page.locator("#previewBody table").count()) > 0);
await page.screenshot({ path: path.join(shots, "ui-03-preview.png") });

await page.click('.tab[data-tab="markdown"]');
await page.waitForTimeout(150);
const markdownText = await page.locator("#previewBody").innerText();
check("Markdown tab 显示原始文本", markdownText.includes("# 项目周会纪要"), markdownText.slice(0, 40));
await page.click('.tab[data-tab="json"]');
await page.waitForTimeout(150);
const jsonText = await page.locator("#previewBody").innerText();
check("JSON tab 显示 Document Model", jsonText.includes('"engine"') && jsonText.includes('"blocks"'), jsonText.slice(0, 60));
await page.screenshot({ path: path.join(shots, "ui-04-json.png") });
await page.click('.tab[data-tab="structure"]');
await page.waitForTimeout(150);
const structureRows = await page.locator(".tree-row").count();
check("结构 tab 枚举块", structureRows > 5, `rows=${structureRows}`);
await page.click('.tab[data-tab="preview"]');
await page.waitForTimeout(120);

// 4. 复制与保存
await page.click("#copyBtn");
await page.waitForTimeout(200);
check("复制 Markdown 到宿主剪贴板", copied.length === 1 && copied[0].includes("# 项目周会纪要"), `copied=${copied.length}`);
await page.click("#saveBtn");
await page.waitForFunction(() => document.querySelector("#toastWrap").innerText.includes("已保存 sample.md"), null, { timeout: 10000 });
const savedMd = path.join(saveDir, "sample.md");
check("保存 Markdown 文件", fs.existsSync(savedMd) && fs.readFileSync(savedMd, "utf8").includes("项目周会纪要"));
await page.click('.tab[data-tab="json"]');
await page.click("#saveBtn");
await page.waitForFunction(() => document.querySelector("#toastWrap").innerText.includes("已保存 sample.json"), null, { timeout: 10000 });
const savedJson = path.join(saveDir, "sample.json");
check("保存 JSON 文件", fs.existsSync(savedJson) && JSON.parse(fs.readFileSync(savedJson, "utf8")).engine.name === "anydoc");
await page.click('.tab[data-tab="preview"]');

// 5. needsOcr 提示与 OCR 入口
await selectItem("scanned.pdf");
const ocrText = await page.locator("#previewBody").innerText();
check("扫描件显示 OCR 说明", ocrText.includes("扫描版 PDF 需要 OCR") && ocrText.includes("第 1 页"), ocrText.slice(0, 80));
await page.click("[data-open-ocr]");
await page.waitForTimeout(300);
check("OCR 入口打开配置弹窗", await page.evaluate(() => !document.querySelector("#ocrLayer").hidden));
check("配置弹窗显示 MinerU 凭据字段", await page.locator("#ocrMineruToken").isVisible());
await page.screenshot({ path: path.join(shots, "ui-05-needs-ocr.png") });
await page.click("#cancelOcr");
check("取消后关闭配置弹窗", await page.evaluate(() => document.querySelector("#ocrLayer").hidden));

// 5.5 配置百度 OCR、测试连接并重试扫描件
await page.click("#previewBody [data-open-ocr]");
await page.waitForTimeout(250);
check("弹窗默认选中 MinerU", (await page.locator('[data-provider="mineru"]').getAttribute("aria-checked")) === "true");
await page.click('[data-provider="baidu"]');
await page.waitForTimeout(150);
check(
  "切换服务商显示百度凭据字段",
  (await page.locator("#ocrBaiduApiKey").isVisible())
    && (await page.locator("#ocrBaiduSecretKey").isVisible())
    && !(await page.locator("#ocrMineruToken").isVisible()),
);
await page.click("#saveOcr");
await page.waitForTimeout(200);
check(
  "未填凭据时保存被拦截",
  (await page.locator("#ocrTestStatus").innerText()).includes("请先填写 API Key 与 Secret Key")
    && await page.evaluate(() => !document.querySelector("#ocrLayer").hidden),
);
await page.fill("#ocrBaiduApiKey", "bad-key");
await page.fill("#ocrBaiduSecretKey", "bad-secret");
await page.click("#testOcr");
await page.waitForFunction(() => {
  const el = document.querySelector("#ocrTestStatus");
  return el && !el.hidden && el.dataset.state === "error";
}, null, { timeout: 15000 });
const badTestText = await page.locator("#ocrTestStatus").innerText();
check("错误凭据的测试连接会失败", badTestText.length > 0, badTestText);
await page.fill("#ocrBaiduApiKey", "ui-baidu-key");
await page.fill("#ocrBaiduSecretKey", "ui-baidu-secret");
await page.click("#testOcr");
await page.waitForFunction(() => {
  const el = document.querySelector("#ocrTestStatus");
  return el && !el.hidden && el.dataset.state === "ok";
}, null, { timeout: 15000 });
const goodTestText = await page.locator("#ocrTestStatus").innerText();
check("百度凭据测试连接成功", goodTestText.includes("access_token"), goodTestText);
await page.screenshot({ path: path.join(shots, "ui-05b-ocr-config.png") });
await page.click("#saveOcr");
await page.waitForFunction(() => document.querySelector("#ocrLayer").hidden, null, { timeout: 15000 });
const ocrSaved = await sidecar.request("doc/ocrConfig", {});
check(
  "保存后服务端启用百度 OCR",
  ocrSaved.config.provider === "baidu" && ocrSaved.config.enabled === true && ocrSaved.config.ready === true,
  JSON.stringify(ocrSaved.config),
);
check("保存后提示已启用", (await page.locator("#toastWrap").innerText()).includes("已启用 百度 OCR"), await page.locator("#toastWrap").innerText());

await openDrawer();
check("设置页显示 OCR 已启用", (await page.locator("#ocrBadge").innerText()) === "已启用", await page.locator("#ocrBadge").innerText());
check("设置页 OCR 描述标明服务商", (await page.locator("#ocrDesc").innerText()).includes("百度 OCR"), await page.locator("#ocrDesc").innerText());
await page.click("#swOcr");
await page.waitForTimeout(400);
check(
  "关闭开关停用 OCR",
  (await page.locator("#swOcr").getAttribute("aria-checked")) === "false" && (await page.locator("#ocrBadge").innerText()) === "已配置",
  await page.locator("#ocrBadge").innerText(),
);
await page.click("#swOcr");
await page.waitForTimeout(400);
check("重新开启 OCR", (await page.locator("#swOcr").getAttribute("aria-checked")) === "true" && (await page.locator("#ocrBadge").innerText()) === "已启用");
await closeDrawer();

await selectItem("scanned.pdf");
check("就绪后 needsOcr 提供重试按钮", (await page.locator("#previewBody [data-retry-ocr]").innerText()).includes("百度 OCR"));
await page.click("#previewBody [data-retry-ocr]");
await page.waitForFunction(() => {
  const item = Array.from(document.querySelectorAll(".file-item"))
    .find((node) => node.querySelector(".file-name").textContent.trim() === "scanned.pdf");
  return item && item.dataset.status === "done";
}, null, { timeout: 60000 });
const ocrPreview = await page.locator("#previewBody").innerText();
check("云端 OCR 重试完成并显示识别结果", ocrPreview.includes("百度 OCR 识别结果"), ocrPreview.slice(0, 80));
check("OCR 重试调用百度接口", ocrMock.state.baiduCalls.length === 1, `calls=${ocrMock.state.baiduCalls.length}`);
await page.screenshot({ path: path.join(shots, "ui-05c-ocr-done.png") });

await openDrawer();

// 6. 设置持久化（此后保持抽屉打开状态检查）
await page.waitForTimeout(200);
await page.click("#swJson");
await page.selectOption("#namingSelect", "dated");
await page.selectOption("#locationSelect", "ask");
await page.click("#swOpenAfter");
await page.waitForTimeout(700);
const persisted = storage.settings;
check("设置写入宿主存储", persisted && persisted.json === false && persisted.naming === "dated" && persisted.location === "ask" && persisted.openAfter === false, JSON.stringify(persisted));
await closeDrawer();
await page.reload();
await waitReady();
await openDrawer();
const restored = await page.evaluate(() => ({
  json: document.querySelector("#swJson").getAttribute("aria-checked"),
  naming: document.querySelector("#namingSelect").value,
  location: document.querySelector("#locationSelect").value,
  openAfter: document.querySelector("#swOpenAfter").getAttribute("aria-checked"),
}));
check("重载后设置恢复", restored.json === "false" && restored.naming === "dated" && restored.location === "ask" && restored.openAfter === "false", JSON.stringify(restored));
await closeDrawer();

// 7. ask 模式保存：Markdown + JSON 均由宿主保存对话框落盘
await openDrawer();
await page.click("#swJson");
await page.waitForTimeout(500);
await closeDrawer();
await page.evaluate(() => window.__dbxTest.setPick(["sample.txt"]));
await page.click("#addBtn");
await page.waitForTimeout(200);
await page.click("#convertBtn");
await waitIdle();
const askDone = terminalEvents.filter((event) => event.method === "doc/done").pop();
check("ask 模式 sidecar 不写插件输出目录", askDone && Object.keys(askDone.params.outputs || {}).length === 0, JSON.stringify(askDone && askDone.params.outputs));
const dated = new Date();
const pad = (value) => String(value).padStart(2, "0");
const stamp = `${dated.getFullYear()}${pad(dated.getMonth() + 1)}${pad(dated.getDate())}`;
const askMd = path.join(saveDir, `sample-${stamp}.md`);
const askJson = path.join(saveDir, `sample-${stamp}.json`);
check("ask 模式保存 Markdown", fs.existsSync(askMd) && fs.readFileSync(askMd, "utf8").includes("DocLite"), askMd);
check("ask 模式保存 JSON", fs.existsSync(askJson) && JSON.parse(fs.readFileSync(askJson, "utf8")).engine.name === "anydoc", askJson);
check("ask 模式不打开输出目录", revealCalls === 1, `reveals=${revealCalls}`);
await page.screenshot({ path: path.join(shots, "ui-06-ask-saved.png") });

// 8. 取消与重试
await openDrawer();
await page.selectOption("#namingSelect", "original");
await page.selectOption("#locationSelect", "plugin");
await page.waitForTimeout(500);
await closeDrawer();
await page.evaluate(() => window.__dbxTest.setPick(["retry.txt"]));
await page.click("#addBtn");
await page.waitForTimeout(200);
await page.click("#convertBtn");
await page.waitForFunction(() => document.querySelectorAll('.file-item[data-status="converting"]').length === 1, null, { timeout: 15000 });
await page.waitForTimeout(300);
await page.click("#cancelBtn");
await page.waitForFunction(() => document.querySelectorAll('.file-item[data-status="ready"]').length === 1, null, { timeout: 30000 });
statuses = await fileStatuses();
check("取消后文件回到待转换", statuses["retry.txt"] === "ready", JSON.stringify(statuses));
check("取消后不产生失败项", Object.values(statuses).every((status) => status !== "failed"), JSON.stringify(statuses));
readDelays.set("retry.txt", 0);
await page.click("#convertBtn");
await waitIdle();
statuses = await fileStatuses();
check("取消后可重试并成功", statuses["retry.txt"] === "done", statuses["retry.txt"]);
check("重试后预览可用", (await page.locator("#previewBody").innerText()).includes("DocLite retry line"));
const bridgeStats = await page.evaluate(() => window.__dbxTest.bridgeStats);
check("大文件分片保持在宿主桥接上限内", bridgeStats.maxChunkParams > 0 && bridgeStats.maxChunkParams <= 2 * 1024 * 1024, `${bridgeStats.maxChunkParams} B`);
await page.screenshot({ path: path.join(shots, "ui-07-retry-done.png") });

// 8.5 自定义输出目录
const customDir = path.join(workDir, "custom-output");
fs.mkdirSync(customDir, { recursive: true });
await page.click("#clearBtn");
await page.waitForTimeout(200);
await openDrawer();
await page.selectOption("#locationSelect", "custom");
await page.waitForTimeout(200);
check("自定义目录输入行可见", await page.evaluate(() => !document.querySelector("#customDirRow").hidden));
await page.fill("#customDirInput", "");
await page.click("#checkCustomDir");
await page.waitForTimeout(300);
check("未填目录时给出提示", (await page.locator("#customDirStatus").innerText()).includes("请先填写保存目录"), await page.locator("#customDirStatus").innerText());
await page.fill("#customDirInput", customDir);
await page.click("#checkCustomDir");
await page.waitForTimeout(600);
check("目录校验通过", (await page.locator("#customDirStatus").innerText()).includes("目录可用"), await page.locator("#customDirStatus").innerText());
check("路径提示显示自定义目录", (await page.locator("#outputPathHint").innerText()).includes("custom-output"), await page.locator("#outputPathHint").innerText());
await page.screenshot({ path: path.join(shots, "ui-09b-custom-dir-setting.png") });

// 8.6 浏览按钮选择目录
if (fakePicker) {
  const pickedDir = path.join(workDir, "picked-output");
  fs.mkdirSync(pickedDir, { recursive: true });
  fs.writeFileSync(pickerModeFile, `ok|${pickedDir}`, "utf8");
  await page.click("#pickCustomDir");
  let picked = false;
  try {
    await page.waitForFunction(
      (expected) => document.querySelector("#customDirInput").value === expected,
      pickedDir,
      { timeout: 15000 },
    );
    picked = true;
  } catch {
    picked = false;
  }
  const inputValue = await page.locator("#customDirInput").inputValue();
  check("浏览按钮填入所选目录", picked && inputValue === pickedDir, inputValue);
  check("所选目录进入路径提示", (await page.locator("#outputPathHint").innerText()).includes("picked-output"), await page.locator("#outputPathHint").innerText());
  await page.waitForTimeout(600);
  const pickStatus = await page.locator("#customDirStatus").innerText();
  check("所选目录校验可用", pickStatus.includes("目录可用"), pickStatus);
  await page.screenshot({ path: path.join(shots, "ui-09c-picked-dir.png") });

  fs.writeFileSync(pickerModeFile, "cancel", "utf8");
  await page.click("#pickCustomDir");
  await page.waitForTimeout(1200);
  check("取消选择后保留原目录", (await page.locator("#customDirInput").inputValue()) === pickedDir, await page.locator("#customDirInput").inputValue());

  await page.fill("#customDirInput", customDir);
  await page.waitForTimeout(200);
} else {
  console.log("SKIP  浏览按钮用例需要 csc.exe 编译选择器替身");
}
if ((await page.locator("#swOpenAfter").getAttribute("aria-checked")) !== "true") await page.click("#swOpenAfter");
await page.waitForTimeout(500);
await closeDrawer();
await page.evaluate(() => window.__dbxTest.setPick(["sample.txt"]));
await page.click("#addBtn");
await page.waitForTimeout(200);
await page.click("#convertBtn");
await waitIdle();
const customDone = terminalEvents.filter((event) => event.method === "doc/done").pop();
check("自定义目录写入 Markdown", fs.existsSync(path.join(customDir, "sample.md")), customDone && JSON.stringify(customDone.params.outputs));
check("自定义目录写入 JSON", fs.existsSync(path.join(customDir, "sample.json")));
check("转换结果回报自定义目录", customDone && customDone.params.outputDir === customDir, customDone && customDone.params.outputDir);
check("队列标注输出目录", (await page.locator(".file-item[data-status=\"done\"] .file-meta").last().innerText()).includes("custom-output"));
const lastReveal = revealParams[revealParams.length - 1] || {};
check("完成后打开自定义目录", revealCalls === 2 && lastReveal.dir === customDir, `reveals=${revealCalls} ${JSON.stringify(lastReveal)}`);
await page.screenshot({ path: path.join(shots, "ui-09-custom-dir.png") });

// 8.7 选择文件夹：扫描、跳过不支持类型、按路径转换
const pickedInput = path.join(workDir, "picked-input");
fs.mkdirSync(path.join(pickedInput, "sub"), { recursive: true });
fs.copyFileSync(path.join(samples, "sample.md"), path.join(pickedInput, "report.md"));
fs.copyFileSync(path.join(samples, "sample.csv"), path.join(pickedInput, "sub", "chart.csv"));
fs.writeFileSync(path.join(pickedInput, "sub", "skip.png"), "PNG");
fs.writeFileSync(path.join(pickedInput, ".hidden.md"), "# hidden\n");
if (fakePicker) {
  const beforeFolder = Number(await page.locator("#queueCount").textContent());
  fs.writeFileSync(pickerModeFile, `ok|${pickedInput}`, "utf8");
  await page.click("#addFolderBtn");
  let folderAdded = false;
  try {
    await page.waitForFunction(
      (expected) => Number(document.querySelector("#queueCount").textContent) === expected,
      beforeFolder + 2,
      { timeout: 20000 },
    );
    folderAdded = true;
  } catch {
    folderAdded = false;
  }
  const folderStatuses = await fileStatuses();
  check("选择文件夹扫描出 2 个文档", folderAdded, `${beforeFolder} -> ${await page.locator("#queueCount").textContent()}`);
  check(
    "文件夹内文档进入待转换",
    folderStatuses["report.md"] === "ready" && folderStatuses["chart.csv"] === "ready",
    JSON.stringify(folderStatuses),
  );
  check("文件夹内不支持类型不进入队列", !("skip.png" in folderStatuses), Object.keys(folderStatuses).join(","));
  check("文件夹内隐藏文件不进入队列", !(".hidden.md" in folderStatuses), Object.keys(folderStatuses).join(","));
  const folderToast = await page.locator("#toastWrap").innerText();
  check("文件夹导入提示跳过数量", folderToast.includes("已加入 2 个文档") && folderToast.includes("跳过 1 个不支持的文件"), folderToast);
  const folderChecks = await checkStates();
  check("文件夹文档默认勾选", folderChecks["report.md"]?.checked && folderChecks["chart.csv"]?.checked, JSON.stringify(folderChecks));
  await page.locator(".file-item", { hasText: "chart.csv" }).locator("input[data-check]").uncheck();
  check("取消一个勾选后全选框为半选", await page.evaluate(() => document.querySelector("#checkAll").indeterminate === true));
  await page.click("#convertBtn");
  await waitIdle();
  const selectiveStatuses = await fileStatuses();
  check("仅转换勾选的文件", selectiveStatuses["report.md"] === "done" && selectiveStatuses["chart.csv"] === "ready", JSON.stringify(selectiveStatuses));
  check("未勾选文件不写入输出", fs.existsSync(path.join(customDir, "report.md")) && !fs.existsSync(path.join(customDir, "chart.json")));
  check("未勾选时主按钮提示未勾选", (await page.locator("#convertBtn").innerText()) === "未勾选待转换文件");
  await page.locator(".file-item", { hasText: "chart.csv" }).locator("input[data-check]").check();
  await selectItem("chart.csv");
  const folderIdentity = await page.locator("#previewIdentity .identity-meta").innerText();
  check("子目录信息显示在预览文件头", folderIdentity.includes("sub"), folderIdentity);
  await page.screenshot({ path: path.join(shots, "ui-10-folder-picked.png") });

  await page.click("#convertBtn");
  await waitIdle();
  const folderConverted = await fileStatuses();
  check(
    "文件夹文档按路径转换完成",
    folderConverted["report.md"] === "done" && folderConverted["chart.csv"] === "done",
    JSON.stringify(folderConverted),
  );
  check("文件夹文档写入自定义目录", fs.existsSync(path.join(customDir, "report.md")) && fs.existsSync(path.join(customDir, "chart.json")));
  await page.screenshot({ path: path.join(shots, "ui-11-folder-done.png") });
} else {
  console.log("SKIP  选择文件夹用例需要 csc.exe 编译选择器替身");
}

// 9. 拖放与暗色主题
const beforeDrop = Number(await page.locator("#queueCount").textContent());
const dropped = await page.evaluate(() => window.__dbxTest.drop(["sample.txt"]));
await page.waitForTimeout(300);
const afterDrop = Number(await page.locator("#queueCount").textContent());
check("拖放文件加入队列", dropped === true && afterDrop === beforeDrop + 1, `${beforeDrop} -> ${afterDrop}`);

const beforeFolderDrop = Number(await page.locator("#queueCount").textContent());
const droppedFolder = await page.evaluate(() => window.__dbxTest.drop([
  { name: "sample.docx", relativePath: "contracts/sample.docx" },
  { name: "bad.exe", relativePath: "contracts/bad.exe" },
]));
await page.waitForTimeout(350);
const afterFolderDrop = Number(await page.locator("#queueCount").textContent());
check(
  "拖入文件夹只加入支持的文档",
  droppedFolder === true && afterFolderDrop === beforeFolderDrop + 1,
  `${beforeFolderDrop} -> ${afterFolderDrop}`,
);
const folderDropToast = await page.locator("#toastWrap").innerText();
check(
  "拖入文件夹提示跳过数量",
  folderDropToast.includes("已加入 1 个文档") && folderDropToast.includes("跳过 1 个不支持的文件"),
  folderDropToast,
);
check(
  "拖入文件夹的文档保留子目录",
  (await page.locator('.file-name[title="contracts/sample.docx"]').count()) === 1,
);
check(
  "拖入文件夹的文档默认勾选",
  await page.locator('.file-item:has(.file-name[title="contracts/sample.docx"]) input[data-check]').isChecked(),
);
await page.screenshot({ path: path.join(shots, "ui-12-folder-drop.png") });

await page.evaluate(() => window.__dbxTest.theme("dark"));
await page.waitForTimeout(250);
check("跟随宿主切换到暗色主题", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
await page.screenshot({ path: path.join(shots, "ui-08-dark.png") });

// 清理与句柄状态检查
check("转换完成文件释放读取句柄", closedHandles.size >= 7, `closed=${closedHandles.size}`);
check("浏览器控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

const failed = results.filter((result) => !result.ok);
console.log("");
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const result of failed) console.log(`FAILED: ${result.name} ${result.detail}`);
}

await browser.close();
await sidecar.close();
await ocrMock.close();
process.exit(failed.length ? 1 : 0);
