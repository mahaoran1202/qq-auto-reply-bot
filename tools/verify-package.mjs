/**
 * 分享包验收脚本 —— 打完包之后跑一遍，确认这个 zip 是能用的。
 *
 *   node tools/verify-package.mjs
 *
 * 它做四件事：
 *   1. 解 zip 的结构层（自己扫 EOCD + 中央目录，逐条 inflate 并重算 CRC32）
 *   2. 解压到临时目录，检查顶层结构
 *   3. 包内所有 .js/.mjs/.cjs 过一遍 node --check
 *   4. 隐私泄漏扫描（API Key / 个人 QQ 号 / 本机 token / 不该存在的文件）
 *
 * 退出码 0 = 全过，1 = 有项目不通过。
 */
import { readFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ZIP = join(ROOT, 'QQ自动回复机器人-分享版.zip');
const PKG_NAME = 'QQ自动回复机器人-分享版';
// 解压到纯 ASCII 的临时目录（中文路径上某些 API 会出问题）
const TMP = join(tmpdir(), 'qqbot-verify');

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

/* ---------------- CRC32 ---------------- */
const TBL = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- 1. ZIP 结构 ---------------- */
console.log('=== 1. ZIP 结构 ===');
if (!existsSync(ZIP)) { bad(`找不到 ${ZIP}，先跑 node tools/make-share-package.mjs`); process.exit(1); }
const zbuf = readFileSync(ZIP);
let eocd = -1;
for (let i = zbuf.length - 22; i >= 0; i--) {
  if (zbuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { bad('找不到 EOCD'); process.exit(1); }
const total = zbuf.readUInt16LE(eocd + 10);
const cdSize = zbuf.readUInt32LE(eocd + 12);
const cdOff = zbuf.readUInt32LE(eocd + 16);
console.log(`  条目数 ${total} / CD 偏移 ${cdOff} / CD 大小 ${cdSize} / EOCD ${eocd}`);
if (cdOff + cdSize !== eocd) bad(`中央目录末尾(${cdOff + cdSize}) 与 EOCD(${eocd}) 不吻合`);

let p = cdOff, crcOk = 0, utf8Ok = 0, badName = 0;
const tops = new Set();
for (let n = 0; n < total; n++) {
  if (zbuf.readUInt32LE(p) !== 0x02014b50) { bad(`第 ${n} 条中央目录签名错误`); break; }
  const flag = zbuf.readUInt16LE(p + 8);
  const method = zbuf.readUInt16LE(p + 10);
  const crcRec = zbuf.readUInt32LE(p + 16);
  const csize = zbuf.readUInt32LE(p + 20);
  const usize = zbuf.readUInt32LE(p + 24);
  const nlen = zbuf.readUInt16LE(p + 28);
  const elen = zbuf.readUInt16LE(p + 30);
  const clen = zbuf.readUInt16LE(p + 32);
  const lho = zbuf.readUInt32LE(p + 42);
  const name = zbuf.slice(p + 46, p + 46 + nlen).toString('utf8');
  if (flag & 0x0800) utf8Ok++;
  tops.add(name.split('/')[0]);
  if (name.includes('\uFFFD')) badName++;
  if (zbuf.readUInt32LE(lho) !== 0x04034b50) bad(`${name} 本地头签名错误`);
  const lnlen = zbuf.readUInt16LE(lho + 26);
  const lelen = zbuf.readUInt16LE(lho + 28);
  const data = zbuf.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
  let raw;
  try { raw = method === 0 ? data : inflateRawSync(data); }
  catch (e) { bad(`${name} 解压失败: ${e.message}`); p += 46 + nlen + elen + clen; continue; }
  if (raw.length !== usize) bad(`${name} 长度不符 ${raw.length} != ${usize}`);
  if (crc32(raw) !== crcRec) bad(`${name} CRC 不符`);
  else crcOk++;
  p += 46 + nlen + elen + clen;
}
if (crcOk === total) ok(`CRC 校验 ${crcOk}/${total} 全部通过`);
if (utf8Ok === total) ok(`UTF-8 标志位 ${utf8Ok}/${total} 全部置位`);
if (badName === 0) ok('文件名无替换字符');
if (tops.size === 1 && tops.has(PKG_NAME)) ok(`顶层目录唯一: ${[...tops][0]}`);
else bad(`顶层目录异常: ${[...tops].join(', ')}`);

/* ---------------- 2. 解压 + 结构 ---------------- */
console.log('');
console.log('=== 2. 解压与结构 ===');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const tar = spawnSync('tar.exe', ['-xf', ZIP, '-C', TMP], { stdio: 'ignore' });
if (tar.status !== 0) { bad('tar 解压失败'); process.exit(1); }
const PKG = join(TMP, PKG_NAME);
if (!existsSync(PKG)) { bad('解压后找不到顶层目录'); process.exit(1); }
const required = [
  '一键启动.bat',
  '第一次用点我.bat', 'setup.bat', '_node.bat', 'start.bat', 'open-panel.bat',
  'force-stop.bat', 'restart-qq-napcat.bat', 'authorize-autorestart.bat', 'fix-napcat.bat',
  'napcat-launcher-autologin.bat', 'README.md', '脚本对照表.md', '面板使用说明.md',
  'config.example.json', 'package.json',
  'runtime/node/node.exe', 'node_modules/ws/package.json',
  'napcat/NapCatWinBootMain.exe', 'napcat/napcat.mjs', 'napcat/static/index.html',
  'public/index.html', 'tools/setup.mjs', 'src/bot.js', 'src/web-ui.js',
];
const missing = required.filter((f) => !existsSync(join(PKG, f)));
if (missing.length) missing.forEach((f) => bad(`缺少 ${f}`));
else ok(`${required.length} 个必需文件/目录全部存在`);

function walk(d, out = []) {
  for (const f of readdirSync(d)) {
    const full = join(d, f);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const all = walk(PKG);
ok(`共 ${all.length} 个文件 / ${(all.reduce((s, f) => s + statSync(f).size, 0) / 1048576).toFixed(1)} MB`);
// 原生模块只应保留 Windows x64
const foreign = all.filter((f) => /[\\/]native[\\/]/.test(f) && /darwin|linux|win32-arm64/i.test(f));
if (foreign.length) bad(`native/ 里还剩 ${foreign.length} 个非 Windows 模块`);
else ok('napcat/native/ 只保留 Windows x64');

/* ---------------- 3. 语法检查 ---------------- */
console.log('');
console.log('=== 3. 包内 JS 语法 ===');
const jsFiles = all.filter((f) => /\.(js|mjs|cjs)$/.test(f) && !f.includes(`${'node_modules'}`));
let synFail = 0;
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'ignore' });
  if (r.status !== 0) { bad(`语法错误: ${relative(PKG, f)}`); synFail++; }
}
if (synFail === 0) ok(`检查 ${jsFiles.length} 个文件，失败 0 个`);

/* ---------------- 4. 隐私扫描 ---------------- */
console.log('');
console.log('=== 4. 隐私泄漏扫描 ===');
const SCAN = ['.js', '.json', '.html', '.mjs', '.md', '.bat', '.txt', '.ps1', '.yml'];
const BAD_QQ = ['3894443054', '1764946482'];       // 开发机上的机器人号 / 主人号
const BAD_KEY = /sk-[a-zA-Z0-9]{20,}/;
const BAD_TOKEN = /cb4dd7de4a83/;                   // 开发机 NapCat WebUI token
const hits = [];
for (const f of all) {
  if (!SCAN.some((e) => f.endsWith(e))) continue;
  const t = readFileSync(f, 'latin1');              // bat 可能是 GBK，latin1 最保真
  for (const q of BAD_QQ) if (t.includes(q)) hits.push(`${relative(PKG, f)} 含个人 QQ 号 ${q}`);
  if (BAD_KEY.test(t)) hits.push(`${relative(PKG, f)} 含疑似 API Key`);
  if (BAD_TOKEN.test(t)) hits.push(`${relative(PKG, f)} 含本机 NapCat token`);
}
const FORBID = [
  'config.json', 'napcat/launcher-autologin.bat', 'records/掉线诊断.log',
  'napcat/guild1.db', 'napcat/guild1.db-wal', 'napcat/guild1.db-shm',
  'napcat/config/passkey.json', 'napcat/config/webui.json', 'napcat/cache/qrcode.png',
];
for (const f of FORBID) if (existsSync(join(PKG, f))) hits.push(`不该存在的文件: ${f}`);
// 不应残留任何 <QQ号>.json 形式的 NapCat 个人配置
const personal = all.filter((f) => /napcat[\\/]config[\\/](napcat|onebot11|napcat_protocol)_\d+\.json/.test(f));
for (const f of personal) hits.push(`NapCat 个人配置: ${relative(PKG, f)}`);
if (hits.length === 0) ok('没有 API Key / 个人 QQ 号 / 本机 token / 隐私文件');
else hits.forEach(bad);

rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log(fail === 0 ? '✓ 验收全部通过。' : `✗ 有 ${fail} 项不通过。`);
process.exit(fail === 0 ? 0 : 1);
