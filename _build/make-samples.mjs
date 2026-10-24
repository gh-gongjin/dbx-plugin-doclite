import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./lib/zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "_build", "samples");
fs.mkdirSync(outDir, { recursive: true });

const markdown = `# 项目周会纪要

## 本周进展

- 完成插件骨架与转换服务
- 打通 DOCX / PDF / CSV 转换链路
- 预览面板支持 Markdown 与结构模型切换

## 下周计划

1. 接入真实插件宿主
2. 补齐错误态与取消逻辑
3. 打包并在 DBX 中安装验证

> 所有转换均在本地完成，不上传原始文件。

| 模块 | 负责人 | 状态 |
| --- | --- | --- |
| Sidecar | 龚进 | 进行中 |
| 预览 | 龚进 | 已完成 |
| 打包 | 龚进 | 待开始 |

\`\`\`js
const result = await convert({ format: "markdown" });
console.log(result.stats.words);
\`\`\`
`;

const text = `DocLite 纯文本样例

这是用于验证文本直读路径的样例文件。
第二段内容包含数字 2026 与英文 DocLite Plugin。
`;

const csv = `模块,负责人,状态,备注
Sidecar,龚进,进行中,JSON-RPC
预览,龚进,已完成,四视图
打包,龚进,待开始,dbxp
`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
`;

const packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`;

const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
`;

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
</w:styles>
`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DocLite 插件验收文档</w:t></w:r></w:p>
    <w:p><w:r><w:t>这一段用于验证 DOCX 正文提取。插件应当保留中文、数字 2026 与标点。</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>转换清单</w:t></w:r></w:p>
    <w:tbl>
      <w:tblPr/>
      <w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
      <w:tr><w:tc><w:p><w:r><w:t>格式</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>DOCX</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>通过</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>PDF</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>通过</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>
`;

function pdfObject(number, body) {
  return `${number} 0 obj\n${body}\nendobj\n`;
}

function buildPdf(objects) {
  let text = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets[index + 1] = Buffer.byteLength(text, "binary");
    text += pdfObject(index + 1, body);
  });
  const xrefOffset = Buffer.byteLength(text, "binary");
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    text += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(text, "binary");
}

const textPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  (() => {
    const stream = "BT\n/F1 20 Tf\n72 720 Td\n(DocLite sample PDF) Tj\n0 -28 Td\n/F1 12 Tf\n(Converted by the anydoc engine.) Tj\nET\n";
    return `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}endstream`;
  })(),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
]);

const scannedPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
  (() => {
    const stream = "q\n500 0 0 700 56 46 cm\n/Im1 Do\nQ\n";
    return `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}endstream`;
  })(),
  (() => {
    const pixel = Buffer.from([0x80]);
    return `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixel.length} >>\nstream\n${pixel.toString("latin1")}\nendstream`;
  })(),
]);

const scannedTwoPagePdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
  (() => {
    const stream = "q\n500 0 0 700 56 46 cm\n/Im1 Do\nQ\n";
    return `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}endstream`;
  })(),
  (() => {
    const pixel = Buffer.from([0x80]);
    return `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixel.length} >>\nstream\n${pixel.toString("latin1")}\nendstream`;
  })(),
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 7 0 R >>",
  (() => {
    const stream = "q\n500 0 0 700 56 46 cm\n/Im1 Do\nQ\n";
    return `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}endstream`;
  })(),
]);

const docxEntries = [
  { name: "[Content_Types].xml", data: contentTypes },
  { name: "_rels/.rels", data: packageRels },
  { name: "word/_rels/document.xml.rels", data: documentRels },
  { name: "word/styles.xml", data: styles },
  { name: "word/document.xml", data: documentXml },
];

fs.writeFileSync(path.join(outDir, "sample.md"), markdown, "utf8");
fs.writeFileSync(path.join(outDir, "sample.txt"), text, "utf8");
fs.writeFileSync(path.join(outDir, "sample.csv"), csv, "utf8");
fs.writeFileSync(path.join(outDir, "sample.pdf"), textPdf);
fs.writeFileSync(path.join(outDir, "scanned.pdf"), scannedPdf);
fs.writeFileSync(path.join(outDir, "scanned-2p.pdf"), scannedTwoPagePdf);
createZip(path.join(outDir, "sample.docx"), docxEntries);

for (const name of ["sample.md", "sample.txt", "sample.csv", "sample.pdf", "scanned.pdf", "scanned-2p.pdf", "sample.docx"]) {
  const stat = fs.statSync(path.join(outDir, name));
  console.log(`${name.padEnd(14)} ${stat.size} bytes`);
}
