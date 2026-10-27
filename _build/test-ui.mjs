import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFakePicker } from "./fake-picker.mjs";
import { startOcrMock } from "./lib/ocr-mock.mjs";

const require = createRequire("D:/nvm/node_global/node_modules/rea-agents/package.json");
const { chromium } = require("playwright-core");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = path.join(root, "_build", "samples");
const workDir = path.join(root, "_build", ".tmp", "ui-test");
const dataDir = path.join(workDir, "data");
const saveDir = path.join(workDir, "saved");
const shots = path.join(root, "_build", "shots");
const uiUrl = pathToFileURL(path.join(root, "ui", "index.html")).href;

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(saveDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const badExe = path.join(workDir, "bad.exe");
fs.writeFileSync(badExe, "MZ not a real executable\n");
const retryTxt = path.join(workDir, "retry.txt");
{
  const line = "DocLite retry line — the quick brown fox jumps over the lazy dog 0123456789.\n";
  const target = 4 * 1024 * 1024 + 64 * 1024;
  fs.writeFileSync(retryTxt, line.repeat(Math.ceil(target / Buffer.byteLength(line))).slice(0, target));
}

const knownFiles = new Map([
  ["sample.md", path.join(samples, "sample.md")],
  ["sample.docx", path.join(samples, "sample.docx")],
  ["sample.pdf", path.join(samples, "sample.pdf")],
  ["scanned.pdf", path.join(samples, "scanned.pdf")],
  ["sample.csv", path.join(samples, "sample.csv")],
  ["sample.txt", path.join(samples, "sample.txt")],
  ["bad.exe", badExe],
  ["retry.txt", retryTxt],
]);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function readZipEntry(buffer, entryName) {
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    if (name === entryName) {
      const raw = buffer.subarray(dataStart, dataStart + size);
      return method === 8 ? zlib.inflateRawSync(raw) : raw;
    }
    offset = dataStart + size;
  }
  throw new Error(`zip entry not found: ${entryName}`);
}

function listZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    entries.push(name);
    offset += 30 + nameLength + extraLength + size;
  }
  return entries;
}

class Sidecar {
  constructor(command, args, extraEnv = {}) {
    this.child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir, DBX_PLUGIN_ID: "com.gongjin.doclite", DBX_PLUGIN_VERSION: "0.1.13", ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.sequence = 0;
    this.eventHook = null;
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message);
          error.code = message.error.data && message.error.data.code;
          error.data = message.error.data;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        this.events.push(message);
        if (this.eventHook) this.eventHook(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        }
      }
    });
    this.child.on("exit", (code, signal) => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`sidecar exited (${code ?? signal})`));
      }
      for (const entry of this.pending.values()) entry.reject(new Error(`sidecar exited (${code ?? signal})`));
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } resolve(); }, 3000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

const pickerModeFile = path.join(workDir, "picker-mode.txt");
const fakePicker = buildFakePicker();
if (fakePicker) fs.writeFileSync(pickerModeFile, "ok", "utf8");
const ocrMock = await startOcrMock(path.join(workDir, "ocr-mock"));
const sidecar = new Sidecar(process.execPath, [path.join(root, "backend", "sidecar.cjs")], {
  ...(fakePicker ? { DBX_PICKER_EXE: fakePicker, FAKE_PICKER_MODE_FILE: pickerModeFile } : {}),
  DOCLITE_MINERU_BASE_URL: ocrMock.baseUrl,
  DOCLITE_BAIDU_BASE_URL: ocrMock.baseUrl,
  DOCLITE_OCR_POLL_MS: "50",
  DOCLITE_OCR_TIMEOUT_MS: "30000",
});
const terminalEvents = [];
sidecar.eventHook = (message) => {
  if (message.params && message.params.jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(message.method)) {
    terminalEvents.push(message);
  }
};

const handles = new Map();
const closedHandles = new Set();
const saves = new Map();
let handleSequence = 0;
let revealCalls = 0;
const revealParams = [];
const storage = {};
const copied = [];
const readDelays = new Map([["retry.txt", 700]]);

