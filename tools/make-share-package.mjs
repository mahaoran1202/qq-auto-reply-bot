/**
 * 打包「开箱即用版」分享包。
 *
 * 和以前的纯源码包不同，这个包内置了：
 *   · 免安装的 Node.js（runtime/node/node.exe）—— 对方电脑没装 Node 也能跑
 *   · 精简过的 NapCat（napcat/）—— 只留 Windows x64 的原生模块，体积减 88MB
 *   · 预装好的 node_modules/ws —— 对方不用跑 npm install
 *   · 第一次用点我.bat / setup.bat —— 一键自检 + 问答式配置
 *
 * 依然不含：API Key、QQ 号、聊天记录、表情包、登录态、数据库。
 *
 * ⚠️ 两个必须遵守的坑（都实测踩过）：
 *   1. 暂存目录必须用**纯 ASCII** 名字。这台机器上 `fs.cpSync(..., {recursive:true})`
 *      遇到「中文 + 连字符」的目标路径会直接 0xC0000409 硬崩（连 catch 都进不去）。
 *      所以：暂存目录叫 pkg，中文包名只作为 zip 里的顶层目录前缀（rootPrefix）。
 *   2. 所有复制一律用 copyFileSync 逐文件做，**不要**用 cpSync 的 recursive。
 *      实测同一棵树、同样 8 个中文名，逐文件复制 8/8 成功，cpSync recursive 崩 3 个。
 */
import {
  existsSync, mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync,
  statSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDir } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, '_share_build');
const STAGE_NAME = 'pkg';                       // 纯 ASCII（见文件头坑 1）
const PKG_NAME = 'QQ自动回复机器人-分享版';        // zip 内顶层目录名 / 压缩包名
const PKG_DIR = resolve(OUT_DIR, STAGE_NAME);
const ZIP = resolve(ROOT, `${PKG_NAME}.zip`);

// ---- 外部素材（官方下载解压后的干净副本）----
const VENDOR = process.env.QQBOT_VENDOR || 'E:\\dsh\\_pkgdl';
const NODE_DIR = process.env.QQBOT_NODE_DIR || 'node-v24.22.0-win-x64';
const NODE_EXE_SRC = resolve(VENDOR, process.env.QQBOT_NODE_EXTRACT || 'node_extract', NODE_DIR, 'node.exe');
const NAPCAT_SRC = resolve(VENDOR, 'napcat_extract');

// ---- 要打包的内容（全部用明确文件名，避免通配符匹配出错）----
const COPY_PLAN = [
  { dir: 'src', match: (f) => f.endsWith('.js') },
  { dir: 'public', match: (f) => f === 'index.html' },
  { dir: 'tools', match: (f) => (f.endsWith('.mjs') || f.endsWith('.ps1')) && f !== 'make-share-package.mjs' && f !== 'zip.mjs' && f !== 'verify-package.mjs' },
  { dir: '', match: (f) => [
    '一键启动.bat',
    'start.bat', 'open-panel.bat', 'force-stop.bat', 'fix-napcat.bat',
    'restart-qq-napcat.bat', 'authorize-autorestart.bat',
    'setup.bat', '_node.bat', '第一次用点我.bat',
    'napcat-launcher-autologin.bat',
    'package.json', '面板使用说明.md', '脚本对照表.md',
  ].includes(f) },
];

/** 明确排除的（个人数据 / 体积大） */
const EXCLUDE_PATTERNS = [
  /^config\.json$/,
  /^config\.[^.]*\.json$/,
  /_share_/,
  /_vendor/,
  /_pkgdl/,
  /_probe/,
  /_tmp/,
  /\.log$/,
  /\.err$/,
  /^make-share-package\.mjs$/,
  /^config\.example\.json$/,        // 单独复制成包里的 config.example.json
  /^README\.md$/,                   // 单独复制成包里的 README.md
  /^zip\.mjs$/,
];

const shouldExclude = (name) => EXCLUDE_PATTERNS.some((re) => re.test(name));

// ---- 复制工具（一律逐文件，不用 cpSync recursive）----
let fileCount = 0;
let totalBytes = 0;

function put(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  fileCount++;
  try { totalBytes += statSync(dst).size; } catch { /* 忽略 */ }
}

/** 递归复制整棵树，返回 { files, bytes } */
function copyTree(src, dst) {
  let files = 0;
  let bytes = 0;
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    const d = join(dst, f);
    if (statSync(s).isDirectory()) {
      const r = copyTree(s, d);
      files += r.files; bytes += r.bytes;
    } else {
      copyFileSync(s, d);
      files++; bytes += statSync(d).size;
    }
  }
  return { files, bytes };
}

