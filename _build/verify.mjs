import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("D:/nvm/node_global/node_modules/rea-agents/package.json");
const { chromium } = require("playwright-core");

const root = "F:/ai-gongjin/dbx-plugins/dbx-doclite";
const shots = path.join(root, "_build", "shots");
const fixtures = path.join(root, "_build", "fixtures");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(fixtures, { recursive: true });
fs.writeFileSync(path.join(fixtures, "季度计划.txt"), "季度目标\n\n- 完成文档转换插件\n- 验证批量导出\n", "utf8");
fs.writeFileSync(path.join(fixtures, "会议纪要.md"), "# 会议纪要\n\n## 结论\n\n1. 先确认原型\n2. 再开发 sidecar\n", "utf8");

const url = "file:///F:/ai-gongjin/dbx-plugins/dbx-doclite/prototype/index.html";
const results = [];
const errors = [];
const warnings = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`);
}

const browser = await chromium.launch({
  executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1243/chrome-win64/chrome.exe"),
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
  if (msg.type() === "warning") warnings.push(msg.text());
});
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
await page.goto(url);
await page.waitForTimeout(400);

const geom = () => page.evaluate(() => {
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    toolbar: box(".toolbar"),
    queue: box(".queue"),
    preview: box(".preview"),
    drawer: box("#settingsDrawer"),
    queueItems: document.querySelectorAll(".file-item").length,
    drawerOpen: document.querySelector("#settingsDrawer").classList.contains("open"),
    drawerHidden: document.querySelector("#settingsDrawer").getAttribute("aria-hidden"),
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    viewportW: innerWidth,
    viewportH: innerHeight,
    theme: document.documentElement.dataset.theme,
    activeTab: document.querySelector(".tab.active")?.textContent?.trim(),
    selectedName: document.querySelector(".file-item.selected .file-name")?.textContent?.trim(),
    convertLabel: document.querySelector("#convertBtn")?.textContent?.trim(),
    outputPill: document.querySelector("#outputPillText")?.textContent?.trim(),
    stripActive: document.querySelector("#conversionStrip").classList.contains("active")
  };
});

let g = await geom();
check("初始示例队列为 5 个文件", g.queueItems === 5, `items=${g.queueItems}`);
check("工具栏高度 48px", g.toolbar?.h === 48, JSON.stringify(g.toolbar));
check("队列宽度 306px", g.queue?.w === 306, JSON.stringify(g.queue));
check("预览区占据剩余宽度", (g.preview?.w || 0) > 700, JSON.stringify(g.preview));
check("没有横向溢出", g.scrollW <= g.viewportW, `scrollW=${g.scrollW} viewportW=${g.viewportW}`);
check("设置抽屉默认关闭", g.drawerOpen === false && g.drawerHidden === "true", `open=${g.drawerOpen} aria-hidden=${g.drawerHidden}`);
check("默认选中首个示例文件", g.selectedName === "产品需求文档.pdf", String(g.selectedName));
check("默认预览 tab 激活", g.activeTab === "预览", String(g.activeTab));
check("主按钮文案正确", g.convertLabel === "开始转换", String(g.convertLabel));
check("输出摘要显示两种格式", g.outputPill === "Markdown + JSON", String(g.outputPill));
await page.screenshot({ path: path.join(shots, "01-light-initial.png") });

// 切换 JSON / 结构 tab
await page.click('.tab[data-tab="json"]');
await page.waitForTimeout(150);
const jsonText = await page.locator(".code-block").textContent().catch(() => "");
check("JSON tab 渲染 Document Model", /blocks|meta|document/i.test(jsonText || ""), (jsonText || "").slice(0, 60));
await page.screenshot({ path: path.join(shots, "02-light-json-tab.png") });
await page.click('.tab[data-tab="structure"]');
await page.waitForTimeout(150);
const structureRows = await page.locator(".tree-row").count();
check("结构 tab 有可枚举的块", structureRows > 0, `rows=${structureRows}`);
await page.click('.tab[data-tab="preview"]');

// 扫描件 -> 配置 OCR 打开抽屉并聚焦入口
await page.click('.file-item[data-id="demo-scan"]');
await page.waitForTimeout(200);
await page.click("[data-open-ocr]");
await page.waitForTimeout(350);
const ocrFlow = await page.evaluate(() => ({
  open: document.querySelector("#settingsDrawer").classList.contains("open"),
  focused: document.activeElement?.id,
  ocrDisabled: document.querySelector(".drawer-body .switch:disabled")?.getAttribute("aria-checked")
}));
check("需要 OCR 时可直接打开设置并聚焦 OCR", ocrFlow.open === true && ocrFlow.focused === "configOcr" && ocrFlow.ocrDisabled === "false", JSON.stringify(ocrFlow));
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.click('.file-item[data-id="demo-prd"]');
await page.waitForTimeout(150);

// 设置抽屉
await page.click("#settingsBtn");
await page.waitForTimeout(350);
g = await geom();
check("设置抽屉打开", g.drawerOpen === true && g.drawerHidden === "false", `open=${g.drawerOpen}`);
check("设置抽屉宽度 342px", g.drawer?.w === 342, JSON.stringify(g.drawer));
check("抽屉在视口右侧", Math.abs((g.drawer?.x || 0) + (g.drawer?.w || 0) - g.viewportW) <= 1, `x=${g.drawer?.x} w=${g.drawer?.w} vw=${g.viewportW}`);
await page.screenshot({ path: path.join(shots, "03-settings-open.png") });

// 输出格式至少保留一种
await page.click("#swMarkdown");
await page.click("#swJson");
await page.waitForTimeout(120);
const switches = await page.evaluate(() => ({
  md: document.querySelector("#swMarkdown").getAttribute("aria-checked"),
  json: document.querySelector("#swJson").getAttribute("aria-checked"),
  toast: [...document.querySelectorAll(".toast")].map((n) => n.textContent.trim())
}));
check("关闭 Markdown 后 JSON 仍开启", switches.md === "false" && switches.json === "true", JSON.stringify(switches));
check("阻止关闭最后一种格式并提示", switches.toast.some((t) => t.includes("至少保留一种")), JSON.stringify(switches.toast));
await page.click("#swMarkdown"); // 恢复
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
g = await geom();
check("Esc 关闭设置抽屉", g.drawerOpen === false, `open=${g.drawerOpen}`);

// 暗色主题
await page.click("#themeBtn");
await page.waitForTimeout(300);
g = await geom();
check("切换到暗色主题", g.theme === "dark", String(g.theme));
const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await page.screenshot({ path: path.join(shots, "04-dark-initial.png") });

// 添加两个真实文件并批量转换（验证进度不再被历史完成项抬高）
await page.setInputFiles("#fileInput", [
  path.join(fixtures, "季度计划.txt"),
  path.join(fixtures, "会议纪要.md")
]);
await page.waitForTimeout(300);
g = await geom();
check("添加文件后队列为 7", g.queueItems === 7, `items=${g.queueItems}`);
await page.click("#convertBtn");
await page.waitForTimeout(140);
const firstPct = await page.evaluate(() => parseInt(document.querySelector("#stripPercent").textContent, 10));
const firstText = await page.evaluate(() => document.querySelector("#stripText").textContent.trim());
check("转换进度不包含历史完成文件", Number.isFinite(firstPct) && firstPct < 25, `pct=${firstPct} text=${firstText}`);
const singleConvertDisabled = await page.locator("[data-convert-file]").isDisabled().catch(() => null);
check("批量转换中禁用单文件转换按钮", singleConvertDisabled === true, `disabled=${singleConvertDisabled}`);
await page.waitForTimeout(550);
const midPct = await page.evaluate(() => parseInt(document.querySelector("#stripPercent").textContent, 10));
const stripActiveMid = await page.evaluate(() => document.querySelector("#conversionStrip").classList.contains("active"));
await page.screenshot({ path: path.join(shots, "05-dark-converting.png") });
check("转换中进度条可见且递增", stripActiveMid === true && midPct >= firstPct, `first=${firstPct} mid=${midPct}`);
const finished = await page.waitForFunction(
  () => !document.querySelector("#conversionStrip").classList.contains("active"),
  null,
  { timeout: 15000 }
).then(() => true).catch(() => false);
check("批量转换在超时前结束", finished === true);
await page.waitForTimeout(250);
const statuses = await page.evaluate(() => ({
  done: document.querySelectorAll('.file-item[data-status="done"]').length,
  ready: document.querySelectorAll('.file-item[data-status="ready"]').length,
  needsOcr: document.querySelectorAll('.file-item[data-status="needsOcr"]').length,
  failed: document.querySelectorAll('.file-item[data-status="failed"]').length
}));
check("转换后结果为 5 完成 / 1 需 OCR / 1 失败", statuses.done === 5 && statuses.ready === 0 && statuses.needsOcr === 1 && statuses.failed === 1, JSON.stringify(statuses));
await page.screenshot({ path: path.join(shots, "06-dark-done.png") });

// 取消转换后文件应回到待转换
await page.setInputFiles("#fileInput", [path.join(fixtures, "季度计划.txt")]);
await page.waitForTimeout(250);
await page.click("#convertBtn");
await page.waitForTimeout(260);
await page.click("#cancelBtn");
await page.waitForTimeout(450);
const cancelState = await page.evaluate(() => ({
  stripActive: document.querySelector("#conversionStrip").classList.contains("active"),
  ready: document.querySelectorAll('.file-item[data-status="ready"]').length,
  done: document.querySelectorAll('.file-item[data-status="done"]').length,
  toast: [...document.querySelectorAll(".toast")].map((n) => n.textContent.trim())
}));
check("取消后进度条停止", cancelState.stripActive === false, JSON.stringify(cancelState));
check("取消的文件回到待转换", cancelState.ready === 1, JSON.stringify(cancelState));

// 移出队列 + 撤销
const beforeRemove = await page.evaluate(() => document.querySelectorAll(".file-item").length);
await page.click("#removeBtn");
await page.waitForTimeout(220);
const afterRemove = await page.evaluate(() => ({
  count: document.querySelectorAll(".file-item").length,
  toast: [...document.querySelectorAll(".toast")].map((n) => n.textContent.trim())
}));
check("移出队列生效", afterRemove.count === beforeRemove - 1, `before=${beforeRemove} after=${afterRemove.count}`);
const undoBtn = page.locator(".toast-action").last();
if (await undoBtn.count()) {
  await undoBtn.click();
  await page.waitForTimeout(220);
}
const afterUndo = await page.evaluate(() => document.querySelectorAll(".file-item").length);
check("撤销后文件恢复", afterUndo === beforeRemove, `afterUndo=${afterUndo} expected=${beforeRemove}`);

// 窄窗口布局
await page.setViewportSize({ width: 1180, height: 760 });
await page.waitForTimeout(350);
g = await geom();
check("1180 宽仍无横向溢出", g.scrollW <= g.viewportW, `scrollW=${g.scrollW} vw=${g.viewportW}`);
check("1180 宽预览区仍可用", (g.preview?.w || 0) > 500, JSON.stringify(g.preview));
await page.screenshot({ path: path.join(shots, "07-narrow-1180.png") });

// 空状态
await page.setViewportSize({ width: 1440, height: 900 });
await page.click("#clearBtn");
await page.waitForTimeout(300);
const emptyState = await page.evaluate(() => ({
  count: document.querySelectorAll(".file-item").length,
  emptyVisible: !!document.querySelector(".empty-state, .preview-empty, .empty"),
  text: document.querySelector(".preview")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 90)
}));
check("清空后展示空状态", emptyState.count === 0 && emptyState.emptyVisible === true, JSON.stringify(emptyState));
await page.screenshot({ path: path.join(shots, "08-empty.png") });

check("无控制台错误", errors.length === 0, errors.join(" || "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log("\n==== SUMMARY ====");
console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
if (warnings.length) console.log("warnings:", warnings.slice(0, 5));
fs.writeFileSync(path.join(shots, "report.json"), JSON.stringify({ results, errors, warnings, darkBg }, null, 2));
process.exitCode = failed.length ? 1 : 0;
