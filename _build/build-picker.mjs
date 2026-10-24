import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "launcher", "Picker.cs");
const outDir = path.join(root, "bin", "windows-x64");
const outFile = path.join(outDir, "dbx-doclite-picker.exe");

const candidates = [
  path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const compiler = candidates.find((candidate) => fs.existsSync(candidate));
if (!compiler) {
  console.error("[picker] csc.exe not found; install .NET Framework 4.x");
  process.exit(1);
}

const frameworkDir = path.dirname(compiler);
const references = ["System.Windows.Forms.dll", "System.Drawing.dll"].map((name) => path.join(frameworkDir, name));
for (const reference of references) {
  if (!fs.existsSync(reference)) {
    console.error(`[picker] missing reference assembly ${reference}`);
    process.exit(1);
  }
}

fs.mkdirSync(outDir, { recursive: true });
const result = spawnSync(
  compiler,
  [
    "/nologo",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    ...references.map((reference) => `/r:${reference}`),
    `/out:${outFile}`,
    source,
  ],
  { encoding: "utf8" },
);
if (result.status !== 0) {
  console.error(result.stdout || "");
  console.error(result.stderr || "");
  process.exit(result.status || 1);
}
const size = fs.statSync(outFile).size;
console.log(`[picker] ${path.relative(root, outFile)} ${size} bytes`);
