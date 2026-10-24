import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "backend", "vendor");
const docliteRoot = process.env.DOCLITE_ROOT || "F:/ai-project-workspace/DocLite";
const modulesDir = path.join(docliteRoot, "node_modules");
const skipNode = process.argv.includes("--skip-node");

function fail(message) {
  console.error(`[vendor] ${message}`);
  process.exit(1);
}

function copy(from, to) {
  if (!fs.existsSync(from)) fail(`missing source file: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function reset(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

fs.mkdirSync(vendorDir, { recursive: true });

const ocrModulesDir = path.join(root, "_build", "ocr-deps", "node_modules");

const anydocDir = path.join(vendorDir, "anydoc");
reset(anydocDir);
for (const name of ["anydoc.js", "index.js", "package.json"]) {
  copy(path.join(modulesDir, "@firecrawl", "anydoc", name), path.join(anydocDir, name));
}
copy(
  path.join(modulesDir, "@firecrawl", "anydoc-win32-x64-msvc", "anydoc.win32-x64-msvc.node"),
  path.join(anydocDir, "anydoc.win32-x64-msvc.node"),
);

const pdfDir = path.join(vendorDir, "pdf-inspector");
reset(pdfDir);
for (const name of ["index.js", "package.json"]) {
  copy(path.join(modulesDir, "@firecrawl", "pdf-inspector", name), path.join(pdfDir, name));
}
copy(
  path.join(modulesDir, "@firecrawl", "pdf-inspector-win32-x64-msvc", "pdf-inspector.win32-x64-msvc.node"),
  path.join(pdfDir, "pdf-inspector.win32-x64-msvc.node"),
);

const pdfiumSource = path.join(ocrModulesDir, "@hyzyla", "pdfium");
const pdfiumDir = path.join(vendorDir, "pdfium");
reset(pdfiumDir);
copy(path.join(pdfiumSource, "package.json"), path.join(pdfiumDir, "package.json"));
copy(path.join(pdfiumSource, "LICENSE.md"), path.join(pdfiumDir, "LICENSE.md"));
copy(path.join(pdfiumSource, "dist", "index.cjs"), path.join(pdfiumDir, "dist", "index.cjs"));
copy(path.join(pdfiumSource, "dist", "pdfium.wasm"), path.join(pdfiumDir, "dist", "pdfium.wasm"));

const jpegSource = path.join(ocrModulesDir, "jpeg-js");
const jpegDir = path.join(vendorDir, "jpeg-js");
reset(jpegDir);
for (const name of ["index.js", "package.json", "LICENSE"]) {
  copy(path.join(jpegSource, name), path.join(jpegDir, name));
}
fs.mkdirSync(path.join(jpegDir, "lib"), { recursive: true });
for (const name of fs.readdirSync(path.join(jpegSource, "lib"))) {
  copy(path.join(jpegSource, "lib", name), path.join(jpegDir, "lib", name));
}

const versions = {
  node: null,
  anydoc: JSON.parse(fs.readFileSync(path.join(anydocDir, "package.json"), "utf8")).version,
  pdfInspector: JSON.parse(fs.readFileSync(path.join(pdfDir, "package.json"), "utf8")).version,
  pdfium: JSON.parse(fs.readFileSync(path.join(pdfiumDir, "package.json"), "utf8")).version,
  jpegJs: JSON.parse(fs.readFileSync(path.join(jpegDir, "package.json"), "utf8")).version,
  files: {},
};

for (const relative of [
  "anydoc/anydoc.js",
  "anydoc/index.js",
  "anydoc/anydoc.win32-x64-msvc.node",
  "pdf-inspector/index.js",
  "pdf-inspector/pdf-inspector.win32-x64-msvc.node",
  "pdfium/dist/index.cjs",
  "pdfium/dist/pdfium.wasm",
  "jpeg-js/index.js",
]) {
  versions.files[relative] = sha256(path.join(vendorDir, relative));
}
for (const name of fs.readdirSync(path.join(jpegDir, "lib"))) {
  versions.files[`jpeg-js/lib/${name}`] = sha256(path.join(jpegDir, "lib", name));
}

if (!skipNode) {
  const nodeDir = path.join(vendorDir, "node");
  reset(nodeDir);
  const nodeExe = process.env.NODE_EXE || process.execPath;
  copy(nodeExe, path.join(nodeDir, "node.exe"));
  const license = path.join(path.dirname(nodeExe), "LICENSE");
  if (fs.existsSync(license)) copy(license, path.join(nodeDir, "LICENSE"));
  const probe = spawnSync(nodeExe, ["-p", "process.versions.node"], { encoding: "utf8" });
  versions.node = (probe.stdout || "").trim() || null;
  versions.files["node/node.exe"] = sha256(path.join(nodeDir, "node.exe"));
}

fs.writeFileSync(path.join(vendorDir, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`, "utf8");

const check = spawnSync(
  process.env.NODE_EXE || process.execPath,
  [
    "-e",
    "const a=require('./anydoc/anydoc.js');const p=require('./pdf-inspector/index.js');const f=require('./pdfium/dist/index.cjs');const j=require('./jpeg-js');console.log(JSON.stringify({anydoc:require('./anydoc/package.json').version,pdf:require('./pdf-inspector/package.json').version,pdfium:typeof f.PDFiumLibrary,jpeg:typeof j.encode,classify:typeof p.classifyPdfAsync,toMarkdown:typeof a.toMarkdown}))",
  ],
  { cwd: vendorDir, encoding: "utf8" },
);
if (check.status !== 0) {
  fail(`vendored modules failed to load:\n${check.stderr || check.stdout}`);
}
console.log(`[vendor] ${check.stdout.trim()}`);
console.log(`[vendor] node ${versions.node || "(skipped)"} -> ${vendorDir}`);
