import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createZip, listFiles } from "./lib/zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const outDir = path.join(root, "dist");
const outFile = path.join(outDir, `dbx-doclite-${manifest.version}.dbxp`);

const ignoredRoots = new Set([
  "_build",
  "prototype",
  "dist",
  "launcher",
  "node_modules",
  ".git",
  ".dbx-dev-data",
]);
const ignoredFiles = new Set([".gitignore", "checksums.json", "signature.json"]);

const files = listFiles(root, {
  ignore: (relative) => {
    const top = relative.split("/")[0];
    return ignoredRoots.has(top) || ignoredFiles.has(relative);
  },
});

const required = [
  "backend/vendor/node/node.exe",
  "backend/vendor/node/LICENSE",
  "bin/windows-x64/dbx-plugin-doclite.exe",
  "bin/windows-x64/dbx-doclite-picker.exe",
];
const present = new Set(files.map((file) => file.relative));
for (const relative of required) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    console.error(`[package] missing ${relative}; run prepare-vendor, build-launcher and build-picker first`);
    process.exit(1);
  }
  if (!present.has(relative)) files.push({ absolute, relative });
}
files.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));

const uiEntry = path.join(root, manifest.entrypoints.ui.entry);
if (!fs.existsSync(uiEntry)) {
  console.error(`[package] missing UI entry ${manifest.entrypoints.ui.entry}`);
  process.exit(1);
}
const backendEntry = path.join(root, manifest.entrypoints.backend.executable);
if (!fs.existsSync(backendEntry)) {
  console.error(`[package] missing backend ${manifest.entrypoints.backend.executable}`);
  process.exit(1);
}

let totalBytes = 0;
for (const file of files) {
  const stat = fs.statSync(file.absolute);
  totalBytes += stat.size;
  if (stat.size > 256 * 1024 * 1024) {
    console.error(`[package] ${file.relative} exceeds the 256 MB per-file limit`);
    process.exit(1);
  }
}
if (files.length > 10000) {
  console.error(`[package] ${files.length} files exceeds the 10000-file limit`);
  process.exit(1);
}
if (totalBytes > 1024 * 1024 * 1024) {
  console.error(`[package] ${totalBytes} bytes exceeds the 1 GB unpacked limit`);
  process.exit(1);
}

const checksums = { algorithm: "sha256", files: {} };
for (const file of files) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file.absolute)).digest("hex");
  checksums.files[file.relative] = hash;
}
const checksumData = Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`, "utf8");

fs.mkdirSync(outDir, { recursive: true });
createZip(outFile, [
  ...files.map((file) => ({ name: file.relative, path: file.absolute })),
  { name: "checksums.json", data: checksumData },
]);

const archiveBytes = fs.statSync(outFile).size;
if (archiveBytes > 512 * 1024 * 1024) {
  console.error(`[package] archive is ${archiveBytes} bytes, above the 512 MB limit`);
  process.exit(1);
}

const tar = path.join(process.env.WINDIR || "C:/Windows", "System32", "tar.exe");
if (fs.existsSync(tar)) {
  const listing = spawnSync(tar, ["-tf", outFile], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listing.status !== 0) {
    console.error(listing.stderr || "archive listing failed");
    process.exit(1);
  }
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  const expected = new Set([...files.map((file) => file.relative), "checksums.json"]);
  for (const name of expected) {
    if (!entries.includes(name)) {
      console.error(`[package] archive is missing ${name}`);
      process.exit(1);
    }
  }
  console.log(`[package] archive entries: ${entries.length}`);
}

const sha256 = crypto.createHash("sha256").update(fs.readFileSync(outFile)).digest("hex");
console.log(`[package] files=${files.length + 1} unpacked=${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`[package] ${path.relative(root, outFile)} ${(archiveBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`[package] sha256 ${sha256}`);