const browser = await chromium.launch({
  executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1243/chrome-win64/chrome.exe"),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error" && !/favicon/i.test(message.text())) consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

function createHandle(name, filePath, size) {
  const handleId = `handle-${++handleSequence}`;
  handles.set(handleId, { name, path: filePath, size, closed: false });
  return handleId;
}

await page.exposeFunction("__dbxInvoke", async (method, params, options) => {
  if (method === "doc/reveal") {
    revealCalls += 1;
    revealParams.push(params || {});
    return { opened: true, path: path.join(dataDir, "output") };
  }
  return sidecar.request(method, params || {}, options && options.timeoutMs ? Math.min(options.timeoutMs, 60000) : 60000);
});
await page.exposeFunction("__dbxPick", async (names) => {
  return (names || []).map((name) => {
    const filePath = knownFiles.get(name);
    if (!filePath) throw new Error(`unknown fixture: ${name}`);
    const size = fs.statSync(filePath).size;
    return { handleId: createHandle(name, filePath, size), name, size, contentType: "application/octet-stream" };
  });
});
await page.exposeFunction("__dbxRead", async (handleId, offset, length) => {
  const handle = handles.get(handleId);
  if (!handle || handle.closed) throw new Error("文件句柄已关闭。");
  const delay = readDelays.get(handle.name) || 0;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const take = Math.max(0, Math.min(Number(length) || 4 * 1024 * 1024, handle.size - offset));
  const buffer = Buffer.alloc(take);
  const fd = fs.openSync(handle.path, "r");
  try {
    fs.readSync(fd, buffer, 0, take, offset);
  } finally {
    fs.closeSync(fd);
  }
  return { dataBase64: buffer.toString("base64"), length: take, offset, eof: offset + take >= handle.size, size: handle.size };
});
await page.exposeFunction("__dbxClose", async (handleId) => {
  const handle = handles.get(handleId);
  if (handle) handle.closed = true;
  closedHandles.add(handleId);
  return null;
});
await page.exposeFunction("__dbxBeginSave", async (options) => {
  const name = path.basename(String(options && options.name ? options.name : "document"));
  const handleId = createHandle(name, null, 0);
  saves.set(handleId, { name, chunks: [], length: 0 });
  return { handleId, chunkBytes: 4 * 1024 * 1024 };
});
await page.exposeFunction("__dbxWrite", async (handleId, offset, dataBase64) => {
  const save = saves.get(handleId);
  if (!save) throw new Error("保存句柄不存在。");
  const bytes = Buffer.from(dataBase64, "base64");
  if (offset !== save.length) throw new Error("写入偏移不连续。");
  save.chunks.push(bytes);
  save.length += bytes.length;
  return null;
});
await page.exposeFunction("__dbxFinishSave", async (handleId) => {
  const save = saves.get(handleId);
  if (!save) throw new Error("保存句柄不存在。");
  fs.writeFileSync(path.join(saveDir, save.name), Buffer.concat(save.chunks));
  saves.delete(handleId);
  return null;
});
await page.exposeFunction("__dbxCancelSave", async (handleId) => {
  saves.delete(handleId);
  return null;
});
await page.exposeFunction("__dbxCopy", async (text) => {
  copied.push(String(text));
  return null;
});
await page.exposeFunction("__dbxStorageGet", async (key) => (key in storage ? storage[key] : null));
await page.exposeFunction("__dbxStorageSet", async (key, value) => { storage[key] = value; return null; });
await page.exposeFunction("__dbxStorageDelete", async (key) => { delete storage[key]; return null; });

// ---- Host API 1.4 data-dictionary fixtures -------------------------------
const dictionaryConnections = [
  { id: "mysql-main", name: "生产 MySQL", dbType: "mysql", connected: true, isConnected: true, database: "shop" },
  { id: "pg-main", name: "应用 PG", dbType: "postgres", connected: true, isConnected: true, database: "appdb" },
  { id: "sqlite-main", name: "本地 SQLite", dbType: "sqlite", connected: true, isConnected: true, database: "local.db" },
  { id: "sqlserver-main", name: "生产 SQL Server", dbType: "sqlserver", connected: true, isConnected: true, database: "appdb" },
  { id: "oracle-main", name: "核心 Oracle", dbType: "oracle", connected: true, isConnected: true, database: "APP" },
  { id: "dameng-main", name: "达梦 DM", dbType: "dameng", connected: true, isConnected: true, database: "DMHR" },
  { id: "clickhouse-main", name: "分析 ClickHouse", dbType: "clickhouse", connected: true, isConnected: true, database: "analytics" },
  { id: "mongo-main", name: "文档库", dbType: "mongodb", connected: true, isConnected: true },
  { id: "mysql-down", name: "离线 MySQL", dbType: "mysql", connected: false, isConnected: false },
];

const mysqlCatalog = {
  shop: [
    {
      name: "orders", comment: "订单",
      columns: [
        ["id", "bigint", "NO", "", "主键", "PRI"],
        ["order_no", "varchar(32)", "NO", "", "订单号", "UNI"],
        ["user_id", "bigint", "NO", "", "下单用户", "MUL"],
        ["total", "decimal(12,2)", "NO", "0.00", "金额", ""],
        ["status", "varchar(20)", "NO", "'pending'", "状态", ""],
        ["created_at", "datetime", "NO", "CURRENT_TIMESTAMP", "创建时间", ""],
      ],
      indexes: [["PRIMARY", "id", 0], ["uk_orders_no", "order_no", 0], ["idx_orders_user", "user_id", 1]],
      foreignKeys: [["fk_orders_user", "user_id", "users", "id"]],
    },
    {
      name: "order_items", comment: "订单明细",
      columns: [
        ["id", "bigint", "NO", "", "", "PRI"],
        ["order_id", "bigint", "NO", "", "", "MUL"],
        ["sku", "varchar(64)", "NO", "", "商品编码", ""],
        ["qty", "int", "NO", "1", "数量", ""],
      ],
      indexes: [["PRIMARY", "id", 0], ["idx_items_order", "order_id", 1]],
      foreignKeys: [["fk_items_order", "order_id", "orders", "id"]],
    },
    {
      name: "users", comment: "",
      columns: [
        ["id", "bigint", "NO", "", "", "PRI"],
        ["email", "varchar(255)", "YES", "", "邮箱", "UNI"],
        ["nickname", "varchar(64)", "YES", "NULL", "昵称", ""],
      ],
      indexes: [["PRIMARY", "id", 0], ["uk_users_email", "email", 0]],
      foreignKeys: [],
    },
  ],
  analytics: [
    {
      name: "events", comment: "埋点事件",
      columns: [["id", "bigint", "NO", "", "", "PRI"], ["name", "varchar(64)", "NO", "", "事件名", ""]],
      indexes: [["PRIMARY", "id", 0]],
      foreignKeys: [],
    },
  ],
};

const pgCatalog = {
  public: [
    {
      name: "customers", comment: "客户",
      columns: [
        ["id", "bigint", false, "nextval('customers_id_seq'::regclass)", "主键"],
        ["code", "text", false, "", "客户编码"],
        ["name", "text", true, "", "客户名称"],
      ],
      indexes: [["customers_pkey", "id", false, true], ["uk_customers_code", "code", true, false]],
      foreignKeys: [],
    },
    {
      name: "invoices", comment: "发票",
      columns: [
        ["id", "bigint", false, "", ""],
        ["customer_id", "bigint", false, "", "客户"],
        ["amount", "numeric(12,2)", false, "0", "金额"],
      ],
      indexes: [["invoices_pkey", "id", false, true], ["idx_invoices_customer", "customer_id", false, false]],
      foreignKeys: [["invoices_customer_fk", "customer_id", "public", "customers", "id"]],
    },
  ],
  audit: [
    {
      name: "change_log", comment: "变更日志",
      columns: [["id", "bigint", false, "", ""], ["entity", "text", true, "", "实体"]],
      indexes: [["change_log_pkey", "id", false, true]],
      foreignKeys: [],
    },
  ],
};

const sqliteCatalog = [
  {
    name: "accounts",
    columns: [["id", "INTEGER", true, "", 1], ["email", "TEXT", true, "", 0], ["balance", "REAL", false, "0.0", 0]],
    indexes: [["uk_accounts_email", 1, "u", ["email"]], ["idx_accounts_balance", 0, "c", ["balance"]]],
    foreignKeys: [],
  },
  {
    name: "entries",
    columns: [["id", "INTEGER", true, "", 1], ["account_id", "INTEGER", true, "", 0], ["amount", "REAL", true, "", 0]],
    indexes: [["idx_entries_account", 0, "c", ["account_id"]]],
    foreignKeys: [[0, 0, "accounts", "account_id", "id"]],
  },
];

// SQL Server is reached through a database-scoped pool, so the catalog is
// keyed by the request's `database` rather than by schema.
const sqlserverCatalog = {
  appdb: [
    {
      schema: "sales", name: "orders", comment: "订单",
      columns: [
        ["id", "bigint", 0, "", "主键", 1],
        ["order_no", "nvarchar(32)", 0, "", "订单号", 0],
        ["customer_id", "bigint", 1, "", "客户", 0],
        ["amount", "decimal(12,2)", 0, "((0))", "金额", 0],
        ["note", "nvarchar(max)", 1, "", "备注", 0],
        ["created_at", "datetime2(7)", 0, "(getdate())", "创建时间", 0],
      ],
      indexes: [
        ["PK_orders", 0, 1, ["id"]],
        ["UK_orders_no", 1, 0, ["order_no"]],
        ["IX_orders_customer", 0, 0, ["customer_id"]],
      ],
      foreignKeys: [["FK_orders_customer", ["customer_id"], "sales", "customers", ["id"]]],
    },
    {
      schema: "sales", name: "customers", comment: "客户",
      columns: [
        ["id", "bigint", 0, "", "主键", 1],
        ["name", "nvarchar(80)", 0, "", "名称", 0],
      ],
      indexes: [["PK_customers", 0, 1, ["id"]]],
      foreignKeys: [],
    },
    {
      schema: "dbo", name: "audit_log", comment: "审计日志",
      columns: [
        ["id", "bigint", 0, "", "", 1],
        ["action", "varchar(40)", 0, "", "动作", 0],
      ],
      indexes: [["PK_audit_log", 0, 1, ["id"]]],
      foreignKeys: [],
    },
  ],
};

// Oracle and DM both read ALL_* views; each connection sees exactly one schema.
const oracleDictionaries = {
  "oracle-main": {
    schema: "APP",
    tables: [
      {
        name: "ORDERS", comment: "订单",
        columns: [
          ["ORDER_ID", "NUMBER(19)", "N", "", "主键", 1],
          ["ORDER_NO", "VARCHAR2(32)", "N", "", "订单号", 0],
          ["CUSTOMER_ID", "NUMBER(19)", "Y", "", "客户", 0],
          ["AMOUNT", "NUMBER(12,2)", "Y", "0", "金额", 0],
          ["CREATED_AT", "TIMESTAMP(6)", "N", "SYSDATE", "创建时间", 0],
        ],
        indexes: [
          ["PK_ORDERS", 0, 1, ["ORDER_ID"]],
          ["UK_ORDERS_NO", 1, 0, ["ORDER_NO"]],
        ],
        foreignKeys: [["FK_ORDERS_CUSTOMER", ["CUSTOMER_ID"], "APP", "CUSTOMERS", ["CUSTOMER_ID"]]],
      },
      {
        name: "CUSTOMERS", comment: "客户",
        columns: [
          ["CUSTOMER_ID", "NUMBER(19)", "N", "", "主键", 1],
          ["NAME", "VARCHAR2(80)", "Y", "", "名称", 0],
        ],
        indexes: [["PK_CUSTOMERS", 0, 1, ["CUSTOMER_ID"]]],
        foreignKeys: [],
      },
    ],
  },
  "dameng-main": {
    schema: "DMHR",
    tables: [
      {
        name: "ORDER_INFO", comment: "订单信息",
        columns: [
          ["ORDER_ID", "BIGINT", "N", "", "主键", 1],
          ["CUSTOMER_ID", "INT", "Y", "", "客户", 0],
          ["AMOUNT", "DECIMAL(12,2)", "Y", "0", "金额", 0],
          ["CREATED_AT", "TIMESTAMP", "N", "SYSDATE", "创建时间", 0],
        ],
        indexes: [["PK_ORDER_INFO", 0, 1, ["ORDER_ID"]]],
        foreignKeys: [["FK_ORDER_CUSTOMER", ["CUSTOMER_ID"], "DMHR", "CUSTOMER", ["CUSTOMER_ID"]]],
      },
      {
        name: "CUSTOMER", comment: "客户",
        columns: [
          ["CUSTOMER_ID", "INT", "N", "", "主键", 1],
          ["NAME", "VARCHAR(80)", "Y", "", "名称", 0],
        ],
        indexes: [["PK_CUSTOMER", 0, 1, ["CUSTOMER_ID"]]],
        foreignKeys: [],
      },
    ],
  },
};

// The last item of each column row is is_in_primary_key; ClickHouse indexes
// are synthesised from it because system tables have no index list.
const clickhouseCatalog = {
  analytics: [
    {
      name: "events", comment: "埋点事件",
      columns: [
        ["event_id", "UUID", 0, "", "事件 ID", 1],
        ["user_id", "UInt64", 0, "", "用户", 1],
        ["payload", "Nullable(String)", 1, "", "载荷", 0],
        ["ts", "DateTime", 0, "now()", "时间", 0],
      ],
    },
    {
      name: "sessions", comment: "会话",
      columns: [
        ["session_id", "String", 0, "", "会话 ID", 1],
        ["duration", "Nullable(UInt32)", 1, "", "时长", 0],
      ],
    },
  ],
};

const dataQueries = [];
let dataDenied = false;

const fakeResult = (connection, columns, rows) => ({
  dbType: connection.dbType,
  columns: columns.map((name) => ({ name })),
  rows,
  truncated: false,
  elapsedMs: 1,
});

function literalAfter(sql, pattern) {
  const match = sql.match(pattern);
  return match ? match[1].replace(/''/g, "'") : "";
}

function fakeQueryData(request) {
  const connection = dictionaryConnections.find((row) => row.id === request.connectionId);
  if (!connection) throw new Error("Connection not found");
  if (dataDenied) throw new Error("PLUGIN_DATA_ACCESS_NOT_GRANTED: user denied");
  if (!connection.connected) throw new Error("Connection is not open");
  dataQueries.push({ ...request });
  const sql = String(request.sql);

  if (connection.dbType === "mysql") {
    if (sql.includes("information_schema.schemata")) {
      return fakeResult(connection, ["name"], Object.keys(mysqlCatalog).map((name) => [name]));
    }
    if (sql.includes("FROM information_schema.tables") && !sql.includes("information_schema.columns")) {
      const database = literalAfter(sql, /table_schema = '([^']*)'/);
      return fakeResult(connection, ["name", "comment"], (mysqlCatalog[database] || []).map((table) => [table.name, table.comment]));
    }
    if (sql.includes("information_schema.columns")) {
      const database = literalAfter(sql, /c\.table_schema = '([^']*)'/);
      const rows = [];
      for (const table of mysqlCatalog[database] || []) {
        table.columns.forEach((column, index) => {
          rows.push([table.name, column[0], column[1], column[2], column[3], column[4], column[5], "", index + 1, table.comment]);
        });
      }
      return fakeResult(connection, ["table_name", "column_name", "data_type", "is_nullable", "column_default", "column_comment", "column_key", "extra", "ordinal_position", "table_comment"], rows);
    }
    if (sql.includes("information_schema.statistics")) {
      const database = literalAfter(sql, /table_schema = '([^']*)'/);
      const rows = [];
      for (const table of mysqlCatalog[database] || []) {
        for (const index of table.indexes) {
          rows.push([table.name, index[0], index[2], 1, index[1], "BTREE"]);
        }
      }
      return fakeResult(connection, ["table_name", "index_name", "non_unique", "seq_in_index", "column_name", "index_type"], rows);
    }
    if (sql.includes("information_schema.key_column_usage")) {
      const database = literalAfter(sql, /table_schema = '([^']*)'/);
      const rows = [];
      for (const table of mysqlCatalog[database] || []) {
        for (const key of table.foreignKeys) {
          rows.push([table.name, key[0], key[1], 1, key[2], key[3]]);
        }
      }
      return fakeResult(connection, ["table_name", "constraint_name", "column_name", "ordinal_position", "referenced_table_name", "referenced_column_name"], rows);
    }
  }

  if (connection.dbType === "postgres") {
    if (sql.includes("FROM pg_database")) {
      return fakeResult(connection, ["name"], [["appdb"]]);
    }
    if (/AS schema_name, c\.relname AS name, obj_description/.test(sql)) {
      const rows = [];
      for (const [schema, tables] of Object.entries(pgCatalog)) {
        for (const table of tables) rows.push([schema, table.name, table.comment]);
      }
      return fakeResult(connection, ["schema_name", "name", "comment"], rows);
    }
    if (/a\.attname AS column_name, format_type/.test(sql)) {
      const rows = [];
      for (const [schema, tables] of Object.entries(pgCatalog)) {
        for (const table of tables) {
          table.columns.forEach((column, index) => {
            rows.push([schema, table.name, column[0], column[1], column[2], column[3], column[4], table.comment, index + 1]);
          });
        }
      }
      return fakeResult(connection, ["schema_name", "table_name", "column_name", "data_type", "is_nullable", "column_default", "column_comment", "table_comment", "ordinal_position"], rows);
    }
    if (sql.includes("FROM pg_index ix")) {
      const rows = [];
      for (const [schema, tables] of Object.entries(pgCatalog)) {
        for (const table of tables) {
          for (const index of table.indexes) {
            rows.push([schema, table.name, index[0], index[2], index[3], index[1], 1]);
          }
        }
      }
      return fakeResult(connection, ["schema_name", "table_name", "index_name", "is_unique", "is_primary", "column_name", "ordinal_position"], rows);
    }
    if (sql.includes("FROM pg_constraint con")) {
      const rows = [];
      for (const [schema, tables] of Object.entries(pgCatalog)) {
        for (const table of tables) {
          for (const key of table.foreignKeys) {
            rows.push([schema, table.name, key[0], key[1], key[2], key[3], key[4], 1]);
          }
        }
      }
      return fakeResult(connection, ["schema_name", "table_name", "constraint_name", "column_name", "ref_schema", "ref_table", "ref_column", "ordinal_position"], rows);
    }
  }

  if (connection.dbType === "sqlite") {
    if (sql.includes("sqlite_master")) {
      return fakeResult(connection, ["name", "comment"], sqliteCatalog.map((table) => [table.name, ""]));
    }
    const tableName = literalAfter(sql, /pragma_(?:table_info|index_list|foreign_key_list)\('([^']*)'\)/);
    const indexName = literalAfter(sql, /pragma_index_info\('([^']*)'\)/);
    if (sql.includes("pragma_table_info")) {
      const table = sqliteCatalog.find((row) => row.name === tableName);
      return fakeResult(connection, ["column_name", "data_type", "not_null", "column_default", "primary_key", "ordinal_position"],
        (table?.columns || []).map((column, index) => [column[0], column[1], column[2] ? 1 : 0, column[3], column[4], index]));
    }
    if (sql.includes("pragma_index_list")) {
      const table = sqliteCatalog.find((row) => row.name === tableName);
      return fakeResult(connection, ["index_name", "is_unique", "origin"], (table?.indexes || []).map((index) => [index[0], index[1], index[2]]));
    }
    if (sql.includes("pragma_index_info")) {
      for (const table of sqliteCatalog) {
        const index = table.indexes.find((row) => row[0] === indexName);
        if (index) return fakeResult(connection, ["seqno", "cid", "name"], index[3].map((name, position) => [position, 0, name]));
      }
      return fakeResult(connection, ["seqno", "cid", "name"], []);
    }
    if (sql.includes("pragma_foreign_key_list")) {
      const table = sqliteCatalog.find((row) => row.name === tableName);
      return fakeResult(connection, ["id", "seq", "ref_table", "column_name", "ref_column"], table?.foreignKeys || []);
    }
  }

  if (connection.dbType === "sqlserver") {
    if (sql.includes("FROM sys.databases")) {
      return fakeResult(connection, ["name"], [["appdb"]]);
    }
    const tables = sqlserverCatalog[request.database] || [];
    if (sql.includes("FROM sys.tables t") && sql.includes("ep.minor_id = 0")) {
      return fakeResult(connection, ["schema_name", "name", "comment"], tables.map((table) => [table.schema, table.name, table.comment]));
    }
    if (sql.includes("FROM sys.indexes i JOIN sys.tables t")) {
      const rows = [];
      for (const table of tables) {
        for (const index of table.indexes) {
          index[3].forEach((column, position) => {
            rows.push([table.schema, table.name, index[0], index[1], index[2], column, position + 1]);
          });
        }
      }
      return fakeResult(connection, ["schema_name", "table_name", "index_name", "is_unique", "is_primary", "column_name", "ordinal_position"], rows);
    }
    if (sql.includes("FROM sys.foreign_keys fk")) {
      const rows = [];
      for (const table of tables) {
        for (const key of table.foreignKeys) {
          key[1].forEach((column, position) => {
            rows.push([table.schema, table.name, key[0], column, key[2], key[3], key[4][position], position + 1]);
          });
        }
      }
      return fakeResult(connection, ["schema_name", "table_name", "constraint_name", "column_name", "ref_schema", "ref_table", "ref_column", "ordinal_position"], rows);
    }
    if (sql.includes("FROM sys.columns c")) {
      const rows = [];
      for (const table of tables) {
        table.columns.forEach((column, index) => {
          rows.push([table.schema, table.name, column[0], column[1], column[2], column[3], column[4], index + 1, column[5]]);
        });
      }
      return fakeResult(connection, ["schema_name", "table_name", "column_name", "data_type", "is_nullable", "column_default", "column_comment", "ordinal_position", "primary_key"], rows);
    }
  }

  if (connection.dbType === "oracle" || connection.dbType === "dameng" || connection.dbType === "oceanbase-oracle") {
    const catalog = oracleDictionaries[connection.id];
    if (!catalog) throw new Error(`unexpected oracle-family connection: ${connection.id}`);
    if (sql.includes("FROM all_users")) {
      return fakeResult(connection, ["name"], [[catalog.schema]]);
    }
    if (sql.includes("FROM all_tables t")) {
      return fakeResult(connection, ["schema_name", "name", "comment"], catalog.tables.map((table) => [catalog.schema, table.name, table.comment]));
    }
    if (sql.includes("FROM all_indexes i")) {
      const rows = [];
      for (const table of catalog.tables) {
        for (const index of table.indexes) {
          index[3].forEach((column, position) => {
            rows.push([catalog.schema, table.name, index[0], index[1], index[2], column, position + 1]);
          });
        }
      }
      return fakeResult(connection, ["schema_name", "table_name", "index_name", "is_unique", "is_primary", "column_name", "ordinal_position"], rows);
    }
    if (sql.includes("FROM all_tab_columns c")) {
      const rows = [];
      for (const table of catalog.tables) {
        table.columns.forEach((column, index) => {
          rows.push([catalog.schema, table.name, column[0], column[1], column[2], column[3], column[4], table.comment, index + 1, column[5]]);
        });
      }
      return fakeResult(connection, ["schema_name", "table_name", "column_name", "data_type", "is_nullable", "column_default", "column_comment", "table_comment", "ordinal_position", "primary_key"], rows);
    }
    if (sql.includes("FROM all_constraints ac")) {
      const rows = [];
      for (const table of catalog.tables) {
        for (const key of table.foreignKeys) {
          key[1].forEach((column, position) => {
            rows.push([catalog.schema, table.name, key[0], column, key[2], key[3], key[4][position], position + 1]);
          });
        }
      }
      return fakeResult(connection, ["schema_name", "table_name", "constraint_name", "column_name", "ref_schema", "ref_table", "ref_column", "ordinal_position"], rows);
    }
  }

  if (connection.dbType === "clickhouse") {
    if (sql.includes("FROM system.databases")) {
      return fakeResult(connection, ["name"], [["analytics"]]);
    }
    const database = literalAfter(sql, /database = '([^']*)'/);
    const tables = clickhouseCatalog[database] || [];
    if (sql.includes("FROM system.tables")) {
      return fakeResult(connection, ["schema_name", "name", "comment"], tables.map((table) => [database, table.name, table.comment]));
    }
    if (sql.includes("FROM system.columns")) {
      if (sql.includes("is_in_primary_key = 1")) {
        const rows = [];
        for (const table of tables) {
          table.columns.filter((column) => column[5]).forEach((column, position) => {
            rows.push([database, table.name, "PRIMARY", 0, 1, column[0], position + 1]);
          });
        }
        return fakeResult(connection, ["schema_name", "table_name", "index_name", "is_unique", "is_primary", "column_name", "ordinal_position"], rows);
      }
      const rows = [];
      for (const table of tables) {
        table.columns.forEach((column, index) => {
          rows.push([database, table.name, column[0], column[1], column[2], column[3], column[4], index + 1, column[5]]);
        });
      }
      return fakeResult(connection, ["schema_name", "table_name", "column_name", "data_type", "is_nullable", "column_default", "column_comment", "ordinal_position", "primary_key"], rows);
    }
  }

  throw new Error(`unexpected dictionary SQL: ${sql.slice(0, 120)}`);
}

