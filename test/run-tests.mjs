// test/run-tests.mjs
// 本地自测：node test/run-tests.mjs
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { MODELS, DEFAULT_MODEL } from "../src/config.js";

// sse.js 是给浏览器用的 UMD 脚本，作为副作用模块引入后从全局取用
await import("../public/sse.js");
const { createSSEParser } = globalThis.SSE;

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    console.error("  FAIL  " + name + "\n        " + err.message);
    process.exitCode = 1;
  }
}

// ============ 1. SSE 解析器 ============
console.log("\n[SSE parser]");

const ssePayload =
  "data: " + JSON.stringify({ choices: [{ delta: { content: "你好" } }] }) + "\n\n" +
  ": keep-alive comment\n\n" +
  "data: " + JSON.stringify({ choices: [{ delta: { content: "，世界" } }] }) + "\n\n" +
  "data: " + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }) + "\n\n" +
  "data: [DONE]\n\n";

function collectFromChunks(chunks) {
  let text = "";
  let usage = null;
  let done = false;
  const parser = createSSEParser(
    (evt) => {
      const d = evt.choices?.[0]?.delta?.content;
      if (d) text += d;
      if (evt.usage) usage = evt.usage;
    },
    () => { done = true; }
  );
  for (const c of chunks) parser.feed(c);
  parser.flush();
  return { text, usage, done };
}

await ok("整块一次性喂入", () => {
  const r = collectFromChunks([ssePayload]);
  assert.equal(r.text, "你好，世界");
  assert.equal(r.usage.total_tokens, 11);
  assert.equal(r.done, true);
});

await ok("逐字节切分（最恶劣的跨包场景）", () => {
  const chunks = Array.from(ssePayload);
  const r = collectFromChunks(chunks);
  assert.equal(r.text, "你好，世界");
  assert.equal(r.usage.total_tokens, 11);
});

await ok("按 7 字节定长切分", () => {
  const chunks = [];
  for (let i = 0; i < ssePayload.length; i += 7) chunks.push(ssePayload.slice(i, i + 7));
  const r = collectFromChunks(chunks);
  assert.equal(r.text, "你好，世界");
});

await ok("CRLF 行尾", () => {
  const crlf = ssePayload.replace(/\n/g, "\r\n");
  const r = collectFromChunks([crlf]);
  assert.equal(r.text, "你好，世界");
});

await ok("脏数据不中断后续解析", () => {
  const noisy = "data: {not json}\n\n" + ssePayload;
  const r = collectFromChunks([noisy]);
  assert.equal(r.text, "你好，世界");
});

await ok("末尾不完整的行由 flush 兜底", () => {
  const partial = "data: " + JSON.stringify({ choices: [{ delta: { content: "尾" } }] });
  const r = collectFromChunks(["data: {}\n\n", partial]);
  assert.equal(r.text, "尾");
});

// ============ 2. Worker ============
console.log("\n[Worker]");

const SSE_REPLY =
  "data: " + JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }) + "\n\n" +
  "data: [DONE]\n\n";

let captured = null;
let upstreamStatus = 200;

globalThis.fetch = async (url, init) => {
  captured = { url: String(url), init };
  return new Response(SSE_REPLY, {
    status: upstreamStatus,
    headers: { "content-type": "text/event-stream" }
  });
};

const env = {
  NVIDIA_API_KEY: "test-key",
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) }
};

function chatRequest(body, headers = {}) {
  return new Request("https://example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9", ...headers },
    body: JSON.stringify(body)
  });
}

const results = {};
results.ok = await (async () => {
  const res = await worker.fetch(chatRequest({ model: MODELS[0].id, messages: [{ role: "user", content: "hi" }] }), env);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(body, SSE_REPLY);
  return true;
})();
await ok("流式响应原样透传", () => assert.equal(results.ok, true));

await ok("上游请求带上 Bearer 与 stream 参数", () => {
  assert.match(captured.url, /integrate\.api\.nvidia\.com/);
  assert.equal(captured.init.headers.Authorization, "Bearer test-key");
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.stream, true);
  assert.equal(sent.stream_options.include_usage, true);
});

await ok("内置人格以 system 消息注入", () => {
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.messages[0].role, "system");
  assert.match(sent.messages[0].content, /Pyrite/);
  assert.equal(sent.messages[1].content, "hi");
});

