// test/dom-test.mjs —— 用 jsdom 真实跑一遍前端交互
// 运行：node test/dom-test.mjs （需要 jsdom，仅供本地开发自测，不参与部署）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { makeDocx } from "./fixtures.mjs";

// jsdom 只用于本地测试：npm i 后即可解析
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const sseSrc = readFileSync(new URL("../public/sse.js", import.meta.url), "utf8");
const docsSrc = readFileSync(new URL("../public/docs.js", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

let passed = 0;
const failures = [];
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failures.push(name);
    console.error("  FAIL  " + name + "\n        " + err.message);
    process.exitCode = 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sseChunks(deltas, splitEvery = 3) {
  const raw = deltas
    .map((d) => "data: " + JSON.stringify({ choices: [{ delta: { content: d } }] }) + "\n\n")
    .join("") +
    "data: " + JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }) + "\n\n" +
    "data: [DONE]\n\n";
  const chunks = [];
  for (let i = 0; i < raw.length; i += splitEvery) chunks.push(raw.slice(i, i + splitEvery));
  return chunks;
}

function makeStreamResponse(chunks) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => (i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true, value: undefined }),
          releaseLock() {},
          cancel: async () => {}
        };
      }
    },
    text: async () => ""
  };
}

function boot() {
  const requests = [];
  let nextResponse = null;

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });

  const win = dom.window;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.Element.prototype.scrollTo = function () {};
  win.scrollTo = () => {};

  // 每次请求都必须拿到一条全新的流；复用同一个 Response 会让第二次读到空内容
  let defaultStream = () => makeStreamResponse(sseChunks(["Hello", " world"]));

  win.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (typeof nextResponse === "function") return nextResponse();
    return defaultStream();
  };

  win.APP_MODELS = [
    { id: "test/model-a", label: "model-a" },
    { id: "test/model-b", label: "model-b" }
  ];

  win.eval(sseSrc);
  win.eval(docsSrc);
  win.eval(appSrc);

  return {
    win,
    doc: win.document,
    requests,
    setResponse(fn) { nextResponse = fn; },
    setStream(deltas) { nextResponse = null; defaultStream = () => makeStreamResponse(sseChunks(deltas)); }
  };
}

function rows(doc) {
  return Array.from(doc.querySelectorAll("#chat .row"));
}

async function sendText(win, doc, text) {
  const input = doc.getElementById("msg");
  input.value = text;
  doc.getElementById("sendBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(80);
}

console.log("\n[前端交互]");

await ok("模型下拉由 window.APP_MODELS 渲染", () => {
  const { doc } = boot();
  const opts = Array.from(doc.querySelectorAll("#modelSel option")).map((o) => o.value);
  assert.deepEqual(opts, ["test/model-a", "test/model-b"]);
});

await ok("发送后流式拼接完整（chunk 被切成 3 字节）", async () => {
  const { win, doc, requests } = boot();
  await sendText(win, doc, "你好");
  const r = rows(doc);
  assert.equal(r.length, 2);
  assert.equal(r[0].querySelector(".bubble").textContent, "你好");
  assert.equal(r[1].querySelector(".bubble").textContent, "Hello world");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.messages.length, 1);
  assert.equal(requests[0].body.messages[0].role, "user");
});

await ok("usage 存在时显示精确 token 统计", async () => {
  const { win, doc } = boot();
  await sendText(win, doc, "hi");
  const stats = doc.querySelector("#chat .row.ai .stats").textContent;
  assert.match(stats, /Prompt: 12/);
  assert.match(stats, /Completion: 5/);
  assert.match(stats, /Total: 17/);
});

await ok("重新生成：替换最后一条回复且不重复提问", async () => {
  const { win, doc, requests, setStream } = boot();
  await sendText(win, doc, "第一问");
  assert.equal(rows(doc).length, 2);

  setStream(["第二次", "回答"]);
  doc.querySelector("#chat .row.ai .act-regen").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(80);

  assert.equal(rows(doc).length, 2, "不应新增 user 气泡");
  assert.equal(doc.querySelector("#chat .row.ai .bubble").textContent, "第二次回答");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.messages.length, 1, "重发时只带 1 条 user 消息");
  assert.equal(requests[1].body.messages[0].content, "第一问");
});

await ok("重新生成可连续进行（多轮后仍正确）", async () => {
  const { win, doc, requests, setStream } = boot();
  await sendText(win, doc, "Q1");
  setStream(["A1"]);
  doc.querySelector(".act-regen").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  setStream(["A1b"]);
  doc.querySelector(".act-regen").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(80);

  const r = rows(doc);
  assert.equal(r.length, 2);
  assert.equal(r[1].querySelector(".bubble").textContent, "A1b");
  assert.equal(requests.at(-1).body.messages.length, 1);
  assert.equal(requests.at(-1).body.messages.at(-1).role, "user");
});

