# DocLite for DBX

A DBX workbench plugin that converts documents to Markdown locally, exports the
result as a Word document, and exports Markdown data dictionaries from databases
already connected in DBX. The UI is an iframe hosted by DBX; the conversion
engine runs in a Node sidecar inside the plugin package, so files never leave
the machine.

## Supported inputs

`doc`, `docx`, `docm`, `pdf`, `ppt`, `pps`, `pot`, `pptx`, `pptm`, `ppsx`,
`ppsm`, `xls`, `xlsx`, `xlsm`, `xlsb`, `csv`, `md`, `markdown`, `txt`, `odt`,
`ods`, `odp`, `rtf`, `epub`.

Scanned or image-only PDFs are detected before conversion and reported as
`needsOcr`. Once a cloud OCR provider is configured, those pages can be
recognized and converted without re-adding the file.

## Cloud OCR (optional)

OCR is opt-in and off by default. Open the settings drawer and click
`配置云端 OCR` to choose a provider:

- **MinerU 官方 API** — uploads the whole PDF, returns layered Markdown.
  Keeps layout and tables; best for scanned books. Requires an API Token.
- **百度 OCR** — renders only the pages that need recognition, uploads each
  page image, and returns plain text. No layout or table structure. Requires
  the API Key and Secret Key of a Baidu Smart Cloud OCR application.

Credentials are stored in `<DBX_PLUGIN_DATA_DIR>/ocr.json` (mode 0600) and
never written into converted files. `测试连接` validates them before saving.

Privacy boundary: with Baidu only the pages flagged as scanned are sent, with
MinerU the entire PDF is sent. Files that do not need OCR are never uploaded.
Nothing else in the plugin talks to the network.

Limits: each job stops above the configured page cap (1–200, default 100) and
reports `ocrPageLimit`; MinerU also enforces its own 200 MB per-file limit.
MinerU's image references are stripped from the Markdown because the images
are not packaged, and Baidu output is plain text without page layout.

The sidecar keeps the uploaded PDF for `needsOcr` and OCR failures so `重试`
works without another upload; the retained copy is deleted after success or
when the queue row is removed.

## Preview and queue

The preview header shows elapsed conversion time (`已用 …` while running,
`耗时 …` once finished), taken from the sidecar's `durationMs`.

Queue rows have checkboxes; `开始转换` converts only the checked files. Newly
added files — including everything indexed from a dropped or picked folder —
start checked, the header checkbox selects all pending files, and rows clear
their check once they finish, fail, or need OCR.

## Folders

Drop a folder anywhere on the workbench, or click the folder button in the
queue header / empty state. Dropped folders are expanded by DBX itself and
arrive as regular files; picked folders are scanned by the sidecar
(`doc/scanFolder`) and converted in place through `doc/begin`'s `sourcePath`,
so nothing is copied or modified. Both paths recurse into subdirectories,
skip dotfiles and symlinks, and stop at 2000 files / 8 levels. Files with
unsupported extensions are skipped silently (the toast reports how many);
supported files over 512 MB still show up as failed queue entries.

## Database data dictionary

The toolbar's `数据字典` mode exports a Markdown data dictionary from a
database that is already open in DBX. It never asks for credentials: the plugin
lists the saved connections through `host.getConnections` and runs read-only
catalog queries through `host.queryData` (`host.connections:read` and
`host.data:read`).

- **Supported**: MySQL family (MySQL, GBase, Doris, StarRocks, GoldenDB),
  PostgreSQL family (PostgreSQL, GaussDB, openGauss, Kingbase, HighGo,
  Vastbase, UXDB, GBase 8c, KWDB), SQLite, SQL Server, Oracle family (Oracle,
  OceanBase Oracle mode, 达梦 DM), and ClickHouse. Other connection types are
  listed but disabled.
- **Oracle-family notes**: Oracle, OceanBase Oracle mode and DM have no
  database list to browse, so the schemas visible in `ALL_USERS` are shown as
  模式 and the export is titled with 模式; catalog reads filter by `OWNER` and
  never switch the session schema. ClickHouse has no foreign keys, so its
  sorting-key columns are listed as a synthetic `PRIMARY` index and no
  foreign-key warning is emitted.
- **Scope**: pick any number of databases; the database list and the table list
  each have their own filter, and tables can be selected individually or per
  database. A connection that exposes only one database (SQLite, or a server
  with a single visible database) loads its tables as soon as it is selected.
