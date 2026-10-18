/**
 * 生成表情包图片（v2：修正坐标问题）。
 *
 * 上一版的问题：用 TranslateTransform/RotateTransform 旋转鲸鱼身体后，
 * 后面的眼睛、文字都跟着坐标系一起偏移了。
 *
 * 这版改成：所有图形都在绝对坐标里画，不用坐标系变换。简单可靠。
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const STICKER_DIR = resolve(ROOT, '..', 'stickers');

/**
 * 表情定义。
 * face: 五官类型
 * text: 底部大字
 * bg: 背景色
 */
const EMOTES = [
  { tag: '无语', text: '无语', face: 'deadpan', bg: [186, 196, 206], n: 3 },
  { tag: '白眼', text: '白眼', face: 'eyeroll', bg: [232, 222, 192], n: 3 },
  { tag: '点赞', text: '牛啊', face: 'happy', bg: [122, 202, 142], n: 3 },
  { tag: '问号', text: '???', face: 'confused', bg: [242, 226, 162], n: 3 },
  { tag: '溜了', text: '溜了', face: 'smug', bg: [202, 182, 222], n: 3 },
  { tag: '睡觉', text: 'Zzz', face: 'sleep', bg: [152, 162, 212], n: 3 },
  { tag: '拒绝', text: '不行', face: 'angry', bg: [236, 152, 152], n: 3 },
  { tag: '加油', text: '加油', face: 'determined', bg: [246, 192, 122], n: 3 },
  { tag: '吐血', text: '吐血', face: 'dead', bg: [222, 202, 202], n: 3 },
  { tag: '害怕', text: '怕怕', face: 'scared', bg: [172, 202, 222], n: 3 },
  { tag: '鼓掌', text: '鼓掌', face: 'happy', bg: [252, 212, 142], n: 3 },
  { tag: '笑死', text: '笑死', face: 'laugh', bg: [250, 226, 130], n: 3 },
  { tag: '震惊', text: '震惊', face: 'shock', bg: [200, 190, 240], n: 3 }
];

/** 五官画法（绝对坐标）。鲸鱼身体：椭圆 (70,120)-(330,270)，中心 (200,195) */
function faceScript(face) {
  const F = {
    // 眼睛位置（左右）
    deadpan: `
$g.FillEllipse($black, 140, 165, 24, 24); $g.FillEllipse($black, 236, 165, 24, 24)
$g.DrawLine($pen, 168, 228, 232, 228)`,
    eyeroll: `
$g.FillEllipse($white, 136, 158, 34, 34); $g.FillEllipse($white, 230, 158, 34, 34)
$g.FillEllipse($black, 144, 172, 16, 16); $g.FillEllipse($black, 238, 172, 16, 16)
$g.DrawArc($pen, 172, 220, 56, 26, 200, 140)`,
    happy: `
$g.DrawArc($pen, 136, 158, 34, 30, 200, 140); $g.DrawArc($pen, 230, 158, 34, 30, 200, 140)
$g.DrawArc($pen, 168, 205, 64, 40, 10, 160)`,
    confused: `
$g.FillEllipse($black, 142, 165, 22, 22); $g.FillEllipse($black, 236, 165, 22, 22)
$g.DrawArc($pen, 178, 222, 44, 24, 200, 140)`,
    smug: `
$g.DrawArc($pen, 136, 158, 34, 26, 200, 140); $g.FillEllipse($black, 236, 165, 22, 22)
$g.DrawArc($pen, 174, 214, 52, 26, 0, 150)`,
    sleep: `
$g.DrawLine($pen, 138, 175, 166, 175); $g.DrawLine($pen, 234, 175, 262, 175)
$g.FillEllipse($black, 188, 222, 26, 20)`,
    angry: `
$g.FillEllipse($black, 142, 168, 22, 22); $g.FillEllipse($black, 236, 168, 22, 22)
$g.DrawLine($pen, 134, 152, 166, 164); $g.DrawLine($pen, 266, 152, 234, 164)
$g.DrawArc($pen, 176, 228, 48, 24, 200, 140)`,
    determined: `
$g.FillEllipse($black, 142, 165, 24, 24); $g.FillEllipse($black, 234, 165, 24, 24)
$g.DrawLine($pen, 178, 228, 222, 228)`,
    dead: `
$g.DrawLine($pen, 140, 160, 168, 188); $g.DrawLine($pen, 168, 160, 140, 188)
$g.DrawLine($pen, 232, 160, 260, 188); $g.DrawLine($pen, 260, 160, 232, 188)
$g.DrawArc($pen, 176, 222, 48, 24, 200, 140)`,
    scared: `
$g.FillEllipse($white, 134, 156, 38, 38); $g.FillEllipse($white, 228, 156, 38, 38)
$g.FillEllipse($black, 146, 168, 16, 16); $g.FillEllipse($black, 240, 168, 16, 16)
$g.FillEllipse($black, 184, 222, 32, 26)`,
    laugh: `
$g.DrawArc($pen, 132, 154, 40, 32, 200, 140); $g.DrawArc($pen, 228, 154, 40, 32, 200, 140)
$g.FillEllipse($black, 176, 208, 48, 40)
$g.FillEllipse($white, 184, 214, 32, 24)`,
    shock: `
$g.FillEllipse($white, 132, 152, 42, 42); $g.FillEllipse($white, 226, 152, 42, 42)
$g.FillEllipse($black, 144, 166, 18, 18); $g.FillEllipse($black, 238, 166, 18, 18)
$g.FillEllipse($black, 186, 218, 28, 32)`
  };
  return F[face] || F.deadpan;
}