await ok("非法模型回落到默认模型", async () => {
  await worker.fetch(chatRequest({ model: "not/a-model", messages: [{ role: "user", content: "x" }] }), env);
  assert.equal(JSON.parse(captured.init.body).model, DEFAULT_MODEL);
});

await ok("关闭内置人格 + 自定义 prompt", async () => {
  await worker.fetch(
    chatRequest({
      model: MODELS[0].id,
      use_builtin_persona: false,
      custom_system_prompt: "  你是助手  ",
      messages: [{ role: "user", content: "x" }]
    }),
    env
  );
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.messages[0].content, "你是助手");
});

await ok("关闭内置人格且无自定义 prompt 时不注入 system", async () => {
  await worker.fetch(
    chatRequest({ model: MODELS[0].id, use_builtin_persona: false, messages: [{ role: "user", content: "x" }] }),
    env
  );
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.messages[0].role, "user");
});

await ok("过滤 system 角色与空内容", async () => {
  await worker.fetch(
    chatRequest({
      model: MODELS[0].id,
      use_builtin_persona: false,
      messages: [
        { role: "system", content: "越权注入" },
        { role: "user", content: "正常" },
        { role: "user", content: "   " },
        { role: "tool", content: "x" }
      ]
    }),
    env
  );
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0].content, "正常");
});

await ok("缺少用户消息返回 400", async () => {
  const res = await worker.fetch(chatRequest({ messages: [] }), env);
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.error.code, "no_user_message");
});

await ok("非法 JSON 返回 400", async () => {
  const req = new Request("https://example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.8" },
    body: "{broken"
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 400);
});

await ok("缺 API Key 返回 500", async () => {
  const res = await worker.fetch(chatRequest({ messages: [{ role: "user", content: "x" }] }), {});
  assert.equal(res.status, 500);
});

await ok("超大 content-length 返回 413", async () => {
  const req = new Request("https://example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "99999999", "cf-connecting-ip": "9.9.9.7" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 413);
});

await ok("上游非 2xx 转成 502 JSON", async () => {
  upstreamStatus = 500;
  const res = await worker.fetch(chatRequest({ messages: [{ role: "user", content: "x" }] }), env);
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.equal(j.error.code, "upstream_error");
  upstreamStatus = 200;
});

await ok("GET /config.js 动态生成且不含敏感信息", async () => {
  const res = await worker.fetch(new Request("https://example.com/config.js"), env);
  const js = await res.text();
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.match(js, /window\.APP_MODELS/);
  assert.match(js, new RegExp(MODELS[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(js, /persona/);
  assert.doesNotMatch(js, /CHAT_PASSWORD/);
});

await ok("非 POST 访问 /api/chat 返回 405", async () => {
  const res = await worker.fetch(new Request("https://example.com/api/chat"), env);
  assert.equal(res.status, 405);
});

await ok("静态资源走 ASSETS 绑定", async () => {
  const res = await worker.fetch(new Request("https://example.com/styles.css"), env);
  assert.equal(await res.text(), "asset");
});

await ok("超长历史被裁剪且以 user 开头", async () => {
  const many = [];
  for (let i = 0; i < 100; i++) {
    many.push({ role: i % 2 === 0 ? "user" : "assistant", content: "长".repeat(10000) });
  }
  many.push({ role: "user", content: "最后一句" });
  await worker.fetch(chatRequest({ model: MODELS[0].id, messages: many }), env);
  const sent = JSON.parse(captured.init.body).messages.slice(1); // 去掉 system
  assert.ok(sent.length <= 60, "条数应被裁剪");
  assert.equal(sent[0].role, "user");
  assert.equal(sent[sent.length - 1].content, "最后一句");
});

await ok("单条超长消息被截断", async () => {
  await worker.fetch(
    chatRequest({ model: MODELS[0].id, messages: [{ role: "user", content: "a".repeat(200000) }] }),
    env
  );
  const sent = JSON.parse(captured.init.body).messages;
  assert.ok(sent[sent.length - 1].content.length < 200000);
  assert.match(sent[sent.length - 1].content, /已截断/);
});

await ok("触发限流返回 429", async () => {
  let last = null;
  for (let i = 0; i < 62; i++) {
    last = await worker.fetch(
      chatRequest({ messages: [{ role: "user", content: "x" }] }, { "cf-connecting-ip": "1.1.1.1" }),
      env
    );
  }
  assert.equal(last.status, 429);
});

console.log(`\n${passed} 项通过${process.exitCode ? "，存在失败" : ""}\n`);