- **Consent**: the first query on a connection triggers DBX's one-time
  read-only grant prompt. Declining leaves no data behind; generating again
  retries the prompt.
- **Output**: one Markdown document with the table comment and a column table
  (type, nullability, default, PK/UK, comment), plus indexes and foreign keys.
  Copy it, save it as Markdown, or save it as Word (`.docx`) through the host
  file picker. The Word export styles headings, converts column tables to real
  Word tables with a repeating header row, and keeps CJK text on a 宋体/Calibri
  font stack.
- **Limits**: the connection must be open in DBX, and each query returns at
  most 5000 rows; results cut by that cap are flagged in the document. Catalog
  tables that a compatible database does not implement (for example an index
  view missing from a Doris build) are skipped with a warning instead of
  failing the whole export.

The mode only reads metadata; it never executes DML.

## Word export

Every converted document can be saved as a Word file (`.docx`) — the entry is
generic, it is not limited to PDFs or to the data dictionary.

- **保存 Word** (preview header) writes the current document through the host
  file panel, so the save location is chosen by DBX itself.
- **全部保存 Word** (queue footer) asks for a folder once through the plugin's
  native picker and writes every finished document straight into it. Files with
  the same name never overwrite each other: the second one becomes
  `<name>-2.docx`.
- The **Word 版式** preview tab renders the same document model the exporter
  consumes, so what is shown matches what is written. It is labelled
  `版式估算` because the final pagination and line breaks follow Word's own
  layout engine.

Limits, stated in the `还原说明` dialog as well:

- **Images are not embedded.** The conversion pipeline keeps the alt text of an
  image and drops the binary, so the exported `.docx` contains no `word/media`
  part. Only the caption survives.
- The layout tab is an estimate, not a pixel-perfect rendering of the source
  document.
- The export reproduces headings, paragraphs, lists, tables, quotes, code
  blocks and rules; inline emphasis is flattened to plain text.
- The whole path runs locally; nothing is uploaded.

## Layout

```
manifest.json                 plugin manifest (Host API 1.4)
ui/                           sandboxed workbench UI
backend/sidecar.cjs           JSON-RPC sidecar (stdio JSONL)
backend/markdown-model.cjs    Markdown -> Document Model parser
backend/docx-writer.cjs       Markdown -> .docx writer (shared by the dictionary
                               export and the document export)
backend/vendor/               anydoc, pdf-inspector, pdfium + jpeg-js (OCR page
                               rendering), portable Node runtime
bin/windows-x64/              stdio-forwarding launcher declared in the manifest
                               + native folder picker used by "Browse…" and folder import
launcher/Launcher.cs          launcher source
launcher/Picker.cs            folder picker source
_build/                       vendor prep, samples, tests, packaging
```

## Build

```bash
node _build/prepare-vendor.mjs   # copy native modules + node.exe from DocLite installs
node _build/build-launcher.mjs   # compile the C# launcher with the in-box csc
node _build/build-picker.mjs     # compile the C# native folder picker
node _build/make-samples.mjs     # generate DOCX/PDF/CSV fixtures
node _build/test-sidecar.mjs     # 61 end-to-end sidecar checks (OCR via local mock)
node _build/test-ui.mjs          # 197 headless UI checks
node _build/package.mjs          # dist/dbx-doclite-<version>.dbxp
```

`prepare-vendor.mjs` reads native modules from `DOCLITE_ROOT`
(default `F:/ai-project-workspace/DocLite`). The bundled runtime is Node.js
v24.21.0 from the official `node-v24.21.0-win-x64.zip` release (zip sha256
`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`);
`backend/vendor/versions.json` records that version and the hash of the
vendored `node.exe`. To rebuild reproducibly, unpack that release and point
`NODE_EXE` at its `node.exe` before running the script.

## Install in DBX

Open Plugin Center, choose "Install from file", and select the `.dbxp`. Local
packages are unsigned; DBX installs them under the local-development policy.

## Data

Converted files are written to `<DBX_PLUGIN_DATA_DIR>/output`; uploads and
previews live under `<DBX_PLUGIN_DATA_DIR>/temp` and are cleaned up on start
(24 h for temp, 7 days for output). The UI can reveal the output folder and
save a copy through the host file picker.

The workbench also offers an output location of your own: pick "Custom
folder" in the settings drawer and click "Browse…" to choose it with the
native folder dialog, or paste an absolute path (for example
`D:\Documents\Converted`). The folder is created on demand, and the retention
sweep only touches the plugin output folder, never a custom one.