await page.exposeFunction("__dbxGetConnections", async () => dictionaryConnections);
await page.exposeFunction("__dbxQueryData", async (request) => fakeQueryData(request || {}));
await page.exposeFunction("__dbxDenyData", async (flag) => { dataDenied = Boolean(flag); return null; });

await page.addInitScript(() => {
  window.__dbxStatus = false;
  // Mirror the real SDK: `capabilities` stays empty until the host answers
  // the SDK's "ready" message, and that round trip always lands after the
  // plugin's own script ran. A stub that pre-fills capabilities hides
  // ordering bugs in the plugin.
  window.__dbxCapabilities = {};
  let resolveReady;
  window.__dbxReady = new Promise((resolve) => { resolveReady = resolve; });
  window.addEventListener("load", () => {
    window.__dbxCapabilities = {
      storage: true,
      clipboardWrite: true,
      connectionsApi: true,
      dataApi: true,
      schemaMetadataApi: true,
      fileTransfer: { pick: true, read: true, beginSave: true, drop: true, folderExpansion: true },
    };
    resolveReady(window.__dbxCapabilities);
  });
  window.__dbxTest = {
    pickQueue: [],
    bridgeStats: { maxChunkParams: 0 },
    setPick(names) { this.pickQueue = names.slice(); },
    async drop(items) {
      const files = [];
      for (const item of items) {
        if (typeof item === "string") {
          files.push(...await window.__dbxPick([item]));
        } else {
          const [file] = await window.__dbxPick([item.name]);
          files.push(item.relativePath ? { ...file, relativePath: item.relativePath } : file);
        }
      }
      if (!window.__dbxDropCb) return false;
      window.__dbxDropCb(files, { truncated: false });
      return true;
    },
    drag(active) { if (window.__dbxDragCb) window.__dbxDragCb(Boolean(active)); },
    theme(appearance) {
      document.dispatchEvent(new CustomEvent("dbx-plugin-env", { detail: { type: "env", locale: "zh-CN", theme: { appearance, tokens: {} } } }));
    },
  };
  window.__dbxDeliverEvent = (message) => { if (window.__dbxEventCb) window.__dbxEventCb(message); };

  const encode = (bytes) => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  };

  window.dbxPlugin = Object.freeze({
    ready: window.__dbxReady,
    get capabilities() { return window.__dbxCapabilities; },
    theme: { appearance: "light", tokens: {} },
    invoke: (method, params, options) => {
      if (params !== undefined) {
        const size = new TextEncoder().encode(JSON.stringify(params)).byteLength;
        if (method === "doc/chunk" && size > window.__dbxTest.bridgeStats.maxChunkParams) {
          window.__dbxTest.bridgeStats.maxChunkParams = size;
        }
        // The real host bridge rejects request params above 2 MiB.
        if (size > 2 * 1024 * 1024) return Promise.reject(new Error("Plugin bridge request is too large"));
      }
      return window.__dbxInvoke(method, params, options).then((result) => {
        if (method === "doc/status") window.__dbxStatus = true;
        return result;
      });
    },
    copy: (text) => window.__dbxCopy(text),
    getConnections: () => window.__dbxGetConnections(),
    queryData: (request) => window.__dbxQueryData(request),
    storage: Object.freeze({
      get: (key) => window.__dbxStorageGet(key),
      set: (key, value) => window.__dbxStorageSet(key, value),
      delete: (key) => window.__dbxStorageDelete(key),
    }),
    fileTransfer: Object.freeze({
      pick: async () => ({ files: await window.__dbxPick(window.__dbxTest.pickQueue) }),
      read: (handleId, offset, length) => window.__dbxRead(handleId, offset, length),
      beginSave: (options) => window.__dbxBeginSave(options),
      write: (handleId, offset, data) => {
        if (typeof data === "string") return window.__dbxWrite(handleId, offset, data);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        return window.__dbxWrite(handleId, offset, encode(bytes));
      },
      finish: (handleId) => window.__dbxFinishSave(handleId),
      cancel: (handleId) => window.__dbxClose(handleId),
      onDragState: (listener) => { window.__dbxDragCb = listener; return () => { window.__dbxDragCb = null; }; },
      onDrop: (listener) => { window.__dbxDropCb = listener; return () => { window.__dbxDropCb = null; }; },
    }),
    onEvent: (listener) => { window.__dbxEventCb = listener; return () => { window.__dbxEventCb = null; }; },
    decodeBase64: (value) => {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    },
    encodeBase64: (value) => encode(value instanceof Uint8Array ? value : new Uint8Array(value)),
  });
});

