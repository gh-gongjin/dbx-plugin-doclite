"use strict";

const BLOCK_START = /^(#{1,6})\s|^```|^~~~|^>\s?|^\s*[-*+]\s+|^\s*\d+\.\s+|^\|/;

function plainInline(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(text) {
  return plainInline(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function splitRow(line) {
  const trimmed = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(String(line).trim());
}

function isRule(line) {
  return /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line);
}

function isListItem(line) {
  return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

function parseList(lines, start) {
  const ordered = /^\s*\d+\.\s+/.test(lines[start]);
  const baseIndent = (lines[start].match(/^\s*/) || [""])[0].length;
  const items = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      if (index + 1 < lines.length && isListItem(lines[index + 1])) {
        index += 1;
        continue;
      }
      break;
    }
    const match = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!match) {
      if (items.length && /^\s{2,}/.test(line)) {
        items[items.length - 1].markdown += "\n" + line.trim();
        items[items.length - 1].text = plainInline(items[items.length - 1].markdown);
        index += 1;
        continue;
      }
      break;
    }
    const indent = match[1].length;
    if (indent < baseIndent) break;
    items.push({ level: Math.max(0, Math.floor((indent - baseIndent) / 2)), markdown: match[3], text: plainInline(match[3]) });
    index += 1;
  }
  return { block: { type: "list", modelType: ordered ? "OrderedList" : "BulletList", ordered, items }, next: index };
}

function parseMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.trim().match(/^(```+|~~~+)(.*)$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim().split(/\s+/)[0] || "";
      index += 1;
      const code = [];
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const text = code.join("\n");
      blocks.push({
        type: "codeBlock",
        modelType: "CodeBlock",
        lang: lang || null,
        lines: code.length,
        text,
        markdown: `${marker}${lang}\n${text}\n${marker}`,
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const raw = heading[2].trim();
      blocks.push({
        type: "heading",
        modelType: `Heading ${level}`,
        level,
        anchor: slugify(raw) || null,
        text: plainInline(raw),
        markdown: raw,
      });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "thematicBreak", modelType: "ThematicBreak", text: "", markdown: line.trim() });
      index += 1;
      continue;
    }

    if (/^\s*\|/.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      const colCount = Math.max(header.length, ...rows.map((row) => row.length));
      blocks.push({
        type: "table",
        modelType: "Table",
        header,
        rows,
        rowCount: rows.length,
        colCount,
        text: `${rows.length} 行 × ${colCount} 列`,
        markdown: [line, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n"),
      });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const raw = quote.join("\n");
      blocks.push({
        type: "blockQuote",
        modelType: "Blockquote",
        text: plainInline(raw),
        markdown: raw,
      });
      continue;
    }

    if (isListItem(line)) {
      const { block, next } = parseList(lines, index);
      blocks.push({ ...block, text: `${block.items.length} 项` });
      index = next;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !BLOCK_START.test(lines[index])) {
      if (isRule(lines[index])) break;
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const raw = paragraph.join("\n");
    blocks.push({
      type: "paragraph",
      modelType: "Paragraph",
      text: plainInline(raw),
      markdown: raw,
    });
  }

  return blocks;
}

function countWords(markdown) {
  const cjk = (String(markdown).match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (String(markdown).replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9][A-Za-z0-9'’_-]*/g) || []).length;
  return cjk + latin;
}

function buildDocumentModel(markdown, source, options = {}) {
  const blocks = parseMarkdown(markdown);
  const counts = {};
  for (const block of blocks) counts[block.type] = (counts[block.type] || 0) + 1;
  return {
    version: 1,
    engine: {
      name: "anydoc",
      version: options.engineVersion || "0.2.4",
    },
    source: {
      name: source.name,
      format: String(source.ext || "").toUpperCase(),
      size: source.size || null,
      pages: source.pages || null,
    },
    stats: {
      characters: String(markdown).length,
      words: countWords(markdown),
      lines: String(markdown).split("\n").length,
      blocks: blocks.length,
      headings: counts.heading || 0,
      paragraphs: counts.paragraph || 0,
      lists: counts.list || 0,
      tables: counts.table || 0,
      codeBlocks: counts.codeBlock || 0,
      quotes: counts.blockQuote || 0,
    },
    warnings: Array.isArray(options.warnings) ? options.warnings.slice() : [],
    blocks: blocks.map((block, blockIndex) => ({ index: blockIndex, ...block })),
  };
}

module.exports = {
  buildDocumentModel,
  parseMarkdown,
  plainInline,
};
