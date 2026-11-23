// test/check-models.mjs
// 检查 src/config.js 里的模型 ID 是否还活在 NVIDIA NIM 目录里（无需 API key）
// 用法：node test/check-models.mjs
import { MODELS, DEFAULT_MODEL } from "../src/config.js";

const BASE = "https://integrate.api.nvidia.com/v1";
const ids = [...new Set([DEFAULT_MODEL, ...MODELS.map((m) => m.id)])];

const statusText = {
  401: "可用（仅缺凭证）",
  410: "已下线 EOL",
  404: "ID 不存在 / 非聊天端点",
  429: "可用（触发限流）"
};

function labelFor(code) {
  return statusText[code] || `HTTP ${code}`;
}

async function probe(id) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }] })
    });

    let detail = "";
    if (res.status === 410) {
      try {
        const j = await res.json();
        detail = j.detail || "";
      } catch {}
    }

    return { code: res.status, detail };
  } catch (err) {
    return { code: 0, detail: err?.message || String(err) };
  }
}

let catalog = null;
try {
  const res = await fetch(`${BASE}/models`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  catalog = new Set(json.data.map((m) => m.id));
  console.log(`官方 /v1/models 当前有 ${catalog.size} 个模型\n`);
} catch (err) {
  console.warn(`无法读取官方模型目录：${err?.message || err}（仍会逐项探测端点）\n`);
}

console.log("配置里的模型：\n");
const bad = [];

for (const id of ids) {
  const role = id === DEFAULT_MODEL ? "默认" : "可选";
  const r = await probe(id);
  const inCatalog = catalog ? (catalog.has(id) ? "在目录中" : "已移出目录") : "目录未知";
  const ok = r.code === 401 || r.code === 429;

  console.log(
    `  ${ok ? "[OK]  " : "[BAD] "} ${id.padEnd(48)} ${role}  ${String(r.code).padEnd(4)} ${labelFor(r.code)}  ${inCatalog}`
  );
  if (r.detail) console.log(`         ${r.detail}`);
  if (!ok) bad.push(id);
}

if (catalog) {
  const chatLike = [...catalog].filter(
    (id) => !/embed|nemoguard|safety|clip|translate|video|retriever/i.test(id)
  );
  console.log(`\n当前目录里可作为聊天候选的模型（${chatLike.length} 个）：`);
  for (const id of chatLike) console.log("  - " + id);
}

console.log("");
if (bad.length) {
  console.error(`有 ${bad.length} 个模型不可用，请更新 src/config.js：`);
  for (const id of bad) console.error("  - " + id);
  process.exitCode = 1;
} else {
  console.log("全部可用，配置无需改动。");
}