sidecar.eventHook = (message) => {
  if (message.params && message.params.jobId && ["doc/done", "doc/error", "doc/cancelled"].includes(message.method)) {
    terminalEvents.push(message);
  }
  page
    .evaluate((payload) => window.__dbxDeliverEvent(payload), { type: "event", method: message.method, params: message.params })
    .catch(() => {});
};

async function waitReady() {
  await page.waitForFunction(() => window.__dbxStatus === true, null, { timeout: 30000 });
  await page.waitForTimeout(150);
}

async function waitIdle() {
  try {
    await page.waitForFunction(() => {
      const items = Array.from(document.querySelectorAll(".file-item"));
      if (!items.length) return false;
      return items.every((item) => !["converting"].includes(item.dataset.status))
        && !document.querySelector("#conversionStrip").classList.contains("active");
    }, null, { timeout: 120000 });
  } catch (error) {
    const diag = await page.evaluate(() => ({
      statuses: Array.from(document.querySelectorAll(".file-item")).map((item) => ({
        name: item.querySelector(".file-name").textContent.trim(),
        status: item.dataset.status,
        meta: item.querySelector(".file-meta").textContent.trim(),
      })),
      strip: document.querySelector("#stripText").textContent,
      toasts: document.querySelector("#toastWrap").innerText,
    }));
    console.error("waitIdle timed out", JSON.stringify(diag));
    console.error("sidecar stderr:", sidecar.stderr.slice(-2000));
    console.error("console errors:", consoleErrors.join(" | "));
    throw error;
  }
  await page.waitForTimeout(150);
}

async function fileStatuses() {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".file-item").forEach((item) => {
      out[item.querySelector(".file-name").textContent.trim()] = item.dataset.status;
    });
    return out;
  });
}

async function checkStates() {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".file-item").forEach((item) => {
      const input = item.querySelector("input[data-check]");
      out[item.querySelector(".file-name").textContent.trim()] = {
        checked: Boolean(input && input.checked),
        disabled: Boolean(input && input.disabled),
      };
    });
    return out;
  });
}

async function itemId(name) {
  return page.evaluate((target) => {
    const item = Array.from(document.querySelectorAll(".file-item"))
      .find((node) => node.querySelector(".file-name").textContent.trim() === target);
    return item ? item.dataset.id : null;
  }, name);
}

async function selectItem(name) {
  const id = await itemId(name);
  if (!id) throw new Error(`missing queue item: ${name}`);
  await page.click(`.file-item[data-id="${id}"]`);
  await page.waitForTimeout(120);
}

async function openDrawer() {
  await page.click("#settingsBtn");
  await page.waitForTimeout(320);
}

