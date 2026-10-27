// test/fixtures.mjs —— 用代码构造真实的 docx（zip）与 doc（OLE2/CFB）样本
import { deflateRawSync } from "node:zlib";

const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// ---------- ZIP ----------
export function makeZip(files, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data, "utf8");
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const localOffset = offset;

    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16le(20), u16le(0), u16le(method), u16le(0), u16le(0),
      u32le(0), u32le(data.length), u32le(raw.length),
      u16le(nameBuf.length), u16le(0),
      nameBuf, data
    ]);

    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16le(20), u16le(20), u16le(0), u16le(method), u16le(0), u16le(0),
      u32le(0), u32le(data.length), u32le(raw.length),
      u16le(nameBuf.length), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(0), u32le(localOffset),
      nameBuf
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16le(0), u16le(0), u16le(files.length), u16le(files.length),
    u32le(cd.length), u32le(offset), u16le(0)
  ]);

  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

// ---------- DOCX ----------
export function docxXml(...paragraphs) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

export function makeDocx(paragraphs, opts = {}) {
  return makeZip([{ name: "word/document.xml", data: docxXml(...paragraphs) }], opts);
}

// ---------- DOC (OLE2 / CFB) ----------
const SEC = 512;
const END = 0xfffffffe;

function cfbHeader({ numFat, firstDir, firstMiniFat = END, firstDifat = END }) {
  const h = Buffer.alloc(SEC, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(h, 0);
  h.writeUInt16LE(0x003e, 24);
  h.writeUInt16LE(0x0003, 26);
  h.writeUInt16LE(0xfffe, 28);
  h.writeUInt16LE(9, 30);   // 512 字节扇区
  h.writeUInt16LE(6, 32);   // 64 字节小扇区
  h.writeUInt32LE(numFat, 44);
  h.writeUInt32LE(firstDir, 48);
  h.writeUInt32LE(4096, 56); // miniCutoff
  h.writeUInt32LE(firstMiniFat, 60);
  h.writeUInt32LE(0, 64);
  h.writeUInt32LE(firstDifat, 68);
  h.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) h.writeUInt32LE(0xffffffff, 76 + i * 4);
  h.writeUInt32LE(0, 76); // DIFAT[0] = 扇区 0（FAT 本身）
  return h;
}

function dirEntry(name, type, start, size) {
  const b = Buffer.alloc(128, 0);
  const n = Buffer.from(name, "utf16le");
  n.copy(b, 0);
  b.writeUInt16LE(n.length + 2, 64);
  b[66] = type;
  b[67] = 1;
  b.writeUInt32LE(start >>> 0, 116);
  b.writeUInt32LE(size >>> 0, 120);
  return b;
}

function fatSector(entries) {
  const s = Buffer.alloc(SEC, 0xff);
  for (let i = 0; i < entries.length; i++) s.writeUInt32LE(entries[i] >>> 0, i * 4);
  return s;
}

function dirSector(entries) {
  const b = Buffer.concat(entries);
  if (b.length > SEC) throw new Error("目录超过一个扇区");
  return Buffer.concat([b, Buffer.alloc(SEC - b.length)]);
}

// 通用：构造一个含任意命名流的 CFB（每个流 4096 字节，走普通扇区）
export function buildCfbStreams(names) {
  const SEC = 512;
  const END = 0xfffffffe;
  const perStream = 8; // 4096 / 512
  const dirSectors = Math.ceil((1 + names.length) / 4);
  const total = 1 + dirSectors + names.length * perStream;

  const fat = new Array(total).fill(END);
  fat[0] = 0xfffffffd;
  for (let i = 0; i < dirSectors; i++) {
    fat[1 + i] = i === dirSectors - 1 ? END : 2 + i;
  }

  const starts = [];
  let cur = 1 + dirSectors;
  for (let s = 0; s < names.length; s++) {
    starts.push(cur);
    for (let k = 0; k < perStream; k++) {
      fat[cur] = k === perStream - 1 ? END : cur + 1;
      cur++;
    }
  }

  const entries = [dirEntry("Root Entry", 5, END, 0)];
  names.forEach((nm, i) => entries.push(dirEntry(nm, 2, starts[i], perStream * SEC)));

  const dirBuf = Buffer.alloc(dirSectors * SEC);
  entries.forEach((e, i) => e.copy(dirBuf, i * 128));

  const parts = [cfbHeader({ numFat: 1, firstDir: 1 }), fatSector(fat), dirBuf];
  for (let s = 0; s < names.length; s++) parts.push(Buffer.alloc(perStream * SEC));

  return new Uint8Array(Buffer.concat(parts));
}

