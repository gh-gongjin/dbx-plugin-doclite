import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildFakePicker } from "./fake-picker.mjs";
import { startOcrMock } from "./lib/ocr-mock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = path.join(root, "_build", "samples");
const workDir = path.join(root, "_build", ".tmp", "sidecar-test");
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
const dataDir = path.join(workDir, "data");
const outputDir = path.join(dataDir, "output");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

class Client {
  constructor(command, args, extraEnv = {}) {
    this.child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir, DBX_PLUGIN_ID: manifest.id, DBX_PLUGIN_VERSION: manifest.version, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.sequence = 0;
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`non-JSON line on stdout: ${line.slice(0, 200)}`);
      }
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
        waiter.reject(new Error(`sidecar exited (${code ?? signal}) before event; stderr: ${this.stderr.slice(-800)}`));
      }
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`sidecar exited (${code ?? signal}); stderr: ${this.stderr.slice(-800)}`));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}; stderr: ${this.stderr.slice(-800)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  waitForEvent(predicate, timeoutMs = 60000) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`event timed out; stderr: ${this.stderr.slice(-800)}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } resolve(); }, 3000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

const results = [];
function pass(name, detail = "") {
  results.push({ name, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function convert(client, fileName, options = {}, sourceBytes) {
  const bytes = sourceBytes || fs.readFileSync(path.join(samples, fileName));
  const begin = await client.request("doc/begin", { name: fileName, size: bytes.length });
  const jobId = begin.jobId;
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    await client.request("doc/chunk", { jobId, offset, dataBase64: slice.toString("base64") });
  }
  await client.request("doc/commit", { jobId, options });
  const terminal = await client.waitForEvent(
    (event) => event.params && event.params.jobId === jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(event.method),
  );
  return { jobId, terminal: terminal.method, params: terminal.params };
}

function readAll(client, jobId, kind, chunkSize = 65536) {  return (async () => {
    let offset = 0;
    const parts = [];
    for (let guard = 0; guard < 10000; guard += 1) {
      const chunk = await client.request("doc/readOutput", { jobId, kind, offset, length: chunkSize });
      parts.push(Buffer.from(chunk.dataBase64, "base64"));
      offset = chunk.offset + chunk.length;
      if (chunk.eof) break;
    }
    return Buffer.concat(parts).toString("utf8");
  })();
}

const nodeExe = process.env.NODE_EXE || process.execPath;
const clients = [];

/** Polls the picker the way the UI does until it reports a final result. */
async function waitForPick(client, token, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.request("doc/pickOutputDirResult", { token });
    if (result.done) return result;
    if (Date.now() > deadline) throw new Error(`picker did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForNewEvent(client, startIndex, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = client.events.slice(startIndex).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("event timed out; stderr: " + client.stderr.slice(-800));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main() {
  const ocrMock = await startOcrMock(path.join(workDir, "ocr-mock"));
  const client = new Client(nodeExe, [path.join(root, "backend", "sidecar.cjs")], {
    DOCLITE_MINERU_BASE_URL: ocrMock.baseUrl,
    DOCLITE_BAIDU_BASE_URL: ocrMock.baseUrl,
    DOCLITE_OCR_POLL_MS: "50",
    DOCLITE_OCR_TIMEOUT_MS: "1500",
  });
  clients.push(client);

  const initialized = await client.request("plugin/initialize", {
    host: { dbxVersion: "0.6.51", hostApiVersion: "1.0.0", protocolVersions: [1] },
    plugin: { id: manifest.id, version: manifest.version },
    permissions: manifest.permissions,
  });
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.plugin.id, manifest.id);
  assert.ok(Array.isArray(initialized.capabilities));
  pass("initialize", `protocol ${initialized.protocolVersion}`);

  const status = await client.request("doc/status");
  assert.equal(status.ready, true);
  assert.equal(status.engine.anydoc, "0.2.4");
  assert.equal(status.engine.pdfInspector, "1.17.0");
  for (const extension of ["docx", "pdf", "csv", "md", "txt", "pptx", "xlsx"]) {
    assert.ok(status.supportedExtensions.includes(extension), `missing ${extension}`);
  }
  assert.ok(!status.supportedExtensions.includes("html"));
  assert.equal(status.ocr.provider, "mineru");
  assert.equal(status.ocr.enabled, false);
  assert.equal(status.ocr.configured, false);
  assert.equal(status.ocr.ready, false);
  pass("doc/status", `${status.supportedExtensions.length} extensions · OCR ${status.ocr.provider}`);

  await assert.rejects(
    client.request("doc/nope"),
    (error) => error.code === "methodNotFound",
  );
  pass("unknown method rejected");

  const md = await convert(client, "sample.md");
  assert.equal(md.terminal, "doc/done", JSON.stringify(md.params));
  assert.equal(md.params.source.format, "MD");
  assert.equal(md.params.stats.headings, 3);
  assert.equal(md.params.stats.tables, 1);
  assert.equal(md.params.outputs.markdown.name, "sample.md");
  assert.equal(md.params.outputs.json.name, "sample.json");
  assert.ok(Number.isFinite(md.params.durationMs) && md.params.durationMs >= 0, "durationMs missing");
  assert.ok(fs.existsSync(path.join(outputDir, "sample.md")));
  assert.ok(fs.existsSync(path.join(outputDir, "sample.json")));
  const previewMarkdown = await readAll(client, md.jobId, "preview", 7);
  assert.ok(previewMarkdown.includes("项目周会纪要"));
  assert.ok(previewMarkdown.endsWith("\n"));
  const model = JSON.parse(await readAll(client, md.jobId, "json"));
  assert.equal(model.engine.name, "anydoc");
  assert.equal(model.source.name, "sample.md");
  assert.ok(model.blocks.length >= 8);
  assert.ok(model.blocks.some((block) => block.type === "table"));
  assert.ok(model.blocks.some((block) => block.type === "codeBlock"));
  pass("markdown conversion", `${md.params.stats.words} words, ${model.blocks.length} blocks`);

  const second = await convert(client, "sample.md");
  assert.equal(second.params.outputs.markdown.name, "sample-2.md");
  assert.equal(second.params.outputs.json.name, "sample-2.json");
  pass("output collision suffix", second.params.outputs.markdown.name);

  const docx = await convert(client, "sample.docx");
  assert.equal(docx.terminal, "doc/done", JSON.stringify(docx.params));
  const docxMarkdown = await readAll(client, docx.jobId, "preview");
  assert.ok(docxMarkdown.includes("DocLite 插件验收文档"), docxMarkdown.slice(0, 500));
  assert.ok(docxMarkdown.includes("2026"));
  assert.ok(docx.params.stats.headings >= 1, JSON.stringify(docx.params.stats));
  pass("docx conversion", `headings=${docx.params.stats.headings} tables=${docx.params.stats.tables}`);

  const pdf = await convert(client, "sample.pdf");
  assert.equal(pdf.terminal, "doc/done", JSON.stringify(pdf.params));
  assert.equal(pdf.params.source.pages, 1);
  const pdfMarkdown = await readAll(client, pdf.jobId, "preview");
  assert.ok(pdfMarkdown.includes("DocLite sample PDF"), pdfMarkdown.slice(0, 500));
  pass("pdf conversion", `pages=${pdf.params.source.pages}`);

  const scanned = await convert(client, "scanned.pdf");
  assert.equal(scanned.terminal, "doc/error", JSON.stringify(scanned.params));
  assert.equal(scanned.params.code, "needsOcr", JSON.stringify(scanned.params));
  assert.equal(scanned.params.pageCount, 1);
  assert.ok(scanned.params.pages.includes(1));
  pass("scanned pdf -> needsOcr", `pages=${scanned.params.pages.join(",")}`);

  const csv = await convert(client, "sample.csv");
  assert.equal(csv.terminal, "doc/done", JSON.stringify(csv.params));
  const csvMarkdown = await readAll(client, csv.jobId, "preview");
  assert.ok(csvMarkdown.includes("Sidecar"));
  assert.ok(csvMarkdown.includes("龚进"));
  assert.ok(csv.params.stats.tables >= 1, JSON.stringify(csv.params.stats));
  pass("csv conversion", `tables=${csv.params.stats.tables}`);

  const txt = await convert(client, "sample.txt");
  assert.equal(txt.terminal, "doc/done", JSON.stringify(txt.params));
  const txtMarkdown = await readAll(client, txt.jobId, "preview");
  assert.ok(txtMarkdown.includes("纯文本样例"));
  pass("text conversion");

  const dated = await convert(client, "sample.txt", { naming: "dated", formats: { markdown: true, json: false } });
  assert.match(dated.params.outputs.markdown.name, /^sample-\d{8}\.md$/);
  assert.equal(dated.params.outputs.json, undefined);
  pass("naming dated + markdown only", dated.params.outputs.markdown.name);

  const indexed = await convert(client, "sample.txt", { naming: "indexed", index: 5, formats: { markdown: false, json: true } });
  assert.equal(indexed.params.outputs.json.name, "doc-005.json");
  assert.equal(indexed.params.outputs.markdown, undefined);
  pass("naming indexed + json only", indexed.params.outputs.json.name);

  const askMode = await convert(client, "ask-only.md", { location: "ask" }, fs.readFileSync(path.join(samples, "sample.md")));
  assert.equal(askMode.terminal, "doc/done", JSON.stringify(askMode.params));
  assert.equal(askMode.params.outputs.markdown, undefined);
  assert.equal(askMode.params.outputs.json, undefined);
  assert.ok(!fs.existsSync(path.join(outputDir, "ask-only.md")), "ask 模式不应写入插件输出目录");
  pass("location ask writes nothing", askMode.params.outputDir);

  const customDir = path.join(workDir, "custom-output", "nested");
  const checkMissing = await client.request("doc/checkOutputDir", { dir: customDir });
  assert.equal(checkMissing.path, customDir);
  assert.equal(checkMissing.exists, false);
  assert.equal(checkMissing.writable, false);
  pass("checkOutputDir reports missing directory");

  const noDirBytes = fs.readFileSync(path.join(samples, "sample.md"));
  const noDirBegin = await client.request("doc/begin", { name: "missing-dir.md", size: noDirBytes.length });
  await client.request("doc/chunk", { jobId: noDirBegin.jobId, offset: 0, dataBase64: noDirBytes.toString("base64") });
  await assert.rejects(
    client.request("doc/commit", { jobId: noDirBegin.jobId, options: { location: "custom" } }),
    /请先设置保存目录/,
  );
  await client.request("doc/discard", { jobId: noDirBegin.jobId });
  pass("custom location without outputDir rejected");

  const relativeBytes = fs.readFileSync(path.join(samples, "sample.md"));
  const relativeBegin = await client.request("doc/begin", { name: "relative-dir.md", size: relativeBytes.length });
  await client.request("doc/chunk", { jobId: relativeBegin.jobId, offset: 0, dataBase64: relativeBytes.toString("base64") });
  await assert.rejects(
    client.request("doc/commit", { jobId: relativeBegin.jobId, options: { location: "custom", outputDir: "relative/dir" } }),
    /绝对路径/,
  );
  await client.request("doc/discard", { jobId: relativeBegin.jobId });
  pass("custom location with relative path rejected");

  const custom = await convert(client, "custom-doc.md", { location: "custom", outputDir: customDir }, fs.readFileSync(path.join(samples, "sample.md")));
  assert.equal(custom.terminal, "doc/done", JSON.stringify(custom.params));
  assert.equal(custom.params.outputDir, customDir);
  assert.ok(fs.existsSync(path.join(customDir, "custom-doc.md")), "自定义目录应生成 markdown");
  assert.ok(fs.existsSync(path.join(customDir, "custom-doc.json")), "自定义目录应生成 json");
  assert.ok(!fs.existsSync(path.join(outputDir, "custom-doc.md")), "不应落到插件输出目录");
  const customMarkdown = fs.readFileSync(path.join(customDir, "custom-doc.md"), "utf8");
  assert.ok(customMarkdown.includes("项目周会纪要"), customMarkdown.slice(0, 300));
  pass("custom location writes to target dir", customDir);

  const checkExisting = await client.request("doc/checkOutputDir", { dir: customDir });
  assert.equal(checkExisting.path, customDir);
  assert.equal(checkExisting.exists, true);
  assert.equal(checkExisting.writable, true);
  pass("checkOutputDir reports existing writable directory");

  await assert.rejects(
    client.request("doc/checkOutputDir", { dir: "relative/dir" }),
    /绝对路径/,
  );
  pass("checkOutputDir rejects relative path");

  // --- native folder picker -------------------------------------------------
  const fakePicker = buildFakePicker();
  if (fakePicker) {
    const modeFile = path.join(workDir, "picker-mode.txt");
    fs.writeFileSync(modeFile, "hang", "utf8");
    const pickerEnv = {
      DBX_PICKER_EXE: fakePicker,
      FAKE_PICKER_MODE_FILE: modeFile,
    };
    const pickerClient = new Client(nodeExe, [path.join(root, "backend", "sidecar.cjs")], pickerEnv);
    clients.push(pickerClient);
    await pickerClient.request("plugin/initialize", {
      host: { dbxVersion: "0.6.51", hostApiVersion: "1.0.0", protocolVersions: [1] },
      plugin: { id: manifest.id, version: manifest.version },
      permissions: manifest.permissions,
    });

    const pickStart = await pickerClient.request("doc/pickOutputDir", { initial: "D:\\" });
    assert.equal(typeof pickStart.token, "string");
    assert.ok(pickStart.token.length > 0);
    pass("doc/pickOutputDir returns a token");

    const pending = await pickerClient.request("doc/pickOutputDirResult", { token: pickStart.token });
    assert.equal(pending.done, false, JSON.stringify(pending));
    pass("doc/pickOutputDirResult reports pending while the dialog is open");

    fs.writeFileSync(modeFile, "ok", "utf8");
    const pickAgain = await pickerClient.request("doc/pickFolder", {});
    const picked = await waitForPick(pickerClient, pickAgain.token);
    assert.equal(picked.done, true, JSON.stringify(picked));
    assert.equal(picked.path, "D:\\fake\\picked");
    pass("doc/pickFolder returns the picked path", picked.path);

    fs.writeFileSync(modeFile, "cancel", "utf8");
    const cancelStart = await pickerClient.request("doc/pickOutputDir", {});
    const canceled = await waitForPick(pickerClient, cancelStart.token);
    assert.equal(canceled.done, true, JSON.stringify(canceled));
    assert.equal(canceled.canceled, true);
    pass("doc/pickOutputDirResult reports a cancelled selection");

    fs.writeFileSync(modeFile, "die", "utf8");
    const deadStart = await pickerClient.request("doc/pickOutputDir", {});
    const dead = await waitForPick(pickerClient, deadStart.token);
    assert.equal(dead.done, true, JSON.stringify(dead));
    assert.equal(dead.canceled, true);
    pass("doc/pickOutputDirResult reports a picker that died without a result");

    await assert.rejects(
      pickerClient.request("doc/pickOutputDirResult", { token: "not-a-session" }),
      /选择器会话/,
    );
    pass("doc/pickOutputDirResult rejects an unknown session");

    const tempEntries = fs.readdirSync(path.join(dataDir, "temp")).filter((name) => name.startsWith("picker-"));
    assert.equal(tempEntries.length, 1, `只有仍打开的 hang 会话应留下工作目录: ${tempEntries.join(", ")}`);
    pass("resolved picker sessions clean up their work directory");

    await pickerClient.request("plugin/shutdown");
    await pickerClient.close();
    const afterShutdown = fs.readdirSync(path.join(dataDir, "temp")).filter((name) => name.startsWith("picker-"));
    assert.deepEqual(afterShutdown, [], `关机后不应残留选择器工作目录: ${afterShutdown.join(", ")}`);
    pass("plugin/shutdown stops the open picker and removes its work directory");
  } else {
    console.log("SKIP  picker checks need csc.exe for the test double");
  }

  await assert.rejects(
    client.request("doc/begin", { name: "sample.html", size: 10 }),
    (error) => error.code === "unsupported",
  );
  pass("unsupported extension rejected");

  await assert.rejects(
    client.request("doc/begin", { name: "huge.pdf", size: 513 * 1024 * 1024 }),
    (error) => error.code === "tooLarge",
  );
  pass("oversized file rejected");

  const mismatchBytes = fs.readFileSync(path.join(samples, "sample.txt"));
  const mismatchBegin = await client.request("doc/begin", { name: "mismatch.txt", size: mismatchBytes.length + 10 });
  await client.request("doc/chunk", {
    jobId: mismatchBegin.jobId,
    offset: 0,
    dataBase64: mismatchBytes.toString("base64"),
  });
  await assert.rejects(
    client.request("doc/commit", { jobId: mismatchBegin.jobId }),
    /大小不一致/,
  );
  await client.request("doc/discard", { jobId: mismatchBegin.jobId });
  pass("upload size mismatch rejected");

  const cancelBytes = fs.readFileSync(path.join(samples, "sample.txt"));
  const cancelBegin = await client.request("doc/begin", { name: "cancel.txt", size: cancelBytes.length });
  await client.request("doc/chunk", {
    jobId: cancelBegin.jobId,
    offset: 0,
    dataBase64: cancelBytes.subarray(0, 10).toString("base64"),
  });
  const cancelled = await client.request("doc/cancel", { jobId: cancelBegin.jobId });
  assert.equal(cancelled.cancelled, true);
  await client.waitForEvent((event) => event.method === "doc/cancelled" && event.params.jobId === cancelBegin.jobId);
  await assert.rejects(
    client.request("doc/readOutput", { jobId: cancelBegin.jobId, kind: "preview" }),
    (error) => error.code === "badRequest",
  );
  pass("upload cancellation");

  const wrongBegin = await client.request("doc/begin", { name: "wrong.docx", size: 5 });
  await client.request("doc/chunk", { jobId: wrongBegin.jobId, offset: 0, dataBase64: Buffer.from("hello").toString("base64") });
  await client.request("doc/commit", { jobId: wrongBegin.jobId });
  const wrongEvent = await client.waitForEvent((event) => event.method === "doc/error" && event.params.jobId === wrongBegin.jobId);
  assert.ok(["malformed", "unsupported"].includes(wrongEvent.params.code), JSON.stringify(wrongEvent.params));
  pass("corrupt docx error mapping", wrongEvent.params.code);

  const slash = await convert(client, "../../weird/name.md", {}, fs.readFileSync(path.join(samples, "sample.md")));
  assert.equal(slash.terminal, "doc/done", JSON.stringify(slash.params));
  assert.ok(!slash.params.outputs.markdown.name.includes("/"));
  assert.ok(!slash.params.outputs.markdown.name.includes("\\"));
  pass("path traversal in file name sanitized", slash.params.outputs.markdown.name);

  const folderRoot = path.join(workDir, "input-folder");
  fs.mkdirSync(path.join(folderRoot, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(folderRoot, "root.md"), "# root\n\nhello folder\n");
  fs.writeFileSync(path.join(folderRoot, "nested", "inner.txt"), "inner text\n");
  fs.writeFileSync(path.join(folderRoot, "nested", "deeper", "data.csv"), "a,b\n1,2\n");
  fs.writeFileSync(path.join(folderRoot, "nested", "ignore.exe"), "MZ");
  fs.writeFileSync(path.join(folderRoot, ".hidden.md"), "hidden\n");
  fs.mkdirSync(path.join(folderRoot, ".git"));
  fs.writeFileSync(path.join(folderRoot, ".git", "config.md"), "nope\n");

  const scan = await client.request("doc/scanFolder", { dir: folderRoot });
  const scannedFiles = scan.files.map((file) => file.relativePath).sort();
  assert.deepEqual(scannedFiles, ["nested/deeper/data.csv", "nested/inner.txt", "root.md"]);
  assert.equal(scan.skipped, 1);
  assert.equal(scan.truncated, false);
  pass("folder scan filters unsupported and hidden files", scannedFiles.join(","));

  await assert.rejects(client.request("doc/scanFolder", { dir: path.join(folderRoot, "root.md") }), /不是文件夹/);
  await assert.rejects(client.request("doc/scanFolder", { dir: "relative/dir" }), /绝对路径/);
  await assert.rejects(client.request("doc/scanFolder", { dir: path.join(folderRoot, "missing") }), /不存在/);
  pass("folder scan rejects invalid directories");

  const rootEntry = scan.files.find((file) => file.relativePath === "root.md");
  const pathBegin = await client.request("doc/begin", { name: rootEntry.name, size: rootEntry.size, sourcePath: rootEntry.path });
  await assert.rejects(
    client.request("doc/chunk", { jobId: pathBegin.jobId, offset: 0, dataBase64: "eA==" }),
    /不能再接收/,
  );
  const sourceBefore = fs.readFileSync(path.join(folderRoot, "root.md"), "utf8");
  await client.request("doc/commit", { jobId: pathBegin.jobId });
  const pathDone = await client.waitForEvent((event) => event.method === "doc/done" && event.params.jobId === pathBegin.jobId);
  assert.ok(pathDone.params.outputs.markdown.name.startsWith("root"), JSON.stringify(pathDone.params.outputs));
  assert.ok(Number.isFinite(pathDone.params.durationMs));
  const pathPreview = await readAll(client, pathBegin.jobId, "preview");
  assert.ok(pathPreview.includes("hello folder"), pathPreview.slice(0, 80));
  assert.equal(fs.readFileSync(path.join(folderRoot, "root.md"), "utf8"), sourceBefore);
  pass("path-based conversion reads the source in place", pathDone.params.outputs.markdown.name);

  const discardTarget = await convert(client, "sample.md");
  const beforeOutputs = fs.readdirSync(outputDir).sort();
  assert.ok(fs.existsSync(path.join(outputDir, discardTarget.params.outputs.markdown.name)));
  await client.request("doc/discard", { jobId: discardTarget.jobId });
  await assert.rejects(
    client.request("doc/readOutput", { jobId: discardTarget.jobId, kind: "preview" }),
    (error) => error.code === "badRequest",
  );
  const afterOutputs = fs.readdirSync(outputDir).sort();
  assert.deepEqual(afterOutputs, beforeOutputs);
  pass("discard keeps output files, drops preview");

  // ---------- Cloud OCR (mock MinerU + Baidu endpoints) ----------

  const configured = await client.request("doc/setOcrConfig", {
    config: { provider: "mineru", enabled: true, maxPages: 100, mineru: { token: "good-token", modelVersion: "vlm" } },
  });
  assert.equal(configured.config.configured, true);
  assert.equal(configured.config.ready, true);
  assert.equal(configured.config.mineru.tokenHint, "••••oken");
  assert.ok(!JSON.stringify(configured.config).includes("good-token"), "response must not echo the token");
  const storedConfig = JSON.parse(fs.readFileSync(path.join(dataDir, "ocr.json"), "utf8"));
  assert.equal(storedConfig.mineru.token, "good-token");
  pass("setOcrConfig stores secrets and returns masked hints", configured.config.mineru.tokenHint);

  const masked = await client.request("doc/setOcrConfig", { config: { mineru: { token: "••••oken" } } });
  assert.equal(masked.config.configured, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "ocr.json"), "utf8")).mineru.token, "good-token");
  pass("masked token keeps the stored credential");

  await assert.rejects(
    client.request("doc/testOcr", { config: { provider: "mineru", mineru: { token: "bad-token" } } }),
    (error) => error.code === "ocrAuth" && /Token/.test(error.message),
  );
  const mineruTest = await client.request("doc/testOcr", { config: { provider: "mineru" } });
  assert.equal(mineruTest.ok, true);
  pass("testOcr validates MinerU tokens", mineruTest.message);

  const mineruOcr = await convert(client, "scanned.pdf");
  assert.equal(mineruOcr.terminal, "doc/done", JSON.stringify(mineruOcr.params));
  const mineruPreview = await readAll(client, mineruOcr.jobId, "preview");
  assert.ok(mineruPreview.includes("MinerU 识别内容"), mineruPreview.slice(0, 200));
  assert.ok(!mineruPreview.includes("images/"), "image references should be stripped");
  assert.ok(mineruOcr.params.warnings.some((warning) => warning.includes("1 处图片")), JSON.stringify(mineruOcr.params.warnings));
  assert.ok(mineruOcr.params.warnings.some((warning) => warning.includes("MinerU")), JSON.stringify(mineruOcr.params.warnings));
  assert.equal(ocrMock.state.applyBodies[0].files[0].is_ocr, true);
  assert.equal(ocrMock.state.applyBodies[0].files[0].name, "scanned.pdf");
  assert.equal(ocrMock.state.uploaded[0].subarray(0, 5).toString(), "%PDF-");
  pass("MinerU OCR conversion", `warnings=${mineruOcr.params.warnings.length}`);

  await assert.rejects(
    client.request("doc/retryOcr", { jobId: mineruOcr.jobId }),
    (error) => error.code === "badRequest",
  );
  pass("retryOcr rejects jobs that do not need OCR");

  await assert.rejects(
    client.request("doc/testOcr", { config: { provider: "baidu", baidu: { apiKey: "bad-key", secretKey: "x" } } }),
    (error) => error.code === "ocrAuth",
  );
  const baiduConfigured = await client.request("doc/setOcrConfig", {
    config: { provider: "baidu", enabled: true, maxPages: 100, baidu: { apiKey: "good-key", secretKey: "good-secret" } },
  });
  assert.equal(baiduConfigured.config.provider, "baidu");
  assert.equal(baiduConfigured.config.baidu.apiKeyHint, "••••-key");
  assert.ok(!JSON.stringify(baiduConfigured.config).includes("good-secret"), "response must not echo the secret");
  const statusAfterBaidu = await client.request("doc/status");
  assert.equal(statusAfterBaidu.ocr.provider, "baidu");
  assert.equal(statusAfterBaidu.ocr.ready, true);
  const baiduTest = await client.request("doc/testOcr", { config: { provider: "baidu" } });
  assert.equal(baiduTest.ok, true);
  pass("testOcr validates Baidu credentials", baiduTest.message);

  const baiduOcr = await convert(client, "scanned.pdf");
  assert.equal(baiduOcr.terminal, "doc/done", JSON.stringify(baiduOcr.params));
  const baiduPreview = await readAll(client, baiduOcr.jobId, "preview");
  assert.ok(baiduPreview.includes("百度 OCR 识别结果第二行内容"), baiduPreview.slice(0, 200));
  assert.ok(ocrMock.state.baiduCalls.length >= 1);
  const baiduCall = ocrMock.state.baiduCalls[0];
  assert.equal(baiduCall.token, "baidu-token");
  assert.equal(baiduCall.languageType, "CHN_ENG");
  assert.ok(baiduCall.imageLength > 1000, `base64 image too small: ${baiduCall.imageLength}`);
  pass("Baidu OCR conversion", `calls=${ocrMock.state.baiduCalls.length} base64=${baiduCall.imageLength}`);

  await client.request("doc/setOcrConfig", { config: { maxPages: 1 } });
  const limited = await convert(client, "scanned-2p.pdf");
  assert.equal(limited.terminal, "doc/error", JSON.stringify(limited.params));
  assert.equal(limited.params.code, "ocrPageLimit", JSON.stringify(limited.params));
  const keptLimitedSource = path.join(dataDir, "temp", limited.jobId, "source.pdf");
  assert.ok(fs.existsSync(keptLimitedSource), "page-limit failure should keep the uploaded PDF");

  const limitedRetryStart = client.events.length;
  await client.request("doc/retryOcr", { jobId: limited.jobId });
  const stillLimited = await waitForNewEvent(
    client,
    limitedRetryStart,
    (event) => event.params.jobId === limited.jobId && event.method === "doc/error",
  );
  assert.equal(stillLimited.params.code, "ocrPageLimit", JSON.stringify(stillLimited.params));

  await client.request("doc/setOcrConfig", { config: { maxPages: 5 } });
  const fixedRetryStart = client.events.length;
  await client.request("doc/retryOcr", { jobId: limited.jobId });
  const fixedRetry = await waitForNewEvent(
    client,
    fixedRetryStart,
    (event) => event.params.jobId === limited.jobId && event.method === "doc/done",
  );
  const fixedPreview = await readAll(client, limited.jobId, "preview");
  assert.ok(fixedPreview.includes("百度 OCR 识别结果"), fixedPreview.slice(0, 200));
  assert.ok(!fs.existsSync(keptLimitedSource), "source should be cleaned after a successful retry");
  pass("page limit failure is retryable", `${fixedRetry.params.source.pages} pages`);

  await client.request("doc/setOcrConfig", { config: { enabled: false } });
  const needs = await convert(client, "scanned.pdf");
  assert.equal(needs.params.code, "needsOcr", JSON.stringify(needs.params));
  const keptSource = path.join(dataDir, "temp", needs.jobId, "source.pdf");
  assert.ok(fs.existsSync(keptSource), "needsOcr should keep the uploaded PDF for retry");
  await assert.rejects(
    client.request("doc/retryOcr", { jobId: needs.jobId }),
    (error) => error.code === "ocrNotConfigured",
  );
  await client.request("doc/setOcrConfig", { config: { enabled: true } });
  const needsRetryStart = client.events.length;
  await client.request("doc/retryOcr", { jobId: needs.jobId });
  await waitForNewEvent(client, needsRetryStart, (event) => event.params.jobId === needs.jobId && event.method === "doc/done");
  assert.ok(!fs.existsSync(keptSource), "source should be cleaned after a successful retry");
  pass("needsOcr retries without re-uploading");

  await client.request("doc/setOcrConfig", {
    config: { provider: "mineru", enabled: true, maxPages: 1, mineru: { token: "good-token" } },
  });
  const mineruLimited = await convert(client, "scanned-2p.pdf");
  assert.equal(mineruLimited.params.code, "ocrPageLimit", JSON.stringify(mineruLimited.params));
  pass("MinerU rejects files above the page limit", mineruLimited.params.message);

  await client.request("doc/setOcrConfig", {
    config: { provider: "mineru", maxPages: 10, mineru: { token: "slow-token" } },
  });
  const slowBytes = fs.readFileSync(path.join(samples, "scanned.pdf"));
  const slowBegin = await client.request("doc/begin", { name: "slow.pdf", size: slowBytes.length });
  for (let offset = 0; offset < slowBytes.length; offset += 65536) {
    const slice = slowBytes.subarray(offset, Math.min(offset + 65536, slowBytes.length));
    await client.request("doc/chunk", { jobId: slowBegin.jobId, offset, dataBase64: slice.toString("base64") });
  }
  await client.request("doc/commit", { jobId: slowBegin.jobId, options: {} });
  await client.waitForEvent(
    (event) => event.params.jobId === slowBegin.jobId && event.method === "doc/progress" && String(event.params.stage || "").includes("MinerU"),
  );
  await client.request("doc/cancel", { jobId: slowBegin.jobId });
  await client.waitForEvent((event) => event.params.jobId === slowBegin.jobId && event.method === "doc/cancelled");
  pass("cloud OCR can be cancelled while polling");

  const timedOut = await convert(client, "scanned.pdf");
  assert.equal(timedOut.terminal, "doc/error", JSON.stringify(timedOut.params));
  assert.equal(timedOut.params.code, "ocrTimeout", JSON.stringify(timedOut.params));
  pass("cloud OCR poll timeout is reported");

  await client.request("doc/setOcrConfig", { config: { mineru: { token: "badzip-token" } } });
  const badZip = await convert(client, "scanned.pdf");
  assert.equal(badZip.params.code, "ocrMalformed", JSON.stringify(badZip.params));
  pass("MinerU result without full.md is rejected", badZip.params.message);

  await client.request("doc/setOcrConfig", { config: { mineru: { token: "good-token" } } });

  await client.request("plugin/shutdown");
  await client.close();
  await ocrMock.close();

  const exe = path.join(root, "bin", "windows-x64", "dbx-plugin-doclite.exe");
  if (fs.existsSync(exe)) {
    const launcher = new Client(exe, []);
    clients.push(launcher);
    const handshake = await launcher.request("plugin/initialize", { host: { protocolVersions: [1] }, plugin: { id: manifest.id, version: manifest.version } });
    assert.equal(handshake.protocolVersion, 1);
    const launcherStatus = await launcher.request("doc/status");
    assert.equal(launcherStatus.ready, true);
    const converted = await convert(launcher, "sample.md");
    assert.equal(converted.terminal, "doc/done", JSON.stringify(converted.params));
    await launcher.close();
    pass("launcher exe end-to-end", path.relative(root, exe));
  } else {
    console.log("SKIP  launcher exe not built");
  }

  console.log(`\n${results.length} checks passed`);
}

main()
  .catch(async (error) => {
    console.error(`\nFAIL  ${error && error.stack ? error.stack : error}`);
    for (const client of clients) {
      if (client.stderr) console.error(`--- sidecar stderr ---\n${client.stderr.slice(-4000)}`);
      try { await client.close(); } catch { /* ignore */ }
    }
    process.exit(1);
  })
  .finally(() => {
    // let stdout drain before the process exits
    setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
  });