async function closeDrawer() {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

await page.goto(uiUrl);
await waitReady();

check("初始队列为空", (await page.locator("#queueCount").textContent()) === "0");
check("初始空态提示拖入文档", (await page.locator("#previewBody").innerText()).includes("把文档拖进来"));
check("初始主按钮没有待转换文件", (await page.locator("#convertBtn").innerText()) === "没有待转换文件");
check("转换引擎就绪", (await page.locator("#convertBtn").innerText()) !== "引擎未就绪");
check("宿主能力就绪后已注册拖放监听", await page.evaluate(() => Boolean(window.__dbxDropCb)));
await page.screenshot({ path: path.join(shots, "ui-01-empty.png") });

// 1. 选择文件（含不支持类型）
await page.evaluate(() => window.__dbxTest.setPick(["sample.md", "sample.docx", "sample.pdf", "scanned.pdf", "sample.csv", "bad.exe"]));
await page.click("#addBtn");
await page.waitForTimeout(250);
let statuses = await fileStatuses();
check("选择 6 个文件进入队列", Object.keys(statuses).length === 6, JSON.stringify(statuses));
check("不支持的 .exe 立即标记失败", statuses["bad.exe"] === "failed", statuses["bad.exe"]);
check("其余文件进入待转换", ["sample.md", "sample.docx", "sample.pdf", "scanned.pdf", "sample.csv"].every((name) => statuses[name] === "ready"), JSON.stringify(statuses));
check("失败文件句柄已关闭", closedHandles.size >= 1, `closed=${closedHandles.size}`);
let queuedChecks = await checkStates();
check(
  "待转换文件默认勾选",
  ["sample.md", "sample.docx", "sample.pdf", "scanned.pdf", "sample.csv"].every((name) => queuedChecks[name]?.checked && !queuedChecks[name]?.disabled),
  JSON.stringify(queuedChecks),
);
check("不支持的文件不可勾选", queuedChecks["bad.exe"] && !queuedChecks["bad.exe"].checked && queuedChecks["bad.exe"].disabled, JSON.stringify(queuedChecks["bad.exe"]));
check("队列底部显示已选数量", (await page.locator("#queueFootText").innerText()).includes("已选 5"), await page.locator("#queueFootText").innerText());
const previewBeforeCheck = await page.locator("#previewIdentity .identity-name").innerText();
await page.locator(".file-item", { hasText: "sample.docx" }).locator("input[data-check]").uncheck();
check("勾选不会切换当前预览", (await page.locator("#previewIdentity .identity-name").innerText()) === previewBeforeCheck);
check("部分勾选时全选框为半选", await page.evaluate(() => document.querySelector("#checkAll").indeterminate === true));
await page.locator(".file-item", { hasText: "sample.docx" }).locator("input[data-check]").check();
const csvCheck = page.locator(".file-item", { hasText: "sample.csv" }).locator("input[data-check]");
await csvCheck.focus();
await page.keyboard.press("Space");
check(
  "空格只切换勾选且不切换预览",
  !(await csvCheck.isChecked()) && (await page.locator("#previewIdentity .identity-name").innerText()) === previewBeforeCheck,
);
await page.keyboard.press("Space");
await page.locator("#checkAll").uncheck();
check("全不选后主按钮禁用并提示未勾选", (await page.locator("#convertBtn").isDisabled()) && (await page.locator("#convertBtn").innerText()) === "未勾选待转换文件");
await page.locator("#checkAll").check();
check("全选后主按钮可用", !(await page.locator("#convertBtn").isDisabled()) && (await page.locator("#convertBtn").innerText()) === "开始转换");
await page.screenshot({ path: path.join(shots, "ui-02-queued.png") });

// 2. 批量转换
await page.click("#convertBtn");
await waitIdle();
statuses = await fileStatuses();
check("Markdown 转换完成", statuses["sample.md"] === "done", statuses["sample.md"]);
check("Word 转换完成", statuses["sample.docx"] === "done", statuses["sample.docx"]);
check("PDF 转换完成", statuses["sample.pdf"] === "done", statuses["sample.pdf"]);
check("CSV 转换完成", statuses["sample.csv"] === "done", statuses["sample.csv"]);
check("扫描 PDF 标记需要 OCR", statuses["scanned.pdf"] === "needsOcr", statuses["scanned.pdf"]);
check("失败项仍为失败", statuses["bad.exe"] === "failed", statuses["bad.exe"]);
check("插件输出模式打开输出目录", revealCalls === 1, `reveals=${revealCalls}`);
check("完成后主按钮无待转换", (await page.locator("#convertBtn").innerText()) === "没有待转换文件");
const settledChecks = await checkStates();
check("完成后勾选自队列清除", Object.values(settledChecks).every((state) => !state.checked), JSON.stringify(settledChecks));
check("无待转换时全选框禁用", await page.locator("#checkAll").isDisabled());
const doneEvents = terminalEvents.filter((event) => event.method === "doc/done");
check(
  "完成事件回报耗时",
  doneEvents.length >= 4 && doneEvents.every((event) => Number.isFinite(event.params.durationMs) && event.params.durationMs >= 0),
  doneEvents.map((event) => event.params.durationMs).join(",")
);

// 3. 预览 / Markdown / JSON / 结构
await selectItem("sample.md");
check("默认选中首个文件", (await page.locator("#previewIdentity").innerText()).includes("sample.md"));
const identityMeta = await page.locator("#previewIdentity .identity-meta").innerText();
check("预览文件头显示耗时", /耗时 \d+(\.\d+)? (毫秒|秒)/.test(identityMeta) || /耗时 \d+ 分 \d+ 秒/.test(identityMeta), identityMeta);
const previewText = await page.locator("#previewBody").innerText();
check("渲染 Markdown 预览", previewText.includes("项目周会纪要"), previewText.slice(0, 60));
check("预览区渲染表格", (await page.locator("#previewBody table").count()) > 0);
await page.screenshot({ path: path.join(shots, "ui-03-preview.png") });

await page.click('.tab[data-tab="markdown"]');
await page.waitForTimeout(150);
const markdownText = await page.locator("#previewBody").innerText();
check("Markdown tab 显示原始文本", markdownText.includes("# 项目周会纪要"), markdownText.slice(0, 40));
await page.click('.tab[data-tab="json"]');
await page.waitForTimeout(150);
const jsonText = await page.locator("#previewBody").innerText();
check("JSON tab 显示 Document Model", jsonText.includes('"engine"') && jsonText.includes('"blocks"'), jsonText.slice(0, 60));
await page.screenshot({ path: path.join(shots, "ui-04-json.png") });
await page.click('.tab[data-tab="structure"]');
await page.waitForTimeout(150);
const structureRows = await page.locator(".tree-row").count();
check("结构 tab 枚举块", structureRows > 5, `rows=${structureRows}`);
await page.click('.tab[data-tab="preview"]');
await page.waitForTimeout(120);

// 4. 复制与保存
await page.click("#copyBtn");
await page.waitForTimeout(200);
check("复制 Markdown 到宿主剪贴板", copied.length === 1 && copied[0].includes("# 项目周会纪要"), `copied=${copied.length}`);
await page.click("#saveBtn");
await page.waitForFunction(() => document.querySelector("#toastWrap").innerText.includes("已保存 sample.md"), null, { timeout: 10000 });
const savedMd = path.join(saveDir, "sample.md");
check("保存 Markdown 文件", fs.existsSync(savedMd) && fs.readFileSync(savedMd, "utf8").includes("项目周会纪要"));
await page.click('.tab[data-tab="json"]');
await page.click("#saveBtn");
await page.waitForFunction(() => document.querySelector("#toastWrap").innerText.includes("已保存 sample.json"), null, { timeout: 10000 });
const savedJson = path.join(saveDir, "sample.json");
check("保存 JSON 文件", fs.existsSync(savedJson) && JSON.parse(fs.readFileSync(savedJson, "utf8")).engine.name === "anydoc");
await page.click('.tab[data-tab="preview"]');

// 4b. Word 版式与 Word 导出
check("转换完成后保存 Word 按钮可用", !(await page.locator("#wordBtn").isDisabled()));
await page.click('.tab[data-tab="word"]');
await page.waitForTimeout(250);
check("Word 版式 tab 渲染 A4 版面", (await page.locator("#previewBody .word-sheet").count()) === 1);
check("Word 版式渲染标题与表格", (await page.locator("#previewBody .ws-title").count()) === 1 && (await page.locator("#previewBody .ws-table").count()) === 1);
check("Word 版式渲染列表与引用", (await page.locator("#previewBody .ws-list-item").count()) >= 3 && (await page.locator("#previewBody .ws-quote").count()) === 1);
check("Word 版式标注图片不嵌入", (await page.locator("#previewBody .fidelity-bar").innerText()).includes("图片不嵌入"));
await page.screenshot({ path: path.join(shots, "ui-11-word-layout.png") });
await page.click("#openWordFidelity");
await page.waitForTimeout(150);
check("还原说明弹窗列出保留与不保留两栏", (await page.locator("#wordLayer .keep-col").count()) === 2);
check("还原说明弹窗说明图片不嵌入", (await page.locator("#wordLayer").innerText()).includes("图片：源文档中的图片暂不嵌入"));
await page.screenshot({ path: path.join(shots, "ui-12-word-fidelity.png") });
await page.click("#confirmWordDialog");
await page.waitForTimeout(120);
check("关闭还原说明弹窗", await page.evaluate(() => document.querySelector("#wordLayer").hidden));

await page.click("#wordBtn");
await page.waitForFunction(() => document.querySelector("#toastWrap").innerText.includes("已保存 sample.docx"), null, { timeout: 30000 });
const savedWordDocx = path.join(saveDir, "sample.docx");
const savedWordBuffer = fs.existsSync(savedWordDocx) ? fs.readFileSync(savedWordDocx) : Buffer.alloc(0);
check("保存 Word 文件", savedWordBuffer.length > 1000 && savedWordBuffer.subarray(0, 2).toString("latin1") === "PK", `${savedWordBuffer.length}B`);
const savedWordXml = savedWordBuffer.length ? readZipEntry(savedWordBuffer, "word/document.xml").toString("utf8") : "";
check("Word 文档包含标题样式", savedWordXml.includes('w:pStyle w:val="Heading1"'));
check("Word 文档包含表格", savedWordXml.includes("<w:tbl>"));
check("Word 文档不嵌入图片", !listZipEntries(savedWordBuffer).some((entry) => entry.startsWith("word/media/")), listZipEntries(savedWordBuffer).join(","));
check("保存后按钮显示已保存 Word", (await page.locator("#wordBtnText").innerText()) === "已保存 Word");

const batchDir = path.join(workDir, "batch-word");
fs.mkdirSync(batchDir, { recursive: true });
if (fakePicker) fs.writeFileSync(pickerModeFile, `ok|${batchDir}`, "utf8");
check("全部保存 Word 按钮可用", !(await page.locator("#saveAllWordBtn").isDisabled()));
await page.click("#saveAllWordBtn");
await page.waitForTimeout(200);
check("批量保存弹窗列出可导出文件", (await page.locator("#wordBatchList .save-item").count()) >= 4);
await page.screenshot({ path: path.join(shots, "ui-13-word-batch.png") });
await page.click("#confirmWordBatch");
await page.waitForFunction(() => document.querySelector("#toastWrap").innerText.includes("个 Word 文件"), null, { timeout: 60000 });
const batchFiles = fs.existsSync(batchDir) ? fs.readdirSync(batchDir) : [];
check("批量保存写出多个 .docx", batchFiles.filter((name) => name.endsWith(".docx")).length >= 4, batchFiles.join(","));
if (fakePicker) fs.writeFileSync(pickerModeFile, "ok", "utf8");

await selectItem("bad.exe");
check("未转换文件的保存 Word 按钮禁用", await page.locator("#wordBtn").isDisabled());
check("未转换文件提示先转换", (await page.locator("#wordBtn").getAttribute("title")).includes("转换完成后可保存 Word"));
await selectItem("sample.md");

// 5. needsOcr 提示与 OCR 入口
await selectItem("scanned.pdf");
const ocrText = await page.locator("#previewBody").innerText();
check("扫描件显示 OCR 说明", ocrText.includes("扫描版 PDF 需要 OCR") && ocrText.includes("第 1 页"), ocrText.slice(0, 80));
await page.click("[data-open-ocr]");
await page.waitForTimeout(300);
check("OCR 入口打开配置弹窗", await page.evaluate(() => !document.querySelector("#ocrLayer").hidden));
check("配置弹窗显示 MinerU 凭据字段", await page.locator("#ocrMineruToken").isVisible());
await page.screenshot({ path: path.join(shots, "ui-05-needs-ocr.png") });
await page.click("#cancelOcr");
check("取消后关闭配置弹窗", await page.evaluate(() => document.querySelector("#ocrLayer").hidden));

// 5.5 配置百度 OCR、测试连接并重试扫描件
await page.click("#previewBody [data-open-ocr]");
await page.waitForTimeout(250);
check("弹窗默认选中 MinerU", (await page.locator('[data-provider="mineru"]').getAttribute("aria-checked")) === "true");
await page.click('[data-provider="baidu"]');
await page.waitForTimeout(150);
check(
  "切换服务商显示百度凭据字段",
  (await page.locator("#ocrBaiduApiKey").isVisible())
    && (await page.locator("#ocrBaiduSecretKey").isVisible())
    && !(await page.locator("#ocrMineruToken").isVisible()),
);
await page.click("#saveOcr");
await page.waitForTimeout(200);
check(
  "未填凭据时保存被拦截",
  (await page.locator("#ocrTestStatus").innerText()).includes("请先填写 API Key 与 Secret Key")
    && await page.evaluate(() => !document.querySelector("#ocrLayer").hidden),
);
await page.fill("#ocrBaiduApiKey", "bad-key");
await page.fill("#ocrBaiduSecretKey", "bad-secret");
await page.click("#testOcr");
await page.waitForFunction(() => {
  const el = document.querySelector("#ocrTestStatus");
  return el && !el.hidden && el.dataset.state === "error";
}, null, { timeout: 15000 });
const badTestText = await page.locator("#ocrTestStatus").innerText();
check("错误凭据的测试连接会失败", badTestText.length > 0, badTestText);
await page.fill("#ocrBaiduApiKey", "ui-baidu-key");
await page.fill("#ocrBaiduSecretKey", "ui-baidu-secret");
await page.click("#testOcr");
await page.waitForFunction(() => {
  const el = document.querySelector("#ocrTestStatus");
  return el && !el.hidden && el.dataset.state === "ok";
}, null, { timeout: 15000 });
const goodTestText = await page.locator("#ocrTestStatus").innerText();
check("百度凭据测试连接成功", goodTestText.includes("access_token"), goodTestText);
await page.screenshot({ path: path.join(shots, "ui-05b-ocr-config.png") });
await page.click("#saveOcr");
await page.waitForFunction(() => document.querySelector("#ocrLayer").hidden, null, { timeout: 15000 });
const ocrSaved = await sidecar.request("doc/ocrConfig", {});
check(
  "保存后服务端启用百度 OCR",
  ocrSaved.config.provider === "baidu" && ocrSaved.config.enabled === true && ocrSaved.config.ready === true,
  JSON.stringify(ocrSaved.config),
);
check("保存后提示已启用", (await page.locator("#toastWrap").innerText()).includes("已启用 百度 OCR"), await page.locator("#toastWrap").innerText());

await openDrawer();
check("设置页显示 OCR 已启用", (await page.locator("#ocrBadge").innerText()) === "已启用", await page.locator("#ocrBadge").innerText());
check("设置页 OCR 描述标明服务商", (await page.locator("#ocrDesc").innerText()).includes("百度 OCR"), await page.locator("#ocrDesc").innerText());
await page.click("#swOcr");
await page.waitForTimeout(400);
check(
  "关闭开关停用 OCR",
  (await page.locator("#swOcr").getAttribute("aria-checked")) === "false" && (await page.locator("#ocrBadge").innerText()) === "已配置",
  await page.locator("#ocrBadge").innerText(),
);
await page.click("#swOcr");
await page.waitForTimeout(400);
check("重新开启 OCR", (await page.locator("#swOcr").getAttribute("aria-checked")) === "true" && (await page.locator("#ocrBadge").innerText()) === "已启用");
await closeDrawer();

await selectItem("scanned.pdf");
check("就绪后 needsOcr 提供重试按钮", (await page.locator("#previewBody [data-retry-ocr]").innerText()).includes("百度 OCR"));
await page.click("#previewBody [data-retry-ocr]");
await page.waitForFunction(() => {
  const item = Array.from(document.querySelectorAll(".file-item"))
    .find((node) => node.querySelector(".file-name").textContent.trim() === "scanned.pdf");
  return item && item.dataset.status === "done";
}, null, { timeout: 60000 });
const ocrPreview = await page.locator("#previewBody").innerText();
check("云端 OCR 重试完成并显示识别结果", ocrPreview.includes("百度 OCR 识别结果"), ocrPreview.slice(0, 80));
check("OCR 重试调用百度接口", ocrMock.state.baiduCalls.length === 1, `calls=${ocrMock.state.baiduCalls.length}`);
await page.screenshot({ path: path.join(shots, "ui-05c-ocr-done.png") });

await openDrawer();

// 6. 设置持久化（此后保持抽屉打开状态检查）
await page.waitForTimeout(200);
await page.click("#swJson");
await page.selectOption("#namingSelect", "dated");
await page.selectOption("#locationSelect", "ask");
await page.click("#swOpenAfter");
await page.waitForTimeout(700);
const persisted = storage.settings;
check("设置写入宿主存储", persisted && persisted.json === false && persisted.naming === "dated" && persisted.location === "ask" && persisted.openAfter === false, JSON.stringify(persisted));
await closeDrawer();
await page.reload();
await waitReady();
await openDrawer();
const restored = await page.evaluate(() => ({
  json: document.querySelector("#swJson").getAttribute("aria-checked"),
  naming: document.querySelector("#namingSelect").value,
  location: document.querySelector("#locationSelect").value,
  openAfter: document.querySelector("#swOpenAfter").getAttribute("aria-checked"),
}));
check("重载后设置恢复", restored.json === "false" && restored.naming === "dated" && restored.location === "ask" && restored.openAfter === "false", JSON.stringify(restored));
await closeDrawer();

// 7. ask 模式保存：Markdown + JSON 均由宿主保存对话框落盘
await openDrawer();
await page.click("#swJson");
await page.waitForTimeout(500);
await closeDrawer();
await page.evaluate(() => window.__dbxTest.setPick(["sample.txt"]));
await page.click("#addBtn");
await page.waitForTimeout(200);
await page.click("#convertBtn");
await waitIdle();
const askDone = terminalEvents.filter((event) => event.method === "doc/done").pop();
check("ask 模式 sidecar 不写插件输出目录", askDone && Object.keys(askDone.params.outputs || {}).length === 0, JSON.stringify(askDone && askDone.params.outputs));
const dated = new Date();
const pad = (value) => String(value).padStart(2, "0");
const stamp = `${dated.getFullYear()}${pad(dated.getMonth() + 1)}${pad(dated.getDate())}`;
const askMd = path.join(saveDir, `sample-${stamp}.md`);
const askJson = path.join(saveDir, `sample-${stamp}.json`);
check("ask 模式保存 Markdown", fs.existsSync(askMd) && fs.readFileSync(askMd, "utf8").includes("DocLite"), askMd);
check("ask 模式保存 JSON", fs.existsSync(askJson) && JSON.parse(fs.readFileSync(askJson, "utf8")).engine.name === "anydoc", askJson);
check("ask 模式不打开输出目录", revealCalls === 1, `reveals=${revealCalls}`);
await page.screenshot({ path: path.join(shots, "ui-06-ask-saved.png") });

// 8. 取消与重试
await openDrawer();
await page.selectOption("#namingSelect", "original");
await page.selectOption("#locationSelect", "plugin");
await page.waitForTimeout(500);
await closeDrawer();
await page.evaluate(() => window.__dbxTest.setPick(["retry.txt"]));
await page.click("#addBtn");
await page.waitForTimeout(200);
await page.click("#convertBtn");
await page.waitForFunction(() => document.querySelectorAll('.file-item[data-status="converting"]').length === 1, null, { timeout: 15000 });
await page.waitForTimeout(300);
await page.click("#cancelBtn");
await page.waitForFunction(() => document.querySelectorAll('.file-item[data-status="ready"]').length === 1, null, { timeout: 30000 });
statuses = await fileStatuses();
check("取消后文件回到待转换", statuses["retry.txt"] === "ready", JSON.stringify(statuses));
check("取消后不产生失败项", Object.values(statuses).every((status) => status !== "failed"), JSON.stringify(statuses));
readDelays.set("retry.txt", 0);
await page.click("#convertBtn");
await waitIdle();
statuses = await fileStatuses();
check("取消后可重试并成功", statuses["retry.txt"] === "done", statuses["retry.txt"]);
check("重试后预览可用", (await page.locator("#previewBody").innerText()).includes("DocLite retry line"));
const bridgeStats = await page.evaluate(() => window.__dbxTest.bridgeStats);
check("大文件分片保持在宿主桥接上限内", bridgeStats.maxChunkParams > 0 && bridgeStats.maxChunkParams <= 2 * 1024 * 1024, `${bridgeStats.maxChunkParams} B`);
await page.screenshot({ path: path.join(shots, "ui-07-retry-done.png") });

// 8.5 自定义输出目录
const customDir = path.join(workDir, "custom-output");
fs.mkdirSync(customDir, { recursive: true });
await page.click("#clearBtn");
await page.waitForTimeout(200);
await openDrawer();
await page.selectOption("#locationSelect", "custom");
await page.waitForTimeout(200);
check("自定义目录输入行可见", await page.evaluate(() => !document.querySelector("#customDirRow").hidden));
await page.fill("#customDirInput", "");
await page.click("#checkCustomDir");
await page.waitForTimeout(300);
check("未填目录时给出提示", (await page.locator("#customDirStatus").innerText()).includes("请先填写保存目录"), await page.locator("#customDirStatus").innerText());
await page.fill("#customDirInput", customDir);
await page.click("#checkCustomDir");
await page.waitForTimeout(600);
check("目录校验通过", (await page.locator("#customDirStatus").innerText()).includes("目录可用"), await page.locator("#customDirStatus").innerText());
check("路径提示显示自定义目录", (await page.locator("#outputPathHint").innerText()).includes("custom-output"), await page.locator("#outputPathHint").innerText());
await page.screenshot({ path: path.join(shots, "ui-09b-custom-dir-setting.png") });

// 8.6 浏览按钮选择目录
if (fakePicker) {
  const pickedDir = path.join(workDir, "picked-output");
  fs.mkdirSync(pickedDir, { recursive: true });
  fs.writeFileSync(pickerModeFile, `ok|${pickedDir}`, "utf8");
  await page.click("#pickCustomDir");
  let picked = false;
  try {
    await page.waitForFunction(
      (expected) => document.querySelector("#customDirInput").value === expected,
      pickedDir,
      { timeout: 15000 },
    );
    picked = true;
  } catch {
    picked = false;
  }
  const inputValue = await page.locator("#customDirInput").inputValue();
  check("浏览按钮填入所选目录", picked && inputValue === pickedDir, inputValue);
  check("所选目录进入路径提示", (await page.locator("#outputPathHint").innerText()).includes("picked-output"), await page.locator("#outputPathHint").innerText());
  await page.waitForTimeout(600);
  const pickStatus = await page.locator("#customDirStatus").innerText();
  check("所选目录校验可用", pickStatus.includes("目录可用"), pickStatus);
  await page.screenshot({ path: path.join(shots, "ui-09c-picked-dir.png") });

  fs.writeFileSync(pickerModeFile, "cancel", "utf8");
  await page.click("#pickCustomDir");
  await page.waitForTimeout(1200);
  check("取消选择后保留原目录", (await page.locator("#customDirInput").inputValue()) === pickedDir, await page.locator("#customDirInput").inputValue());

  await page.fill("#customDirInput", customDir);
  await page.waitForTimeout(200);
} else {
  console.log("SKIP  浏览按钮用例需要 csc.exe 编译选择器替身");
}
if ((await page.locator("#swOpenAfter").getAttribute("aria-checked")) !== "true") await page.click("#swOpenAfter");
await page.waitForTimeout(500);
await closeDrawer();
await page.evaluate(() => window.__dbxTest.setPick(["sample.txt"]));
await page.click("#addBtn");
await page.waitForTimeout(200);
await page.click("#convertBtn");
await waitIdle();
const customDone = terminalEvents.filter((event) => event.method === "doc/done").pop();
check("自定义目录写入 Markdown", fs.existsSync(path.join(customDir, "sample.md")), customDone && JSON.stringify(customDone.params.outputs));
check("自定义目录写入 JSON", fs.existsSync(path.join(customDir, "sample.json")));
check("转换结果回报自定义目录", customDone && customDone.params.outputDir === customDir, customDone && customDone.params.outputDir);
check("队列标注输出目录", (await page.locator(".file-item[data-status=\"done\"] .file-meta").last().innerText()).includes("custom-output"));
const lastReveal = revealParams[revealParams.length - 1] || {};
check("完成后打开自定义目录", revealCalls === 2 && lastReveal.dir === customDir, `reveals=${revealCalls} ${JSON.stringify(lastReveal)}`);
await page.screenshot({ path: path.join(shots, "ui-09-custom-dir.png") });

// 8.7 选择文件夹：扫描、跳过不支持类型、按路径转换
const pickedInput = path.join(workDir, "picked-input");
fs.mkdirSync(path.join(pickedInput, "sub"), { recursive: true });
fs.copyFileSync(path.join(samples, "sample.md"), path.join(pickedInput, "report.md"));
fs.copyFileSync(path.join(samples, "sample.csv"), path.join(pickedInput, "sub", "chart.csv"));
fs.writeFileSync(path.join(pickedInput, "sub", "skip.png"), "PNG");
fs.writeFileSync(path.join(pickedInput, ".hidden.md"), "# hidden\n");
if (fakePicker) {
  const beforeFolder = Number(await page.locator("#queueCount").textContent());
  fs.writeFileSync(pickerModeFile, `ok|${pickedInput}`, "utf8");
  await page.click("#addFolderBtn");
  let folderAdded = false;
  try {
    await page.waitForFunction(
      (expected) => Number(document.querySelector("#queueCount").textContent) === expected,
      beforeFolder + 2,
      { timeout: 20000 },
    );
    folderAdded = true;
  } catch {
    folderAdded = false;
  }
  const folderStatuses = await fileStatuses();
  check("选择文件夹扫描出 2 个文档", folderAdded, `${beforeFolder} -> ${await page.locator("#queueCount").textContent()}`);
  check(
    "文件夹内文档进入待转换",
    folderStatuses["report.md"] === "ready" && folderStatuses["chart.csv"] === "ready",
    JSON.stringify(folderStatuses),
  );
  check("文件夹内不支持类型不进入队列", !("skip.png" in folderStatuses), Object.keys(folderStatuses).join(","));
  check("文件夹内隐藏文件不进入队列", !(".hidden.md" in folderStatuses), Object.keys(folderStatuses).join(","));
  const folderToast = await page.locator("#toastWrap").innerText();
  check("文件夹导入提示跳过数量", folderToast.includes("已加入 2 个文档") && folderToast.includes("跳过 1 个不支持的文件"), folderToast);
  const folderChecks = await checkStates();
  check("文件夹文档默认勾选", folderChecks["report.md"]?.checked && folderChecks["chart.csv"]?.checked, JSON.stringify(folderChecks));
  await page.locator(".file-item", { hasText: "chart.csv" }).locator("input[data-check]").uncheck();
  check("取消一个勾选后全选框为半选", await page.evaluate(() => document.querySelector("#checkAll").indeterminate === true));
  await page.click("#convertBtn");
  await waitIdle();
  const selectiveStatuses = await fileStatuses();
  check("仅转换勾选的文件", selectiveStatuses["report.md"] === "done" && selectiveStatuses["chart.csv"] === "ready", JSON.stringify(selectiveStatuses));
  check("未勾选文件不写入输出", fs.existsSync(path.join(customDir, "report.md")) && !fs.existsSync(path.join(customDir, "chart.json")));
  check("未勾选时主按钮提示未勾选", (await page.locator("#convertBtn").innerText()) === "未勾选待转换文件");
  await page.locator(".file-item", { hasText: "chart.csv" }).locator("input[data-check]").check();
  await selectItem("chart.csv");
  const folderIdentity = await page.locator("#previewIdentity .identity-meta").innerText();
  check("子目录信息显示在预览文件头", folderIdentity.includes("sub"), folderIdentity);
  await page.screenshot({ path: path.join(shots, "ui-10-folder-picked.png") });

  await page.click("#convertBtn");
  await waitIdle();
  const folderConverted = await fileStatuses();
  check(
    "文件夹文档按路径转换完成",
    folderConverted["report.md"] === "done" && folderConverted["chart.csv"] === "done",
    JSON.stringify(folderConverted),
  );
  check("文件夹文档写入自定义目录", fs.existsSync(path.join(customDir, "report.md")) && fs.existsSync(path.join(customDir, "chart.json")));
  await page.screenshot({ path: path.join(shots, "ui-11-folder-done.png") });
} else {
  console.log("SKIP  选择文件夹用例需要 csc.exe 编译选择器替身");
}

// 9. 拖放与暗色主题
const beforeDrop = Number(await page.locator("#queueCount").textContent());
const dropped = await page.evaluate(() => window.__dbxTest.drop(["sample.txt"]));
await page.waitForTimeout(300);
const afterDrop = Number(await page.locator("#queueCount").textContent());
check("拖放文件加入队列", dropped === true && afterDrop === beforeDrop + 1, `${beforeDrop} -> ${afterDrop}`);

const beforeFolderDrop = Number(await page.locator("#queueCount").textContent());
const droppedFolder = await page.evaluate(() => window.__dbxTest.drop([
  { name: "sample.docx", relativePath: "contracts/sample.docx" },
  { name: "bad.exe", relativePath: "contracts/bad.exe" },
]));
await page.waitForTimeout(350);
const afterFolderDrop = Number(await page.locator("#queueCount").textContent());
check(
  "拖入文件夹只加入支持的文档",
  droppedFolder === true && afterFolderDrop === beforeFolderDrop + 1,
  `${beforeFolderDrop} -> ${afterFolderDrop}`,
);
const folderDropToast = await page.locator("#toastWrap").innerText();
check(
  "拖入文件夹提示跳过数量",
  folderDropToast.includes("已加入 1 个文档") && folderDropToast.includes("跳过 1 个不支持的文件"),
  folderDropToast,
);
check(
  "拖入文件夹的文档保留子目录",
  (await page.locator('.file-name[title="contracts/sample.docx"]').count()) === 1,
);
check(
  "拖入文件夹的文档默认勾选",
  await page.locator('.file-item:has(.file-name[title="contracts/sample.docx"]) input[data-check]').isChecked(),
);
await page.screenshot({ path: path.join(shots, "ui-12-folder-drop.png") });

// 10. 数据字典（Host API 1.4）
const queueBeforeDict = Number(await page.locator("#queueCount").textContent());
await page.click('.mode-btn[data-mode="dictionary"]');
await page.waitForFunction(() => document.querySelectorAll("#dictConnection option").length > 1, null, { timeout: 10000 });
check(
  "模式切换显示数据字典面板",
  (await page.locator("#dictWorkspace").isVisible()) && !(await page.locator("#convertWorkspace").isVisible()),
);
check(
  "数据字典模式隐藏文件转换控件",
  (await page.locator("#convertBtn").isHidden()) && (await page.locator("#openSettings").isHidden()) && (await page.locator("#settingsBtn").isHidden()),
);
const modeState = await page.evaluate(() => ({
  active: document.querySelector(".mode-btn.active")?.dataset.mode,
  selected: document.querySelector('.mode-btn[data-mode="dictionary"]')?.getAttribute("aria-selected"),
}));
check("模式按钮状态同步", modeState.active === "dictionary" && modeState.selected === "true", JSON.stringify(modeState));

const connectionOptions = await page.evaluate(() => Array.from(document.querySelectorAll("#dictConnection option")).map((option) => ({
  value: option.value,
  text: option.textContent,
  disabled: option.disabled,
})));
check("列出 DBX 已保存连接", connectionOptions.length === 10, connectionOptions.map((option) => option.text).join(" | "));
check(
  "未连接与不支持类型置灰",
  connectionOptions.find((option) => option.value === "mysql-down")?.disabled === true
    && connectionOptions.find((option) => option.value === "mongo-main")?.disabled === true
    && /暂不支持/.test(connectionOptions.find((option) => option.value === "mongo-main")?.text || ""),
  connectionOptions.filter((option) => option.disabled).map((option) => option.text).join(" | "),
);
check("读取连接列表不触发数据查询", dataQueries.length === 0, `queries=${dataQueries.length}`);
check("未选连接时不显示库筛选框", await page.locator("#dictDbFilter").isHidden());

await page.selectOption("#dictConnection", "mysql-main");
await page.waitForFunction(() => document.querySelectorAll("#dictDatabases input[data-db]").length === 2, null, { timeout: 10000 });
const databasePanel = await page.locator("#dictDatabases").innerText();
check("MySQL 列出可见库", databasePanel.includes("shop") && databasePanel.includes("analytics"), databasePanel);
check("未勾选库时不列出表", (await page.locator("#dictTables").innerText()).includes("勾选库后列出表"));

await page.locator("#dictDatabases input[data-db]").first().check();
await page.waitForFunction(() => document.querySelectorAll("#dictTables input[data-table]").length === 3, null, { timeout: 10000 });
const mysqlTableNames = await page.evaluate(() => Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent));
check("勾选库后加载表且默认全选", mysqlTableNames.join(",") === "order_items,orders,users", mysqlTableNames.join(","));
check("统计已选表数量", (await page.locator("#dictFootText").innerText()) === "已选 3 张表");
check("选择表后生成按钮可用", !(await page.locator("#dictGenerateBtn").isDisabled()));

