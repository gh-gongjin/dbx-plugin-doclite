import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("D:/nvm/node_global/node_modules/rea-agents/node_modules/playwright-core");

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "shots");
const pageUrl = pathToFileURL(path.join(here, "..", "prototype", "word-export.html")).href;

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

const browser = await chromium.launch({
  executablePath: "C:/Users/zhcx/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto(pageUrl);
await page.waitForTimeout(400);

// 1. 首屏
check("队列渲染 5 个文件", (await page.locator(".file-item").count()) === 5);
check("默认选中年度经营分析.pdf", (await page.locator(".file-item.selected .file-name").innerText()) === "年度经营分析.pdf");
check("Word 版式标签为激活态", await page.locator('.tab[data-tab="word"].active').count() === 1);
check("还原说明条可见", await page.locator(".fidelity-bar").isVisible());
check("A4 纸张渲染 2 页", (await page.locator(".word-sheet").count()) === 2);
check("续页表头重复标注存在", (await page.locator(".ws-callout").count()) === 1);
check("图片未嵌入占位可见", (await page.locator(".ws-figure-missing").count()) === 1);
check("保存 Word 按钮可用", !(await page.locator("#wordBtn").isDisabled()));
check("底部统计为 5 个文件", (await page.locator("#queueFootText").innerText()).includes("5 个文件"));
await page.screenshot({ path: path.join(shots, "proto-word-01-overview.png") });

// 2. 保存 Word（单文件）
await page.locator("#wordBtn").click();
await page.waitForTimeout(200);
check("保存弹窗打开", await page.locator("#modalBackdrop.show").isVisible());
check("弹窗默认文件名为 .docx", (await page.locator("#saveName").inputValue()) === "年度经营分析.pdf".replace(/\.pdf$/, "") + ".docx");
await page.screenshot({ path: path.join(shots, "proto-word-02-save-dialog.png") });
await page.locator("#modal [data-confirm]").click();
await page.waitForTimeout(300);
check("保存中按钮显示生成中", (await page.locator("#wordBtnText").innerText()) === "生成中");
await page.waitForTimeout(900);
check("保存后按钮变为已保存 Word", (await page.locator("#wordBtnText").innerText()) === "已保存 Word");
check("队列行显示 Word 已保存", (await page.locator('[data-meta="f1"]').innerText()).includes("Word 已保存"));
check("成功提示出现", (await page.locator(".toast").count()) >= 1);
await page.screenshot({ path: path.join(shots, "proto-word-03-saved.png") });

// 3. 扫描件：Word 不可用
await page.locator('.file-item[data-id="f3"]').click();
await page.waitForTimeout(200);
check("扫描件保存 Word 置灰", await page.locator("#wordBtn").isDisabled());
check("扫描件提示为未识别到文字", (await page.locator(".state-title").innerText()).includes("未识别到文字"));
check("扫描件仍可看到 OCR 入口", (await page.locator('[data-action^="ocr:"]').count()) === 1);
await page.screenshot({ path: path.join(shots, "proto-word-04-scanned.png") });

// 4. 加密文件
await page.locator('.file-item[data-id="f5"]').click();
await page.waitForTimeout(200);
check("加密文件显示失败态", (await page.locator(".state-title").innerText()).includes("加密"));
check("加密文件 Word 置灰", await page.locator("#wordBtn").isDisabled());

// 5. 待转换 -> 转换（转换队列）
await page.locator('.file-item[data-id="f4"]').click();
await page.waitForTimeout(200);
check("待转换文件显示未转换面板", (await page.locator(".state-title").innerText()).includes("尚未转换"));
await page.locator('[data-action^="convert:"]').click();
await page.waitForTimeout(600);
check("转换条出现", await page.locator("#conversionStrip.active").isVisible());
const f4Meta = await page.locator('[data-meta="f4"]').innerText();
check("待转文件进入转换流水线（排队中或转换中）", /排队中|转换中/.test(f4Meta), f4Meta);
await page.waitForFunction(() => {
  const meta = document.querySelector('[data-meta="f4"]');
  return meta && meta.textContent.includes("Word 约");
}, null, { timeout: 40000 });
check("转换完成后可保存 Word", !(await page.locator("#wordBtn").isDisabled()));
check("转换完成后队列显示已转换", !(await page.locator('[data-meta="f4"]').innerText()).includes("待转换"));
await page.screenshot({ path: path.join(shots, "proto-word-05-converted.png") });

// 6. 还原说明弹窗
await page.locator('.file-item[data-id="f1"]').click();
await page.waitForTimeout(150);
await page.locator('[data-action="fidelity"]').click();
await page.waitForTimeout(200);
check("还原说明弹窗打开", await page.locator("#modalBackdrop.show").isVisible());
check("保留/不保留两列齐全", (await page.locator(".keep-col").count()) === 2);
await page.screenshot({ path: path.join(shots, "proto-word-06-fidelity.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Esc 关闭弹窗", (await page.locator("#modalBackdrop.show").count()) === 0);

// 7. 批量保存
await page.locator("#saveAllBtn").click();
await page.waitForTimeout(200);
check("批量保存弹窗列出多个文件", (await page.locator(".save-item").count()) >= 2);
await page.screenshot({ path: path.join(shots, "proto-word-07-batch.png") });
await page.locator("#modal [data-close]").first().click();
await page.waitForTimeout(150);

// 8. 暗色主题
await page.locator("#themeBtn").click();
await page.waitForTimeout(250);
check("切换到暗色主题", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
await page.screenshot({ path: path.join(shots, "proto-word-08-dark.png") });

// 9. 其它标签页
await page.locator("#themeBtn").click();
await page.waitForTimeout(150);
await page.locator('.tab[data-tab="preview"]').click();
await page.waitForTimeout(200);
check("预览标签渲染文档", (await page.locator(".doc-sheet .prose h1").count()) === 1);
await page.locator('.tab[data-tab="markdown"]').click();
await page.waitForTimeout(150);
check("Markdown 标签渲染源码", (await page.locator(".code-block code").count()) === 1);
await page.locator('.tab[data-tab="structure"]').click();
await page.waitForTimeout(150);
check("结构标签渲染块树", (await page.locator(".tree-row").count()) >= 10);
await page.screenshot({ path: path.join(shots, "proto-word-09-structure.png") });

check("浏览器控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
if (failed.length) {
  failed.forEach((item) => console.log(`  - ${item.name} ${item.extra}`));
  process.exit(1);
}
