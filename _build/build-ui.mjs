import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "_build", "ui-app.js");
const htmlPath = path.join(root, "ui", "index.html");

const source = fs.readFileSync(sourcePath, "utf8").trim();
const html = fs.readFileSync(htmlPath, "utf8");
const pattern = /<script>\n([\s\S]*?)\n<\/script>/;
if (!pattern.test(html)) {
  console.error("[ui] inline script block not found in ui/index.html");
  process.exit(1);
}
const next = html.replace(pattern, () => `<script>\n${source}\n</script>`);
if (next === html) {
  console.log("[ui] ui/index.html already in sync");
} else {
  fs.writeFileSync(htmlPath, next, "utf8");
  console.log(`[ui] synced ${source.length} chars into ui/index.html`);
}