// ---- 前置检查 ----
const missing = [];
if (!existsSync(NODE_EXE_SRC)) missing.push(`Node: ${NODE_EXE_SRC}`);
if (!existsSync(NAPCAT_SRC)) missing.push(`NapCat: ${NAPCAT_SRC}`);
if (missing.length) {
  console.log('缺少外部素材，请先下载解压：');
  for (const m of missing) console.log('  ✗ ' + m);
  console.log('');
  console.log('下载命令（GitHub 直连下载会卡在 0 字节，必须走 ghproxy.net 前缀）：');
  console.log('  curl -L -o "' + join(VENDOR, 'node.zip') + '" https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip');
  console.log('  curl -L --retry 8 -o "' + join(VENDOR, 'napcat.zip') + '" https://ghproxy.net/https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.38/NapCat.Shell.zip');
  console.log('  tar -xf "' + join(VENDOR, 'node.zip') + '" -C "' + join(VENDOR, 'node_extract') + '"');
  console.log('  tar -xf "' + join(VENDOR, 'napcat.zip') + '" -C "' + NAPCAT_SRC + '"');
  console.log('');
  console.log('（解大 zip 一定要用 tar，PowerShell 的 Expand-Archive 会内存溢出崩掉。）');
  process.exit(1);
}

// ---- 1. 清理并创建目录 ----
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });
console.log('暂存目录:', PKG_DIR);
console.log('压缩包  :', ZIP);
console.log('');

// ---- 2. 复制源码文件 ----
console.log('=== 复制源码 ===');
for (const { dir: sub, match } of COPY_PLAN) {
  const srcDir = sub ? join(ROOT, sub) : ROOT;
  const dstDir = sub ? join(PKG_DIR, sub) : PKG_DIR;
  if (!existsSync(srcDir)) { console.log(`  跳过（不存在）: ${sub || '(root)'}`); continue; }
  mkdirSync(dstDir, { recursive: true });

  let copied = 0;
  for (const f of readdirSync(srcDir)) {
    let isFile = false;
    try { isFile = statSync(join(srcDir, f)).isFile(); } catch { continue; }
    if (!isFile) continue;
    if (shouldExclude(f)) continue;
    try { if (!match(f)) continue; } catch { continue; }
    put(join(srcDir, f), join(dstDir, f));
    copied++;
  }
  console.log(`  ${sub || '(root)'}: 复制 ${copied} 个`);
}

// ---- 3. 内置免安装 Node.js ----
console.log('');
console.log('=== 内置 Node.js ===');
{
  const dst = join(PKG_DIR, 'runtime', 'node', 'node.exe');
  put(NODE_EXE_SRC, dst);
  console.log(`  ✓ runtime/node/node.exe  ${(statSync(dst).size / 1048576).toFixed(2)} MB  (${NODE_DIR})`);
  const note = '\uFEFF这个文件夹里是压缩包自带的 Node.js 运行环境（只需要 node.exe）。\n' +
    '有它，对方电脑没装过 Node.js 也能直接跑机器人。\n\n' +
    '各脚本里的 _node.bat 会优先用它；如果它不见了，就退回用系统装的 node。\n';
  writeFileSync(join(PKG_DIR, 'runtime', '_说明.txt'), note, 'utf8');
  fileCount++;
}

// ---- 4. 预装依赖（免得对方跑 npm install）----
console.log('');
console.log('=== 预装依赖 ===');
{
  const src = join(ROOT, 'node_modules', 'ws');
  if (existsSync(src)) {
    const r = copyTree(src, join(PKG_DIR, 'node_modules', 'ws'));
    fileCount += r.files;
    totalBytes += r.bytes;
    console.log(`  ✓ node_modules/ws  ${r.files} 个文件`);
  } else {
    console.log('  ⚠ 本机没有 node_modules/ws，包里就没预装 —— 对方得自己 npm install');
  }
}

