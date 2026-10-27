// public/docs.js
// 零依赖的 Word 文档正文提取：
//   .docx / .docm —— zip + OOXML，解压后从 word/document.xml 里抽 <w:t> 文本
//   .doc          —— OLE2 复合文档（CFB），读 WordDocument 流的 FIB / 片段表
// 浏览器与 Node 都能用（Node 下挂到 globalThis.DOCS，测试直接取用）。
(function (root) {
  "use strict";

  // ============ 通用小工具 ============
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, "&");
  }

  // 收尾清理：去掉 Word 字段控制符、零宽字符，压缩空行
  function tidy(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0013\u0014\u0015\u0007\u0000]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ============ DOCX ============
  const DOCX_ENTRY = "word/document.xml";

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("当前浏览器不支持解压 .docx，请升级浏览器或先把文件另存为 .txt");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 解析 zip 中央目录，返回条目表（顺便供“这到底是什么文件”的诊断用）
  function parseZip(u8) {
    let eocd = -1;
    const floor = Math.max(0, u8.length - 66000);
    for (let i = u8.length - 22; i >= floor; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("zip 结构不完整（找不到中央目录），文件可能已损坏或被截断");

    const count = u16(u8, eocd + 10);
    let p = u32(u8, eocd + 16);
    const entries = [];

    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length || u32(u8, p) !== 0x02014b50) break;

      const nameLen = u16(u8, p + 28);
      const extraLen = u16(u8, p + 30);
      const commentLen = u16(u8, p + 32);

      entries.push({
        name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)),
        method: u16(u8, p + 10),
        compSize: u32(u8, p + 20),
        localOffset: u32(u8, p + 42)
      });

      p += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
  }

  async function readZipEntries(u8, wanted) {
    const entries = parseZip(u8);
    const hit = entries.find((e) => e.name === wanted);
    if (!hit) return { data: null, names: entries.map((e) => e.name) };

    const localOffset = hit.localOffset;
    if (u32(u8, localOffset) !== 0x04034b50) throw new Error("zip 局部文件头损坏");

    const lhNameLen = u16(u8, localOffset + 26);
    const lhExtraLen = u16(u8, localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = u8.subarray(dataStart, dataStart + hit.compSize);

    let data;
    if (hit.method === 0) data = raw;
    else if (hit.method === 8) data = await inflateRaw(raw);
    else throw new Error("docx 使用了不支持的压缩方式：" + hit.method);

    return { data, names: entries.map((e) => e.name) };
  }

  // 从 OOXML 里抽正文：<w:t> 是文本，<w:tab/> <w:br/> </w:p> 是排版边界
  function ooxmlToText(xml) {
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>|<\/w:p>/g;
    let out = "";
    let m;

    while ((m = re.exec(xml))) {
      if (m[1] !== undefined) out += decodeEntities(m[1]);
      else if (m[0].indexOf("<w:tab") === 0) out += "\t";
      else out += "\n";
    }

    return tidy(out);
  }

  async function extractDocx(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const { data, names } = await readZipEntries(u8, DOCX_ENTRY);

    if (!data) {
      if (names.some((n) => n.startsWith("xl/"))) throw new Error("这看起来是 Excel 文件，不是 Word 文档");
      if (names.some((n) => n.startsWith("ppt/"))) throw new Error("这看起来是 PPT 文件，不是 Word 文档");
      throw new Error("这个 docx 里没有 word/document.xml，可能不是 Word 文档");
    }

    const text = ooxmlToText(new TextDecoder("utf-8").decode(data));
    if (!text) throw new Error("docx 里没有提取到文字（可能是纯图片或空的文档）");
    return text;
  }

  // ============ DOC（OLE2 / CFB） ============
  const END_OF_CHAIN = 0xfffffffe;

  function readCfb(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    for (let i = 0; i < 8; i++) {
      if (u8[i] !== sig[i]) throw new Error("不是 Word 97-2003 文档（缺少 OLE 头）");
    }

    const sectorSize = 1 << u16(u8, 30);
    const miniSize = 1 << u16(u8, 32);
    const numFatSectors = u32(u8, 44);
    const firstDirSector = u32(u8, 48);
    const miniCutoff = u32(u8, 56);
    const firstMiniFat = u32(u8, 60);
    const firstDifat = u32(u8, 68);

    const sector = (n) => {
      const start = (n + 1) * sectorSize;
      return u8.subarray(start, Math.min(start + sectorSize, u8.length));
    };

    // DIFAT → FAT 扇区号列表
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
      const v = u32(u8, 76 + i * 4);
      if (v < 0xfffffffa) fatSectors.push(v);
    }

    let difat = firstDifat;
    let guard = 0;
    while (difat < 0xfffffffa && guard++ < 4096) {
      const s = sector(difat);
      const per = sectorSize / 4 - 1;
      for (let i = 0; i < per; i++) {
        const v = u32(s, i * 4);
        if (v < 0xfffffffa) fatSectors.push(v);
      }
      difat = u32(s, sectorSize - 4);
    }

    // FAT 表
    const fat = [];
    const limit = numFatSectors || fatSectors.length;
    for (let k = 0; k < limit && k < fatSectors.length; k++) {
      const s = sector(fatSectors[k]);
      for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(s, i * 4));
    }

    const chain = (start, table) => {
      const out = [];
      let cur = start;
      let g = 0;
      while (cur < 0xfffffffa && cur < table.length && g++ < 1000000) {
        out.push(cur);
        cur = table[cur];
      }
      return out;
    };

    const readChain = (start, size) => {
      const secs = chain(start, fat);
      const out = new Uint8Array(secs.length * sectorSize);
      secs.forEach((s, i) => out.set(sector(s), i * sectorSize));
      return size != null ? out.subarray(0, Math.min(size, out.length)) : out;
    };

    // 目录项
    const dir = readChain(firstDirSector, null);
    const entries = [];
    for (let off = 0; off + 128 <= dir.length; off += 128) {
      const type = dir[off + 66];
      if (type === 0) continue;
      const nameLen = u16(dir, off + 64);
      const name = new TextDecoder("utf-16le").decode(
        dir.subarray(off, off + Math.max(0, nameLen - 2))
      );
      entries.push({ name, type, start: u32(dir, off + 116), size: u32(dir, off + 120) });
    }

    // 小流（< 4096 字节的流存在 root 的 mini stream 里）
    let miniStream = null;
    let miniFat = null;
    const rootEntry = entries.find((e) => e.type === 5);

    function loadMini() {
      if (miniFat) return;
      miniStream = rootEntry ? readChain(rootEntry.start, rootEntry.size) : new Uint8Array(0);
      miniFat = [];
      for (const s of chain(firstMiniFat, fat)) {
        for (let i = 0; i < sectorSize / 4; i++) miniFat.push(u32(sector(s), i * 4));
      }
    }

    return {
      names() {
        return entries.filter((e) => e.type === 2).map((e) => e.name);
      },
      getStream(name) {
        const e = entries.find((x) => x.type === 2 && x.name === name);
        if (!e) return null;

        if (e.size < miniCutoff) {
          loadMini();
          const out = new Uint8Array(e.size);
          let written = 0;
          for (const s of chain(e.start, miniFat)) {
            const chunk = miniStream.subarray(s * miniSize, (s + 1) * miniSize);
            out.set(chunk.subarray(0, Math.min(chunk.length, e.size - written)), written);
            written += chunk.length;
            if (written >= e.size) break;
          }
          return out;
        }

        return readChain(e.start, e.size);
      }
    };
  }

  function decodeTextRange(bytes, start, end, utf16) {
    const s = Math.max(0, start);
    const e = Math.min(end, bytes.length);
    if (e <= s) return "";
    const slice = bytes.subarray(s, e);
    if (utf16) return new TextDecoder("utf-16le").decode(slice);

    // 8 位压缩片段：基本是 cp1252 / 本地代码页，逐字节映射
    let out = "";
    for (let i = 0; i < slice.length; i++) {
      const b = slice[i];
      out += b < 0x80 ? String.fromCharCode(b) : String.fromCharCode(b);
    }
    return out;
  }

  function extractDoc(buffer) {
    const cfb = readCfb(buffer);
    const wd = cfb.getStream("WordDocument");
    if (!wd) throw new Error("这是 OLE 文件，但里面没有 WordDocument 流（不是 Word 文档？）");
    if (wd.length < 0x20) throw new Error("Word 文档头太短，无法解析");
    if (u16(wd, 0) !== 0xa5ec) throw new Error("不是 Word 97-2003 文档（FIB 魔数不符）");

    const flags = u16(wd, 0x0a);
    const fComplex = (flags & 0x0004) !== 0;
    const fExtChar = (flags & 0x1000) !== 0;
    const whichTable = (flags & 0x0200) !== 0 ? "1Table" : "0Table";

    let text = "";

    if (!fComplex) {
      // 简单文档：直接按 fcMin..fcMac 取
      text = decodeTextRange(wd, u32(wd, 0x18), u32(wd, 0x1c), fExtChar);
    } else {
      // 复杂文档（Word 97+ 常态）：走片段表
      const table = cfb.getStream(whichTable);
      const fcClx = u32(wd, 0x01a2);
      const lcbClx = u32(wd, 0x01a6);

      if (!table || !lcbClx || fcClx + lcbClx > table.length) {
        // 兜底：按 fcMin..fcMac 猜
        text = decodeTextRange(wd, u32(wd, 0x18), u32(wd, 0x1c), fExtChar);
      } else {
        let p = fcClx;
        const end = fcClx + lcbClx;
        let pcdtStart = -1;
        let pcdtLen = 0;

        while (p < end) {
          const kind = table[p];
          if (kind === 0x01) {
            p += 3 + u16(table, p + 1); // 跳过 Prc
          } else if (kind === 0x02) {
            pcdtLen = u32(table, p + 1);
            pcdtStart = p + 5;
            break;
          } else {
            break;
          }
        }

        if (pcdtStart < 0 || pcdtLen < 4) {
          text = decodeTextRange(wd, u32(wd, 0x18), u32(wd, 0x1c), fExtChar);
        } else {
          const n = Math.floor((pcdtLen - 4) / 12); // 每段：4 字节 CP + 8 字节 PCD
          const pcdBase = pcdtStart + 4 * (n + 1);

          for (let i = 0; i < n; i++) {
            const cpStart = u32(table, pcdtStart + 4 * i);
            const cpEnd = u32(table, pcdtStart + 4 * (i + 1));
            const len = cpEnd - cpStart;
            if (len <= 0) continue;

            const fcRaw = u32(table, pcdBase + 8 * i + 2);
            if (fcRaw & 0x40000000) {
              // 压缩片段：8 位，字符数 = 字节数
              const fc = (fcRaw & 0x3fffffff) >>> 1;
              text += decodeTextRange(wd, fc, fc + len, false);
            } else {
              const fc = fcRaw & 0x3fffffff;
              text += decodeTextRange(wd, fc, fc + len * 2, true);
            }
          }
        }
      }
    }

    const cleaned = tidy(text);
    if (!cleaned) throw new Error("没有提取到文字，请把 .doc 另存为 .docx 后重试");
    return cleaned;
  }

  // ============ 对外接口 ============
  const WORD_DOCX_MIME = /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\./i;
  const WORD_DOC_MIME = /^application\/(msword|vnd\.ms-word)/i;

  // 返回 "docx" | "doc" | null（null = 不是 Word 文档）
  function detectWordKind(name, mime) {
    const n = String(name || "").toLowerCase();
    if (/\.docx$/.test(n)) return "docx";
    if (/\.docm$/.test(n)) return "docx";
    if (/\.doc$/.test(n)) return "doc";
    if (mime && WORD_DOCX_MIME.test(mime)) return "docx";
    if (mime && WORD_DOC_MIME.test(mime)) return "doc";
    return null;
  }

  // 只看文件头判断容器类型，不信扩展名（改名、加密都会让扩展名说谎）
  function sniffContainer(u8) {
    if (u8.length >= 4) {
      const pk = u8[0] === 0x50 && u8[1] === 0x4b;
      const okLocal = u8[2] === 0x03 && u8[3] === 0x04;
      const okEmpty = u8[2] === 0x05 && u8[3] === 0x06;
      const okSpan = u8[2] === 0x07 && u8[3] === 0x08;
      if (pk && (okLocal || okEmpty || okSpan)) return "zip";
    }

    if (
      u8.length >= 8 &&
      u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0 &&
      u8[4] === 0xa1 && u8[5] === 0xb1 && u8[6] === 0x1a && u8[7] === 0xe1
    ) {
      return "cfb";
    }

    const head = new TextDecoder("utf-8")
      .decode(u8.subarray(0, Math.min(1024, u8.length)))
      .replace(/^\uFEFF/, "")
      .trimStart();

    if (head.startsWith("<")) return "xml";
    return "unknown";
  }

  function hexHead(u8, n = 8) {
    return Array.from(u8.subarray(0, Math.min(n, u8.length)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
  }

  async function extractWord(buffer, kind) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!u8.length) throw new Error("文件是空的");

    const container = sniffContainer(u8);

    // 1) 正常 docx / docm
    if (container === "zip") return await extractDocx(u8);

    // 2) OLE2 容器：可能是真 .doc，也可能是加密 Office 文档，还可能是 Excel/PPT 改名
    if (container === "cfb") {
      const cfb = readCfb(u8);
      const names = cfb.names();

      if (names.includes("EncryptionInfo") || names.includes("EncryptedPackage")) {
        throw new Error("这个文档设了打开密码（加密的 Office 文件），请先在 Word 里去掉密码再上传");
      }
      if (names.includes("WordDocument")) {
        // .doc 改成了 .docx，或者本来就是 .doc——统一走 doc 解析
        return extractDoc(u8);
      }
      if (names.includes("Workbook") || names.includes("Book")) {
        throw new Error("这看起来是 Excel 文件（.xls），不是 Word 文档");
      }
      if (names.includes("PowerPoint Document")) {
        throw new Error("这看起来是 PPT 文件（.ppt），不是 Word 文档");
      }
      throw new Error("这是 OLE 文档，但里面没有 Word 正文，可能不是 Word 文件");
    }

    // 3) Word 2003 XML（.xml / 伪装成 .doc 的 XML）
    if (container === "xml") {
      const xml = new TextDecoder("utf-8").decode(u8).replace(/^\uFEFF/, "");
      if (xml.indexOf("<w:body") === -1 && xml.indexOf("<w:wordDocument") === -1) {
        throw new Error("这是 XML 文件，但不是 Word 文档（找不到 w:body）");
      }
      const text = ooxmlToText(xml);
      if (!text) throw new Error("Word XML 里没有提取到文字");
      return text;
    }

    throw new Error(
      `无法识别这个文件的格式（文件头 ${hexHead(u8)}），请用 Word 另存为 .docx 后重试`
    );
  }

  const api = {
    detectWordKind,
    extractWord,
    extractDocx,
    extractDoc,
    ooxmlToText,
    sniffContainer
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DOCS = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
