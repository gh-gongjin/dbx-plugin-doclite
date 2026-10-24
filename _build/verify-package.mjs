import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startOcrMock } from "./lib/ocr-mock.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("F:/ai-project-workspace/DocLite/node_modules/ajv/dist/2020.js").default;
const semver = require("F:/ai-project-workspace/DocLite/node_modules/semver");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbxRoot = path.resolve(root, "..", "..", "dbx");
const schemaPath = path.join(dbxRoot, "plugins", "manifest.schema.json");
const runtimeManifestPath = path.join(dbxRoot, "crates", "dbx-plugin-runtime", "src", "plugins", "manifest.rs");
const archivePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "dist", `dbx-doclite-${JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version}.dbxp`);
const checkDir = path.join(root, "_build", ".tmp", "package-check");
const samplePath = path.join(root, "_build", "samples", "sample.txt");
const expectedDbxVersion = process.env.DBX_VERSION || "0.6.51";

const checks = [];
function pass(name, detail = "") {
  checks.push({ name, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertSafeName(name, label) {
  assert.ok(name.length > 0, `${label}: 空路径`);
  assert.ok(!name.includes("\0"), `${label}: 含 NUL 字符`);
  assert.ok(!name.includes("\\"), `${label}: 使用反斜杠 ${name}`);
  assert.ok(!name.startsWith("/"), `${label}: 绝对路径 ${name}`);
  assert.ok(!/^[A-Za-z]:/.test(name), `${label}: 盘符路径 ${name}`);
  const parts = name.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), `${label}: 路径穿越 ${name}`);
  const resolved = path.resolve(checkDir, ...parts);
  assert.ok(resolved.startsWith(`${checkDir}${path.sep}`), `${label}: 解析后越界 ${name}`);
  return parts;
}

function readZipEntries(archive) {
  const data = fs.readFileSync(archive);
  let eocd = -1;
  const minOffset = Math.max(0, data.length - 22 - 0xffff);
  for (let offset = data.length - 22; offset >= minOffset; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.ok(eocd >= 0, "ZIP 缺少 EOCD");
  const disk = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const countOnDisk = data.readUInt16LE(eocd + 8);
  const count = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  assert.equal(disk, 0, "不支持分卷 ZIP");
  assert.equal(centralDisk, 0, "不支持分卷 ZIP");
  assert.equal(countOnDisk, count, "ZIP 条目计数不一致");
  assert.ok(centralOffset + centralSize <= eocd, "ZIP 中央目录越界");
  assert.ok(count > 0 && count < 0xffff, "不支持 ZIP64 或空包");

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50, `中央目录条目 ${index} 签名错误`);
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const checksum = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    assert.equal(flags & 0x0001, 0, `${name}: 不允许加密条目`);
    assert.ok([0, 8].includes(method), `${name}: 不支持的压缩方式 ${method}`);
    assert.notEqual(compressedSize, 0xffffffff, `${name}: 不支持 ZIP64`);
    assert.notEqual(size, 0xffffffff, `${name}: 不支持 ZIP64`);
    assert.ok(localOffset + 30 + nameLength <= centralOffset, `${name}: 本地头越界`);
    assert.equal(data.readUInt32LE(localOffset), 0x04034b50, `${name}: 本地头签名错误`);
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    assert.equal(data.readUInt16LE(localOffset + 8), method, `${name}: 本地头压缩方式不一致`);
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(
      data.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    assert.equal(localName, name, `${name}: 本地头文件名不一致`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assert.ok(dataOffset + compressedSize <= centralOffset, `${name}: 数据段越界`);
    const payload = data.subarray(dataOffset, dataOffset + compressedSize);
    const unpacked = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(unpacked.length, size, `${name}: 解压后大小不符`);
    assert.equal(crc32(unpacked), checksum, `${name}: CRC32 不符`);
    entries.push({ name, size, unpacked });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, centralOffset + centralSize, "ZIP 中央目录长度不符");
  return { entries, archiveSize: data.length };
}

function writeExtracted(entries) {
  fs.mkdirSync(checkDir, { recursive: true });
  for (const entry of entries) {
    const parts = assertSafeName(entry.name, "条目");
    const target = path.resolve(checkDir, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.unpacked);
  }
}

function walkFiles(directory) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.push(path.relative(checkDir, absolute).split(path.sep).join("/"));
      else assert.fail(`解包目录含非普通文件：${absolute}`);
    }
  };
  visit(directory);
  return found.sort();
}

