/**
 * 阻止电脑睡眠 —— 机器人运行时保持唤醒。
 *
 * 为什么需要：
 *   电脑睡眠后，NapCat 的 WebSocket 服务和 QQ 的连接都会失效，
 *   唤醒后 NapCat 变成「空壳进程」（内存只剩几 MB），无法自愈，必须重启。
 *
 * 做法：调 Windows 的 SetThreadExecutionState，告诉系统「有人正在用，别睡」。
 * 用 PowerShell 起一个常驻进程来持有这个状态（Node 里没法直接调这个 API）。
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

let holder = null;
let holderPs1 = null;

/**
 * 开始阻止睡眠。
 * @param {{log?:Function, alsoKeepDisplayOn?:boolean}} opts
 * @returns {{ok:boolean, method:string, error?:string}}
 */
export function preventSleep(opts = {}) {
  const log = opts.log || console.log;
  if (holder) return { ok: true, method: 'already' };

  // ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x00000001)
  // 加 ES_DISPLAY_REQUIRED(0x00000002) 可以连屏幕也不关
  const flags = opts.alsoKeepDisplayOn ? 0x80000003 : 0x80000001;

  holderPs1 = join(ROOT, 'records', '.keepawake.ps1');
  const ps = `
$sig = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$t = Add-Type -MemberDefinition $sig -Name PowerKeep -Namespace Win32 -PassThru
# 一直持有唤醒锁，直到进程被杀
$t::SetThreadExecutionState(${flags})
Write-Output "keepawake active"
while ($true) { Start-Sleep -Seconds 30; $t::SetThreadExecutionState(${flags}) | Out-Null }
`;
  try {
    writeFileSync(holderPs1, '\uFEFF' + ps, 'utf8');
    holder = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', holderPs1], {
      windowsHide: true, detached: false, stdio: 'ignore'
    });
    holder.on('exit', () => { holder = null; });
    log(`[power] 已阻止系统睡眠（机器人运行期间保持唤醒）`);
    return { ok: true, method: 'execution-state' };
  } catch (e) {
    return { ok: false, method: 'none', error: e.message };
  }
}

/** 停止阻止睡眠（机器人退出时调用） */
export function allowSleep() {
  try {
    if (holder) { holder.kill(); holder = null; }
    if (holderPs1 && existsSync(holderPs1)) {
      try { unlinkSync(holderPs1); } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
}

/** 查询当前电源状态 */
export function powerStatus() {
  const out = { preventSleep: !!holder };
  try {
    const r = execSync('powercfg /getactivescheme', { encoding: 'utf8', stdio: 'pipe' });
    out.scheme = r.trim();
  } catch { /* 忽略 */ }
  return out;
}

/** 是否正在阻止睡眠 */
export function isPreventing() {
  return !!holder;
}
