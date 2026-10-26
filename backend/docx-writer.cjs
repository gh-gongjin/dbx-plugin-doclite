"use strict";

const zlib = require("node:zlib");
const { parseMarkdown } = require("./markdown-model.cjs");

const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const PAGE_MARGIN = 1134;
const TEXT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const TABLE_FONT_SIZE = 17;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip(entries, date) {
  const stamp = dosStamp(date);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const payload = stored ? data : deflated;
    const checksum = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.day, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(stored ? 0 : 8, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.day, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + payload.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function runXml(text, options = {}) {
  const props = [];
  if (options.bold) props.push("<w:b/>");
  if (options.italic) props.push("<w:i/>");
  if (options.size) props.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);
  if (options.mono) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/>');
  if (options.color) props.push(`<w:color w:val="${options.color}"/>`);
  const body = options.breaks
    ? String(text).split("\n").map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join("<w:br/>")
    : `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;
  return `<w:r>${props.length ? `<w:rPr>${props.join("")}</w:rPr>` : ""}${body}</w:r>`;
}

function paragraphXml(text, options = {}) {
  const props = [];
  if (options.style) props.push(`<w:pStyle w:val="${options.style}"/>`);
  if (options.keepNext) props.push("<w:keepNext/>");
  if (options.indent) props.push(`<w:ind w:left="${options.indent}" w:hanging="${Math.min(options.indent, 240)}"/>`);
  if (options.before || options.after) {
    props.push(`<w:spacing${options.before ? ` w:before="${options.before}"` : ""}${options.after ? ` w:after="${options.after}"` : ""}/>`);
  }
  const run = text ? runXml(text, options.run || {}) : "";
  return `<w:p>${props.length ? `<w:pPr>${props.join("")}</w:pPr>` : ""}${run}</w:p>`;
}

function headingStyle(level) {
  if (level <= 1) return "Title";
  return `Heading${Math.min(3, level - 1)}`;
}

function columnWidths(header, rows, count) {
  const weights = [];
  for (let index = 0; index < count; index += 1) {
    let longest = String(header[index] ?? "").length;
    for (const row of rows) longest = Math.max(longest, String(row[index] ?? "").length);
    weights.push(Math.min(48, Math.max(3, longest)));
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const widths = weights.map((weight) => Math.max(520, Math.round((TEXT_WIDTH * weight) / total)));
  const drift = TEXT_WIDTH - widths.reduce((sum, width) => sum + width, 0);
  const widest = widths.indexOf(Math.max(...widths));
  widths[widest] += drift;
  return widths;
}

function cellAlign(label) {
  const text = String(label ?? "").trim();
  if (text === "#") return "right";
  if (["可空", "键", "唯一"].includes(text)) return "center";
  return "left";
}

function cellXml(value, options) {
  const text = String(value ?? "").trim();
  const run = text
    ? `<w:r><w:rPr>${options.header ? "<w:b/>" : ""}<w:sz w:val="${TABLE_FONT_SIZE}"/><w:szCs w:val="${TABLE_FONT_SIZE}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
    : "";
  return `<w:tc><w:tcPr><w:tcW w:w="${options.width}" w:type="dxa"/>${options.header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/>' : ""}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20" w:line="252" w:lineRule="auto"/><w:jc w:val="${options.align}"/></w:pPr>${run}</w:p></w:tc>`;
}

function tableXml(block) {
  const header = block.header.slice();
  const rows = block.rows.map((row) => row.slice());
  const count = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const widths = columnWidths(header, rows, count);
  const renderRow = (cells, isHeader) => {
    const rendered = [];
    for (let index = 0; index < count; index += 1) {
      rendered.push(cellXml(cells[index], {
        header: isHeader,
        width: widths[index],
        align: cellAlign(header[index]),
      }));
    }
    return `<w:tr><w:trPr>${isHeader ? "<w:tblHeader/>" : ""}<w:cantSplit/></w:trPr>${rendered.join("")}</w:tr>`;
  };
  return `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/><w:jc w:val="left"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/></w:tblBorders><w:tblLayout w:type="autofit"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${renderRow(header, true)}${rows.map((row) => renderRow(row, false)).join("")}</w:tbl>`;
}

function listXml(block) {
  return block.items.map((item, index) => {
    const marker = block.ordered ? `${index + 1}. ` : "• ";
    const indent = 360 + (item.level || 0) * 300;
    return paragraphXml(`${marker}${item.text}`, { indent, after: 60 });
  }).join("");
}

function paragraphBlockXml(block) {
  const raw = String(block.markdown || "").trim();
  const bold = /^\*\*[^*]+\*\*$/.test(raw);
  return paragraphXml(block.text, {
    run: bold ? { bold: true } : {},
    before: bold ? 120 : 0,
  });
}

function codeBlockXml(block) {
  return paragraphXml(block.text || "", { style: "Code", run: { mono: true, size: 18, breaks: true } });
}

function renderBlocks(blocks) {
  const parts = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        parts.push(paragraphXml(block.text, { style: headingStyle(block.level), keepNext: true }));
        break;
      case "paragraph":
        parts.push(paragraphBlockXml(block));
        break;
      case "list":
        parts.push(listXml(block));
        break;
      case "table":
        parts.push(tableXml(block));
        break;
      case "blockQuote":
        parts.push(paragraphXml(block.text, { style: "Quote", run: { italic: true, color: "57606A", size: 19 } }));
        break;
      case "codeBlock":
        parts.push(codeBlockXml(block));
        break;
      default:
        if (block.text) parts.push(paragraphXml(block.text));
    }
  }
  return parts.join("");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="60" w:after="60"/><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="57606A"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/><w:spacing w:before="60" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style></w:styles>`;

function coreXml(title, date) {
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>DocLite</dc:creator><cp:lastModifiedBy>DocLite</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
}

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>DocLite</Application></Properties>`;

const SECTION = `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/><w:pgMar w:top="${PAGE_MARGIN}" w:right="${PAGE_MARGIN}" w:bottom="${PAGE_MARGIN}" w:left="${PAGE_MARGIN}" w:header="567" w:footer="567" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>`;

function buildDictionaryDocx(markdown, options = {}) {
  const blocks = parseMarkdown(String(markdown || ""));
  if (!blocks.length) throw new Error("数据字典内容为空。");
  const date = options.date instanceof Date ? options.date : new Date();
  const title = String(options.title || options.name || "数据字典").slice(0, 200);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${renderBlocks(blocks)}${SECTION}</w:body></w:document>`;
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/core.xml", data: coreXml(title, date) },
    { name: "docProps/app.xml", data: APP },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: STYLES },
    { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
  ], date);
}

module.exports = {
  buildDictionaryDocx,
  crc32,
};