// 简单文档：fComplex = 0，正文直接放在 fcMin..fcMac
export function buildSimpleDoc(text) {
  const FC_MIN = 1024;
  const txt = Buffer.from(text, "utf16le");

  const wd = Buffer.alloc(4096, 0);
  wd.writeUInt16LE(0xa5ec, 0);
  wd.writeUInt16LE(0x1000, 0x0a); // fExtChar = 1（UTF-16LE）
  wd.writeUInt32LE(FC_MIN, 0x18);
  wd.writeUInt32LE(FC_MIN + txt.length, 0x1c);
  txt.copy(wd, FC_MIN);

  // 扇区：0 FAT / 1 目录 / 2..9 WordDocument
  const fat = [0xfffffffd, END, 3, 4, 5, 6, 7, 8, 9, END];
  const dir = dirSector([
    dirEntry("Root Entry", 5, END, 0),
    dirEntry("WordDocument", 2, 2, 4096)
  ]);

  return new Uint8Array(
    Buffer.concat([cfbHeader({ numFat: 1, firstDir: 1 }), fatSector(fat), dir, wd])
  );
}

// 复杂文档：fComplex = 1，正文偏移写在 1Table 的片段表里；1Table 走小流(mini stream)
export function buildComplexDoc(text) {
  const FC_TEXT = 2048;
  const txt = Buffer.from(text, "utf16le");
  const charLen = text.length;

  const wd = Buffer.alloc(4096, 0);
  wd.writeUInt16LE(0xa5ec, 0);
  wd.writeUInt16LE(0x1204, 0x0a); // fComplex | fWhichTblStm | fExtChar
  wd.writeUInt32LE(FC_TEXT, 0x18);
  wd.writeUInt32LE(FC_TEXT + txt.length, 0x1c);
  txt.copy(wd, FC_TEXT);

  // CLX：0x02 + lcb + (n+1 个 CP) + n 个 PCD（fc 在 PCD 的第 2 字节）
  const lcb = 4 * 2 + 8; // 1 段
  const clx = Buffer.alloc(1 + 4 + lcb, 0);
  clx.writeUInt8(0x02, 0);
  clx.writeUInt32LE(lcb, 1);
  // PlcPcd 从第 5 字节开始：2 个 CP（8 字节）+ 1 个 PCD（8 字节）
  clx.writeUInt32LE(0, 5);          // CP[0]
  clx.writeUInt32LE(charLen, 9);    // CP[1]
  clx.writeUInt32LE(FC_TEXT, 13 + 2); // PCD.fc

  wd.writeUInt32LE(0, 0x01a2);       // fcClx = 0（表流起点）
  wd.writeUInt32LE(clx.length, 0x01a6); // lcbClx

  // 扇区：0 FAT / 1 目录 / 2..9 WordDocument / 10 miniFAT / 11..12 mini stream
  const fat = [
    0xfffffffd, END, 3, 4, 5, 6, 7, 8, 9, END, // 0..9
    END, 12, END                                // 10 miniFAT / 11-12 mini stream
  ];

  const miniFat = Buffer.alloc(SEC, 0xff);
  miniFat.writeUInt32LE(END, 0);

  const miniStream = Buffer.alloc(1024, 0);
  clx.copy(miniStream, 0);

  const dir = dirSector([
    dirEntry("Root Entry", 5, 11, 1024),
    dirEntry("WordDocument", 2, 2, 4096),
    dirEntry("1Table", 2, 0, clx.length)
  ]);

  return new Uint8Array(
    Buffer.concat([
      cfbHeader({ numFat: 1, firstDir: 1, firstMiniFat: 10 }),
      fatSector(fat),
      dir,
      wd,
      miniFat,
      miniStream
    ])
  );
}