check("选择连接后显示库筛选框", await page.locator("#dictDbFilter").isVisible());
await page.fill("#dictDbFilter", "ana");
await page.waitForTimeout(120);
const filteredDatabases = await page.evaluate(() => Array.from(document.querySelectorAll("#dictDatabases input[data-db]")).map((input) => input.parentElement.textContent.trim()));
check("按库名筛选", filteredDatabases.length === 1 && filteredDatabases[0].includes("analytics"), filteredDatabases.join(" | "));
check("库筛选显示匹配数量", (await page.locator("#dictDatabases .dict-group-title .dict-tag").innerText()) === "1/2");
check("提示被筛选隐藏的已勾选库", (await page.locator("#dictDatabases .dict-hidden-note").innerText()).includes("已勾选的 1 个库"));
check("库筛选不影响已选表", (await page.locator("#dictFootText").innerText()) === "已选 3 张表");
await page.screenshot({ path: path.join(shots, "ui-13b-db-filter.png") });
await page.fill("#dictDbFilter", "zzz");
await page.waitForTimeout(120);
check("库筛选无匹配时给出提示", (await page.locator("#dictDatabases").innerText()).includes("没有匹配的库"));
await page.fill("#dictDbFilter", "");
await page.waitForTimeout(120);
check("清空库筛选恢复全部库", (await page.locator("#dictDatabases input[data-db]").count()) === 2);

