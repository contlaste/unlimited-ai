import {
  DEFAULT_MODEL,
  MODELS,
  PROMPT_1,
  PROMPT_2,
  PROMPT_3,
  PROMPT_4
} from "./config.js";

const UPSTREAM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

// 请求体硬上限（字节）
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// 上下文裁剪参数
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 60000;
const MAX_TOTAL_CHARS = 400000;
// 等待上游「响应头」的最长时间；超过就主动放弃，避免浏览器干等
// 注意：上游自己在 ~100 秒就会返回 524，这里设 120 秒是为了兜住「连接挂住但没有任何响应」的情况
const UPSTREAM_HEADER_TIMEOUT_MS = 120000;
// 这些状态码通常是上游抖动/排队，自动重试一次（去掉 stream_options 简化请求）
const RETRYABLE_STATUS = new Set([502, 503, 504, 522, 523, 524]);
// 轻量限流（同一 isolate 内存内，best-effort）
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 60;

const rateBuckets = new Map();

function resp(body, contentType = "text/plain; charset=utf-8", status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

function fail(message, status = 400, code = "bad_request") {
  return resp(
    JSON.stringify({ error: { code, message } }),
    "application/json; charset=utf-8",
    status
  );
}

function isAllowedModel(modelId) {
  return MODELS.some((m) => m.id === modelId);
}

function builtinPromptForModel(modelId) {
  const meta = MODELS.find((m) => m.id === modelId);
  const persona = meta?.persona ?? 1;

  if (persona === 4) return PROMPT_4;
  if (persona === 3) return PROMPT_3;
  if (persona === 2) return PROMPT_2;
  return PROMPT_1;
}

function clientConfigJs() {
  const models = MODELS.map((m) => ({
    id: m.id,
    label: m.label
  }));

  return `window.APP_MODELS = ${JSON.stringify(models, null, 2)};
window.APP_DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};
`;
}

// 只保留 user/assistant，单条与总量都设上限；从最新往回保留，保证首条是 user
function prepareMessages(rawMessages) {
  const cleaned = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    let content = typeof msg.content === "string" ? msg.content : "";
    if (!content.trim()) continue;

    if (content.length > MAX_MESSAGE_CHARS) {
      content = content.slice(0, MAX_MESSAGE_CHARS) + "\n\n…(内容过长，已截断)";
    }

    cleaned.push({ role: msg.role, content });
  }

  const kept = [];
  let total = 0;

  for (let i = cleaned.length - 1; i >= 0; i--) {
    const msg = cleaned[i];
    if (kept.length >= MAX_MESSAGES) break;
    if (kept.length > 0 && total + msg.content.length > MAX_TOTAL_CHARS) break;
    kept.push(msg);
    total += msg.content.length;
  }

  kept.reverse();

  // 历史必须以 user 开头，否则部分上游会报错
  while (kept.length && kept[0].role !== "user") kept.shift();

  return kept;
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    if (rateBuckets.size > 5000) rateBuckets.clear();
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

async function handleChat(request, env) {
  if (!env.NVIDIA_API_KEY) {
    return fail(
      "服务端未配置 NVIDIA_API_KEY，请先执行 wrangler secret put NVIDIA_API_KEY。",
      500,
      "missing_api_key"
    );
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return fail("请求体过大。", 413, "payload_too_large");
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return fail("请求体不是合法 JSON。", 400, "bad_json");
  }

  if (isRateLimited(clientIp(request))) {
    return fail("请求过于频繁，请稍后再试。", 429, "rate_limited");
  }

  const requestedModel = payload?.model;
  const model = isAllowedModel(requestedModel) ? requestedModel : DEFAULT_MODEL;

  const useBuiltinPersona = payload?.use_builtin_persona !== false;
  const customSystemPrompt =
    typeof payload?.custom_system_prompt === "string"
      ? payload.custom_system_prompt.trim().slice(0, 20000)
      : "";

  const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  const messages = prepareMessages(rawMessages);

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return fail("缺少有效的用户消息。", 400, "no_user_message");
  }

  const upstreamMessages = [];

  if (useBuiltinPersona) {
    upstreamMessages.push({
      role: "system",
      content: builtinPromptForModel(model)
    });
  } else if (customSystemPrompt) {
    upstreamMessages.push({
      role: "system",
      content: customSystemPrompt
    });
  }

  for (const msg of messages) upstreamMessages.push(msg);

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_HEADER_TIMEOUT_MS);

  const onClientAbort = () => controller.abort();
  if (request.signal) request.signal.addEventListener("abort", onClientAbort);

  const call = (withUsage) =>
    fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(
        withUsage
          ? { model, stream: true, stream_options: { include_usage: true }, messages: upstreamMessages }
          : { model, stream: true, messages: upstreamMessages }
      ),
      signal: controller.signal
    });

  let upstream;
  try {
    upstream = await call(true);

    // 上游抖动（含 524 源站超时）时，去掉 stream_options 再试一次
    if (RETRYABLE_STATUS.has(upstream.status)) {
      try {
        await upstream.body?.cancel();
      } catch {}
      upstream = await call(false);
    }
  } catch (err) {
    if (timedOut) {
      return fail(
        `上游 ${Math.round(UPSTREAM_HEADER_TIMEOUT_MS / 1000)} 秒内没有返回任何内容（已经主动断开）。` +
          "常见原因是上下文太长、附件太大或该模型正在排队，请缩短对话/附件或换个模型再试。",
        504,
        "upstream_timeout"
      );
    }
    if (request.signal?.aborted) {
      return resp("", "text/plain; charset=utf-8", 499);
    }
    return fail(`无法连接上游服务：${err?.message || err}`, 502, "upstream_unreachable");
  } finally {
    clearTimeout(timer);
    if (request.signal) request.signal.removeEventListener("abort", onClientAbort);
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => "");
    const status = upstream.status;

    if (status === 524 || status === 504) {
      return fail(
        `上游超时（${status}，模型 ${model}）：100 秒内没有吐出第一个 token。` +
          "这通常是上下文过长或该模型排队导致的，请清空/缩短对话、减少附件，或换个模型重试。",
        504,
        "upstream_timeout"
      );
    }

    if (status === 429) {
      return fail("上游限流了（429），请稍后再试或换个模型。", 429, "upstream_rate_limited");
    }

    if (status === 401 || status === 403) {
      return fail(
        `上游拒绝访问（${status}）：NVIDIA_API_KEY 可能无效或没有该模型权限。`,
        502,
        "upstream_auth"
      );
    }

    return fail(
      `上游返回 ${status}：${errorText.slice(0, 2000)}`,
      502,
      "upstream_error"
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/config.js") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return fail("Method Not Allowed", 405, "method_not_allowed");
      }
      return resp(clientConfigJs(), "text/javascript; charset=utf-8", 200, {
        "Cache-Control": "no-store"
      });
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return fail("Method Not Allowed", 405, "method_not_allowed");
      }
      return handleChat(request, env);
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return resp(
      "Static assets binding 'ASSETS' is missing. Please configure [assets] in wrangler.toml.",
      "text/plain; charset=utf-8",
      500
    );
  }
};