await ok("只有最后一条 AI 回复显示“重新生成”", async () => {
  const { win, doc } = boot();
  await sendText(win, doc, "Q1");
  await sendText(win, doc, "Q2");
  const aiRows = Array.from(doc.querySelectorAll("#chat .row.ai"));
  assert.equal(aiRows.length, 2);
  const visible = aiRows.map((r) => r.querySelector(".act-regen").style.display !== "none");
  assert.deepEqual(visible, [false, true]);
});

await ok("上传文本文件：正文进入请求、气泡只显示摘要", async () => {
  const { win, doc, requests } = boot();

  const file = new win.File(["line1\nline2"], "note.md", { type: "text/markdown" });
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: async () => "line1\nline2" });
  }

  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(60);

  const chips = doc.querySelectorAll("#attachments .chip");
  assert.equal(chips.length, 1);
  assert.match(chips[0].textContent, /note\.md/);

  await sendText(win, doc, "看看这个文件");

  const sent = requests[0].body.messages[0].content;
  assert.match(sent, /看看这个文件/);
  assert.match(sent, /line1\nline2/);
  assert.match(sent, /```markdown/);

  const bubble = doc.querySelector("#chat .row.user .bubble").textContent;
  assert.match(bubble, /\[附件\] note\.md/);
  assert.doesNotMatch(bubble, /line1/);
  assert.equal(doc.querySelectorAll("#attachments .chip").length, 0, "发送后清空附件");
});

await ok("上传 docx：提取正文发给模型，气泡只显示字数", async () => {
  const { win, doc, requests } = boot();

  const bytes = makeDocx(["我是 Word 里的第一段", "第二段"], { deflate: false });
  const file = new win.File([bytes], "会议纪要.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  }

  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(80);

  const chips = doc.querySelectorAll("#attachments .chip");
  assert.equal(chips.length, 1);
  assert.match(chips[0].textContent, /会议纪要\.docx/);

  await sendText(win, doc, "总结一下这个文档");

  const sent = requests[0].body.messages[0].content;
  assert.match(sent, /总结一下这个文档/);
  assert.match(sent, /我是 Word 里的第一段/);
  assert.match(sent, /Word 文档，已提取正文 \d+ 字/);
  assert.doesNotMatch(sent, /PK\u0003\u0004/, "不应把 zip 二进制塞进去");

  const bubble = doc.querySelector("#chat .row.user .bubble").textContent;
  assert.match(bubble, /\[附件\] 会议纪要\.docx · Word · \d+ 字/);
});

await ok("损坏的 docx 给出可读错误且不加入附件", async () => {
  const { win, doc } = boot();
  const file = new win.File([new Uint8Array([1, 2, 3, 4, 5])], "坏文件.docx", { type: "" });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer });
  }

  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(80);

  assert.equal(doc.querySelectorAll("#attachments .chip").length, 0);
  assert.match(doc.getElementById("toast").textContent, /解析失败/);
});

await ok("超过 200KB 的文件被跳过", async () => {
  const { win, doc } = boot();
  const big = new win.File(["x".repeat(210 * 1024)], "大文件.txt", { type: "text/plain" });

  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { value: [big], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(80);

  assert.equal(doc.querySelectorAll("#attachments .chip").length, 0);
  assert.match(doc.getElementById("toast").textContent, /200\.0 KB/);
});

await ok("200KB 以内的文件可以上传", async () => {
  const { win, doc } = boot();
  const ok = new win.File(["y".repeat(150 * 1024)], "刚好.txt", { type: "text/plain" });

  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { value: [ok], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(80);

  assert.equal(doc.querySelectorAll("#attachments .chip").length, 1);
});

await ok("非文本文件被忽略", async () => {
  const { win, doc } = boot();
  const file = new win.File(["x"], "photo.jpg", { type: "image/jpeg" });
  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(40);
  assert.equal(doc.querySelectorAll("#attachments .chip").length, 0);
  assert.match(doc.getElementById("toast").textContent, /忽略/);
});

await ok("仅附件（不输入文字）也能发送", async () => {
  const { win, doc, requests } = boot();
  const file = new win.File(["abc"], "a.txt", { type: "text/plain" });
  if (typeof file.text !== "function") Object.defineProperty(file, "text", { value: async () => "abc" });
  const input = doc.getElementById("fileInput");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(60);

  doc.getElementById("sendBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.messages[0].content, /abc/);
});

await ok("服务端错误 JSON 被解析成可读提示", async () => {
  const { win, doc, setResponse } = boot();
  setResponse(() => ({
    ok: false,
    status: 500,
    body: null,
    text: async () => JSON.stringify({ error: { code: "missing_api_key", message: "服务端未配置 NVIDIA_API_KEY" } })
  }));
  await sendText(win, doc, "hi");
  const bubble = doc.querySelector("#chat .row.ai .bubble");
  assert.match(bubble.textContent, /请求失败（500）/);
  assert.match(bubble.textContent, /未配置 NVIDIA_API_KEY/);
  assert.ok(bubble.classList.contains("error"));
});

await ok("网络异常不会卡死，显示错误但不写入会话", async () => {
  const { win, doc, setResponse, requests } = boot();
  setResponse(() => { throw new Error("network down"); });
  await sendText(win, doc, "hi");
  const bubble = doc.querySelector("#chat .row.ai .bubble");
  assert.match(bubble.textContent, /请求失败/);
  assert.match(bubble.textContent, /network down/);
  assert.equal(doc.getElementById("sendBtn").textContent, "Send", "按钮应恢复");

  setResponse(() => makeStreamResponse(sseChunks(["ok"])));
  doc.querySelector(".act-regen").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  assert.equal(requests.at(-1).body.messages.length, 1, "失败的气泡不应进入上下文");
});

await ok("生成中按钮变为“停止”，点击可中断", async () => {
  const { win, doc, setResponse } = boot();
  setResponse(() => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: () => new Promise((_, reject) => {
            const err = new Error("aborted");
            err.name = "AbortError";
            setTimeout(() => reject(err), 30);
          }),
          releaseLock() {}
        };
      }
    },
    text: async () => ""
  }));

  doc.getElementById("msg").value = "hi";
  const btn = doc.getElementById("sendBtn");
  btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(5);
  assert.equal(btn.textContent, "停止");

  btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  assert.equal(btn.textContent, "Send");
});

await ok("回退到 user 消息：删掉该条及之后，草稿与附件放回输入区", async () => {
  const { win, doc, requests } = boot();

  const file = new win.File(["附件正文ABC"], "note.txt", { type: "text/plain" });
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: async () => "附件正文ABC" });
  }
  const fileInput = doc.getElementById("fileInput");
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(50);

  await sendText(win, doc, "第一问");
  await sendText(win, doc, "第二问");
  assert.equal(rows(doc).length, 4);

  doc.querySelectorAll("#chat .row.user")[0]
    .querySelector(".act-rewind")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(30);

  assert.equal(rows(doc).length, 0, "该条及其之后全部移除");
  assert.equal(doc.getElementById("msg").value, "第一问");
  assert.equal(doc.querySelectorAll("#attachments .chip").length, 1, "附件也要恢复");
  assert.ok(doc.getElementById("undoBar").classList.contains("show"));

  await sendText(win, doc, "第一问（改过）");
  assert.equal(requests.at(-1).body.messages.length, 1, "上下文只剩新的这一条");
  assert.match(requests.at(-1).body.messages[0].content, /附件正文ABC/);
});

await ok("撤销回退能完整恢复对话", async () => {
  const { win, doc } = boot();
  await sendText(win, doc, "第一问");
  await sendText(win, doc, "第二问");
  assert.equal(rows(doc).length, 4);

  doc.querySelectorAll("#chat .row.user")[1]
    .querySelector(".act-rewind")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  assert.equal(rows(doc).length, 2);
  assert.equal(doc.getElementById("msg").value, "第二问");

  doc.getElementById("undoBtn")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  assert.equal(rows(doc).length, 4, "四条消息都回来");
  assert.equal(doc.getElementById("msg").value, "");
  assert.equal(doc.getElementById("undoBar").classList.contains("show"), false);
});

await ok("回退到 AI 消息：保留它之前的提问", async () => {
  const { win, doc } = boot();
  await sendText(win, doc, "第一问");
  await sendText(win, doc, "第二问");

  doc.querySelectorAll("#chat .row.ai")[0]
    .querySelector(".act-rewind")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(30);

  assert.equal(rows(doc).length, 1);
  assert.ok(rows(doc)[0].classList.contains("user"));
  assert.equal(doc.getElementById("msg").value, "");
});

await ok("新建并启用持续预设：之后每轮请求都带上", async () => {
  const { win, doc, requests } = boot();

  doc.getElementById("settingsBtn")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  doc.getElementById("presetNew")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  doc.getElementById("presetName").value = "中文模式";
  doc.getElementById("presetContent").value = "始终用简体中文，输出用表格";
  doc.getElementById("presetSave")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(20);

  assert.match(doc.getElementById("presetHint").textContent, /中文模式/);
  assert.ok(doc.getElementById("presetSel").value, "下拉应选中新预设");
  assert.ok(win.localStorage.getItem("cfw_presets_v1"), "预设应写入本地存储");

  await sendText(win, doc, "第一轮");
  assert.equal(requests[0].body.persistent_prompt, "始终用简体中文，输出用表格");
  await sendText(win, doc, "第二轮");
  assert.equal(requests[1].body.persistent_prompt, "始终用简体中文，输出用表格");
});

await ok("切换为「不使用」后不再发送预设", async () => {
  const { win, doc, requests } = boot();

  doc.getElementById("presetNew")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  doc.getElementById("presetContent").value = "保持简洁";
  doc.getElementById("presetSave")
    .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(20);

  const sel = doc.getElementById("presetSel");
  sel.value = "";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(20);

  await sendText(win, doc, "hi");
  assert.equal(requests[0].body.persistent_prompt, "");
});

console.log(`\n${passed} 项通过${failures.length ? "，失败：" + failures.join(" / ") : ""}\n`);
