# DeepSeek Worker UI

Cloudflare Workers 上的极简 AI 聊天前端，把请求代理到 NVIDIA 的兼容 OpenAI 接口（`integrate.api.nvidia.com`）。零依赖、零构建。

## 功能

- 多模型下拉切换（模型白名单由后端下发，前端拿不到 `persona` 映射）
- 流式输出 + 精确 token 统计（上游返回 usage 时显示 prompt/completion/speed，否则给出估算值）
- 生成中可点 **停止** 中断（同时取消上游请求，避免继续计费）
- 每条回复支持 **复制**；最后一条支持 **重新生成**（丢弃该条回复后重新请求，不会重复添加提问）
- 输入框 **+** 可上传文本文件（txt / md / 代码 / json / csv / 日志等）和 **Word 文档（.docx / .docm / .doc）**，正文会被提取后随消息发给模型
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
public/docs.js       零依赖 Word 正文提取（docx 解 zip+XML，doc 解 OLE2 片段表）
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
| 附件数量、体积与字数 | `public/app.js` → `MAX_FILES` / `MAX_FILE_BYTES` / `MAX_FILE_CHARS` / `MAX_TOTAL_ATTACH_CHARS` |
| 允许的附件类型 | 文本：`public/app.js` → `TEXT_EXT`；Word：`public/docs.js` → `detectWordKind`；两处都要同步 `index.html` 的 `accept` |

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
npm test     # = 下面三条
node test/run-tests.mjs    # 31 项：SSE 解析器 + Worker 路由/校验/裁剪/限流/524 重试
node test/docs-test.mjs    # 23 项：docx / doc 正文提取（样本由 test/fixtures.mjs 现场构造）
node test/dom-test.mjs     # 16 项：jsdom 里跑真实前端交互（发送/停止/重新生成/上传）
```

## 常见错误

| 页面提示 | 含义 | 处理 |
|---|---|---|
| `请求失败（504）/ 上游超时 524` | NVIDIA 源站 100 秒没返回首个 token，通常是上下文太长、附件太大，或该模型在排队 | 清空/缩短对话、减少附件、换模型；Worker 已自动重试一次，仍失败就是上游问题 |
| `请求失败（429）` | 本地限流（60 次/分钟）或上游限流 | 等一分钟；调 `src/worker.js` 的 `RATE_MAX` |
| `上游拒绝访问（401/403）` | `NVIDIA_API_KEY` 无效或无该模型权限 | 重新 `wrangler secret put NVIDIA_API_KEY` |
| `上游返回 400` | 消息格式或模型不支持（例如 `stream_options`） | 看响应体里的 detail |
| 上传提示「设了打开密码」 | 加密的 Office 文档会被存成 OLE 容器，不是 zip | 在 Word 里去掉打开密码后另存为 .docx |
| 上传提示「无法识别…文件头 xx xx」 | 扩展名是假的（.doc 改名、下载到的是错误页） | 用 Word 打开后另存为 .docx；把提示里的文件头发我可进一步判断 |

`wrangler tail` 可以看到每次请求的实际状态码（注意 524 是上游返回的，不是你 Worker 崩了）。

## 限额

| 项 | 值 | 改哪里 |
|---|---|---|
| 历史条数 | 60 条 | `src/worker.js` → `MAX_MESSAGES` |
| 单条消息 | 6 万字 | `MAX_MESSAGE_CHARS` |
| 上下文总量 | 40 万字（超出从最早的消息开始丢） | `MAX_TOTAL_CHARS` |
| 附件数量与体积 | 3 个 / 每个 200 KB | `public/app.js` → `MAX_FILES` / `MAX_FILE_BYTES` |
| 附件正文 | 单条 6 万字、合计 6 万字 | `MAX_FILE_CHARS` / `MAX_TOTAL_ATTACH_CHARS` |
| 限流 | 60 次 / 分钟（单 isolate） | `RATE_MAX` |

注意：附件正文最终仍受「单条消息 6 万字」约束——超出的部分会被截断并提示。

## 说明

- 对话历史与自定义模板只存在浏览器 `localStorage`，不会上传到服务端。
- 单次请求超过 `MAX_TOTAL_CHARS` 时会从最早的消息开始裁剪，保证请求不撑爆上游上下文。
- 限流基于 isolate 内存，属于尽力而为的软限制；需要严格限额请自行接 Durable Objects 或 KV。
