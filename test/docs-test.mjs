// test/docs-test.mjs —— Word 文档正文提取的单元测试
import assert from "node:assert/strict";
import { makeDocx, makeZip, buildSimpleDoc, buildComplexDoc } from "./fixtures.mjs";

await import("../public/docs.js");
const DOCS = globalThis.DOCS;

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

console.log("\n[Word 文档解析]");

// ---------- 类型识别 ----------
await ok("按扩展名识别 docx / docm / doc", () => {
  assert.equal(DOCS.detectWordKind("报告.docx"), "docx");
  assert.equal(DOCS.detectWordKind("报告.DOCM"), "docx");
  assert.equal(DOCS.detectWordKind("旧文档.doc"), "doc");
  assert.equal(DOCS.detectWordKind("a.txt"), null);
  assert.equal(DOCS.detectWordKind("a.pdf", "application/pdf"), null);
});

await ok("按 MIME 识别（扩展名缺失时）", () => {
  assert.equal(
    DOCS.detectWordKind("无扩展名", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "docx"
  );
  assert.equal(DOCS.detectWordKind("无扩展名", "application/msword"), "doc");
});

// ---------- DOCX ----------
await ok("docx（store 无压缩）提取多段正文", async () => {
  const buf = makeDocx(["第一段：你好", "第二段：世界"], { deflate: false });
  const text = await DOCS.extractDocx(buf);
  assert.equal(text, "第一段：你好\n第二段：世界");
});

await ok("docx（deflate 压缩）走 DecompressionStream", async () => {
  const buf = makeDocx(["压缩后的正文", "第二行"], { deflate: true });
  const text = await DOCS.extractDocx(buf);
  assert.equal(text, "压缩后的正文\n第二行");
});

await ok("docx 实体解码与制表符", async () => {
  const xml =
    '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>a &amp;lt; b</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>c</w:t></w:r></w:p></w:body></w:document>';
  const buf = makeZip([{ name: "word/document.xml", data: xml }]);
  const text = await DOCS.extractDocx(buf);
  assert.equal(text, "a &lt; b\tc");
});

await ok("docx 里没有 document.xml 时报错", async () => {
  const buf = makeZip([{ name: "other.xml", data: "<a/>" }]);
  await assert.rejects(() => DOCS.extractDocx(buf), /document\.xml/);
});

await ok("docx 没有文字时报错", async () => {
  const buf = makeDocx([""]);
  await assert.rejects(() => DOCS.extractDocx(buf), /没有提取到文字/);
});

await ok("非 zip 内容报错", async () => {
  await assert.rejects(() => DOCS.extractDocx(new Uint8Array([1, 2, 3, 4, 5, 6])), /docx/);
});

// ---------- DOC ----------
await ok("doc 简单文档（fComplex=0，UTF-16 正文）", () => {
  const text = "你好，这是 Word 97 文档。\n第二行。";
  const buf = buildSimpleDoc(text);
  assert.equal(DOCS.extractDoc(buf), text);
});

await ok("doc 复杂文档（片段表 + 小流）", () => {
  const text = "复杂文档正文：通过 PlcPcd 片段表定位。";
  const buf = buildComplexDoc(text);
  assert.equal(DOCS.extractDoc(buf), text);
});

await ok("doc 片段表为空时回落到 fcMin/fcMac", () => {
  const buf = buildComplexDoc("兜底正文");
  const WD = 512 + 512 + 512; // 头 + FAT + 目录之后就是 WordDocument
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(view.getUint16(WD, true), 0xa5ec, "FIB 魔数应在该位置");

  view.setUint32(WD + 0x01a6, 0, true); // lcbClx = 0 → 强制走兜底
  assert.equal(DOCS.extractDoc(buf), "兜底正文");
});

await ok("非 OLE 文件报错", () => {
  assert.throws(() => DOCS.extractDoc(new Uint8Array(600)), /OLE/);
});

await ok("OLE 里没有 WordDocument 流时报错", () => {
  const wd = buildSimpleDoc("x");
  // 篡改目录里的名字，使 WordDocument 流消失
  const nameOffset = 512 + 512 + 128; // 目录第 2 项的 name 字段
  for (let i = 0; i < 24; i++) wd[nameOffset + i] = 0x41;
  assert.throws(() => DOCS.extractDoc(wd), /WordDocument/);
});

await ok("extractWord 按 kind 分发", async () => {
  const docx = await DOCS.extractWord(makeDocx(["来自 docx"]), "docx");
  assert.equal(docx, "来自 docx");
  const doc = DOCS.extractWord(buildSimpleDoc("来自 doc"), "doc");
  assert.equal(await doc, "来自 doc");
});

console.log(`\n${passed} 项通过${failures.length ? "，失败：" + failures.join(" / ") : ""}\n`);
