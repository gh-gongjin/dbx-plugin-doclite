(() => {
  "use strict";

  const host = window.dbxPlugin;
  if (!host) {
    document.body.innerHTML = '<div style="padding:48px;font:13px system-ui;color:#737373">请在 DBX 中打开 DocLite。</div>';
    return;
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const SUPPORTED_EXTENSIONS = [
    "doc", "docx", "docm", "pdf", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
    "xls", "xlsx", "xlsm", "xlsb", "csv", "md", "markdown", "txt",
    "odt", "ods", "odp", "rtf", "epub"
  ];
  const MAX_FILE_BYTES = 512 * 1024 * 1024;
  // Host bridge rejects request params above 2 MiB; base64 inflates raw bytes by 4/3.
  const UPLOAD_CHUNK_BYTES = 1024 * 1024;
  const READ_CHUNK_BYTES = 4 * 1024 * 1024;
  const CONVERSION_TIMEOUT_MS = 10 * 60 * 1000;
  const PICK_TIMEOUT_MS = 5 * 60 * 1000;
  const UNDO_WINDOW_MS = 10000;
  const SETTINGS_KEY = "settings";

  const STATUS = {
    done: { label: "已完成", cls: "done" },
    ready: { label: "待转换", cls: "ready" },
    converting: { label: "转换中", cls: "converting" },
    needsOcr: { label: "需要 OCR", cls: "warn" },
    failed: { label: "失败", cls: "danger" }
  };

  const DEFAULT_SETTINGS = {
    markdown: true,
    json: true,
    naming: "original",
    location: "plugin",
    outputDir: "",
    openAfter: true
  };

  const DEFAULT_OCR_STATE = {
    provider: "mineru",
    enabled: false,
    configured: false,
    ready: false,
    maxPages: 100,
    language: "ch",
    mineru: { configured: false, tokenHint: "", modelVersion: "vlm" },
    baidu: { configured: false, apiKeyHint: "", secretKeyHint: "" }
  };

  const OCR_RETRY_CODES = new Set([
    "needsOcr", "ocrNotConfigured", "ocrAuth", "ocrQuota", "ocrTimeout",
    "ocrNetwork", "ocrMalformed", "ocrEngine", "ocrPageLimit", "ocrFailed"
  ]);

  const state = {
    files: [],
    selectedId: null,
    tab: "preview",
    theme: "light",
    converting: false,
    cancelRequested: false,
    convertingFileId: null,
    conversionTotal: 0,
    convertingIndex: 0,
    settings: { ...DEFAULT_SETTINGS },
    supported: SUPPORTED_EXTENSIONS.slice(),
    outputDir: "",
    ready: true,
    initialized: false,
    waiters: new Map(),
    cleanupTimers: new Map(),
    sequence: 0,
    settingsTimer: null,
    pickSession: null,
    lastInputDir: "",
    ocr: { ...DEFAULT_OCR_STATE, mineru: { ...DEFAULT_OCR_STATE.mineru }, baidu: { ...DEFAULT_OCR_STATE.baidu } },
    ocrTesting: false,
    ocrSaving: false
  };

  const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));

  const escapeText = (value = "") => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function errorText(error) {
    if (!error) return "操作失败，请重试。";
    const message = typeof error === "string" ? error : (error.message || String(error));
    return message && message.trim() ? message.trim() : "操作失败，请重试。";
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDuration(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    if (value < 1000) return `${value} 毫秒`;
    if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`;
    const minutes = Math.floor(value / 60000);
    const seconds = Math.round((value % 60000) / 1000);
    return `${minutes} 分 ${seconds} 秒`;
  }

  function baseName(name) {
    return String(name).replace(/\.[^.]+$/, "");
  }

  function extensionOf(name) {
    return (String(name).split(".").pop() || "").toLowerCase();
  }

  function fileKind(ext) {
    if (ext === "pdf") return "pdf";
    if (["doc", "docx", "docm", "odt", "rtf"].includes(ext)) return "doc";
    if (["ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "odp"].includes(ext)) return "pptx";
    if (["xls", "xlsx", "xlsm", "xlsb", "ods", "csv"].includes(ext)) return "xlsx";
    if (["md", "markdown", "txt"].includes(ext)) return "md";
    return "other";
  }

  function typeLabel(ext) {
    return String(ext || "?").toUpperCase().slice(0, 4);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function getSelected() {
    return state.files.find((file) => file.id === state.selectedId) || null;
  }

  function statusBadge(status) {
    const meta = STATUS[status] || STATUS.ready;
    const icon = status === "done" ? "i-check-circle"
      : status === "failed" ? "i-x-circle"
      : status === "needsOcr" ? "i-alert"
      : status === "converting" ? "i-refresh"
      : "";
    return `<span class="badge ${meta.cls}">${icon ? `<svg class="icon"><use href="#${icon}"/></svg>` : ""}${meta.label}</span>`;
  }

  function stateIcon(status) {
    if (status === "done") return `<svg class="icon state-check"><use href="#i-check-circle"/></svg>`;
    if (status === "needsOcr") return `<svg class="icon state-warn"><use href="#i-alert"/></svg>`;
    if (status === "failed") return `<svg class="icon state-danger"><use href="#i-x-circle"/></svg>`;
    if (status === "converting") return `<span class="spinner"></span>`;
    return `<span class="state-dot"></span>`;
  }

  function blockCount(file) {
    if (file.model && Array.isArray(file.model.blocks)) return file.model.blocks.length;
    if (file.stats && Number.isFinite(file.stats.blocks)) return file.stats.blocks;
    return 0;
  }

  function fileMeta(file) {
    const parts = [formatBytes(file.size)];
    if (file.status === "needsOcr") {
      parts.push("扫描件，需要 OCR");
    } else if (file.status === "failed") {
      parts.push("转换失败");
    } else if (file.status === "converting") {
      parts.push(`${file.progress || 0}%`);
    } else if (file.status === "done") {
      if (file.pages) parts.push(`${file.pages} 页`);
      const blocks = blockCount(file);
      if (blocks) parts.push(`${blocks} 个块`);
      if (file.outputDir) parts.push(`→ ${folderName(file.outputDir)}`);
    } else {
      parts.push("待转换");
    }
    return parts.join(" · ");
  }

  function fileMetaClass(file) {
    return file.status === "needsOcr" ? "warn" : file.status === "failed" ? "danger" : "";
  }

  function folderName(dir) {
    const parts = String(dir || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(dir || "");
  }

  function identityText(file) {
    if (!file) return "未选择文件";
    const parts = [String(file.ext || "?").toUpperCase(), formatBytes(file.size)];
    if (file.pages) parts.push(`${file.pages} 页`);
    const folder = folderOf(file.relativePath);
    if (folder) parts.push(folder);
    if (file.warnings && file.warnings.length) parts.push(`${file.warnings.length} 条提示`);
    const elapsed = elapsedMs(file);
    if (elapsed !== null) parts.push(`${file.status === "converting" ? "已用" : "耗时"} ${formatDuration(elapsed)}`);
    return parts.join(" · ");
  }

  function elapsedMs(file) {
    if (file.status === "converting") {
      return file.startedAt ? Math.max(0, Date.now() - file.startedAt) : null;
    }
    return Number.isFinite(file.durationMs) ? file.durationMs : null;
  }

  function render() {
    renderToolbar();
    renderQueue();
    renderPreview();
    renderSettings();
    renderStrip();
  }

  function renderToolbar() {
    const outputs = [];
    if (state.settings.markdown) outputs.push("Markdown");
    if (state.settings.json) outputs.push("JSON");
    $("#outputPillText").textContent = outputs.length ? outputs.join(" + ") : "未选择输出";
    const ready = state.files.filter((file) => file.status === "ready");
    const picked = ready.filter((file) => file.checked).length;
    const btn = $("#convertBtn");
    btn.disabled = state.converting || !picked || !state.ready;
    btn.textContent = state.converting ? "转换中…"
      : !state.ready ? "引擎未就绪"
      : picked ? "开始转换"
      : ready.length ? "未勾选待转换文件"
      : "没有待转换文件";
  }

  function syncSelectionSummary() {
    const ready = state.files.filter((file) => file.status === "ready");
    const picked = ready.filter((file) => file.checked).length;
    const all = $("#checkAll");
    if (all) {
      all.disabled = state.converting || ready.length === 0;
      all.checked = ready.length > 0 && picked === ready.length;
      all.indeterminate = picked > 0 && picked < ready.length;
    }
    const foot = $("#queueFootText");
    if (foot) {
      const total = state.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
      foot.textContent = state.files.length
        ? `${state.files.length} 个文件 · ${formatBytes(total)}${picked ? ` · 已选 ${picked}` : ""}`
        : "队列为空";
    }
  }

  function renderQueue() {
    const list = $("#fileList");
    $("#queueCount").textContent = String(state.files.length);
    syncSelectionSummary();
    $("#clearBtn").disabled = state.files.length === 0 || state.converting;

    if (!state.files.length) {
      list.innerHTML = `
        <div class="queue-empty">
          <div class="queue-empty-icon"><svg class="icon"><use href="#i-doc"/></svg></div>
          <div class="queue-empty-title">队列为空</div>
          <div>拖入文档开始</div>
        </div>`;
      return;
    }

    list.innerHTML = state.files.map((file) => {
      const selected = file.id === state.selectedId;
      const kind = fileKind(file.ext);
      const checkable = file.status === "ready" && !state.converting;
      return `
        <div class="file-item${selected ? " selected" : ""}" data-id="${escapeHtml(file.id)}" data-status="${escapeHtml(file.status)}" role="option" tabindex="0" aria-selected="${selected}">
          <label class="file-check"><input type="checkbox" data-check="${escapeHtml(file.id)}" aria-label="选择 ${escapeHtml(file.name)}" ${file.checked ? "checked" : ""} ${checkable ? "" : "disabled"}></label>
          <span class="ftype ${kind}">${escapeHtml(typeLabel(file.ext))}</span>
          <span class="file-main">
            <span class="file-name" title="${escapeHtml(file.relativePath || file.name)}">${escapeHtml(file.name)}</span>
            <span class="file-meta ${fileMetaClass(file)}">${escapeHtml(fileMeta(file))}</span>
          </span>
          <span class="file-state">${stateIcon(file.status)}</span>
          <button class="file-remove" type="button" data-remove="${escapeHtml(file.id)}" title="移出队列" aria-label="移出队列">
            <svg class="icon icon-sm"><use href="#i-x"/></svg>
          </button>
          ${file.status === "converting" ? `<span class="file-progress"><i style="width:${file.progress || 0}%"></i></span>` : ""}
        </div>`;
    }).join("");
  }

  function renderPreview() {
    const file = getSelected();
    const identity = $("#previewIdentity");
    const copyBtn = $("#copyBtn");
    const saveBtn = $("#saveBtn");
    const removeBtn = $("#removeBtn");
    const tabs = $$(".tab");
    const meta = $("#tabsMeta");

    if (!file) {
      identity.innerHTML = `
        <span class="ftype other">—</span>
        <span class="identity-text">
          <span class="identity-name"><span>未选择文件</span></span>
          <span class="identity-meta">从左侧队列选择一个文档</span>
        </span>`;
      copyBtn.disabled = true;
      saveBtn.disabled = true;
      removeBtn.disabled = true;
      tabs.forEach((tab) => { tab.disabled = true; });
      meta.textContent = "";
      renderEmpty();
      return;
    }

    identity.innerHTML = `
      <span class="ftype ${fileKind(file.ext)}">${escapeHtml(typeLabel(file.ext))}</span>
      <span class="identity-text">
        <span class="identity-name"><span>${escapeHtml(file.name)}</span>${statusBadge(file.status)}</span>
        <span class="identity-meta">${escapeHtml(identityText(file))}</span>
      </span>`;

    const done = file.status === "done";
    copyBtn.disabled = !done;
    saveBtn.disabled = !done;
    removeBtn.disabled = state.converting && file.status === "converting";
    tabs.forEach((tab) => {
      tab.disabled = !done;
      tab.classList.toggle("active", tab.dataset.tab === state.tab);
      tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
    });

    if (done) {
      meta.textContent = `${(file.markdown || "").length.toLocaleString("zh-CN")} 字符 · ${blockCount(file)} 个块`;
    } else {
      meta.textContent = STATUS[file.status]?.label || "";
    }

    renderPreviewBody(file);
  }

  function renderEmpty() {
    const body = $("#previewBody");
    body.innerHTML = `
      <div class="empty">
        <div class="empty-icon"><svg class="icon icon-lg"><use href="#i-doc"/></svg></div>
        <div class="empty-title">把文档拖进来</div>
        <div class="empty-sub">将 Word、PDF、PPT、Excel、EPUB 等文档转换为干净的 Markdown 和结构化 JSON。</div>
        <div class="format-chips">
          ${["PDF", "DOCX", "PPTX", "XLSX", "CSV", "EPUB", "ODT", "RTF", "MD"].map((x) => `<span class="format-chip">${x}</span>`).join("")}
        </div>
        <div class="empty-actions">
          <button class="btn btn-primary" type="button" data-pick>选择文件</button>
          <button class="btn" type="button" data-pick-folder>选择文件夹</button>
        </div>
      </div>`;
    body.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", pickFiles));
    body.querySelectorAll("[data-pick-folder]").forEach((btn) => btn.addEventListener("click", pickFolder));
  }

  function statePanel(opts) {
    return `
      <div class="state-panel">
        <div class="state-icon ${opts.cls || ""}">${opts.icon || ""}</div>
        <div class="state-title">${escapeHtml(opts.title)}</div>
        <div class="state-desc">${escapeHtml(opts.desc)}</div>
        ${opts.progress === undefined ? "" : `
          <div class="state-progress"><i class="state-progress-fill" style="width:${opts.progress}%"></i></div>
          <div class="state-progress-text">${opts.progress}%</div>`}
        <div class="state-actions">${opts.actions || ""}</div>
      </div>`;
  }

  function bindStateActions(file, body) {
    body.querySelectorAll("[data-convert-file]").forEach((btn) => btn.addEventListener("click", () => {
      startConversion([file.id]);
    }));
    body.querySelectorAll("[data-remove-file]").forEach((btn) => btn.addEventListener("click", () => removeFile(file.id)));
    body.querySelectorAll("[data-open-ocr]").forEach((btn) => btn.addEventListener("click", () => openOcrDialog()));
    body.querySelectorAll("[data-retry-ocr]").forEach((btn) => btn.addEventListener("click", () => { void retryOcr(file); }));
    body.querySelectorAll("[data-retry-preview]").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      await loadOutputs(file);
      renderPreview();
    }));
    const cancel = $("#stateCancel");
    if (cancel) cancel.addEventListener("click", requestCancel);
  }

  function renderPreviewBody(file) {
    const body = $("#previewBody");
    if (file.status !== "done") {
      let html = "";
      if (file.status === "ready") {
        html = statePanel({
          icon: `<svg class="icon icon-lg"><use href="#i-doc"/></svg>`,
          title: "尚未转换",
          desc: "转换后可在这里预览 Markdown、Document Model 与结构块。",
          actions: `
            <button class="btn btn-primary" type="button" data-convert-file${state.converting ? ' disabled title="批量转换进行中"' : ""}>转换此文件</button>
            <button class="btn" type="button" data-remove-file>移出队列</button>`
        });
      } else if (file.status === "converting") {
        html = statePanel({
          cls: "progress",
          icon: `<span class="spinner"></span>`,
          title: "正在转换",
          desc: `${file.stage || "正在转换"} · 完成后会立即更新预览。`,
          progress: file.progress || 0,
          actions: `<button class="btn" type="button" id="stateCancel">取消转换</button>`
        });
      } else if (file.status === "needsOcr") {
        const pages = Array.isArray(file.needsOcrPages) && file.needsOcrPages.length
          ? `检测到第 ${file.needsOcrPages.join("、")} 页是扫描或图片内容。`
          : "这份文档是扫描件或图片型文档。";
        const provider = ocrProviderLabel();
        const ready = state.ocr.ready;
        html = statePanel({
          cls: "warn",
          icon: `<svg class="icon icon-lg"><use href="#i-alert"/></svg>`,
          title: "扫描版 PDF 需要 OCR",
          desc: ready
            ? `${pages}已启用 ${provider}，可直接重试识别；原始文件仍保留在本机。`
            : `${pages}配置云端 OCR 后可识别这份扫描件，原始文件仍保留在本机。`,
          actions: ready
            ? `<button class="btn btn-primary" type="button" data-retry-ocr>用 ${provider} 重试</button>
               <button class="btn" type="button" data-open-ocr>OCR 设置</button>
               <button class="btn" type="button" data-remove-file>移出队列</button>`
            : `<button class="btn btn-primary" type="button" data-open-ocr>配置 OCR</button>
               <button class="btn" type="button" data-remove-file>移出队列</button>`
        });
      } else if (file.status === "failed") {
        const ocrError = OCR_RETRY_CODES.has(file.errorCode);
        const canRetry = ocrError && Boolean(file.jobId) && state.ocr.ready;
        html = statePanel({
          cls: "danger",
          icon: `<svg class="icon icon-lg"><use href="#i-x-circle"/></svg>`,
          title: "转换失败",
          desc: file.error || "文件无法解析，请检查文件是否损坏或加密。",
          actions: `
            ${canRetry ? `<button class="btn btn-primary" type="button" data-retry-ocr>用 ${ocrProviderLabel()} 重试</button>` : ""}
            ${ocrError ? `<button class="btn" type="button" data-open-ocr>OCR 设置</button>` : ""}
            <button class="btn" type="button" data-remove-file>移出队列</button>`
        });
      }
      body.innerHTML = html;
      bindStateActions(file, body);
      return;
    }

    if (file.previewError && !file.markdown) {
      body.innerHTML = statePanel({
        cls: "danger",
        icon: `<svg class="icon icon-lg"><use href="#i-x-circle"/></svg>`,
        title: "预览加载失败",
        desc: file.previewError,
        actions: `
          <button class="btn btn-primary" type="button" data-retry-preview>重试</button>
          <button class="btn" type="button" data-remove-file>移出队列</button>`
      });
      bindStateActions(file, body);
      return;
    }

    if (state.tab === "markdown") {
      body.innerHTML = `
        <div class="code-view">
          <div class="code-head"><b>Markdown</b><span>GFM</span><span class="spacer"></span><span>${(file.markdown || "").split("\n").length} 行</span></div>
          <div class="code-block"><pre>${escapeText(file.markdown || "")}</pre></div>
        </div>`;
      return;
    }

    if (state.tab === "json") {
      if (!file.model) {
        body.innerHTML = statePanel({
          cls: file.modelError ? "danger" : "",
          icon: `<svg class="icon icon-lg"><use href="#i-doc"/></svg>`,
          title: file.modelError ? "Document Model 加载失败" : "正在加载 Document Model",
          desc: file.modelError || "请稍候…",
          actions: `<button class="btn" type="button" data-retry-preview>重新加载</button>`
        });
        bindStateActions(file, body);
        return;
      }
      body.innerHTML = `
        <div class="code-view">
          <div class="code-head"><b>Document Model</b><span>JSON</span><span class="spacer"></span><span>${file.model.blocks?.length || 0} 个块</span></div>
          <div class="code-block"><pre>${highlightJson(file.model)}</pre></div>
        </div>`;
      return;
    }

    if (state.tab === "structure") {
      const model = file.model;
      if (!model) {
        body.innerHTML = statePanel({
          cls: file.modelError ? "danger" : "",
          icon: `<svg class="icon icon-lg"><use href="#i-doc"/></svg>`,
          title: file.modelError ? "结构加载失败" : "正在加载结构",
          desc: file.modelError || "请稍候…",
          actions: `<button class="btn" type="button" data-retry-preview>重新加载</button>`
        });
        bindStateActions(file, body);
        return;
      }
      const blocks = Array.isArray(model.blocks) ? model.blocks : [];
      body.innerHTML = `
        <div class="structure">
          <div class="structure-head"><b>结构块</b><span>Document Model</span><span class="spacer"></span><span>${blocks.length} blocks</span></div>
          <div class="tree">
            <div class="tree-row root">
              <span class="tree-type">Document</span>
              <span class="tree-text">${escapeHtml(file.name)}</span>
            </div>
            ${blocks.map((block) => `
              <div class="tree-row" style="padding-left:${20 + (block.level ? Math.min(block.level - 1, 5) * 14 : 0)}px">
                <span class="tree-type">${escapeHtml(block.modelType || block.type || "Block")}</span>
                <span class="tree-text">${escapeHtml(block.text || "—")}</span>
              </div>`).join("")}
          </div>
        </div>`;
      return;
    }

    const warnings = Array.isArray(file.warnings) ? file.warnings : [];
    body.innerHTML = `
      ${warnings.length ? `<div class="doc-warning"><svg class="icon"><use href="#i-alert"/></svg><span>${escapeHtml(warnings.join(" "))}</span></div>` : ""}
      <div class="doc-sheet"><article class="prose">${renderMarkdown(file.markdown || "")}</article></div>`;
  }

  function renderSettings() {
    setSwitch("#swMarkdown", state.settings.markdown);
    setSwitch("#swJson", state.settings.json);
    setSwitch("#swOpenAfter", state.settings.openAfter);
    $("#namingSelect").value = state.settings.naming;
    $("#locationSelect").value = state.settings.location;
    const custom = state.settings.location === "custom";
    const customRow = $("#customDirRow");
    if (customRow) customRow.hidden = !custom;
    const customInput = $("#customDirInput");
    if (customInput && document.activeElement !== customInput) {
      customInput.value = state.settings.outputDir || "";
    }
    renderOutputHint();
    renderOcrSettings();
    const dropzoneHint = $("#dropzoneHint");
    if (dropzoneHint && state.supported.length) {
      dropzoneHint.textContent = `支持 ${state.supported.length} 种格式 · 本地处理`;
    }
  }

  function renderOutputHint() {
    const hint = $("#outputPathHint");
    if (!hint) return;
    if (state.settings.location === "plugin") {
      const text = state.outputDir || "插件数据目录 / output";
      hint.textContent = text;
      hint.title = text;
    } else if (state.settings.location === "custom") {
      const text = state.settings.outputDir || "尚未设置保存目录";
      hint.textContent = text;
      hint.title = text;
    } else {
      hint.textContent = "转换完成时逐个询问";
      hint.title = "";
    }
  }

  function setSwitch(selector, checked) {
    const el = $(selector);
    if (el) el.setAttribute("aria-checked", String(Boolean(checked)));
  }

  async function checkCustomDir() {
    const dir = (state.settings.outputDir || "").trim();
    const status = $("#customDirStatus");
    const setStatus = (text, tone) => {
      if (!status) return;
      status.textContent = text;
      status.dataset.state = tone;
    };
    if (!dir) {
      setStatus("请先填写保存目录", "warn");
      return;
    }
    setStatus("正在检查…", "");
    try {
      const result = await host.invoke("doc/checkOutputDir", { dir }, { timeoutMs: 10000 });
      if (!result || typeof result.path !== "string") throw new Error("目录检查失败。");
      if (!result.exists) {
        setStatus("目录不存在，转换时会自动创建", "warn");
        return;
      }
      if (!result.writable) {
        setStatus("目录不可写，请换一个位置", "warn");
        return;
      }
      setStatus("目录可用", "ok");
    } catch (error) {
      setStatus(errorText(error), "error");
    }
  }

  function setCustomDirStatus(text, tone) {
    const status = $("#customDirStatus");
    if (!status) return;
    status.textContent = text;
    status.dataset.state = tone;
  }

  // The host exposes no directory picker, so the sidecar opens a native folder
  // browser in a helper process and reports the chosen path back.
  async function runFolderPicker(initial) {
    const started = await host.invoke("doc/pickFolder", { initial: String(initial || "").trim() }, { timeoutMs: 15000 });
    const token = started && started.token;
    if (!token) throw new Error("目录选择器没有启动。");
    const deadline = Date.now() + PICK_TIMEOUT_MS;
    for (;;) {
      const result = await host.invoke("doc/pickFolderResult", { token }, { timeoutMs: 15000 });
      if (!result || !result.done) {
        if (Date.now() > deadline) throw new Error("选择目录超时，请重新选择。");
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      return result.path ? { path: result.path } : { canceled: true, error: String(result.error || "") };
    }
  }

  async function pickCustomDir() {
    if (state.pickSession) return;
    const button = $("#pickCustomDir");
    if (button) button.disabled = true;
    state.pickSession = { kind: "output" };
    setCustomDirStatus("正在打开文件夹选择器…", "");
    try {
      const picked = await runFolderPicker(state.settings.outputDir);
      if (picked.canceled) {
        setCustomDirStatus(picked.error ? errorText(picked.error) : "已取消选择", picked.error ? "error" : "");
        return;
      }
      state.settings.outputDir = picked.path;
      const input = $("#customDirInput");
      if (input) input.value = picked.path;
      persistSettings();
      renderSettings();
      void checkCustomDir();
      showToast("已选择保存目录");
    } catch (error) {
      setCustomDirStatus(errorText(error), "error");
    } finally {
      state.pickSession = null;
      if (button) button.disabled = false;
    }
  }

  function renderStrip() {
    const strip = $("#conversionStrip");
    strip.classList.toggle("active", state.converting);
    if (!state.converting) return;
    const current = state.files.find((file) => file.id === state.convertingFileId);
    const completed = Math.max(0, (state.convertingIndex || 1) - 1);
    const targetCount = state.conversionTotal || state.files.filter((f) => f.status === "ready" || f.status === "converting").length;
    const pct = Math.round(((completed + (current ? (current.progress || 0) / 100 : 0)) / Math.max(1, targetCount)) * 100);
    $("#stripText").innerHTML = `正在转换 <b>${escapeHtml(current ? current.name : "")}</b> · ${Math.min(completed + 1, targetCount)}/${targetCount}`;
    $("#stripProgress").style.width = `${Math.min(99, pct)}%`;
    $("#stripPercent").textContent = `${Math.min(99, pct)}%`;
  }

  function updateProgressUI(file) {
    const item = $(`.file-item[data-id="${cssEscape(file.id)}"]`);
    if (item) {
      const bar = item.querySelector(".file-progress i");
      if (bar) bar.style.width = `${file.progress || 0}%`;
      const meta = item.querySelector(".file-meta");
      if (meta) meta.textContent = fileMeta(file);
    }
    if (state.selectedId === file.id) {
      const identityMeta = $("#previewIdentity .identity-meta");
      if (identityMeta) identityMeta.textContent = identityText(file);
      const fill = $(".state-progress-fill");
      const text = $(".state-progress-text");
      if (fill) fill.style.width = `${file.progress || 0}%`;
      if (text) text.textContent = `${file.progress || 0}%`;
    }
    const completed = Math.max(0, (state.convertingIndex || 1) - 1);
    const pct = Math.round(((completed + (file.progress || 0) / 100) / Math.max(1, state.conversionTotal)) * 100);
    $("#stripProgress").style.width = `${Math.min(99, pct)}%`;
    $("#stripPercent").textContent = `${Math.min(99, pct)}%`;
    $("#stripText").innerHTML = `正在转换 <b>${escapeHtml(file.name)}</b> · ${state.convertingIndex || 1}/${state.conversionTotal}`;
  }

  function selectFile(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    render();
  }

  async function pickFiles() {
    await initPromise;
    if (!state.initialized) { showToast("插件正在启动，请稍候"); return; }
    if (!host.capabilities?.fileTransfer?.pick) {
      showToast("当前宿主不支持文件选择");
      return;
    }
    try {
      const result = await host.fileTransfer.pick({ multiple: true });
      addFiles(result && result.files ? result.files : []);
    } catch (error) {
      showToast(`无法选择文件：${errorText(error)}`);
    }
  }

  async function pickFolder() {
    await initPromise;
    if (!state.initialized) { showToast("插件正在启动，请稍候"); return; }
    if (state.pickSession) return;
    state.pickSession = { kind: "input" };
    try {
      const picked = await runFolderPicker(state.lastInputDir);
      if (picked.canceled) {
        if (picked.error) showToast(`无法选择文件夹：${picked.error}`);
        return;
      }
      state.lastInputDir = picked.path;
      showToast("正在读取文件夹…", { duration: 1500 });
      const scan = await host.invoke("doc/scanFolder", { dir: picked.path }, { timeoutMs: 120000 });
      const files = scan && Array.isArray(scan.files) ? scan.files : [];
      if (!files.length) {
        showToast(scan && scan.skipped ? "文件夹里没有可转换的文档" : "文件夹是空的");
        return;
      }
      addFiles(files, {
        fromFolder: true,
        skipped: scan && Number(scan.skipped) ? Number(scan.skipped) : 0,
        truncated: Boolean(scan && scan.truncated)
      });
    } catch (error) {
      showToast(`无法读取文件夹：${errorText(error)}`);
    } finally {
      state.pickSession = null;
    }
  }

  function folderOf(relativePath) {
    const parts = String(relativePath || "").split("/").filter(Boolean);
    return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  }

  function releaseHandle(handleId) {
    if (!handleId) return;
    try {
      Promise.resolve(host.fileTransfer.cancel(handleId)).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  function addFiles(fileObjects, options = {}) {
    const incoming = Array.from(fileObjects || []);
    if (!incoming.length) return;
    const fromFolder = Boolean(options.fromFolder);
    let added = 0;
    let skipped = Math.max(0, Number(options.skipped) || 0);
    let duplicates = 0;
    let folderEntries = 0;
    let firstAdded = null;
    incoming.forEach((entry, index) => {
      const name = String(entry.name || `document-${index + 1}`);
      const ext = extensionOf(name);
      const size = Number(entry.size) || 0;
      const relativePath = String(entry.relativePath || "");
      const sourcePath = typeof entry.sourcePath === "string" && entry.sourcePath
        ? entry.sourcePath
        : (typeof entry.path === "string" ? entry.path : "");
      const folderEntry = fromFolder || Boolean(relativePath) || Boolean(sourcePath);
      if (folderEntry) folderEntries += 1;
      const supported = state.supported.includes(ext);
      if (folderEntry && !supported) {
        skipped += 1;
        releaseHandle(entry.handleId);
        return;
      }
      if (sourcePath) {
        const key = sourcePath.toLowerCase();
        if (state.files.some((file) => (file.sourcePath || "").toLowerCase() === key)) {
          duplicates += 1;
          return;
        }
      } else if (entry.handleId) {
        if (state.files.some((file) => file.handleId === entry.handleId)) {
          duplicates += 1;
          return;
        }
      } else if (folderEntry && state.files.some((file) => file.name === name && file.size === size && file.relativePath === relativePath)) {
        duplicates += 1;
        return;
      }
      let status = supported ? "ready" : "failed";
      let error = supported ? null : `不支持的文件类型：.${ext || "未知"}`;
      if (supported && size > MAX_FILE_BYTES) {
        status = "failed";
        error = "文件超过 512 MB 上限。";
      }
      const file = {
        id: `file-${Date.now()}-${state.sequence += 1}`,
        handleId: entry.handleId || null,
        sourcePath,
        relativePath,
        name,
        ext: ext || "?",
        size,
        status,
        checked: status === "ready",
        progress: 0,
        stage: "",
        startedAt: null,
        durationMs: null,
        jobId: null,
        markdown: "",
        model: null,
        pages: null,
        stats: null,
        warnings: [],
        outputs: {},
        names: {},
        error,
        errorCode: null,
        needsOcrPages: [],
        previewError: null,
        modelError: null
      };
      state.files.push(file);
      added += 1;
      if (!firstAdded) firstAdded = file;
      if (status === "failed") closeHandle(file);
    });
    if (firstAdded) {
      const fromFolderBatch = fromFolder || folderEntries > 0;
      if (!state.selectedId || !fromFolderBatch) state.selectedId = firstAdded.id;
      state.tab = "preview";
    }
    if (added) render();
    if (!added) {
      if (skipped) showToast("文件夹里没有可转换的文档");
      else if (duplicates) showToast("这些文档已经在队列里");
      return;
    }
    if (fromFolder || folderEntries) {
      const parts = [`已加入 ${added} 个文档`];
      if (skipped) parts.push(`跳过 ${skipped} 个不支持的文件`);
      if (duplicates) parts.push(`${duplicates} 个已在队列`);
      if (options.truncated) parts.push("文件较多，仅读取了前一部分");
      showToast(parts.join(" · "));
      return;
    }
    showToast(`已加入 ${added} 个文件`);
  }

  function resetReady(file) {
    file.status = "ready";
    file.checked = true;
    file.progress = 0;
    file.stage = "";
    file.startedAt = null;
    file.durationMs = null;
    file.jobId = null;
  }

  function removeFile(id) {
    const target = state.files.find((file) => file.id === id);
    if (!target) return;
    if (state.converting && target.status === "converting") {
      showToast("转换中的文件不能移出队列");
      return;
    }
    const index = state.files.indexOf(target);
    state.files.splice(index, 1);
    if (state.selectedId === id) {
      state.selectedId = state.files[Math.min(index, state.files.length - 1)]?.id || null;
    }
    render();
    scheduleCleanup(target);
    showToast(`已移出「${target.name}」`, {
      actionLabel: "撤销",
      duration: 5000,
      onAction: () => {
        cancelCleanup(target.id);
        state.files.splice(Math.min(index, state.files.length), 0, target);
        state.selectedId = target.id;
        render();
      }
    });
  }

  function clearAll() {
    if (state.converting) { showToast("转换进行中，暂时不能清空队列"); return; }
    if (!state.files.length) return;
    const snapshot = state.files.slice();
    const selected = state.selectedId;
    state.files = [];
    state.selectedId = null;
    render();
    snapshot.forEach(scheduleCleanup);
    showToast("已清空队列", {
      actionLabel: "撤销",
      duration: 5000,
      onAction: () => {
        snapshot.forEach((file) => cancelCleanup(file.id));
        state.files = snapshot;
        state.selectedId = selected;
        render();
      }
    });
  }

  function scheduleCleanup(file) {
    if (!file.handleId && !file.jobId) return;
    const timer = setTimeout(() => {
      state.cleanupTimers.delete(file.id);
      closeHandle(file);
      discardJob(file.jobId);
    }, UNDO_WINDOW_MS);
    state.cleanupTimers.set(file.id, timer);
  }

  function cancelCleanup(id) {
    const timer = state.cleanupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      state.cleanupTimers.delete(id);
    }
  }

  function closeHandle(file) {
    if (!file || !file.handleId) return;
    const handleId = file.handleId;
    file.handleId = null;
    try {
      Promise.resolve(host.fileTransfer.cancel(handleId)).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  function discardJob(jobId) {
    if (!jobId) return;
    try {
      Promise.resolve(host.invoke("doc/discard", { jobId }, { timeoutMs: 5000 })).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  function requestCancel() {
    if (!state.converting) return;
    if (!state.cancelRequested) showToast("正在取消转换…");
    state.cancelRequested = true;
    const file = state.files.find((item) => item.status === "converting" && item.jobId);
    if (file && file.jobId) cancelJob(file.jobId);
  }

  function cancelJob(jobId) {
    if (!jobId) return;
    try {
      Promise.resolve(host.invoke("doc/cancel", { jobId }, { timeoutMs: 10000 })).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  function waitForJob(jobId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.waiters.delete(jobId);
        resolve({ kind: "timeout" });
      }, CONVERSION_TIMEOUT_MS);
      state.waiters.set(jobId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
  }

  function handleBackendEvent(method, params) {
    const jobId = params && params.jobId;
    if (!jobId) return;
    const file = state.files.find((item) => item.jobId === jobId);
    if (!file) return;

    if (method === "doc/progress") {
      file.progress = Math.max(0, Math.min(100, Math.round(Number(params.progress) || 0)));
      file.stage = String(params.stage || "");
      if (file.status === "converting") updateProgressUI(file);
      return;
    }

    if (method === "doc/done") {
      file.status = "done";
      file.checked = false;
      file.progress = 100;
      file.stage = "转换完成";
      file.durationMs = Number.isFinite(params.durationMs)
        ? Math.max(0, params.durationMs)
        : (file.startedAt ? Math.max(0, Date.now() - file.startedAt) : null);
      file.pages = params.source && params.source.pages ? params.source.pages : null;
      file.stats = params.stats || null;
      file.warnings = Array.isArray(params.warnings) ? params.warnings.slice() : [];
      file.outputs = params.outputs || {};
      file.names = params.names || {};
      file.outputDir = typeof params.outputDir === "string" ? params.outputDir : "";
      file.error = null;
      file.errorCode = null;
    } else if (method === "doc/error") {
      file.status = params.code === "needsOcr" ? "needsOcr" : "failed";
      file.checked = false;
      file.progress = 0;
      file.stage = "";
      file.durationMs = Number.isFinite(params.durationMs)
        ? Math.max(0, params.durationMs)
        : (file.startedAt ? Math.max(0, Date.now() - file.startedAt) : null);
      file.error = String(params.message || "转换失败，请重试。");
      file.errorCode = String(params.code || "internal");
      file.needsOcrPages = Array.isArray(params.pages) ? params.pages.slice() : [];
    } else if (method === "doc/cancelled") {
      file.status = "ready";
      file.checked = true;
      file.progress = 0;
      file.stage = "";
      file.startedAt = null;
      file.durationMs = null;
      file.jobId = null;
    } else {
      return;
    }

    const waiter = state.waiters.get(jobId);
    if (waiter) {
      state.waiters.delete(jobId);
      waiter.resolve({
        kind: method === "doc/done" ? "done" : method === "doc/error" ? "error" : "cancelled",
        params
      });
    }
  }

  async function startConversion(ids = null) {
    if (state.converting) return;
    if (!state.ready) { showToast("转换引擎未就绪，请重新安装插件后再试"); return; }
    if (state.settings.location === "custom" && !(state.settings.outputDir || "").trim()) {
      showToast("请先在设置里填写保存目录");
      openSettings();
      const input = $("#customDirInput");
      if (input) input.focus();
      return;
    }
    const targets = state.files.filter((file) => file.status === "ready" && (ids ? ids.includes(file.id) : file.checked));
    if (!targets.length) { showToast("没有待转换文件"); return; }

    state.converting = true;
    state.cancelRequested = false;
    state.conversionTotal = targets.length;
    state.convertingIndex = 0;
    state.convertingFileId = null;
    render();

    let success = 0;
    let failed = 0;

    for (let index = 0; index < targets.length; index += 1) {
      if (state.cancelRequested) break;
      const file = targets[index];
      if (file.status !== "ready") continue;
      state.convertingIndex = index + 1;
      state.convertingFileId = file.id;
      if (!state.selectedId) state.selectedId = file.id;
      file.status = "converting";
      file.progress = 0;
      file.stage = "正在准备";
      file.startedAt = Date.now();
      file.durationMs = null;
      file.error = null;
      render();

      const outcome = await convertOne(file);
      if (outcome === "done") success += 1;
      else if (outcome === "failed") failed += 1;
      state.convertingFileId = null;
      render();
      if (outcome === "cancelled") break;
    }

    const cancelled = state.cancelRequested;
    state.converting = false;
    state.cancelRequested = false;
    state.convertingFileId = null;
    render();

    if (cancelled) {
      showToast(success ? `已取消转换 · 已完成 ${success} 个` : "已取消转换");
      return;
    }

    const pendingOcr = state.files.filter((file) => file.status === "needsOcr").length;
    const suffix = pendingOcr ? ` · ${pendingOcr} 个需要 OCR` : "";
    showToast(`转换完成：${success} 个成功${failed ? ` · ${failed} 个失败` : ""}${suffix}`);

    if (state.settings.openAfter && state.settings.location !== "ask" && success) {
      const params = state.settings.location === "custom" ? { dir: state.settings.outputDir } : {};
      host.invoke("doc/reveal", params, { timeoutMs: 5000 }).catch(() => {});
    }
  }

  async function uploadSource(file, jobId) {
    if (!file.handleId) throw new Error("文件句柄已失效，请重新添加文件。");
    let offset = 0;
    while (offset < file.size) {
      if (state.cancelRequested) return false;
      const length = Math.min(UPLOAD_CHUNK_BYTES, file.size - offset);
      const chunk = await host.fileTransfer.read(file.handleId, offset, length);
      if (!chunk || typeof chunk.dataBase64 !== "string") throw new Error("读取文件失败，请重新添加后再试。");
      if (state.cancelRequested) return false;
      await host.invoke("doc/chunk", { jobId, offset, dataBase64: chunk.dataBase64 }, { timeoutMs: 120000 });
      const copied = Number(chunk.length) || 0;
      if (!copied) throw new Error("读取文件失败，请重新添加后再试。");
      offset += copied;
      file.progress = Math.min(29, Math.round((offset / Math.max(1, file.size)) * 30));
      file.stage = "正在读取文件";
      updateProgressUI(file);
      if (chunk.eof && offset < file.size) throw new Error("文件读取不完整，请重新添加后再试。");
    }
    return true;
  }

  async function convertOne(file) {
    let jobId = null;
    let keepHandle = false;
    try {
      const beginParams = file.sourcePath
        ? { name: file.name, size: file.size, sourcePath: file.sourcePath }
        : { name: file.name, size: file.size };
      const begin = await host.invoke("doc/begin", beginParams, { timeoutMs: 20000 });
      jobId = String(begin && begin.jobId ? begin.jobId : "");
      if (!jobId) throw new Error("转换服务未返回任务 ID。");
      file.jobId = jobId;

      if (file.sourcePath) {
        file.progress = Math.max(file.progress || 0, 30);
        file.stage = "正在准备文件";
        updateProgressUI(file);
      } else {
        const uploaded = await uploadSource(file, jobId);
        if (!uploaded || state.cancelRequested) {
          keepHandle = true;
          cancelJob(jobId);
          resetReady(file);
          render();
          return "cancelled";
        }
      }

      const waiter = waitForJob(jobId);
      const options = {
        formats: { markdown: state.settings.markdown, json: state.settings.json },
        naming: state.settings.naming,
        location: state.settings.location,
        outputDir: state.settings.outputDir
      };
      try {
        await host.invoke("doc/commit", { jobId, options }, { timeoutMs: 30000 });
      } catch (error) {
        state.waiters.delete(jobId);
        throw error;
      }

      const outcome = await waiter;

      if (outcome.kind === "done") {
        await loadOutputs(file);
        closeHandle(file);
        if (state.settings.location === "ask") await saveOutputsAsk(file);
        render();
        return "done";
      }

      if (outcome.kind === "error") {
        closeHandle(file);
        render();
        return "failed";
      }

      if (outcome.kind === "timeout") {
        cancelJob(jobId);
        file.jobId = null;
        throw new Error("转换超时，请重试。");
      }

      keepHandle = true;
      resetReady(file);
      render();
      return "cancelled";
    } catch (error) {
      if (state.cancelRequested) {
        keepHandle = true;
        if (jobId) cancelJob(jobId);
        resetReady(file);
        render();
        return "cancelled";
      }
      file.status = "failed";
      file.checked = false;
      file.progress = 0;
      file.stage = "";
      file.error = errorText(error);
      file.errorCode = "internal";
      render();
      return "failed";
    } finally {
      if (!keepHandle) closeHandle(file);
    }
  }

  function decodeBase64(value) {
    if (typeof host.decodeBase64 === "function") {
      try { return host.decodeBase64(value); } catch { /* fall through */ }
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function readOutput(jobId, kind) {
    const parts = [];
    let offset = 0;
    let total = 0;
    for (let guard = 0; guard < 8192; guard += 1) {
      const chunk = await host.invoke("doc/readOutput", { jobId, kind, offset, length: READ_CHUNK_BYTES }, { timeoutMs: 30000 });
      if (!chunk || typeof chunk.dataBase64 !== "string") throw new Error("读取输出失败。");
      const bytes = decodeBase64(chunk.dataBase64);
      parts.push(bytes);
      total += bytes.length;
      offset = Number(chunk.offset) + Number(chunk.length);
      if (chunk.eof || !chunk.length) break;
    }
    if (!parts.length) return "";
    const merged = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      merged.set(part, at);
      at += part.length;
    }
    return new TextDecoder("utf-8").decode(merged);
  }

  async function loadOutputs(file) {
    file.previewError = null;
    file.modelError = null;
    if (!file.jobId) {
      file.previewError = "转换结果已失效，请重新添加文件。";
      return;
    }
    if (!file.markdown) {
      try {
        file.markdown = await readOutput(file.jobId, "preview");
      } catch (error) {
        file.previewError = errorText(error);
      }
    }
    if (!file.model) {
      try {
        const text = await readOutput(file.jobId, "json");
        file.model = JSON.parse(text);
      } catch (error) {
        file.modelError = errorText(error);
      }
    }
  }

  async function saveText(name, contentType, text) {
    if (!host.capabilities?.fileTransfer?.beginSave) throw new Error("当前宿主不支持保存文件。");
    const bytes = new TextEncoder().encode(text);
    const target = await host.fileTransfer.beginSave({ name, contentType, size: bytes.length });
    if (!target) return false;
    try {
      const chunkBytes = Math.max(1, Math.min(Number(target.chunkBytes) || 4 * 1024 * 1024, 8 * 1024 * 1024));
      let offset = 0;
      while (offset < bytes.length) {
        const slice = bytes.subarray(offset, offset + chunkBytes);
        await host.fileTransfer.write(target.handleId, offset, slice);
        offset += slice.length;
      }
      await host.fileTransfer.finish(target.handleId);
      return true;
    } catch (error) {
      try { await host.fileTransfer.cancel(target.handleId); } catch { /* best effort */ }
      throw error;
    }
  }

  async function saveOutputsAsk(file) {
    let skipped = false;
    if (state.settings.markdown) {
      if (!file.markdown) {
        showToast("Markdown 预览读取失败，已跳过保存");
      } else {
        const name = file.names?.markdown || `${baseName(file.name)}.md`;
        try {
          const saved = await saveText(name, "text/markdown;charset=utf-8", file.markdown);
          if (!saved) skipped = true;
        } catch (error) {
          showToast(`保存 Markdown 失败：${errorText(error)}`);
          skipped = true;
        }
      }
    }
    if (!skipped && state.settings.json && file.model) {
      const name = file.names?.json || `${baseName(file.name)}.json`;
      try {
        const saved = await saveText(name, "application/json;charset=utf-8", `${JSON.stringify(file.model, null, 2)}\n`);
        if (!saved) skipped = true;
      } catch (error) {
        showToast(`保存 JSON 失败：${errorText(error)}`);
      }
    }
    if (skipped) showToast("已取消保存");
  }

  async function copyCurrent() {
    const file = getSelected();
    if (!file || file.status !== "done") return;
    if (state.tab === "json" && !file.model) await loadOutputs(file);
    const content = state.tab === "json"
      ? (file.model ? `${JSON.stringify(file.model, null, 2)}\n` : "")
      : file.markdown || "";
    if (!content) { showToast("没有可复制的内容"); return; }
    try {
      await host.copy(content);
      showToast(state.tab === "json" ? "已复制 JSON" : "已复制 Markdown");
    } catch (error) {
      showToast(`复制失败：${errorText(error)}`);
    }
  }

  async function saveCurrent() {
    const file = getSelected();
    if (!file || file.status !== "done") return;
    const isJson = state.tab === "json";
    if (isJson && !file.model) await loadOutputs(file);
    if (isJson && !file.model) { showToast(file.modelError || "Document Model 尚未加载"); return; }
    const content = isJson ? `${JSON.stringify(file.model, null, 2)}\n` : file.markdown || "";
    const name = (isJson ? file.names?.json : file.names?.markdown) || `${baseName(file.name)}${isJson ? ".json" : ".md"}`;
    try {
      const saved = await saveText(name, isJson ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8", content);
      showToast(saved ? `已保存 ${name}` : "已取消保存");
    } catch (error) {
      showToast(`保存失败：${errorText(error)}`);
    }
  }

  function openSettings() {
    $("#settingsDrawer").classList.add("open");
    $("#scrim").classList.add("show");
    $("#settingsDrawer").setAttribute("aria-hidden", "false");
  }

  function closeSettings() {
    $("#settingsDrawer").classList.remove("open");
    $("#scrim").classList.remove("show");
    $("#settingsDrawer").setAttribute("aria-hidden", "true");
  }

  function normalizeOcrState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const mineru = source.mineru && typeof source.mineru === "object" ? source.mineru : {};
    const baidu = source.baidu && typeof source.baidu === "object" ? source.baidu : {};
    const maxPages = Number(source.maxPages);
    return {
      provider: source.provider === "baidu" ? "baidu" : "mineru",
      enabled: Boolean(source.enabled),
      configured: Boolean(source.configured),
      ready: Boolean(source.ready),
      maxPages: Number.isFinite(maxPages) ? Math.max(1, Math.min(200, Math.round(maxPages))) : DEFAULT_OCR_STATE.maxPages,
      language: typeof source.language === "string" ? source.language : "ch",
      mineru: {
        configured: Boolean(mineru.configured),
        tokenHint: String(mineru.tokenHint || ""),
        modelVersion: mineru.modelVersion === "pipeline" ? "pipeline" : "vlm"
      },
      baidu: {
        configured: Boolean(baidu.configured),
        apiKeyHint: String(baidu.apiKeyHint || ""),
        secretKeyHint: String(baidu.secretKeyHint || "")
      }
    };
  }

  function ocrProviderLabel(provider = state.ocr.provider) {
    return provider === "baidu" ? "百度 OCR" : "MinerU";
  }

  function renderOcrSettings() {
    const badge = $("#ocrBadge");
    if (!badge) return;
    const ocr = state.ocr;
    badge.textContent = !ocr.configured ? "未配置" : ocr.enabled ? "已启用" : "已配置";
    badge.className = `badge ${!ocr.configured ? "muted" : ocr.enabled ? "done" : "ready"}`;
    const desc = $("#ocrDesc");
    if (desc) {
      desc.textContent = !ocr.configured
        ? "扫描件会标记为需要 OCR。配置云端服务后可识别扫描页。"
        : ocr.enabled
          ? `已启用 ${ocrProviderLabel()}，扫描件会自动识别。`
          : `已配置 ${ocrProviderLabel()}，打开开关后扫描件才会发送到云端。`;
    }
    const sw = $("#swOcr");
    if (sw) {
      sw.disabled = !ocr.configured;
      sw.setAttribute("aria-checked", String(Boolean(ocr.enabled)));
      sw.setAttribute("aria-label", !ocr.configured ? "请先配置云端 OCR" : (ocr.enabled ? "停用云端 OCR" : "启用云端 OCR"));
    }
    const label = $("#configOcrLabel");
    if (label) label.textContent = ocr.configured ? "编辑云端 OCR" : "配置云端 OCR";
  }

  function currentOcrProvider() {
    const active = $$("[data-provider]").find((btn) => btn.getAttribute("aria-checked") === "true");
    return active && active.dataset.provider === "baidu" ? "baidu" : "mineru";
  }

  function updateOcrProviderFields() {
    const provider = currentOcrProvider();
    $("#ocrMineruFields").hidden = provider !== "mineru";
    $("#ocrBaiduFields").hidden = provider !== "baidu";
    $("#ocrProviderHint").textContent = provider === "mineru"
      ? "整份 PDF 上传解析，保留版面与表格，适合扫描书刊；单文件上限 200 MB。"
      : "逐页渲染后识别，只上传需要识别的扫描页；输出为纯文本，不含版面结构。";
  }

  function setOcrTestStatus(text, tone) {
    const el = $("#ocrTestStatus");
    if (!el) return;
    el.hidden = !text;
    el.textContent = text;
    el.dataset.state = tone || "";
  }

  function openOcrDialog() {
    const ocr = state.ocr;
    $$("[data-provider]").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.provider === ocr.provider));
    });
    const token = $("#ocrMineruToken");
    token.value = "";
    token.placeholder = ocr.mineru.configured
      ? `已保存 ${ocr.mineru.tokenHint || "••••"}，留空保持不变`
      : "粘贴 MinerU API Token";
    $("#ocrMineruModel").value = ocr.mineru.modelVersion;
    const apiKey = $("#ocrBaiduApiKey");
    apiKey.value = "";
    apiKey.placeholder = ocr.baidu.configured
      ? `已保存 ${ocr.baidu.apiKeyHint || "••••"}，留空保持不变`
      : "百度智能云应用的 API Key";
    const secretKey = $("#ocrBaiduSecretKey");
    secretKey.value = "";
    secretKey.placeholder = ocr.baidu.configured
      ? `已保存 ${ocr.baidu.secretKeyHint || "••••"}，留空保持不变`
      : "百度智能云应用的 Secret Key";
    $("#ocrMaxPages").value = String(ocr.maxPages);
    setOcrTestStatus("", "");
    $("#saveOcr").textContent = ocr.enabled ? "保存" : "保存并启用";
    $("#saveOcr").disabled = false;
    $("#testOcr").disabled = false;
    updateOcrProviderFields();
    $("#ocrLayer").hidden = false;
    const focusTarget = ocr.provider === "baidu" ? apiKey : token;
    setTimeout(() => focusTarget.focus(), 0);
  }

  function closeOcrDialog() {
    $("#ocrLayer").hidden = true;
  }

  function collectOcrDraft() {
    const provider = currentOcrProvider();
    const rawPages = Math.round(Number($("#ocrMaxPages").value));
    const maxPages = Number.isFinite(rawPages) ? Math.max(1, Math.min(200, rawPages)) : state.ocr.maxPages;
    const draft = {
      provider,
      enabled: true,
      maxPages,
      language: state.ocr.language || "ch",
      mineru: { modelVersion: $("#ocrMineruModel").value === "pipeline" ? "pipeline" : "vlm" },
      baidu: {}
    };
    const token = $("#ocrMineruToken").value.trim();
    if (token) draft.mineru.token = token;
    const apiKey = $("#ocrBaiduApiKey").value.trim();
    const secretKey = $("#ocrBaiduSecretKey").value.trim();
    if (apiKey) draft.baidu.apiKey = apiKey;
    if (secretKey) draft.baidu.secretKey = secretKey;
    return draft;
  }

  function ocrDraftConfigured(draft, provider) {
    if (provider === "baidu") {
      return Boolean((draft.baidu.apiKey && draft.baidu.secretKey) || state.ocr.baidu.configured);
    }
    return Boolean((draft.mineru.token) || state.ocr.mineru.configured);
  }

  async function testOcrConnection() {
    if (state.ocrTesting) return;
    const draft = collectOcrDraft();
    if (!ocrDraftConfigured(draft, draft.provider)) {
      setOcrTestStatus(draft.provider === "baidu" ? "请先填写 API Key 与 Secret Key。" : "请先填写 MinerU Token。", "error");
      return;
    }
    state.ocrTesting = true;
    $("#testOcr").disabled = true;
    setOcrTestStatus("正在连接…", "testing");
    try {
      const result = await host.invoke("doc/testOcr", { config: draft }, { timeoutMs: 60000 });
      if (result && result.ok) setOcrTestStatus(String(result.message || "连接成功。"), "ok");
      else setOcrTestStatus(String((result && result.message) || "测试失败。"), "error");
    } catch (error) {
      setOcrTestStatus(errorText(error), "error");
    } finally {
      state.ocrTesting = false;
      $("#testOcr").disabled = false;
    }
  }

  async function saveOcrSettings() {
    if (state.ocrSaving) return;
    const draft = collectOcrDraft();
    if (!ocrDraftConfigured(draft, draft.provider)) {
      setOcrTestStatus(draft.provider === "baidu" ? "请先填写 API Key 与 Secret Key。" : "请先填写 MinerU Token。", "error");
      return;
    }
    state.ocrSaving = true;
    const btn = $("#saveOcr");
    btn.disabled = true;
    btn.textContent = "正在保存…";
    try {
      const result = await host.invoke("doc/setOcrConfig", { config: draft }, { timeoutMs: 20000 });
      state.ocr = normalizeOcrState(result && result.config);
      renderOcrSettings();
      closeOcrDialog();
      if (state.ocr.ready) showToast(`已启用 ${ocrProviderLabel()}，扫描件会自动识别`);
      else showToast("OCR 设置已保存，但凭据不完整");
      const file = getSelected();
      if (file) renderPreviewBody(file);
    } catch (error) {
      setOcrTestStatus(errorText(error), "error");
    } finally {
      state.ocrSaving = false;
      btn.disabled = false;
      btn.textContent = state.ocr.enabled ? "保存" : "保存并启用";
    }
  }

  async function toggleOcrEnabled() {
    if (!state.ocr.configured) {
      openOcrDialog();
      return;
    }
    const next = !state.ocr.enabled;
    $("#swOcr").disabled = true;
    try {
      const result = await host.invoke("doc/setOcrConfig", { config: { enabled: next } }, { timeoutMs: 20000 });
      state.ocr = normalizeOcrState(result && result.config);
      renderOcrSettings();
      const file = getSelected();
      if (file) renderPreviewBody(file);
      showToast(next ? "已启用云端 OCR" : "已停用云端 OCR");
    } catch (error) {
      showToast(`无法更新 OCR 设置：${errorText(error)}`);
    } finally {
      $("#swOcr").disabled = !state.ocr.configured;
    }
  }

  async function retryOcr(file) {
    if (!file || state.converting) return;
    if (!state.ocr.ready) {
      showToast("请先启用并配置云端 OCR");
      openOcrDialog();
      return;
    }
    if (!file.jobId) {
      showToast("原始文件已失效，请重新添加这份文件");
      return;
    }
    const jobId = file.jobId;
    const waiter = waitForJob(jobId);
    state.converting = true;
    state.cancelRequested = false;
    state.conversionTotal = 1;
    state.convertingIndex = 1;
    state.convertingFileId = file.id;
    file.status = "converting";
    file.progress = 0;
    file.stage = `正在调用${ocrProviderLabel()}`;
    file.error = null;
    file.errorCode = null;
    file.needsOcrPages = [];
    file.startedAt = Date.now();
    file.durationMs = null;
    render();
    try {
      await host.invoke("doc/retryOcr", { jobId }, { timeoutMs: 20000 });
    } catch (error) {
      state.waiters.delete(jobId);
      state.converting = false;
      state.convertingFileId = null;
      file.status = "failed";
      file.progress = 0;
      file.stage = "";
      file.error = errorText(error);
      file.errorCode = "internal";
      render();
      showToast(file.error);
      return;
    }
    const outcome = await waiter;
    state.converting = false;
    state.cancelRequested = false;
    state.convertingFileId = null;
    if (outcome.kind === "done") {
      await loadOutputs(file);
      render();
      showToast("云端 OCR 完成");
      return;
    }
    if (outcome.kind === "cancelled") {
      file.status = "failed";
      file.progress = 0;
      file.stage = "";
      file.jobId = null;
      file.error = "已取消云端 OCR，请重新添加这份文件后再转换。";
      file.errorCode = "cancelled";
      render();
      return;
    }
    if (outcome.kind === "timeout") {
      cancelJob(jobId);
      file.status = "failed";
      file.progress = 0;
      file.stage = "";
      file.error = "云端 OCR 处理超时，请稍后重试。";
      file.errorCode = "ocrTimeout";
      render();
      return;
    }
    render();
    showToast(file.error || "云端 OCR 失败");
  }

  function toggleFormat(key) {
    const next = { ...state.settings, [key]: !state.settings[key] };
    if (!next.markdown && !next.json) {
      showToast("至少保留一种输出格式");
      return;
    }
    state.settings = next;
    renderToolbar();
    renderSettings();
    persistSettings();
  }

  function toggleOpenAfter() {
    state.settings.openAfter = !state.settings.openAfter;
    renderSettings();
    persistSettings();
  }

  function resetSettings() {
    state.settings = { ...DEFAULT_SETTINGS };
    renderToolbar();
    renderSettings();
    persistSettings();
    showToast("已恢复默认设置");
  }

  function applyTheme(theme) {
    let appearance = state.theme;
    if (theme && (theme.appearance === "light" || theme.appearance === "dark")) {
      appearance = theme.appearance;
    } else {
      const current = document.documentElement.dataset.dbxTheme;
      if (current === "light" || current === "dark") appearance = current;
    }
    state.theme = appearance;
    document.documentElement.dataset.theme = appearance;
  }

  function showToast(message, opts = {}) {
    const wrap = $("#toastWrap");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    if (opts.actionLabel) {
      const action = document.createElement("button");
      action.className = "toast-action";
      action.type = "button";
      action.textContent = opts.actionLabel;
      action.addEventListener("click", () => {
        opts.onAction?.();
        toast.remove();
      });
      toast.appendChild(action);
    }
    wrap.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("out");
      setTimeout(() => toast.remove(), 180);
    }, opts.duration || 3200);
  }

  function splitRow(line) {
    return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  function inlineMarkdown(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<a>$1</a>");
    return s;
  }

  function renderMarkdown(markdown = "") {
    const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }

      if (/^```/.test(line.trim())) {
        const lang = line.trim().slice(3).trim();
        const code = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i += 1; }
        i += 1;
        out.push(`<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeText(code.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\|/.test(line) && i + 1 < lines.length && lines[i + 1].includes("-") && /^\|?[\s:|-]+\|?$/.test(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
        out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i += 1; }
        out.push(`<blockquote>${quote.map((entry) => inlineMarkdown(entry)).join("<br>")}</blockquote>`);
        continue;
      }

      if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
        const ordered = /^\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && (/^[-*+]\s+/.test(lines[i]) || /^\d+\.\s+/.test(lines[i]))) {
          items.push(lines[i].replace(/^([-*+]|\d+\.)\s+/, ""));
          i += 1;
        }
        out.push(`<${ordered ? "ol" : "ul"}>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }

      const paragraph = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s|^```|^>\s?|^[-*+]\s|^\d+\.\s|^\|/.test(lines[i])) {
        paragraph.push(lines[i]); i += 1;
      }
      out.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    }
    return out.join("\n");
  }

  function highlightJson(value) {
    const text = escapeText(JSON.stringify(value, null, 2));
    return text.replace(/("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/g, (match, str, colon, bool) => {
      if (str) return `<span class="j-${colon ? "key" : "str"}">${str}</span>${colon || ""}`;
      if (bool) return `<span class="j-bool">${match}</span>`;
      if (match === "null") return `<span class="j-null">null</span>`;
      return `<span class="j-num">${match}</span>`;
    });
  }

  async function loadSettings() {
    if (!host.capabilities?.storage) return;
    try {
      const saved = await host.storage.get(SETTINGS_KEY);
      if (!saved || typeof saved !== "object") return;
      const next = { ...DEFAULT_SETTINGS };
      if (saved.markdown === false) next.markdown = false;
      if (saved.json === false) next.json = false;
      if (!next.markdown && !next.json) next.markdown = true;
      if (["original", "dated", "indexed"].includes(saved.naming)) next.naming = saved.naming;
      if (["plugin", "ask", "custom"].includes(saved.location)) next.location = saved.location;
      if (typeof saved.outputDir === "string") next.outputDir = saved.outputDir;
      if (saved.openAfter === false) next.openAfter = false;
      state.settings = next;
    } catch {
      /* defaults are fine */
    }
  }

  function persistSettings() {
    if (!host.capabilities?.storage) return;
    clearTimeout(state.settingsTimer);
    state.settingsTimer = setTimeout(() => {
      host.storage.set(SETTINGS_KEY, { ...state.settings }).catch(() => {});
    }, 300);
  }

  function bindEvents() {
    $("#openSettings").addEventListener("click", openSettings);
    $("#settingsBtn").addEventListener("click", openSettings);
    $("#closeSettings").addEventListener("click", closeSettings);
    $("#scrim").addEventListener("click", closeSettings);
    $("#convertBtn").addEventListener("click", () => startConversion());
    $("#cancelBtn").addEventListener("click", requestCancel);
    $("#addBtn").addEventListener("click", pickFiles);
    $("#addFolderBtn").addEventListener("click", pickFolder);
    $("#dropzone").addEventListener("click", pickFiles);
    $("#clearBtn").addEventListener("click", clearAll);
    $("#checkAll").addEventListener("change", (event) => {
      if (state.converting) {
        event.target.checked = false;
        syncSelectionSummary();
        return;
      }
      const next = Boolean(event.target.checked);
      state.files.forEach((file) => {
        if (file.status === "ready") file.checked = next;
      });
      $$('#fileList input[data-check]').forEach((input) => {
        if (!input.disabled) input.checked = next;
      });
      syncSelectionSummary();
      renderToolbar();
    });
    $("#copyBtn").addEventListener("click", copyCurrent);
    $("#saveBtn").addEventListener("click", saveCurrent);
    $("#removeBtn").addEventListener("click", () => {
      const file = getSelected();
      if (file) removeFile(file.id);
    });

    $("#swMarkdown").addEventListener("click", () => toggleFormat("markdown"));
    $("#swJson").addEventListener("click", () => toggleFormat("json"));
    $("#swOpenAfter").addEventListener("click", toggleOpenAfter);
    $("#namingSelect").addEventListener("change", (event) => {
      state.settings.naming = event.target.value;
      persistSettings();
    });
    $("#locationSelect").addEventListener("change", (event) => {
      const value = event.target.value;
      state.settings.location = value === "ask" || value === "custom" ? value : "plugin";
      renderSettings();
      persistSettings();
      if (state.settings.location === "custom") {
        const input = $("#customDirInput");
        if (input) { input.focus(); input.select(); }
      }
    });
    const customInput = $("#customDirInput");
    if (customInput) {
      customInput.addEventListener("input", (event) => {
        state.settings.outputDir = event.target.value;
        const status = $("#customDirStatus");
        if (status) { status.textContent = ""; status.dataset.state = ""; }
        renderOutputHint();
        persistSettings();
      });
      customInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void checkCustomDir();
      });
    }
    const checkCustomDirBtn = $("#checkCustomDir");
    if (checkCustomDirBtn) checkCustomDirBtn.addEventListener("click", () => { void checkCustomDir(); });
    const pickCustomDirBtn = $("#pickCustomDir");
    if (pickCustomDirBtn) pickCustomDirBtn.addEventListener("click", () => { void pickCustomDir(); });
    $("#resetSettings").addEventListener("click", resetSettings);
    $("#configOcr").addEventListener("click", () => openOcrDialog());
    $("#swOcr").addEventListener("click", () => { void toggleOcrEnabled(); });
    $("#closeOcrDialog").addEventListener("click", closeOcrDialog);
    $("#cancelOcr").addEventListener("click", closeOcrDialog);
    $("#ocrScrim").addEventListener("click", closeOcrDialog);
    $("#testOcr").addEventListener("click", () => { void testOcrConnection(); });
    $("#saveOcr").addEventListener("click", () => { void saveOcrSettings(); });
    $$("[data-provider]").forEach((btn) => btn.addEventListener("click", () => {
      $$("[data-provider]").forEach((item) => item.setAttribute("aria-checked", String(item === btn)));
      setOcrTestStatus("", "");
      updateOcrProviderFields();
    }));

    $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
      if (tab.disabled) return;
      state.tab = tab.dataset.tab;
      $$(".tab").forEach((item) => {
        item.classList.toggle("active", item === tab);
        item.setAttribute("aria-selected", String(item === tab));
      });
      const file = getSelected();
      if (file) renderPreviewBody(file);
    }));

    $("#fileList").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove]");
      if (remove) { event.stopPropagation(); removeFile(remove.dataset.remove); return; }
      if (event.target.closest(".file-check")) return;
      const item = event.target.closest(".file-item");
      if (item) selectFile(item.dataset.id);
    });

    $("#fileList").addEventListener("change", (event) => {
      const input = event.target.closest("input[data-check]");
      if (!input) return;
      const file = state.files.find((item) => item.id === input.dataset.check);
      if (!file || file.status !== "ready" || state.converting) {
        input.checked = Boolean(file && file.checked);
        return;
      }
      file.checked = input.checked;
      syncSelectionSummary();
      renderToolbar();
    });

    $("#fileList").addEventListener("keydown", (event) => {
      if (event.target.closest("input, button, label")) return;
      const item = event.target.closest(".file-item");
      if (!item) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectFile(item.dataset.id);
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeFile(item.dataset.id);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!$("#ocrLayer").hidden) closeOcrDialog();
        else closeSettings();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        startConversion();
      }
    });
  }

  function registerHostEvents() {
    host.onEvent((message) => {
      if (!message || message.type !== "event" || typeof message.method !== "string") return;
      handleBackendEvent(message.method, message.params || {});
    });

    document.addEventListener("dbx-plugin-env", (event) => {
      const theme = event.detail && event.detail.theme;
      if (theme) applyTheme(theme);
    });
  }

  // The SDK only fills `capabilities` once the host's init message arrives, so
  // the drop listeners have to be registered after host.ready: gating on the
  // capability any earlier sees an empty object and silently skips them.
  function registerDropSupport() {
    if (!host.capabilities?.fileTransfer?.drop) return;
    try {
      host.fileTransfer.onDrop((files, info) => {
        addFiles(files, { truncated: Boolean(info && info.truncated) });
      });
      host.fileTransfer.onDragState((active) => {
        $("#dropzone").classList.toggle("dragover", Boolean(active));
      });
    } catch {
      /* drops stay optional */
    }
  }

  async function init() {
    applyTheme(host.theme);
    bindEvents();
    registerHostEvents();
    render();
    try {
      await host.ready;
    } catch {
      /* requests surface their own errors */
    }
    registerDropSupport();
    await loadSettings();
    render();
    try {
      const status = await host.invoke("doc/status", {}, { timeoutMs: 15000 });
      if (status && Array.isArray(status.supportedExtensions) && status.supportedExtensions.length) {
        state.supported = status.supportedExtensions.slice();
      }
      state.outputDir = status && typeof status.outputDir === "string" ? status.outputDir : "";
      if (status && status.ocr) state.ocr = normalizeOcrState(status.ocr);
      state.ready = !status || status.ready !== false;
    } catch (error) {
      showToast(`转换引擎不可用：${errorText(error)}`);
    }
    state.initialized = true;
    render();
  }

  const initPromise = init();
})();