function checkPe(file, label) {
  const header = fs.readFileSync(file);
  assert.equal(header.readUInt16LE(0), 0x5a4d, `${label}: 缺少 MZ 头`);
  const peOffset = header.readUInt32LE(0x3c);
  assert.equal(header.readUInt32LE(peOffset), 0x00004550, `${label}: 缺少 PE 头`);
  assert.equal(header.readUInt16LE(peOffset + 4), 0x8664, `${label}: 不是 x64 PE`);
}

class Client {
  constructor(command, args, options = {}) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.sequence = 0;
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`stdout 出现非 JSON 行：${line.slice(0, 200)}`);
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message);
          error.code = message.error.data && message.error.data.code;
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
        waiter.reject(new Error(`进程提前退出 (${code ?? signal})；stderr: ${this.stderr.slice(-2000)}`));
      }
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`进程提前退出 (${code ?? signal})；stderr: ${this.stderr.slice(-2000)}`));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 120000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时：${method}；stderr: ${this.stderr.slice(-2000)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  waitForEvent(predicate, timeoutMs = 120000) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`等待事件超时；stderr: ${this.stderr.slice(-2000)}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {
      /* 已关闭 */
    }
    await new Promise((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          this.child.kill();
        } catch {
          /* 已退出 */
        }
        resolve();
      }, 5000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function smokeTestLauncher(packageDir, manifest) {
  const executable = path.join(packageDir, manifest.entrypoints.backend.executable);
  const dataDir = path.join(checkDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const client = new Client(executable, [], {
    cwd: packageDir,
    env: {
      ...process.env,
      DBX_PLUGIN_DATA_DIR: dataDir,
      DBX_PLUGIN_ID: manifest.id,
      DBX_PLUGIN_VERSION: manifest.version,
      DBX_HOST_API_VERSION: "1.4.0",
    },
  });
  try {
    const initialized = await client.request("plugin/initialize", {
      host: { dbxVersion: expectedDbxVersion, hostApiVersion: "1.4.0", protocolVersions: [1] },
      plugin: { id: manifest.id, version: manifest.version },
      permissions: manifest.permissions,
    });
    assert.equal(initialized.protocolVersion, 1);
    const status = await client.request("doc/status");
    assert.equal(status.ready, true);
    assert.equal(status.engine.anydoc, "0.2.4");
    assert.equal(status.engine.pdfInspector, "1.17.0");
    assert.equal(status.ocr.provider, "mineru");
    assert.equal(status.ocr.enabled, false);
    assert.equal(status.ocr.configured, false);
    assert.equal(status.ocr.ready, false);

    const bytes = fs.readFileSync(samplePath);
    const begin = await client.request("doc/begin", { name: "verify-sample.txt", size: bytes.length });
    const jobId = begin.jobId;
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      await client.request("doc/chunk", { jobId, offset, dataBase64: slice.toString("base64") });
    }
    await client.request("doc/commit", {
      jobId,
      options: { formats: { markdown: true, json: true }, naming: "original" },
    });
    const terminal = await client.waitForEvent(
      (event) => event.params && event.params.jobId === jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(event.method),
    );
    assert.equal(terminal.method, "doc/done", JSON.stringify(terminal.params));
    const preview = await client.request("doc/readOutput", { jobId, kind: "preview", offset: 0, length: 64 * 1024 });
    const markdown = Buffer.from(preview.dataBase64, "base64").toString("utf8");
    assert.ok(markdown.includes("DocLite 纯文本样例"), "预览内容不符");
    const model = JSON.parse(fs.readFileSync(path.join(dataDir, "output", terminal.params.outputs.json.name), "utf8"));
    assert.equal(model.engine.name, "anydoc");
    assert.ok(model.blocks.length > 0);
    assert.ok(fs.existsSync(path.join(dataDir, "output", terminal.params.outputs.markdown.name)));

    const customDir = path.join(checkDir, "custom-output");
    const customBytes = fs.readFileSync(samplePath);
    const customBegin = await client.request("doc/begin", { name: "verify-custom.txt", size: customBytes.length });
    for (let offset = 0; offset < customBytes.length; offset += chunkSize) {
      const slice = customBytes.subarray(offset, Math.min(offset + chunkSize, customBytes.length));
      await client.request("doc/chunk", { jobId: customBegin.jobId, offset, dataBase64: slice.toString("base64") });
    }
    await client.request("doc/commit", {
      jobId: customBegin.jobId,
      options: { location: "custom", outputDir: customDir },
    });
    const customTerminal = await client.waitForEvent(
      (event) => event.params && event.params.jobId === customBegin.jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(event.method),
    );
    assert.equal(customTerminal.method, "doc/done", JSON.stringify(customTerminal.params));
    assert.equal(customTerminal.params.outputDir, customDir);
    assert.ok(fs.existsSync(path.join(customDir, "verify-custom.md")));
    assert.ok(fs.existsSync(path.join(customDir, "verify-custom.json")));
    const checked = await client.request("doc/checkOutputDir", { dir: customDir });
    assert.equal(checked.exists, true);
    assert.equal(checked.writable, true);
    await client.request("plugin/shutdown");
    return {
      anydoc: status.engine.anydoc,
      pdfInspector: status.engine.pdfInspector,
      outputs: terminal.params.outputs,
      customDir,
    };
  } finally {
    await client.close();
  }
}

async function smokeTestOcr(packageDir, manifest, baseUrl) {
  const executable = path.join(packageDir, manifest.entrypoints.backend.executable);
  const dataDir = path.join(checkDir, "ocr-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const client = new Client(executable, [], {
    cwd: packageDir,
    env: {
      ...process.env,
      DBX_PLUGIN_DATA_DIR: dataDir,
      DBX_PLUGIN_ID: manifest.id,
      DBX_PLUGIN_VERSION: manifest.version,
      DBX_HOST_API_VERSION: "1.4.0",
      DOCLITE_MINERU_BASE_URL: baseUrl,
      DOCLITE_BAIDU_BASE_URL: baseUrl,
      DOCLITE_OCR_POLL_MS: "50",
    },
  });
  try {
    await client.request("plugin/initialize", {
      host: { dbxVersion: expectedDbxVersion, hostApiVersion: "1.4.0", protocolVersions: [1] },
      plugin: { id: manifest.id, version: manifest.version },
      permissions: manifest.permissions,
    });
    const configured = await client.request("doc/setOcrConfig", {
      config: {
        provider: "baidu",
        enabled: true,
        baidu: { apiKey: "verify-key", secretKey: "verify-secret" },
      },
    });
    assert.equal(configured.config.ready, true, JSON.stringify(configured.config));
    const bytes = fs.readFileSync(path.join(root, "_build", "samples", "scanned.pdf"));
    const begin = await client.request("doc/begin", { name: "verify-scanned.pdf", size: bytes.length });
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      await client.request("doc/chunk", { jobId: begin.jobId, offset, dataBase64: slice.toString("base64") });
    }
    await client.request("doc/commit", { jobId: begin.jobId, options: { formats: { markdown: true } } });
    const terminal = await client.waitForEvent(
      (event) => event.params && event.params.jobId === begin.jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(event.method),
    );
    assert.equal(terminal.method, "doc/done", JSON.stringify(terminal.params));
    const preview = await client.request("doc/readOutput", { jobId: begin.jobId, kind: "preview", offset: 0, length: 64 * 1024 });
    const markdown = Buffer.from(preview.dataBase64, "base64").toString("utf8");
    assert.ok(markdown.includes("百度 OCR 识别结果"), "OCR 预览内容不符");
    await client.request("plugin/shutdown");
    return markdown;
  } finally {
    await client.close();
  }
}

async function smokeTestPicker(packageDir) {
  const pickerExe = path.join(packageDir, "bin", "windows-x64", "dbx-doclite-picker.exe");
  const resultFile = path.join(checkDir, "picker-result.json");
  fs.rmSync(resultFile, { force: true });
  const exitCode = await new Promise((resolve) => {
    const child = spawn(pickerExe, ["--result", resultFile, "--auto-select", "D:\\picked"], { stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
  assert.equal(exitCode, 0, "目录选择器退出码异常");
  const payload = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(payload.ok, true);
  assert.equal(payload.path, "D:\\picked");
  return payload.path;
}

async function main() {
  assert.ok(fs.existsSync(archivePath), `安装包不存在：${archivePath}`);
  const archive = fs.readFileSync(archivePath);
  const archiveSize = archive.length;
  assert.ok(archiveSize <= 512 * 1024 * 1024, "安装包超过 512 MB");
  pass("安装包大小", `${(archiveSize / 1024 / 1024).toFixed(1)} MB`);
  pass("安装包 SHA-256", sha256(archive));

  fs.rmSync(checkDir, { recursive: true, force: true });
  fs.mkdirSync(checkDir, { recursive: true });
  const { entries } = readZipEntries(archivePath);
  assert.ok(entries.length <= 10000, "条目数超过 10000");
  let unpackedBytes = 0;
  for (const entry of entries) {
    assert.ok(!entry.name.endsWith("/"), `不允许目录条目：${entry.name}`);
    assertSafeName(entry.name, "ZIP 条目");
    assert.ok(entry.size <= 256 * 1024 * 1024, `${entry.name}: 超过 256 MB`);
    unpackedBytes += entry.size;
  }
  assert.ok(unpackedBytes <= 1024 * 1024 * 1024, "解包后超过 1 GB");
  pass("ZIP 路径安全", `${entries.length} 个文件，无穿越/绝对路径/目录条目`);
  writeExtracted(entries);
  pass("ZIP 完整性", `${entries.length} 个条目 CRC32 与尺寸全部通过`);
  pass("解包后体积", `${(unpackedBytes / 1024 / 1024).toFixed(1)} MB`);
  checkPe(path.join(checkDir, "bin", "windows-x64", "dbx-plugin-doclite.exe"), "launcher");
  checkPe(path.join(checkDir, "backend", "vendor", "node", "node.exe"), "内置 Node");
  checkPe(path.join(checkDir, "bin", "windows-x64", "dbx-doclite-picker.exe"), "目录选择器");
  pass("PE 架构", "launcher、目录选择器与内置 Node 均为 windows-x64");

  const vendorVersions = JSON.parse(fs.readFileSync(path.join(checkDir, "backend", "vendor", "versions.json"), "utf8"));
  assert.equal(vendorVersions.pdfium, "3.0.0");
  assert.equal(vendorVersions.jpegJs, "0.4.4");
  for (const relative of [
    "backend/vendor/pdfium/dist/index.cjs",
    "backend/vendor/pdfium/dist/pdfium.wasm",
    "backend/vendor/jpeg-js/index.js",
  ]) {
    assert.ok(fs.existsSync(path.join(checkDir, ...relative.split("/"))), `缺少 OCR 依赖：${relative}`);
  }
  pass("OCR 依赖", `pdfium ${vendorVersions.pdfium} / jpeg-js ${vendorVersions.jpegJs}`);

  const extractedFiles = walkFiles(checkDir);
  assert.equal(extractedFiles.length, entries.length, "解包文件数与 ZIP 条目数不一致");
  assert.deepEqual(extractedFiles, entries.map((entry) => entry.name).sort(), "解包文件列表与 ZIP 条目不一致");

  const checksumsRaw = fs.readFileSync(path.join(checkDir, "checksums.json"), "utf8");
  const checksums = JSON.parse(checksumsRaw);
  assert.equal(checksums.algorithm, "sha256");
  assert.ok(checksums.files && typeof checksums.files === "object" && !Array.isArray(checksums.files));
  const declaredFiles = Object.keys(checksums.files).sort();
  const expectedFiles = entries
    .map((entry) => entry.name)
    .filter((name) => name !== "checksums.json" && name !== "signature.json")
    .sort();
  assert.deepEqual(declaredFiles, expectedFiles, "checksums.json 未精确覆盖包内文件");
  for (const relative of declaredFiles) {
    assertSafeName(relative, "checksums 路径");
    assert.match(checksums.files[relative], /^[0-9a-f]{64}$/i, `${relative}: 校验和格式错误`);
    const actual = sha256(fs.readFileSync(path.join(checkDir, ...relative.split("/"))));
    assert.equal(actual.toLowerCase(), checksums.files[relative].toLowerCase(), `${relative}: SHA-256 不符`);
  }
  pass("校验和", `${declaredFiles.length} 个文件精确覆盖且全部匹配`);
  assert.ok(!fs.existsSync(path.join(checkDir, "signature.json")), "开发包不应携带未核验的签名");
  pass("签名状态", "未签名（仅“允许未签名开发包 / LocalDevelopment”策略可安装）");

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const manifest = JSON.parse(fs.readFileSync(path.join(checkDir, "manifest.json"), "utf8"));
  if (!validate(manifest)) {
    const details = validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    assert.fail(`manifest 未通过 schema 校验：${details}`);
  }
  pass("Manifest schema", `v${manifest.manifest_version} / ${manifest.id} ${manifest.version}`);

  const runtimeSource = fs.readFileSync(runtimeManifestPath, "utf8");
  const hostApiVersion = /pub const SUPPORTED_PLUGIN_HOST_API_VERSION: &str = "([^"]+)"/.exec(runtimeSource)[1];
  const protocolVersion = Number(/pub const SUPPORTED_PLUGIN_PROTOCOL_VERSION: u32 = (\d+)/.exec(runtimeSource)[1]);
  const permissionBlock = /pub const SUPPORTED_PLUGIN_PERMISSIONS: &\[&str\] = &\[([\s\S]*?)\];/.exec(runtimeSource)[1];
  const supportedPermissions = new Set([...permissionBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]));

  assert.ok(manifest.engines && typeof manifest.engines.host_api === "string");
  for (const [label, key, actual] of [
    ["DBX", "dbx", expectedDbxVersion],
    ["Host API", "host_api", hostApiVersion],
  ]) {
    const requirement = manifest.engines[key];
    if (!requirement) continue;
    assert.ok(semver.validRange(requirement), `${label} 版本范围无效：${requirement}`);
    assert.ok(semver.satisfies(actual, requirement), `插件要求 ${label} ${requirement}，当前 ${actual}`);
  }
  pass("引擎兼容", `DBX ${expectedDbxVersion} / Host API ${hostApiVersion}`);
  for (const permission of manifest.permissions) {
    assert.ok(supportedPermissions.has(permission), `不支持的权限：${permission}`);
  }
  assert.ok(manifest.permissions.includes("host.storage"));
  assert.ok(manifest.permissions.includes("host.events"));
  pass("权限", manifest.permissions.join(", "));

  assert.equal(manifest.entrypoints.backend.transport, "stdio-jsonl");
  assert.ok(manifest.entrypoints.backend.protocol_versions.includes(protocolVersion));
  assert.ok(manifest.entrypoints.ui);
  for (const relative of [manifest.icon, manifest.entrypoints.backend.executable, manifest.entrypoints.ui.entry, ...(manifest.contributions || []).map((item) => item.icon)]) {
    if (!relative) continue;
    assertSafeName(relative, "manifest 路径");
    assert.ok(fs.existsSync(path.join(checkDir, ...relative.split("/"))), `manifest 引用的文件不存在：${relative}`);
  }
  const uiRoot = path.resolve(checkDir, manifest.entrypoints.ui.root || path.dirname(manifest.entrypoints.ui.entry));
  const uiEntry = path.resolve(checkDir, manifest.entrypoints.ui.entry);
  assert.ok(fs.statSync(uiRoot).isDirectory(), "UI root 不是目录");
  assert.ok(uiEntry.startsWith(`${uiRoot}${path.sep}`), "UI entry 不在 UI root 内");
  pass("入口路径", uiEntry.slice(checkDir.length + 1));

  const smoke = await smokeTestLauncher(checkDir, manifest);
  pass("launcher 实包运行", `anydoc ${smoke.anydoc} / pdf-inspector ${smoke.pdfInspector}`);
  pass("实包转换", `${smoke.outputs.markdown.name} + ${smoke.outputs.json.name}`);
  pass("实包自定义目录", path.basename(smoke.customDir));

  const ocrMock = await startOcrMock(path.join(checkDir, "ocr-mock"));
  let ocrCalls = 0;
  try {
    await smokeTestOcr(checkDir, manifest, ocrMock.baseUrl);
    ocrCalls = ocrMock.state.baiduCalls.length;
  } finally {
    await ocrMock.close();
  }
  pass("实包云端 OCR", `百度接口调用 ${ocrCalls} 次，扫描页渲染成功`);

  const picked = await smokeTestPicker(checkDir);
  pass("实包目录选择器", picked);

  console.log(`\n校验通过：${checks.length} 项`);
  console.log(`安装包：${archivePath}`);
}

main().catch((error) => {
  console.error(`\nFAIL  ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
