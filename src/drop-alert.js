/**
 * 掉线告警 + 自动恢复。
 *
 * 为什么单独做：
 *   QQ 掉线时，机器人自己也没法用 QQ 通知你（鸡生蛋问题），
 *   所以必须走独立渠道 —— Windows 系统弹窗 + 声音。
 *
 * 两种情况会告警：
 *   1. OneBot WebSocket 断了（连不上 NapCat）
 *   2. 连着但 QQ 离线（online:false）—— 这种最坑，看着正常其实收发全废
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.js';

/**
 * 弹 Windows 系统通知 + 响铃。
 * 用 PowerShell 的 Toast 通知，不需要额外依赖。
 * @param {string} title
 * @param {string} message
 */
export function notify(title, message) {
  // 清理文本，避免注入 PowerShell
  const safe = (s) => String(s || '').replace(/['"`$\\]/g, ' ').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const t = safe(title);
  const m = safe(message);

  const ps = `
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $tpl = @"
<toast scenario="reminder">
  <visual>
    <binding template="ToastGeneric">
      <text>${t}</text>
      <text>${m}</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="false"/>
</toast>
"@
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($tpl)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("QQ机器人").Show($toast)
} catch {
  # 退路：用气泡提示
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Warning
    $n.Visible = $true
    $n.ShowBalloonTip(15000, "${t}", "${m}", [System.Windows.Forms.ToolTipIcon]::Warning)
    Start-Sleep -Seconds 15
    $n.Dispose()
  } catch {}
}
# 再响一声
try { [console]::beep(880, 400); Start-Sleep -Milliseconds 200; [console]::beep(660, 500) } catch {}
`;
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
      windowsHide: true, detached: true, stdio: 'ignore'
    }).unref();
  } catch (e) {
    console.log('[alert] 弹窗失败: ' + e.message);
  }
}

/**
 * 在桌面写一个醒目的告警文件（回来后一眼能看到）。
 */
export function writeAlertFile(title, lines) {
  try {
    const desktop = join(process.env.USERPROFILE || ROOT, 'Desktop');
    const dir = existsSync(desktop) ? desktop : ROOT;
    const p = join(dir, '⚠️QQ机器人掉线.md');
    const body = [
      `# ${title}`,
      '',
      `时间：${new Date().toLocaleString()}`,
      '',
      ...lines,
      '',
      '---',
      '处理办法：',
      `1. 右键运行 ${join(ROOT, 'restart-qq-napcat.bat')}（以管理员身份）`,
      '2. 扫码登录 QQ',
      '3. 打开面板点「启动机器人」',
      '',
      '（重启成功后这个文件会自动删除）'
    ].join('\n');
    writeFileSync(p, body, 'utf8');
    return p;
  } catch {
    return null;
  }
}

/** 删掉告警文件（恢复正常时调用） */
export function clearAlertFile() {
  try {
    const desktop = join(process.env.USERPROFILE || ROOT, 'Desktop');
    const dir = existsSync(desktop) ? desktop : ROOT;
    const p = join(dir, '⚠️QQ机器人掉线.md');
    if (existsSync(p)) unlinkSync(p);
  } catch { /* 忽略 */ }
}

/** 计划任务名（由 authorize-autorestart.bat 创建） */
const TASK_NAME = 'QQBot_NapCatRestart';

/**
 * 尝试自动重启 QQ + NapCat。
 *
 * 三种方式，按优先级：
 *   1. 计划任务（免 UAC）—— 需要先跑过一次 authorize-autorestart.bat
 *   2. 已是管理员 —— 直接执行
 *   3. UAC 提权 —— 会弹确认框，需要你点「是」（睡觉时点不了）
 */
