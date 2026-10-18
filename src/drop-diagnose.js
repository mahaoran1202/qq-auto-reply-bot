/**
 * 掉线诊断：记录「掉线前后」的系统状态快照，用于定位原因。
 *
 * 为什么需要：
 *   面板日志重启后会丢，QQ/NapCat 的进程也会消失，事后什么都查不到。
 *   所以在检测到掉线的那一刻，把当时的现场存下来。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT } from './config.js';

const DIR = resolve(ROOT, 'records');
const FILE = join(DIR, '掉线诊断.log');

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

/** 跑个命令，失败返回空 */
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

/**
 * 抓一份现场快照。
 * @param {string} reason 掉线原因描述
 */
export function snapshot(reason) {
  ensureDir();
  const now = new Date();
  const lines = [];

  lines.push('');
  lines.push('='.repeat(70));
  lines.push(`掉线时间：${now.toLocaleString('zh-CN')}`);
  lines.push(`原因：${reason}`);
  lines.push('='.repeat(70));

  // 1) 系统运行时长（判断有没有重启）
  try {
    const os = run('powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString(\'s\')"');
    lines.push(`系统上次启动：${os}`);
  } catch { /* 忽略 */ }

  // 2) 有没有真正的睡眠/唤醒（今天）
  const sleepEv = run('powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName=\'System\'; ProviderName=\'Microsoft-Windows-Kernel-Power\'; Id=42,107; StartTime=(Get-Date).AddHours(-6)} -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { $_.TimeCreated.ToString(\'s\') + \' Id=\' + $_.Id }"');
  lines.push(`近6小时睡眠/唤醒事件：${sleepEv || '(无)'}`);

  // 3) 会话状态变化（锁屏/解锁等）
  const sessionEv = run('powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName=\'System\'; ProviderName=\'Microsoft-Windows-Kernel-Power\'; Id=566; StartTime=(Get-Date).AddHours(-6)} -ErrorAction SilentlyContinue | Select-Object -First 6 | ForEach-Object { $_.TimeCreated.ToString(\'HH:mm:ss\') + \' \' + ($_.Message -replace \'\\r?\\n\',\' \') }"');
  lines.push(`近6小时会话变化：`);
  lines.push(sessionEv ? sessionEv.split('\n').map((s) => '  ' + s).join('\n') : '  (无)');

  // 4) 网络状态
  const net = run('powershell -NoProfile -Command "Get-NetAdapter | Where-Object Status -eq Up | Select-Object -First 3 | ForEach-Object { $_.Name + \'=\' + $_.Status }"');
  lines.push(`网络适配器：${net || '(查询失败)'}`);

  // 5) QQ / NapCat 进程（有没有、启动时间）
  const procs = run('powershell -NoProfile -Command "Get-Process QQ,NapCatWinBootMain -ErrorAction SilentlyContinue | Sort-Object StartTime | ForEach-Object { $_.ProcessName + \'(\' + $_.Id + \') 启动于 \' + $_.StartTime.ToString(\'HH:mm:ss\') }"');
  lines.push(`QQ/NapCat 进程：`);
  lines.push(procs ? procs.split('\n').map((s) => '  ' + s).join('\n') : '  (一个都没有 —— 进程没了)');

  // 6) 端口
  const port = run('powershell -NoProfile -Command "(netstat -ano | Select-String \':3001.*LISTENING\') -ne $null"');
  lines.push(`3001 端口监听：${port === 'True' ? '是' : '否'}`);

  // 7) 电源相关
  const sleepSet = run('powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE');
  const m = sleepSet.match(/当前交流电源设置索引:\s*(0x[0-9a-f]+)/i);
  lines.push(`自动睡眠设置(交流)：${m ? m[1] : '?'} （0=从不）`);

  // 8) 内存/CPU 压力（排除卡死）
  const mem = run('powershell -NoProfile -Command "$os=Get-CimInstance Win32_OperatingSystem; [math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1)"');
  lines.push(`已用内存：${mem || '?'} GB`);

  // 9) 最近的系统错误
  const errs = run('powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName=\'System\'; Level=1,2; StartTime=(Get-Date).AddHours(-2)} -MaxEvents 5 -ErrorAction SilentlyContinue | ForEach-Object { $_.TimeCreated.ToString(\'HH:mm:ss\') + \' [\' + $_.ProviderName + \'] \' + ($_.Message -replace \'\\r?\\n\',\' \').Substring(0,[Math]::Min(60,($_.Message -replace \'\\r?\\n\',\' \').Length)) }"');
  lines.push(`近2小时系统错误：`);
  lines.push(errs ? errs.split('\n').map((s) => '  ' + s).join('\n') : '  (无)');

  lines.push('');

  try {
    appendFileSync(FILE, lines.join('\n'), 'utf8');
    console.log(`[diag] 已记录掉线现场 → ${FILE}`);
  } catch (e) {
    console.log(`[diag] 写诊断日志失败: ${e.message}`);
  }

  return lines.join('\n');
}

/** 读回诊断记录（面板展示） */
export function readDiagnostics(limit = 5) {
  if (!existsSync(FILE)) return [];
  try {
    const all = readFileSync(FILE, 'utf8');
    const blocks = all.split(/={70}\n/).filter((b) => b.trim());
    return blocks.slice(-limit).reverse().map((b) => b.trim());
  } catch {
    return [];
  }
}

export { FILE as DIAG_FILE };