await page.fill("#dictFilter", "订单");
await page.waitForTimeout(120);
const filteredTables = await page.evaluate(() => Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent));
check("按表名与注释筛选", filteredTables.join(",") === "order_items,orders", filteredTables.join(","));
await page.fill("#dictFilter", "");
await page.waitForTimeout(120);
check("清空筛选恢复全部表", (await page.locator("#dictTables input[data-table]").count()) === 3);

await page.click("#dictGenerateBtn");
await page.waitForFunction(() => Boolean(document.querySelector("#dictBody .prose h1")), null, { timeout: 15000 });
check("生成 MySQL 数据字典", (await page.locator("#dictBody .prose h1").innerText()).includes("生产 MySQL"));
const mysqlBody = await page.locator("#dictBody").innerText();
check(
  "字典包含表注释与字段注释",
  mysqlBody.includes("orders — 订单") && mysqlBody.includes("订单号") && mysqlBody.includes("创建时间"),
  mysqlBody.slice(0, 120),
);
check("字典标注主键与唯一键", mysqlBody.includes("PK") && mysqlBody.includes("UK") && mysqlBody.includes("uk_orders_no"));
check("字典列出索引与外键", mysqlBody.includes("idx_orders_user") && mysqlBody.includes("fk_orders_user") && mysqlBody.includes("users(id)"));
const mysqlStats = await page.locator("#dictIdentity .identity-meta").innerText();
check("字典统计表数与字段数", /3 张表 · 13 个字段/.test(mysqlStats), mysqlStats);
await page.screenshot({ path: path.join(shots, "ui-13-dictionary.png") });

await page.click("#dictCopyBtn");
await page.waitForTimeout(150);
check("复制数据字典 Markdown", (copied.at(-1) || "").includes("# 数据库数据字典：生产 MySQL"));
await page.click("#dictSaveBtn");
await page.waitForTimeout(400);
const dictionaryFile = path.join(saveDir, "生产 MySQL-数据字典.md");
check(
  "保存数据字典为 Markdown",
  fs.existsSync(dictionaryFile) && fs.readFileSync(dictionaryFile, "utf8").includes("## 库 `shop`"),
  dictionaryFile,
);

check("生成后 Word 保存按钮可用", !(await page.locator("#dictSaveWordBtn").isDisabled()));
await page.click("#dictSaveWordBtn");
await page.waitForFunction(() => document.querySelector("#toastWrap").innerText.includes("已保存为 Word"), null, { timeout: 30000 });
const dictionaryDocx = path.join(saveDir, "生产 MySQL-数据字典.docx");
const docxBuffer = fs.existsSync(dictionaryDocx) ? fs.readFileSync(dictionaryDocx) : Buffer.alloc(0);
check("保存数据字典为 Word", docxBuffer.length > 1000 && docxBuffer.subarray(0, 2).toString("latin1") === "PK", `${dictionaryDocx} ${docxBuffer.length}B`);
const docxDocument = docxBuffer.length ? readZipEntry(docxBuffer, "word/document.xml").toString("utf8") : "";
check(
  "Word 文档包含字典内容",
  docxDocument.includes("数据库数据字典：生产 MySQL") && docxDocument.includes("orders") && docxDocument.includes("订单号"),
  `${docxDocument.length} chars`,
);
check(
  "Word 表格使用重复表头",
  docxDocument.includes("<w:tblHeader/>") || docxDocument.includes("<w:tblHeader "),
);
check("保存 Word 后按钮恢复可用", !(await page.locator("#dictSaveWordBtn").isDisabled()) && (await page.locator("#dictSaveWordBtn").innerText()).includes("保存 Word"));

await page.click('.mode-btn[data-mode="convert"]');
await page.waitForTimeout(150);
check(
  "切回文档转换保留队列",
  (await page.locator("#convertWorkspace").isVisible()) && Number(await page.locator("#queueCount").textContent()) === queueBeforeDict,
);
check("切回文档转换恢复转换控件", (await page.locator("#convertBtn").isVisible()) && (await page.locator("#openSettings").isVisible()));
await page.click('.mode-btn[data-mode="dictionary"]');
await page.waitForTimeout(200);
check("切回数据字典保留生成结果", (await page.locator("#dictBody .prose h1").innerText()).includes("生产 MySQL"));

await page.evaluate(() => window.__dbxDenyData(true));
await page.click("#dictGenerateBtn");
await page.waitForFunction(() => {
  const alert = document.querySelector("#dictAlert .dict-alert");
  return Boolean(alert && alert.classList.contains("danger"));
}, null, { timeout: 10000 });
const deniedText = await page.locator("#dictAlert").innerText();
check("拒绝授权时给出中文提示", deniedText.includes("未获得只读授权"), deniedText);
check("拒绝授权时不产出字典", (await page.locator("#dictBody .prose h1").count()) === 0);
await page.evaluate(() => window.__dbxDenyData(false));

