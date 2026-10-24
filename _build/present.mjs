import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire("D:/nvm/node_global/node_modules/rea-agents/package.json");
const { chromium } = require("playwright-core");
const shots = "F:/ai-gongjin/dbx-plugins/dbx-doclite/_build/shots";
const fixtures = "F:/ai-gongjin/dbx-plugins/dbx-doclite/_build/fixtures";
const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1243/chrome-win64/chrome.exe"), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await page.goto("file:///F:/ai-gongjin/dbx-plugins/dbx-doclite/prototype/index.html");
await page.waitForTimeout(500);

await page.screenshot({ path: path.join(shots, "clean-01-light.png") });

await page.click('.file-item[data-id="demo-scan"]');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(shots, "clean-02-needs-ocr.png") });

await page.click("#settingsBtn");
await page.waitForTimeout(350);
await page.screenshot({ path: path.join(shots, "clean-03-settings.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

await page.click("#themeBtn");
await page.waitForTimeout(350);
await page.screenshot({ path: path.join(shots, "clean-04-dark.png") });

await page.setInputFiles("#fileInput", [path.join(fixtures, "季度计划.txt"), path.join(fixtures, "会议纪要.md")]);
await page.waitForTimeout(3500);
await page.click("#convertBtn");
await page.waitForTimeout(850);
await page.screenshot({ path: path.join(shots, "clean-05-converting.png") });
await page.waitForFunction(() => !document.querySelector("#conversionStrip").classList.contains("active"), null, { timeout: 15000 });
await page.waitForTimeout(3600);
await page.click('.file-item[data-id="demo-arch"]');
await page.click('.tab[data-tab="json"]');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, "clean-06-json-dark.png") });

await page.click('.tab[data-tab="preview"]');
await page.click("#themeBtn");
await page.waitForTimeout(300);
await page.click('.file-item[data-id="demo-broken"]');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(shots, "clean-07-failed-light.png") });

await page.click("#clearBtn");
await page.waitForTimeout(3600);
await page.screenshot({ path: path.join(shots, "clean-08-empty.png") });

await browser.close();
console.log("clean screenshots done");
