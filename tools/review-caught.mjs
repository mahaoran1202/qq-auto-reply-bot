/**
 * 用新的分类器审查已抓取的表情包，清掉不该留的（截图/照片/无意义）。
 */
import { readFileSync, existsSync, unlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { analyzeImage } from '../src/image-classifier.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const c = loadConfig();
const dir = join(ROOT, 'stickers', '_自动抓取');

if (!existsSync(dir)) { console.log('没有抓取目录'); process.exit(0); }

const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
console.log(`审查 ${files.length} 张已抓取的图...\n`);

const reject = [];
const keep = [];

for (const f of files) {
  const p = join(dir, f);
  const size = statSync(p).size;
  let buf;
  try { buf = readFileSync(p); } catch { continue; }

  // 超大图直接判为不该留
  if (size > 2_500_000) {
    reject.push({ f, why: `过大(${Math.round(size/1024)}KB)`, kind: 'too_big' });
    console.log(`✗ ${f}  过大 ${Math.round(size/1024)}KB`);
    continue;
  }

  const r = await analyzeImage(c, buf);
  if (!r.ok) {
    keep.push({ f, why: '分析失败，保守保留' });
    console.log(`? ${f}  分析失败，保留`);
    continue;
  }

  if (r.keep) {
    keep.push({ f, verdict: r.verdict, desc: r.desc });
    console.log(`✓ ${f}  ${r.verdict}  ${r.desc}`);
  } else {
    reject.push({ f, why: r.desc, kind: r.verdict });
    console.log(`✗ ${f}  ${r.verdict}  ${r.desc}  ← 要删`);
  }
}

console.log('\n=============== 结果 ===============');
console.log(`保留 ${keep.length} 张 / 删除 ${reject.length} 张`);

if (reject.length) {
  console.log('\n待删除:');
  for (const r of reject) console.log(`  ${r.f}  [${r.kind}] ${r.why}`);
}

// 真正删除 + 清缓存
if (process.argv.includes('--apply')) {
  let n = 0;
  for (const r of reject) {
    try { unlinkSync(join(dir, r.f)); n++; } catch { /* 忽略 */ }
  }
  // 清标签缓存里对应的项
  const tp = join(ROOT, 'stickers', '.tags.json');
  if (existsSync(tp)) {
    try {
      const cache = JSON.parse(readFileSync(tp, 'utf8'));
      for (const r of reject) delete cache[`_自动抓取/${r.f}`];
      writeFileSync(tp, JSON.stringify(cache, null, 2), 'utf8');
    } catch { /* 忽略 */ }
  }
  console.log(`\n✓ 已删除 ${n} 张，并清理了标签缓存`);
} else {
  console.log('\n（这是预览，加 --apply 才真正删除）');
}
