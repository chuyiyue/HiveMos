// 纯 store（不压缩）的 zip 写入器，给 WebDAV 目标把整棵目录树打成一个包。
//
// 为什么不用第三方库：Workers 里能用的压缩只有 CompressionStream 的 gzip /
// deflate，没有 zip 容器；引一个 npm 包（fflate 等）会新增构建依赖，而 v1
// 只需要一个能 PUT 上云的包。store 模式零依赖、字节可预期，代价是体积约等于
// 原文件之和（配置包是纯文本，量级在几十 KB 到几 MB）。这是有意取舍，报告
// 里已注明。
//
// 结构与常见 zip 一致：每个文件一条 local file header + 数据，末尾 central
// directory + EOCD，文件名按 UTF-8 写（general purpose bit 11）。

export interface ZipInput {
  path: string;
  text: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

export function zipStore(files: ZipInput[], at: Date): Uint8Array {
  const encoder = new TextEncoder();
  const stamp = dosStamp(at);
  const entries = files.map((file) => {
    const name = encoder.encode(file.path.replace(/\\/g, "/"));
    const data = encoder.encode(file.text);
    return { name, data, crc: crc32(data) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const entry of entries) {
    localSize += 30 + entry.name.length + entry.data.length;
    centralSize += 46 + entry.name.length;
  }
  const total = localSize + centralSize + 22;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (const entry of entries) {
    u32(view, offset, 0x04034b50);
    u16(view, offset + 4, 20); // version needed
    u16(view, offset + 6, 0x0800); // UTF-8 file name
    u16(view, offset + 8, 0); // store
    u16(view, offset + 10, stamp.time);
    u16(view, offset + 12, stamp.date);
    u32(view, offset + 14, entry.crc);
    u32(view, offset + 18, entry.data.length);
    u32(view, offset + 22, entry.data.length);
    u16(view, offset + 26, entry.name.length);
    u16(view, offset + 28, 0);
    out.set(entry.name, offset + 30);
    out.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }

  const centralOffset = offset;
  for (const entry of entries) {
    u32(view, offset, 0x02014b50);
    u16(view, offset + 4, 20); // version made by
    u16(view, offset + 6, 20); // version needed
    u16(view, offset + 8, 0x0800);
    u16(view, offset + 10, 0);
    u16(view, offset + 12, stamp.time);
    u16(view, offset + 14, stamp.date);
    u32(view, offset + 16, entry.crc);
    u32(view, offset + 20, entry.data.length);
    u32(view, offset + 24, entry.data.length);
    u16(view, offset + 28, entry.name.length);
    u16(view, offset + 30, 0); // extra
    u16(view, offset + 32, 0); // comment
    u16(view, offset + 34, 0); // disk
    u16(view, offset + 36, 0); // internal attrs
    u32(view, offset + 38, 0); // external attrs
    u32(view, offset + 42, 0); // local header offset, filled in below
    offset += 46 + entry.name.length;
  }

  // Central directory local-header offsets, filled in a second pass so the
  // loop above stays readable.
  let dataOffset = 0;
  let centralCursor = centralOffset;
  for (const entry of entries) {
    u32(view, centralCursor + 42, dataOffset);
    out.set(entry.name, centralCursor + 46);
    dataOffset += 30 + entry.name.length + entry.data.length;
    centralCursor += 46 + entry.name.length;
  }

  offset = centralCursor;
  u32(view, offset, 0x06054b50);
  u16(view, offset + 4, 0);
  u16(view, offset + 6, 0);
  u16(view, offset + 8, entries.length);
  u16(view, offset + 10, entries.length);
  u32(view, offset + 12, centralSize);
  u32(view, offset + 16, centralOffset);
  u16(view, offset + 20, 0);
  return out;
}