// ---- 5. 干净的 NapCat（只留 Windows x64）----
console.log('');
console.log('=== 内置 NapCat（Windows x64 精简版）===');
{
  // 原生模块文件名是运行时按 `process.platform + "." + process.arch` 拼出来的
  // （napcat.mjs 里 `"napi2native." + e + ".node"`），所以其它平台的全是死重量。
  const skip = (rel) => /darwin|linux/i.test(rel) || /win32-arm64/i.test(rel);
  let copied = 0, skipped = 0, bytes = 0;

  const walk = (rel) => {
    const s = rel ? join(NAPCAT_SRC, rel) : NAPCAT_SRC;
    const d = rel ? join(PKG_DIR, 'napcat', rel) : join(PKG_DIR, 'napcat');
    mkdirSync(d, { recursive: true });
    for (const f of readdirSync(s)) {
      const r = rel ? `${rel}/${f}` : f;
      const sp = join(NAPCAT_SRC, r);
      if (statSync(sp).isDirectory()) { walk(r); continue; }
      if (skip(r)) { skipped++; continue; }
      const dp = join(PKG_DIR, 'napcat', r);
      copyFileSync(sp, dp);
      copied++; bytes += statSync(dp).size;
    }
  };
  walk('');

  fileCount += copied;
  totalBytes += bytes;
  console.log(`  ✓ 复制 ${copied} 个文件，${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`  ✓ 跳过 ${skipped} 个非 Windows 平台的原生模块`);
}

// ---- 6. 写分享版专用文件 ----
put(resolve(ROOT, 'config.example.json'), join(PKG_DIR, 'config.example.json'));
put(resolve(ROOT, 'README.md'), join(PKG_DIR, 'README.md'));

// ---- 7. 创建空目录（带说明文件，保证能被解压出来）----
for (const [dir, note] of [
  ['stickers', '把表情包图片放进这个文件夹。\n\n支持三种命名方式（都会自动识别情绪）：\n  stickers/笑死/01.gif       ← 按文件夹名\n  stickers/无语.jpg          ← 按文件名\n  stickers/[生气]骂人.png    ← 方括号显式标签\n\n新丢进来的图会自动用 AI 打标签（结果缓存，不重复花钱）。\n'],
  ['notebooks', '机器人的小本本会存在这里（按 QQ 号一个文件）。\n\n记录每个人：记仇 / 记好 / 性格印象 / 事件。\n只认人不认环境，私聊和群聊共用。\n\n可以在控制台「⑥ 小本本」页查看和修改。\n'],
  ['records', '聊天记录会存在这里（录制功能开启时）。\n'],
  ['exports', '导出的聊天记录文本会放在这里。\n'],
]) {
  const d = join(PKG_DIR, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '_说明.txt'), '\uFEFF' + note, 'utf8');
  fileCount++;
}

// ---- 8. 安全检查 ----
console.log('');
console.log('=== 安全检查 ===');
const leaked = [];
const SCAN_EXT = ['.js', '.json', '.html', '.mjs', '.md', '.bat', '.txt', '.ps1'];
function scanForSecrets(dir) {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) { scanForSecrets(full); continue; }
    if (!SCAN_EXT.some((e) => f.endsWith(e))) continue;
    let content;
    try { content = readFileSync(full, 'latin1'); } catch { continue; }
    const keys = content.match(/sk-[a-zA-Z0-9]{20,}/g);
    if (keys) leaked.push(`${full.slice(PKG_DIR.length + 1)}: API Key ${keys.map((k) => k.slice(0, 10) + '...').join(', ')}`);
    if (/3894443054|1764946482/.test(content)) leaked.push(`${full.slice(PKG_DIR.length + 1)}: 包含你的 QQ 号`);
  }
}
scanForSecrets(PKG_DIR);
if (leaked.length) {
  console.log('⚠ 发现疑似个人数据:');
  for (const l of leaked) console.log('   ' + l);
} else {
  console.log('✓ 没有发现 API Key 或个人 QQ 号');
}

// 确认 NapCat 没把登录态 / 数据库带出来
const FORBIDDEN_NAPCAT = ['guild1.db', 'guild1.db-wal', 'guild1.db-shm', 'passkey.json', 'webui.json', 'cache/qrcode.png'];
for (const f of FORBIDDEN_NAPCAT) {
  if (existsSync(join(PKG_DIR, 'napcat', f))) leaked.push(`napcat/${f}: 不该出现在分享包里`);
}
const napcatConfigDir = join(PKG_DIR, 'napcat', 'config');
const strayConfigs = existsSync(napcatConfigDir)
  ? readdirSync(napcatConfigDir).filter((f) => /_(3894443054|1764946482)/.test(f))
  : [];
if (strayConfigs.length) leaked.push('napcat/config: 残留账号配置 ' + strayConfigs.join(', '));

// ---- 8b. bat 健康检查 ----
console.log('');
console.log('=== bat 健康检查 ===');
// 根目录的是我们自己写的，必须严格合规；
// napcat/ 里的是官方原样带的（官方用裸 LF，实测能正常启动），只提示不报错。
function checkBats(dir, prefix = '') {
  const upstream = prefix.startsWith('napcat/');
  for (const f of readdirSync(dir).sort()) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) { checkBats(full, prefix + f + '/'); continue; }
    if (!f.endsWith('.bat')) continue;

    const buf = readFileSync(full);
    const problems = [];
    let text;
    try { text = new TextDecoder('utf8', { fatal: true }).decode(buf); }
    catch { problems.push('不是合法 UTF-8'); text = buf.toString('latin1'); }

    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push('带 UTF-8 BOM');
    const repl = (text.match(/\uFFFD/g) || []).length;
    if (repl > 0) problems.push(`${repl} 个替换字符（编码已损坏）`);

    if (!upstream) {
      let loneLf = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a && !(i > 0 && buf[i - 1] === 0x0d)) loneLf++;
      }
      if (loneLf > 0) problems.push(`${loneLf} 个裸 LF（cmd 会解析错乱）`);

      // 只有含中文的脚本才要求 chcp，且 chcp 之前不能有中文
      if (/[^\x00-\x7F]/.test(text)) {
        const idx = text.indexOf('chcp 65001');
        if (idx < 0) problems.push('有中文但没有 chcp 65001');
        else {
          if (/[^\x00-\x7F]/.test(text.slice(0, idx))) problems.push('chcp 65001 之前就有中文（会被按 GBK 误读）');
          // cmd 的 chcp 会把重定向进来的标准输入整份吃掉（实测），必须显式 <nul 挡住
          const chcpLine = text.slice(idx).split(/\r?\n/)[0];
          if (!/<nul/i.test(chcpLine)) problems.push('chcp 没加 <nul（会把重定向进来的输入吃掉，向导会收不到回答）');
        }
      }
    }

    if (problems.length) {
      if (upstream) {
        console.log(`  · ${prefix}${f} — ${problems.join('；')}（官方原样，不影响使用）`);
      } else {
        console.log(`  ✗ ${prefix}${f} — ${problems.join('；')}`);
        leaked.push(`${f}: bat 格式问题`);
      }
    } else if (!upstream) {
      console.log(`  ✓ ${f}`);
    }
  }
}
checkBats(PKG_DIR);

// ---- 9. 打 zip ----
if (existsSync(ZIP)) rmSync(ZIP, { force: true });
console.log('');
console.log('=== 压缩中（node.exe 有 89 MB，要等十几秒）===');
const t0 = Date.now();
const zr = await zipDir(PKG_DIR, ZIP, {
  rootPrefix: PKG_NAME,
  onProgress: (d, total, rel) => {
    if (d > 1 && d % 500 === 0) console.log(`  ${d}/${total}  ${rel}`);
  },
});
const zipSize = existsSync(ZIP) ? statSync(ZIP).size : 0;
console.log(`  打包 ${zr.files} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
console.log('');
console.log('================ 打包完成 ================');
console.log('文件数  :', fileCount);
console.log('原始大小:', mb(totalBytes));
console.log('压缩包  :', ZIP);
console.log('压缩后  :', mb(zipSize));
console.log('顶层目录:', PKG_NAME + '/');

// ---- 10. 列清单（顶两层 + 大目录汇总）----
console.log('');
console.log('=== 包内结构 ===');
function listFiles(dir, prefix = '', depth = 0) {
  const entries = readdirSync(dir).sort();
  if (entries.length > 25 && depth >= 1) {
    let bytes = 0, files = 0;
    const sub = (d) => {
      for (const f of readdirSync(d)) {
        const full = join(d, f);
        if (statSync(full).isDirectory()) sub(full);
        else { files++; bytes += statSync(full).size; }
      }
    };
    sub(dir);
    console.log(`  ${prefix}… ${entries.length} 项 / ${files} 个文件 / ${mb(bytes)}`);
    return;
  }
  for (const f of entries) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) {
      console.log(`  ${prefix}${f}/`);
      if (depth < 2) listFiles(full, prefix + '  ', depth + 1);
    } else {
      console.log(`  ${prefix}${f}`);
    }
  }
}
listFiles(PKG_DIR);

if (leaked.some((l) => !l.includes('bat 格式问题'))) {
  console.log('');
  console.log('⚠ 安全检查有未通过项，请先处理再分发。');
  process.exit(1);
}
console.log('');
console.log('✓ 全部检查通过。');
