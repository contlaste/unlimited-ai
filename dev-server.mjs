// dev-server.mjs —— 本地联调用的零依赖服务器（不替代 wrangler，仅方便本地点开页面看效果）
// 用法：NVIDIA_API_KEY=sk-xxx node dev-server.mjs   然后打开 http://localhost:8788
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./src/worker.js";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 8788);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const buf = await readFile(filePath);
      return new Response(buf, {
        headers: { "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream" }
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
};

const env = {
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || "",
  ASSETS
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host"]);

http
  .createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
      }

      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;

      const request = new Request("http://" + (req.headers.host || `localhost:${PORT}`) + req.url, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined
      });

      const response = await worker.fetch(request, env);

      res.writeHead(response.status, Object.fromEntries(response.headers));

      if (response.body) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("dev-server error: " + (err?.message || err));
    }
  })
  .listen(PORT, () => {
    console.log(`dev server: http://localhost:${PORT}`);
    if (!env.NVIDIA_API_KEY) {
      console.warn("提示：未设置 NVIDIA_API_KEY，/api/chat 会返回 500。");
    }
  });