export function tryRestartNapCat(opts = {}) {
  const log = opts.log || console.log;
  // 用纯 ASCII 文件名，避免中文路径在某些环境下被 GBK 误读
  const candidates = [
    join(ROOT, 'restart-qq-napcat.bat'),
    join(ROOT, '重启NapCat和QQ.bat'),
    join(ROOT, '重新登录QQ.bat')
  ];
  const script = opts.scriptPath || candidates.find((p) => existsSync(p));

  if (!script) {
    return { ok: false, method: 'none', error: `找不到重启脚本，试过：${candidates.map((p) => p.split('\\').pop()).join(', ')}` };
  }

  // ---- 方式1：计划任务（免 UAC，最可靠）----
  try {
    const q = execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe', encoding: 'utf8' });
    if (q && !/错误|ERROR|cannot find/i.test(q)) {
      log('[alert] 用计划任务重启（免 UAC）');
      execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe', timeout: 15000 });
      return { ok: true, method: 'task' };
    }
  } catch {
    // 任务不存在，走下面的方式
  }

  // ---- 方式2：已是管理员 ----
  const isAdmin = (() => {
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  try {
    if (isAdmin) {
      log('[alert] 已是管理员，直接执行重启脚本');
      spawn('cmd.exe', ['/c', script], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      return { ok: true, method: 'direct' };
    }
    // ---- 方式3：UAC 提权（需要用户点确认）----
    log('[alert] 需要提权，正在弹出 UAC 确认框（请点「是」）');
    log('[alert] 提示：跑一次 authorize-autorestart.bat以后就不需要 UAC 了');
    const psCmd = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c "${script}"' -Verb RunAs`;
    spawn('powershell', ['-NoProfile', '-Command', psCmd], {
      windowsHide: true, detached: true, stdio: 'ignore'
    }).unref();
    return { ok: true, method: 'uac' };
  } catch (e) {
    return { ok: false, method: 'error', error: e.message };
  }
}

/**
 * 掉线监控器。
 * 定期检查 OneBot 连接状态和 QQ 在线状态，异常就告警。
 */
export class DropWatcher {
  /**
   * @param {object} opts
   * @param {() => Promise<{connected:boolean, online:boolean|null, reason?:string}>} opts.check 状态检查函数
   * @param {object} opts.config
   * @param {Function} opts.log
   */
  constructor(opts) {
    this.check = opts.check;
    this.config = opts.config;
    this.log = opts.log || console.log;
    this.timer = null;
    this.state = 'ok';          // ok | disconnected | offline
    this.since = 0;
    this.lastAlertAt = 0;
    this.restartTriedAt = 0;
    this.consecutiveBad = 0;
  }

  start(intervalMs = 60000) {
    const cfg = this.config.bot?.dropAlert || {};
    if (cfg.enabled === false) {
      this.log('[alert] 掉线告警已关闭');
      return;
    }
    const iv = Number(cfg.checkSeconds) * 1000 || intervalMs;
    this.log(`[alert] 掉线监控已启动（每 ${Math.round(iv/1000)} 秒检查一次）`);
    this.timer = setInterval(() => this.tick().catch(() => {}), iv);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const cfg = this.config.bot?.dropAlert || {};
    let st;
    try {
      st = await this.check();
    } catch (e) {
      st = { connected: false, online: null, reason: e.message };
    }

    // 判断当前状态
    let now = 'ok';
    if (!st.connected) now = 'disconnected';
    else if (st.online === false) now = 'offline';

    // 连续两次异常才告警，避免网络抖动误报
    if (now !== 'ok') {
      this.consecutiveBad++;
    } else {
      this.consecutiveBad = 0;
    }

    const needTwo = cfg.confirmTimes ?? 2;

    if (now === this.state) return;

    // 恢复正常
    if (now === 'ok') {
      if (this.state !== 'ok') {
        const dur = Math.round((Date.now() - this.since) / 1000);
        this.log(`[alert] ✓ 已恢复正常（异常持续 ${dur} 秒）`);
        if (cfg.notifyOnRecover !== false) {
          notify('QQ 机器人已恢复', `连接正常了（之前异常 ${dur} 秒）`);
        }
        clearAlertFile();
      }
      this.state = 'ok';
      this.consecutiveBad = 0;
      return;
    }

    // 异常，但还没确认够次数
    if (this.consecutiveBad < needTwo) {
      this.log(`[alert] 检测到异常（${now}），等待确认…`);
      return;
    }

    // 确认异常，告警
    this.state = now;
    this.since = Date.now();

    const isOffline = now === 'offline';
    const title = isOffline ? 'QQ 掉线了！' : 'NapCat 连接断了！';
    const detail = isOffline
      ? 'QQ 显示离线，收发消息都不工作'
      : '连不上 NapCat，可能 NapCat 没在运行';

    this.log(`[alert] ⚠ ${title} —— ${detail}`);

    // 0) 抓一份现场快照（用于事后定位原因）
    if (cfg.diagnose !== false) {
      try {
        const { snapshot } = await import('./drop-diagnose.js');
        snapshot(`${title} —— ${detail}${st.reason ? ' | ' + st.reason : ''}`);
      } catch (e) {
        this.log(`[diag] 快照失败: ${e.message}`);
      }
    }

    // 1) 系统弹窗 + 声音
    if (cfg.notify !== false) {
      notify(title, detail + '。请重启 QQ 并扫码登录。');
    }

    // 2) 桌面告警文件
    if (cfg.writeFile !== false) {
      const p = writeAlertFile(title, [
        `**问题**：${detail}`,
        st.reason ? `**详情**：${st.reason}` : '',
        '',
        '机器人仍在运行，但无法收发 QQ 消息。'
      ].filter(Boolean));
      if (p) this.log(`[alert] 已在桌面写入告警文件：${p}`);
    }

    // 3) 自动重启
    const canRestart = cfg.autoRestart !== false;
    const cooldown = Number(cfg.restartCooldownMinutes ?? 10) * 60000;
    if (canRestart && Date.now() - this.restartTriedAt > cooldown) {
      this.restartTriedAt = Date.now();
      this.log('[alert] 尝试自动重启 QQ + NapCat…');
      const r = tryRestartNapCat({ log: this.log });
      if (r.ok) {
        this.log(`[alert] 已发起重启（方式：${r.method === 'uac' ? 'UAC 提权，需要你点确认' : '直接执行'}）`);
        if (cfg.notify !== false) {
          notify('正在自动重启 QQ', r.method === 'uac'
            ? '弹出了 UAC 确认框，请点「是」。之后需要扫码登录。'
            : '重启中，稍后可能需要扫码登录。');
        }
      } else {
        this.log(`[alert] 自动重启失败：${r.error}`);
        if (cfg.notify !== false) {
          notify('自动重启失败', r.error + ' 请手动运行 restart-qq-napcat.bat');
        }
      }
    }

    this.lastAlertAt = Date.now();
  }
}