/** 生成一段画图用的 PowerShell 脚本 */
function buildScript(outPath, emote, variant) {
  const [r, g, b] = emote.bg;
  const body = faceScript(emote.face);
  // 每张略微不同：尾巴角度 + 文字位置
  const tailDrop = (variant % 3) * 8;
  const textY = 306 + (variant % 2) * 6;

  return `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 400,400
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(${r},${g},${b}))

$black = [System.Drawing.Brushes]::Black
$white = [System.Drawing.Brushes]::White
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 9)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

# 尾巴（三角形，在身体左侧）
$whale = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(72,132,202))
$tail = New-Object System.Drawing.PointF[] 3
$tail[0] = New-Object System.Drawing.PointF(78,195)
$tail[1] = New-Object System.Drawing.PointF(22,${157 + tailDrop})
$tail[2] = New-Object System.Drawing.PointF(22,${233 - tailDrop})
$g.FillPolygon($whale, $tail)

# 身体
$g.FillEllipse($whale, 70, 120, 260, 150)

# 肚皮
$belly = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(214,232,247))
$g.FillEllipse($belly, 108, 178, 185, 84)

# 喷水
$water = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(126,184,232), 8)
$water.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$water.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($water, 210, 122, 210, 88)
$g.DrawLine($water, 210, 100, 188, 76)
$g.DrawLine($water, 210, 100, 232, 76)

# 眼睛白底
$g.FillEllipse($white, 132, 152, 44, 44)
$g.FillEllipse($white, 226, 152, 44, 44)

# 五官
${body}

# 底部大字
$font = New-Object System.Drawing.Font("SimHei", 52, [System.Drawing.FontStyle]::Bold)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, ${textY}, 400, 80)
$g.DrawString("${emote.text}", $font, $black, $rect, $fmt)

$g.Dispose()
$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
}

mkdirSync(STICKER_DIR, { recursive: true });
let made = 0;
const summary = [];

for (const emote of EMOTES) {
  const dir = join(STICKER_DIR, emote.tag);
  mkdirSync(dir, { recursive: true });
  let ok = 0;
  for (let v = 0; v < emote.n; v++) {
    const out = join(dir, `${emote.tag}_${v + 1}.png`);
    const tmpPs = join(dir, `_t${v}.ps1`);
    writeFileSync(tmpPs, '\uFEFF' + buildScript(out, emote, v), 'utf8');
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs}"`, { stdio: 'ignore' });
      if (existsSync(out)) { made++; ok++; }
    } catch { /* 忽略 */ }
    try { if (existsSync(tmpPs)) unlinkSync(tmpPs); } catch {}
  }
  summary.push(`${emote.tag}(${ok})`);
}

console.log('生成完成:', summary.join(' '));
console.log(`共 ${made} 张 → ${STICKER_DIR}`);