await page.fill("#dictDbFilter", "appdb");
await page.selectOption("#dictConnection", "pg-main");
await page.waitForFunction(() => document.querySelectorAll("#dictTables input[data-table]").length === 3, null, { timeout: 10000 });
check("切换连接重置库筛选", (await page.inputValue("#dictDbFilter")) === "");
const pgTableNames = await page.evaluate(() => Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent));
check("PostgreSQL 单库自动加载并按 schema 排序", pgTableNames.join(",") === "audit.change_log,customers,invoices", pgTableNames.join(","));
await page.click("#dictGenerateBtn");
await page.waitForFunction(() => Boolean(document.querySelector("#dictBody .prose h1")), null, { timeout: 15000 });
const pgBody = await page.locator("#dictBody").innerText();
check(
  "PostgreSQL 字典包含跨 schema 表",
  pgBody.includes("audit.change_log — 变更日志") && pgBody.includes("customers — 客户"),
  pgBody.slice(0, 160),
);
check("PostgreSQL 外键带 schema 前缀", pgBody.includes("invoices_customer_fk") && pgBody.includes("public.customers(id)"));
check("PostgreSQL 唯一索引标注 UK", pgBody.includes("uk_customers_code") && pgBody.includes("UK"));

await page.selectOption("#dictConnection", "sqlite-main");
await page.waitForFunction(() => document.querySelectorAll("#dictTables input[data-table]").length === 2, null, { timeout: 10000 });
check("SQLite 使用连接内的库", (await page.locator("#dictDatabases").innerText()).includes("local.db"));
await page.click("#dictGenerateBtn");
await page.waitForFunction(() => Boolean(document.querySelector("#dictBody .prose h1")), null, { timeout: 15000 });
const sqliteBody = await page.locator("#dictBody").innerText();
check(
  "SQLite 字典包含主键与唯一索引",
  sqliteBody.includes("accounts") && sqliteBody.includes("entries") && sqliteBody.includes("uk_accounts_email")
    && sqliteBody.includes("PK") && sqliteBody.includes("UK"),
);
check("SQLite 外键生成约束名", sqliteBody.includes("entries_fk_0") && sqliteBody.includes("accounts(id)"));

// ---- SQL Server / Oracle / 达梦 / ClickHouse -------------------------------
await page.selectOption("#dictConnection", "sqlserver-main");
await page.waitForFunction(() => (
  Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent).join(",") === "dbo.audit_log,sales.customers,sales.orders"
), null, { timeout: 10000 });
const sqlserverTableNames = await page.evaluate(() => Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent));
check("SQL Server 表显示 schema 前缀并排序", sqlserverTableNames.join(",") === "dbo.audit_log,sales.customers,sales.orders", sqlserverTableNames.join(","));
check(
  "SQL Server 单库自动勾选",
  (await page.locator("#dictDatabases").innerText()).includes("appdb") && (await page.locator("#dictFootText").innerText()) === "已选 3 张表",
);
await page.click("#dictGenerateBtn");
await page.waitForFunction(() => Boolean(document.querySelector("#dictBody .prose h1")), null, { timeout: 15000 });
const sqlserverBody = await page.locator("#dictBody").innerText();
check("SQL Server 字典使用库标题", /^库 appdb$/m.test(sqlserverBody), sqlserverBody.slice(0, 120));
check(
  "SQL Server 表标题带 schema",
  sqlserverBody.includes("sales.orders — 订单") && sqlserverBody.includes("dbo.audit_log — 审计日志"),
);
check(
  "SQL Server 类型保留长度与精度",
  sqlserverBody.includes("nvarchar(32)") && sqlserverBody.includes("nvarchar(max)")
    && sqlserverBody.includes("decimal(12,2)") && sqlserverBody.includes("datetime2(7)"),
);
check("SQL Server 标注主键与唯一键", sqlserverBody.includes("PK_orders") && sqlserverBody.includes("UK_orders_no") && sqlserverBody.includes("UK"));
check("SQL Server 外键带 schema 前缀", sqlserverBody.includes("FK_orders_customer") && sqlserverBody.includes("sales.customers(id)"));
const sqlserverStats = await page.locator("#dictIdentity .identity-meta").innerText();
check("SQL Server 统计表数与字段数", /3 张表 · 10 个字段/.test(sqlserverStats), sqlserverStats);

await page.selectOption("#dictConnection", "oracle-main");
await page.waitForFunction(() => (
  Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent).join(",") === "CUSTOMERS,ORDERS"
), null, { timeout: 10000 });
const oraclePanel = await page.locator("#dictDatabases").innerText();
check("Oracle 用模式承载库一级", oraclePanel.includes("模式") && oraclePanel.includes("APP"), oraclePanel);
check("Oracle 库筛选改称模式", (await page.locator("#dictDbFilter").getAttribute("placeholder")) === "筛选模式名");
const oracleTableNames = await page.evaluate(() => Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent));
check("Oracle 表名不重复拼接模式", oracleTableNames.join(",") === "CUSTOMERS,ORDERS", oracleTableNames.join(","));
await page.click("#dictGenerateBtn");
await page.waitForFunction(() => Boolean(document.querySelector("#dictBody .prose h1")), null, { timeout: 15000 });
const oracleBody = await page.locator("#dictBody").innerText();
check("Oracle 字典使用模式标题", /^模式 APP$/m.test(oracleBody), oracleBody.slice(0, 120));
check("Oracle 类型保留长度与精度", oracleBody.includes("NUMBER(19)") && oracleBody.includes("VARCHAR2(32)") && oracleBody.includes("NUMBER(12,2)") && oracleBody.includes("TIMESTAMP(6)"));
check("Oracle 标注主键与唯一键", oracleBody.includes("PK_ORDERS") && oracleBody.includes("UK_ORDERS_NO"));
check("Oracle 同模式外键不带前缀", oracleBody.includes("FK_ORDERS_CUSTOMER") && oracleBody.includes("CUSTOMERS(CUSTOMER_ID)"));
const oracleStats = await page.locator("#dictIdentity .identity-meta").innerText();
check("Oracle 统计表数与字段数", /2 张表 · 7 个字段/.test(oracleStats), oracleStats);

await page.selectOption("#dictConnection", "dameng-main");
await page.waitForFunction(() => (
  Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent).join(",") === "CUSTOMER,ORDER_INFO"
), null, { timeout: 10000 });
check("达梦复用 Oracle 方言", (await page.locator("#dictDatabases").innerText()).includes("DMHR"));
await page.click("#dictGenerateBtn");
await page.waitForFunction(() => Boolean(document.querySelector("#dictBody .prose h1")), null, { timeout: 15000 });
const damengBody = await page.locator("#dictBody").innerText();
check("达梦字典使用模式标题", /^模式 DMHR$/m.test(damengBody) && damengBody.includes("ORDER_INFO — 订单信息"), damengBody.slice(0, 120));
check("达梦类型与外键", damengBody.includes("DECIMAL(12,2)") && damengBody.includes("FK_ORDER_CUSTOMER") && damengBody.includes("CUSTOMER(CUSTOMER_ID)"));

await page.selectOption("#dictConnection", "clickhouse-main");
await page.waitForFunction(() => (
  Array.from(document.querySelectorAll("#dictTables .dict-table-name")).map((element) => element.textContent).join(",") === "events,sessions"
), null, { timeout: 10000 });
check("ClickHouse 库自动加载", (await page.locator("#dictDatabases").innerText()).includes("analytics"));
await page.click("#dictGenerateBtn");
await page.waitForFunction(() => Boolean(document.querySelector("#dictBody .prose h1")), null, { timeout: 15000 });
const clickhouseBody = await page.locator("#dictBody").innerText();
check("ClickHouse 类型含 Nullable", clickhouseBody.includes("Nullable(String)") && clickhouseBody.includes("Nullable(UInt32)") && clickhouseBody.includes("UUID"));
check("ClickHouse 用排序键生成 PRIMARY 索引", clickhouseBody.includes("PRIMARY") && clickhouseBody.includes("event_id"));
check("ClickHouse 无外键时不报警告", !clickhouseBody.includes("外键信息读取失败"), clickhouseBody.slice(0, 200));
const clickhouseStats = await page.locator("#dictIdentity .identity-meta").innerText();
check("ClickHouse 统计表数与字段数", /2 张表 · 6 个字段/.test(clickhouseStats), clickhouseStats);

const illegalQueries = dataQueries.filter((query) => (
  !query.connectionId
  || !query.sql
  || (query.maxRows || 0) > 5000
  || query.sql.length > 100000
  || query.sql.includes(";")
  || /^\s*USE\b/i.test(query.sql)
));
check("只读查询参数合法", illegalQueries.length === 0, JSON.stringify(illegalQueries.slice(0, 2)));
check(
  "覆盖三类数据库的目录查询",
  ["information_schema.columns", "pg_index", "pragma_table_info"].every((needle) => dataQueries.some((query) => query.sql.includes(needle))),
  `queries=${dataQueries.length}`,
);
const scopedQueries = dataQueries.filter((query) => !query.sql.includes("information_schema.schemata") && !query.sql.includes("FROM pg_database"));
check(
  "表级查询指定库，SQLite 不指定",
  scopedQueries.filter((query) => query.connectionId === "mysql-main").every((query) => query.database === "shop")
    && scopedQueries.filter((query) => query.connectionId === "pg-main").every((query) => query.database === "appdb")
    && dataQueries.filter((query) => query.connectionId === "sqlite-main").every((query) => query.database === undefined),
  `scoped=${scopedQueries.length}`,
);
check(
  "SQL Server 表级查询指定库",
  dataQueries.filter((query) => query.connectionId === "sqlserver-main" && !query.sql.includes("sys.databases"))
    .every((query) => query.database === "appdb"),
  JSON.stringify(dataQueries.filter((query) => query.connectionId === "sqlserver-main").map((query) => query.database)),
);
check(
  "Oracle 与达梦按 OWNER 过滤且不切换会话库",
  ["oracle-main", "dameng-main"].every((id) => {
    const queries = dataQueries.filter((query) => query.connectionId === id);
    return queries.length > 0
      && queries.every((query) => query.database === undefined)
      && queries.filter((query) => !query.sql.includes("all_users")).every((query) => /owner = '/.test(query.sql));
  }),
);
check(
  "Oracle 与达梦保留当前用户模式",
  ["oracle-main", "dameng-main"].every((id) => dataQueries.some((query) => (
    query.connectionId === id && query.sql.includes("FROM all_users") && query.sql.includes("= USER")
  ))),
);
check(
  "ClickHouse 按库名过滤且不切换会话库",
  dataQueries.filter((query) => query.connectionId === "clickhouse-main" && !query.sql.includes("system.databases"))
    .every((query) => query.database === undefined && query.sql.includes("'analytics'")),
);
check(
  "新方言目录查询覆盖",
  ["sys.tables", "all_tab_columns", "system.columns"].every((needle) => dataQueries.some((query) => query.sql.includes(needle))),
);

await page.evaluate(() => window.__dbxTest.theme("dark"));
await page.waitForTimeout(250);
check("跟随宿主切换到暗色主题", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
await page.screenshot({ path: path.join(shots, "ui-08-dark.png") });

// 清理与句柄状态检查
check("转换完成文件释放读取句柄", closedHandles.size >= 7, `closed=${closedHandles.size}`);
check("浏览器控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

const failed = results.filter((result) => !result.ok);
console.log("");
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const result of failed) console.log(`FAILED: ${result.name} ${result.detail}`);
}

await browser.close();
await sidecar.close();
await ocrMock.close();
process.exit(failed.length ? 1 : 0);
