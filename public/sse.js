// public/sse.js
// 带缓冲的 SSE 解析器：解决“一个 data: 行被拆到多个 chunk 里导致 JSON.parse 失败”的丢字问题。
// 浏览器里挂到 window.SSE，Node 下可 require 做单元测试。
(function (root) {
  "use strict";

  function createSSEParser(onEvent, onDone) {
    let buffer = "";
    let finished = false;

    function handleLine(rawLine) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line || line[0] === ":") return; // 空行 / 注释行

      if (!line.startsWith("data:")) return;

      let data = line.slice(5);
      if (data.startsWith(" ")) data = data.slice(1);
      data = data.trim();
      if (!data) return;

      if (data === "[DONE]") {
        finished = true;
        if (typeof onDone === "function") onDone();
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        return; // 单行就是完整的 JSON，解析失败说明是脏数据，跳过
      }

      if (typeof onEvent === "function") onEvent(parsed);
    }

    function feed(text) {
      if (typeof text !== "string" || !text) return;
      buffer += text;

      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }

    function flush() {
      if (!buffer) return;
      const rest = buffer;
      buffer = "";
      handleLine(rest);
    }

    function reset() {
      buffer = "";
      finished = false;
    }

    return {
      feed,
      flush,
      reset,
      isFinished: () => finished,
      pending: () => buffer
    };
  }

  const api = { createSSEParser };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SSE = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
