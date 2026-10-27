# DeepSeek Worker UI

Cloudflare Workers 上的极简 AI 聊天前端，把请求代理到 NVIDIA 的兼容 OpenAI 接口（`integrate.api.nvidia.com`）。零依赖、零构建。

## 功能

- 多模型下拉切换（模型白名单由后端下发，前端拿不到 `persona` 映射）
- 流式输出 + 精确 token 统计（上游返回 usage 时显示 prompt/completion/speed，否则给出估算值）
- 生成中可点 **停止** 中断（同时取消上游请求，避免继续计费）
- 每条回复支持 **复制**；最后一条支持 **重新生成**（丢弃该条回复后重新请求，不会重复添加提问）
- 输入框 **+** 可上传文本类文件（txt / md / 代码 / json / csv / 日志等），作为附件正文随消息一起发给模型
- 😈 使用内置人格模板；😇 使用网页端自定义 system prompt
- 本地对话记忆与自定义模板分开存储，可分别清除
- 打赏入口

## 目录

```
src/worker.js        Worker 入口：/api/chat 代理 + 动态 /config.js
src/config.js        模型列表、默认模型、内置人格模板（要改的都在这里）
public/index.html    页面结构
public/app.js        前端全部逻辑
public/sse.js        带缓冲的 SSE 解析器（跨 chunk 拆行也能正确解析）
public/styles.css    样式（暗色主题，CSS 变量驱动）
dev-server.mjs       本地联调用的零依赖服务器
test/                自测脚本
wrangler.toml        Workers 配置（ASSETS 绑定 + run_worker_first）
```

## 部署

```bash
npm i -g wrangler
wrangler login
wrangler secret put NVIDIA_API_KEY   # 填你的 NVIDIA key
wrangler deploy
```

部署完成后直接打开 Worker 地址即可使用。

## 想改的东西

| 想改什么 | 改哪里 |
|---|---|
| 默认模型 | `src/config.js` → `DEFAULT_MODEL` |
| 可选模型 | `src/config.js` → `MODELS`（`id` 必须存在于上游；`persona` 决定用哪份内置模板） |
| 内置人格 | `src/config.js` → `PROMPT_1` ~ `PROMPT_4` |
| 上下文条数/字数上限 | `src/worker.js` → `MAX_MESSAGES` / `MAX_TOTAL_CHARS` / `MAX_MESSAGE_CHARS` |
| 限流 | `src/worker.js` → `RATE_MAX` / `RATE_WINDOW_MS` |
| 附件大小与数量 | `public/app.js` → `MAX_FILES` / `MAX_FILE_BYTES` / `MAX_TOTAL_FILE_BYTES` |
| 允许的附件类型 | `public/app.js` → `TEXT_EXT` 与 `index.html` 里 `input[type=file]` 的 `accept` |

## 本地联调

不装 wrangler 也能在本机跑：

```bash
# Windows PowerShell: $env:NVIDIA_API_KEY="sk-xxx"
NVIDIA_API_KEY=sk-xxx node dev-server.mjs
# 打开 http://localhost:8788
```

不带 key 时页面照常打开，只是发送会返回 500（用于验证 UI）。

## 自测

```bash
npm i        # 只为测试装 jsdom，部署不需要
npm test     # = 下面两条
node test/run-tests.mjs    # 24 项：SSE 解析器 + Worker 路由/校验/限流
node test/dom-test.mjs     # 12 项：jsdom 里跑真实前端交互（发送/停止/重新生成/上传）
```

## 说明

- 对话历史与自定义模板只存在浏览器 `localStorage`，不会上传到服务端。
- 单次请求超过 `MAX_TOTAL_CHARS` 时会从最早的消息开始裁剪，保证请求不撑爆上游上下文。
- 限流基于 isolate 内存，属于尽力而为的软限制；需要严格限额请自行接 Durable Objects 或 KV。
