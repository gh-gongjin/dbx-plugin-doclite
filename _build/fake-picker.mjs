import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Compiles the folder-picker test double. Returns its path, or null when no
 * C# compiler is available on this machine.
 */
export function buildFakePicker() {
  const outFile = path.join(root, "_build", ".tmp", "fake-picker.exe");
  const source = path.join(root, "_build", "fake-picker.cs");
  if (fs.existsSync(outFile) && fs.statSync(outFile).mtimeMs >= fs.statSync(source).mtimeMs) return outFile;
  const candidates = [
    path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const compiler = candidates.find((candidate) => fs.existsSync(candidate));
  if (!compiler) return null;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const result = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", `/out:${outFile}`, source], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    return null;
  }
  return outFile;
}
