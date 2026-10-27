// public/app.js
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const historyWrap = $("history");
  const chatEl = $("chat");
  const inputEl = $("msg");
  const composerEl = $("composer");
  const spacerEl = $("bottom-spacer");

  const modelSel = $("modelSel");
  const personaToggle = $("personaToggle");
  const settingsBtn = $("settingsBtn");
  const sendBtn = $("sendBtn");
  const uploadBtn = $("uploadBtn");
  const fileInput = $("fileInput");
  const attachmentsEl = $("attachments");
  const toastEl = $("toast");

  const settingsMask = $("settingsMask");
  const customPromptEl = $("customPrompt");
  const savePromptBtn = $("savePrompt");
  const clearPromptBtn = $("clearPrompt");
  const closeSettingsBtn = $("closeSettings");
  const historyKeepEl = $("historyKeep");
  const clearHistoryBtn = $("clearHistory");
  const promptKeepEl = $("promptKeep");

  const donateBtn = $("donateBtn");
  const donateMask = $("donateMask");
  const donateClose = $("donateClose");

  const MODELS = (window.APP_MODELS || [
    { id: "openai/gpt-oss-120b", label: "gpt-oss-120b" },
  ]);

  // ====== 附件限制（故意保守：附件会被完整塞进 prompt，太大会让上游 prefill 超时）======
  const MAX_FILES = 3;
  const MAX_FILE_CHARS = 40000;          // 单个附件「提取后」的字数上限
  const MAX_TOTAL_ATTACH_CHARS = 60000;  // 所有附件提取后的合计字数
  const MAX_RAW_BYTES = 8 * 1024 * 1024; // 原始文件体积上限（docx 体积大但正文未必多）
  const WARN_PAYLOAD_CHARS = 40000;
  const TEXT_EXT = /\.(txt|text|md|markdown|mdx|json|jsonc|json5|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|php|java|kt|swift|go|rs|c|h|cc|cpp|hpp|cs|m|mm|pl|lua|r|jl|scala|sh|bash|zsh|bat|ps1|cmd|sql|csv|tsv|log|html|htm|xml|css|scss|sass|less|yml|yaml|ini|conf|cfg|toml|env|properties|gradle|dockerfile|makefile|gitignore|srt|vtt|tex)$/i;
  const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|x-sh|x-httpd-php|sql|javascript|typescript|x-javascript|x-python|x-ruby|x-shellscript|toml|rtf))/i;

  const LS_MODEL = "cfw_model";
  const LS_USE_BUILTIN = "cfw_use_builtin";      // "1"=😈, "0"=😇
  const LS_HISTORY_ENABLED = "cfw_history_enabled";
  const LS_CHAT_SESSION = "cfw_chat_session_v1";
  const LS_PROMPT_ENABLED = "cfw_prompt_enabled";
  const LS_CUSTOM_PROMPT = "cfw_custom_prompt_v1";

  const MAX_PERSIST_CHARS = 2000000;

  const session = [];
  let pendingFiles = [];
  let streaming = false;
  let abortController = null;

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalInEstimate = 0;
  let totalOutEstimate = 0;

  let useBuiltin = (localStorage.getItem(LS_USE_BUILTIN) ?? "1") === "1";
  personaToggle.textContent = useBuiltin ? "😈" : "😇";

  let historyEnabled = (localStorage.getItem(LS_HISTORY_ENABLED) ?? "0") === "1";
  let promptEnabled = (localStorage.getItem(LS_PROMPT_ENABLED) ?? "1") === "1";
  historyKeepEl.checked = historyEnabled;
  promptKeepEl.checked = promptEnabled;

  // ===== 小工具 =====
  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    // 长错误多留一会儿，方便看清
    const ms = Math.min(6000, Math.max(2200, String(msg).length * 80));
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0, ascii = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
      const isCJK =
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3040 && code <= 0x30FF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xFF00 && code <= 0xFFEF);
      if (isCJK) cjk++; else ascii++;
    }
    return cjk + Math.ceil(ascii / 4);
  }

  function updateSpacer() {
    if (!composerEl || !spacerEl) return;
    const rect = composerEl.getBoundingClientRect();
    const rootStyle = getComputedStyle(document.documentElement);
    const gap = parseFloat(rootStyle.getPropertyValue("--composer-gap")) || 18;
    const extra = parseFloat(rootStyle.getPropertyValue("--spacer-extra")) || 28;
    const h = Math.ceil(rect.height + gap + extra);
    spacerEl.style.height = h + "px";
    historyWrap.style.scrollPaddingBottom = h + "px";
  }

  function isNearBottom() {
    const threshold = 120;
    return (historyWrap.scrollHeight - historyWrap.scrollTop - historyWrap.clientHeight) < threshold;
  }

  function scrollToBottom() {
    historyWrap.scrollTo({ top: historyWrap.scrollHeight, behavior: "auto" });
  }

  function autoGrow() {
    inputEl.style.height = "auto";
    const max = parseFloat(getComputedStyle(inputEl).maxHeight) || 200;
    inputEl.style.height = Math.min(inputEl.scrollHeight, max) + "px";
  }

  // ===== 渲染 =====
  function makeRow(role) {
    const row = document.createElement("div");
    row.className = "row " + (role === "user" ? "user" : "ai");

    const avatar = document.createElement("div");
    avatar.className = "avatar " + (role === "user" ? "human" : "bot");
    avatar.textContent = (role === "user" ? "U" : "B");

    const content = document.createElement("div");
    content.className = "content";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (role === "user" ? "User" : "Bot");

    const bubble = document.createElement("div");
    bubble.className = "bubble " + (role === "user" ? "user" : "ai");

    const stats = document.createElement("div");
    stats.className = "stats";

    content.appendChild(meta);
    content.appendChild(bubble);

    let actions = null;
    if (role === "assistant") {
      actions = document.createElement("div");
      actions.className = "actions";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "act act-copy";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", () => copyText(bubble.textContent, copyBtn));

      const regenBtn = document.createElement("button");
      regenBtn.type = "button";
      regenBtn.className = "act act-regen";
      regenBtn.textContent = "重新生成";
      regenBtn.addEventListener("click", () => regenerate());

      actions.appendChild(copyBtn);
      actions.appendChild(regenBtn);
      content.appendChild(actions);
    }

    content.appendChild(stats);

    if (role === "user") {
      row.appendChild(content);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(content);
    }

    chatEl.insertBefore(row, spacerEl);
    if (isNearBottom()) scrollToBottom();

    return { row, bubble, stats, actions };
  }

  function clearUIRows() {
    const nodes = Array.from(chatEl.children);
    for (const n of nodes) {
      if (n === spacerEl) continue;
      chatEl.removeChild(n);
    }
  }

  // “重新生成”只对最后一条 AI 回复显示
  function refreshActions() {
    const aiRows = Array.from(chatEl.querySelectorAll(".row.ai"));
    aiRows.forEach((row, i) => {
      const btn = row.querySelector(".act-regen");
      if (!btn) return;
      const isLast = i === aiRows.length - 1;
      btn.disabled = streaming;
      btn.style.display = (isLast && !streaming) ? "" : "none";
    });
  }

  async function copyText(text, btn) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      const old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch {
      toast("复制失败，请手动选择文本");
    }
  }

  // ===== 本地存储 =====
  function persistSessionIfEnabled() {
    if (!historyEnabled) return;
    try {
      const data = session.map((m) => ({
        role: m.role,
        content: m.content,
        display: m.display || ""
      }));
      const raw = JSON.stringify(data);
      if (raw.length > MAX_PERSIST_CHARS) {
        console.warn("[history] 本地历史过大，已跳过本次持久化");
        return;
      }
      localStorage.setItem(LS_CHAT_SESSION, raw);
    } catch (err) {
      console.warn("[history] 本地历史保存失败", err);
    }
  }

  function restoreSessionIfEnabled() {
    if (!historyEnabled) return;
    const raw = localStorage.getItem(LS_CHAT_SESSION);
    if (!raw) return;

    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;

      session.length = 0;
      for (const m of arr) {
        if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
        if (typeof m.content !== "string") continue;
        session.push({
          role: m.role,
          content: m.content,
          display: typeof m.display === "string" ? m.display : ""
        });
      }

      clearUIRows();
      for (const m of session) {
        const r = makeRow(m.role === "user" ? "user" : "assistant");
        r.bubble.textContent = (m.role === "user" && m.display) ? m.display : m.content;
        r.stats.textContent = "";
        m.el = r.row;
      }
      refreshActions();
    } catch {}
  }

  function initModels() {
    modelSel.innerHTML = "";
    for (const m of MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      modelSel.appendChild(opt);
    }

    const saved = localStorage.getItem(LS_MODEL);
    modelSel.value = (saved && MODELS.some((m) => m.id === saved)) ? saved : MODELS[0].id;

    modelSel.addEventListener("change", () => {
      localStorage.setItem(LS_MODEL, modelSel.value);
    });
  }

  // ===== 顶栏 / 设置 =====
  personaToggle.addEventListener("click", () => {
    useBuiltin = !useBuiltin;
    personaToggle.textContent = useBuiltin ? "😈" : "😇";
    localStorage.setItem(LS_USE_BUILTIN, useBuiltin ? "1" : "0");
  });

  settingsBtn.addEventListener("click", () => {
    settingsMask.style.display = "flex";
    historyKeepEl.checked = historyEnabled;
    promptKeepEl.checked = promptEnabled;
    customPromptEl.value = (localStorage.getItem(LS_CUSTOM_PROMPT) || "");
  });
  closeSettingsBtn.addEventListener("click", () => {
    settingsMask.style.display = "none";
  });
  settingsMask.addEventListener("click", (e) => {
    if (e.target === settingsMask) settingsMask.style.display = "none";
  });

  historyKeepEl.addEventListener("change", () => {
    historyEnabled = !!historyKeepEl.checked;
    localStorage.setItem(LS_HISTORY_ENABLED, historyEnabled ? "1" : "0");
    if (historyEnabled) persistSessionIfEnabled();
  });
  clearHistoryBtn.addEventListener("click", () => {
    const ok = confirm("确定清除本地历史？\n只会删除对话记录，不会影响网页自定义人物模板。");
    if (!ok) return;
    localStorage.removeItem(LS_CHAT_SESSION);
    session.length = 0;
    clearUIRows();
    updateSpacer();
    scrollToBottom();
  });

  promptKeepEl.addEventListener("change", () => {
    promptEnabled = !!promptKeepEl.checked;
    localStorage.setItem(LS_PROMPT_ENABLED, promptEnabled ? "1" : "0");
    if (!promptEnabled) localStorage.removeItem(LS_CUSTOM_PROMPT);
  });
  savePromptBtn.addEventListener("click", () => {
    const val = customPromptEl.value || "";
    if (promptEnabled) localStorage.setItem(LS_CUSTOM_PROMPT, val);
    else localStorage.removeItem(LS_CUSTOM_PROMPT);
    settingsMask.style.display = "none";
  });
  clearPromptBtn.addEventListener("click", () => {
    const ok = confirm("确定清除网页自定义人物模板？\n只会删除自定义模板，不会影响本地历史。");
    if (!ok) return;
    localStorage.removeItem(LS_CUSTOM_PROMPT);
    customPromptEl.value = "";
  });

  // 打赏弹窗
  function openDonate() { donateMask.style.display = "flex"; }
  function closeDonate() { donateMask.style.display = "none"; }
  donateBtn.addEventListener("click", openDonate);
  donateClose.addEventListener("click", closeDonate);
  donateMask.addEventListener("click", (e) => { if (e.target === donateMask) closeDonate(); });

  // ===== 附件：纯文本 / Word =====
  // 返回 "text" | "docx" | "doc" | null
  function resolveKind(file) {
    if (window.DOCS) {
      const word = window.DOCS.detectWordKind(file.name, file.type);
      if (word) return word;
    }
    if (TEXT_EXT.test(file.name)) return "text";
    if (file.type && TEXT_MIME.test(file.type)) return "text";
    if (!file.type) return "text"; // 无 MIME 的多为代码/纯文本
    return null;
  }

  const KIND_LABEL = { text: "文本", docx: "Word", doc: "Word" };

  function guessLang(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    const map = {
      js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
      ts: "typescript", tsx: "tsx", py: "python", rb: "ruby", php: "php",
      java: "java", go: "go", rs: "rust", c: "c", h: "c", cpp: "cpp",
      cs: "csharp", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
      sql: "sql", html: "html", htm: "html", css: "css", scss: "scss",
      json: "json", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
      md: "markdown", markdown: "markdown", csv: "csv", tsv: "tsv",
      kt: "kotlin", swift: "swift", lua: "lua", r: "r", pl: "perl"
    };
    return map[ext] || "";
  }

  function renderAttachments() {
    if (!attachmentsEl) return;
    attachmentsEl.innerHTML = "";

    if (!pendingFiles.length) {
      attachmentsEl.style.display = "none";
      return;
    }

    attachmentsEl.style.display = "flex";

    pendingFiles.forEach((f, index) => {
      const chip = document.createElement("span");
      chip.className = "chip";

      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = f.name;
      name.title = f.kind === "text"
        ? `${f.name} · ${formatSize(f.size)}`
        : `${f.name} · ${formatSize(f.size)} · 提取 ${f.chars} 字`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-x";
      remove.title = "移除";
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        pendingFiles.splice(index, 1);
        renderAttachments();
        updateSpacer();
      });

      chip.appendChild(name);
      chip.appendChild(remove);
      attachmentsEl.appendChild(chip);
    });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    let totalChars = pendingFiles.reduce((sum, f) => sum + f.chars, 0);
    let skipped = 0;

    for (const file of files) {
      if (pendingFiles.length >= MAX_FILES) {
        toast(`最多同时上传 ${MAX_FILES} 个文件`);
        break;
      }

      const kind = resolveKind(file);
      if (!kind) {
        skipped++;
        continue;
      }

      if (file.size > MAX_RAW_BYTES) {
        toast(`${file.name} 超过 ${formatSize(MAX_RAW_BYTES)}，已跳过`);
        continue;
      }

      let content = "";
      try {
        if (kind === "text") {
          content = await file.text();
          // 含 NUL 字节基本可判定为二进制
          if (content.indexOf("\u0000") !== -1) {
            skipped++;
            continue;
          }
        } else {
          if (!window.DOCS) {
            toast("文档解析模块未加载（/docs.js）");
            continue;
          }
          content = await window.DOCS.extractWord(await file.arrayBuffer(), kind);
        }
      } catch (err) {
        toast(`${file.name} 解析失败：${(err && err.message) || err}`);
        continue;
      }

      if (!content || !content.trim()) {
        toast(`${file.name} 里没有提取到文字`);
        continue;
      }

      let truncated = false;
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS);
        truncated = true;
      }

      if (totalChars + content.length > MAX_TOTAL_ATTACH_CHARS) {
        toast(`附件合计超过 ${MAX_TOTAL_ATTACH_CHARS} 字，已跳过 ${file.name}`);
        break;
      }

      pendingFiles.push({
        name: file.name,
        kind,
        size: file.size,
        content,
        chars: content.length,
        truncated,
        lang: kind === "text" ? guessLang(file.name) : ""
      });
      totalChars += content.length;

      if (truncated) toast(`${file.name} 内容较长，只取前 ${MAX_FILE_CHARS} 字`);
    }

    if (skipped) toast(`已忽略 ${skipped} 个不支持的文件`);

    renderAttachments();
    updateSpacer();
  }

  // 发给模型的内容（带完整正文）
  function buildPayloadText(text, files) {
    if (!files.length) return text;

    const blocks = files.map((f) => {
      if (f.kind !== "text") {
        const note = f.truncated ? "，超长部分已截断" : "";
        return `--- 附件：${f.name}（Word 文档，已提取正文 ${f.chars} 字${note}） ---\n${f.content}`;
      }
      const lang = f.lang || "";
      return `--- 附件：${f.name}（${formatSize(f.size)}） ---\n\`\`\`${lang}\n${f.content}\n\`\`\``;
    });

    return (text ? text + "\n\n" : "") + blocks.join("\n\n");
  }

  // 气泡里只展示简短摘要，避免刷屏
  function buildDisplayText(text, files) {
    const lines = [];
    if (text) lines.push(text);
    if (files.length) {
      lines.push(
        files
          .map((f) =>
            f.kind === "text"
              ? `[附件] ${f.name} · ${formatSize(f.size)}`
              : `[附件] ${f.name} · ${KIND_LABEL[f.kind]} · ${f.chars} 字`
          )
          .join("\n")
      );
    }
    return lines.join("\n\n");
  }

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      await addFiles(fileInput.files);
      fileInput.value = "";
    });
  }

  // ===== 输入框 =====
  inputEl.addEventListener("input", () => {
    autoGrow();
    const stick = isNearBottom();
    updateSpacer();
    if (stick) scrollToBottom();
  });

  function setupResizeObserver() {
    if (!composerEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const stick = isNearBottom();
      updateSpacer();
      if (stick) scrollToBottom();
    });
    ro.observe(composerEl);
  }

  function setupViewportListener() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener("resize", () => {
      const stick = isNearBottom();
      updateSpacer();
      if (stick) scrollToBottom();
    });
  }

  window.addEventListener("resize", () => {
    const stick = isNearBottom();
    updateSpacer();
    if (stick) scrollToBottom();
  });

  // ===== 请求 =====
  function setStreaming(on) {
    streaming = on;
    sendBtn.textContent = on ? "停止" : "Send";
    sendBtn.classList.toggle("stop", on);
    document.body.classList.toggle("streaming", on);
    refreshActions();
    updateSpacer();
  }

  function resolveErrorText(status, rawText) {
    let message = rawText || "";
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
      else if (parsed && typeof parsed.error === "string") message = parsed.error;
    } catch {}
    return `请求失败（${status}）\n${message || "无详细信息"}`;
  }

  async function requestAI() {
    const aiRow = makeRow("assistant");
    let full = "";
    let exactUsage = null;
    let outStartMs = 0;
    let failedText = "";
    let aborted = false;

    const parserFactory = window.SSE && window.SSE.createSSEParser;
    if (!parserFactory) {
      aiRow.bubble.textContent = "前端脚本加载异常：缺少 SSE 解析器（/sse.js）。";
      aiRow.bubble.classList.add("error");
      return;
    }

    let customPrompt = "";
    if (!useBuiltin && promptEnabled) {
      customPrompt = localStorage.getItem(LS_CUSTOM_PROMPT) || "";
    }

    abortController = new AbortController();
    setStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelSel.value,
          use_builtin_persona: useBuiltin,
          custom_system_prompt: customPrompt,
          messages: session.map((m) => ({ role: m.role, content: m.content }))
        }),
        signal: abortController.signal
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        failedText = resolveErrorText(res.status, raw);
        aiRow.bubble.textContent = failedText;
        aiRow.bubble.classList.add("error");
        return;
      }

      if (!res.body) {
        failedText = "请求失败：响应没有可读取的流。";
        aiRow.bubble.textContent = failedText;
        aiRow.bubble.classList.add("error");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      const parser = parserFactory((event) => {
        if (event.usage) exactUsage = event.usage;
        const delta = event.choices && event.choices[0] && event.choices[0].delta && event.choices[0].delta.content;
        if (delta) {
          if (!outStartMs) outStartMs = performance.now();
          full += delta;
          aiRow.bubble.textContent = full;
          if (isNearBottom()) scrollToBottom();
        }
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }

      parser.feed(decoder.decode());
      parser.flush();
    } catch (err) {
      aborted = err && err.name === "AbortError";
      if (!aborted) {
        failedText = `请求失败\n${(err && err.message) || String(err)}`;
        aiRow.bubble.textContent = full
          ? full + "\n\n[连接中断] " + ((err && err.message) || "")
          : failedText;
        aiRow.bubble.classList.add("error");
      }
    } finally {
      abortController = null;
      setStreaming(false);
    }

    const outEndMs = performance.now();

    if (!full) {
      if (aborted) {
        aiRow.bubble.textContent = failedText || "已停止，未产生内容。";
      } else if (!failedText) {
        aiRow.bubble.textContent = "上游没有返回任何内容。";
        aiRow.bubble.classList.add("error");
      }
      updateSpacer();
      refreshActions();
      return;
    }

    // 只有拿到内容才写入会话，避免污染上下文
    session.push({ role: "assistant", content: full, display: "" });
    session[session.length - 1].el = aiRow.row;
    aiRow.bubble.classList.remove("error");
    if (aborted) aiRow.bubble.textContent = full + "\n\n[已停止]";
    persistSessionIfEnabled();

    const seconds = Math.max(0.001, (outEndMs - (outStartMs || outEndMs)) / 1000);

    if (exactUsage && typeof exactUsage.completion_tokens === "number") {
      const p = exactUsage.prompt_tokens || 0;
      const c = exactUsage.completion_tokens || 0;
      const t = exactUsage.total_tokens || (p + c);

      totalPromptTokens += p;
      totalCompletionTokens += c;

      const tps = c / seconds;
      aiRow.stats.textContent =
        `Prompt: ${p} | Completion: ${c} | Total: ${t} | Speed: ${tps.toFixed(2)} tok/s | CumPrompt: ${totalPromptTokens} | CumCompletion: ${totalCompletionTokens}`;
    } else {
      const outEst = estimateTokens(full);
      totalOutEstimate += outEst;
      const tps = outEst / seconds;
      aiRow.stats.textContent =
        `Output(估算): ≈${outEst} | Total Out(估算): ≈${totalOutEstimate} | Speed(估算): ${tps.toFixed(2)} tok/s | (usage未返回)`;
    }

    updateSpacer();
    scrollToBottom();
    refreshActions();
  }

  async function send() {
    if (streaming) return;

    const typed = inputEl.value.trim();
    if (!typed && !pendingFiles.length) return;

    const files = pendingFiles.slice();
    const payloadText = buildPayloadText(typed, files);
    const displayText = buildDisplayText(typed, files);

    if (payloadText.length > WARN_PAYLOAD_CHARS) {
      toast(`内容较长（约 ${payloadText.length} 字），上游可能更慢或超时`);
    }

    inputEl.value = "";
    autoGrow();
    pendingFiles = [];
    renderAttachments();

    const userRow = makeRow("user");
    userRow.bubble.textContent = displayText;

    const inEst = estimateTokens(payloadText);
    totalInEstimate += inEst;
    userRow.stats.textContent = `Input(估算): ≈${inEst} | Total In(估算): ≈${totalInEstimate}`;

    const msg = { role: "user", content: payloadText, display: files.length ? displayText : "" };
    session.push(msg);
    msg.el = userRow.row;

    persistSessionIfEnabled();
    updateSpacer();
    scrollToBottom();

    await requestAI();
  }

  async function regenerate() {
    if (streaming) return;

    // 找到最后一条 assistant，把它及其之后的内容全部丢弃
    let lastAssistantIdx = -1;
    for (let i = session.length - 1; i >= 0; i--) {
      if (session[i].role === "assistant") { lastAssistantIdx = i; break; }
    }

    const lastMsg = session[session.length - 1];
    if (lastAssistantIdx === -1 && (!lastMsg || lastMsg.role !== "user")) {
      toast("没有可重新生成的内容");
      return;
    }

    if (lastAssistantIdx !== -1) {
      for (let i = lastAssistantIdx; i < session.length; i++) {
        const el = session[i].el;
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      session.splice(lastAssistantIdx);
    }

    // 清掉没有进入会话的报错气泡
    const known = new Set(session.map((m) => m.el).filter(Boolean));
    chatEl.querySelectorAll(".row.ai").forEach((row) => {
      if (!known.has(row)) row.remove();
    });

    persistSessionIfEnabled();
    updateSpacer();
    scrollToBottom();
    await requestAI();
  }

  sendBtn.addEventListener("click", () => {
    if (streaming) {
      if (abortController) abortController.abort();
      return;
    }
    send();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!streaming) send();
    }
  });

  function init() {
    initModels();
    setupResizeObserver();
    setupViewportListener();
    renderAttachments();
    autoGrow();
    updateSpacer();
    restoreSessionIfEnabled();
    refreshActions();
    scrollToBottom();
  }

  init();
})();
