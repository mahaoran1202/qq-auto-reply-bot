/**
 * 最小 ZIP 打包器（纯 Node，不依赖任何外部库/命令）。
 *
 * 为什么自己写：
 *   PowerShell 的 Compress-Archive 在遇到中文路径时会崩（0xC0000409）。
 *   Node 的 zlib 自带 deflate，自己拼 ZIP 结构最稳。
 *
 * 为什么是异步流式：
 *   压缩一个 89 MB 的 node.exe 时，`deflateRawSync(wholeBuffer)` 会在 zlib 内部
 *   一次性申请整块输出缓冲，直接抛 `RangeError: Array buffer allocation failed`。
 *   所以这里改成 createReadStream → createDeflateRaw 逐块喂，CRC 也是增量算的。
 *   峰值内存只跟「压缩后的体积」有关（node.exe 约 28 MB），跟原文件多大无关。
 *
 * 只实现打包需要的部分：store/deflate、无加密、支持 UTF-8 文件名。
 */
import { createDeflateRaw, deflateRawSync } from 'node:zlib';
import { createReadStream, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** CRC32 查表 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 增量 CRC：把已有的中间值 c 继续往后算 */
function crcUpdate(c, buf) {
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return c;
}

/** 递归收集文件 */
function walk(dir, base = dir, out = []) {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ full, rel: relative(base, full).replace(/\\/g, '/'), size: st.size });
  }
  return out;
}

/**
 * 流式压缩一个大文件：读一块 → 喂给 deflate → 收输出块。
 * 返回 { method, payload, size, crc }；payload 是压缩后的数据（或原始数据）。
 */
function deflateLarge(full, level, chunkSize = 1 << 20) {
  return new Promise((resolve, reject) => {
    const def = createDeflateRaw({ level });
    const out = [];
    let compressedBytes = 0;
    let crcState = 0 ^ -1;
    let size = 0;

    def.on('data', (c) => { out.push(c); compressedBytes += c.length; });
    def.on('error', reject);

    const rs = createReadStream(full, { highWaterMark: chunkSize });
    rs.on('error', reject);

    rs.on('data', (chunk) => {
      crcState = crcUpdate(crcState, chunk);
      size += chunk.length;
      if (!def.write(chunk)) { rs.pause(); def.once('drain', () => rs.resume()); }
    });
    rs.on('end', () => def.end());

    def.on('end', () => {
      const payload = Buffer.concat(out, compressedBytes);
      resolve({ method: 8, payload, size, crc: (crcState ^ -1) >>> 0 });
    });
  });
}

/**
 * 打包一个目录为 zip。
 * @param {string} srcDir 源目录
 * @param {string} outZip 输出 zip 路径
 * @param {{level?:number, rootPrefix?:string, onProgress?:function}} opts
 *        rootPrefix: 在 zip 内加一层顶层目录名
 *        onProgress(done, total, rel): 每个文件处理完回调一次
 */
export async function zipDir(srcDir, outZip, opts = {}) {
  const level = opts.level ?? 9;
  const prefix = opts.rootPrefix ? String(opts.rootPrefix).replace(/\/+$/, '') + '/' : '';
  const files = walk(srcDir);

  const chunks = [];
  const central = [];
  let offset = 0;

  let done = 0;
  for (const f of files) {
    let method = 0;
    let payload;
    let crc;
    let rawSize = f.size;

    if (f.size > 16 * 1024 * 1024) {
      // 大文件走流式，避免一次性分配
      const r = await deflateLarge(f.full, level);
      method = r.method; payload = r.payload; crc = r.crc; rawSize = r.size;
    } else {
      const data = readFileSync(f.full);
      rawSize = data.length;
      crc = crc32(data);
      if (level > 0 && data.length > 64) {
        const def = deflateRawSync(data, { level });
        if (def.length < data.length) { method = 8; payload = def; }
        else { method = 0; payload = data; }
      } else {
        payload = data;
      }
    }

    const nameBuf = Buffer.from(prefix + f.rel, 'utf8');

    // 本地文件头
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // 版本
    local.writeUInt16LE(0x0800, 6);          // 标志：UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);              // 时间
    local.writeUInt16LE(0x21, 12);           // 日期（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(rawSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // 扩展区长度

    chunks.push(local, nameBuf, payload);

    // 中央目录项
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);                // 创建版本
    cen.writeUInt16LE(20, 6);                // 需要版本
    cen.writeUInt16LE(0x0800, 8);            // UTF-8
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(rawSize, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);                // 外部属性
    cen.writeUInt32LE(offset, 42);           // 本地头偏移
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;

    done++;
    if (opts.onProgress) opts.onProgress(done, files.length, f.rel);
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  // 中央目录结束记录
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);                  // 注释长度

  const zip = Buffer.concat([...chunks, centralBuf, end], centralOffset + centralBuf.length + 22);
  writeFileSync(outZip, zip);

  return { files: files.length, bytes: zip.length };
}
