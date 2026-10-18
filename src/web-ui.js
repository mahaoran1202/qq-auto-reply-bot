import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve, dirname, extname, basename } from 'node:path';
import { loadConfig, CONFIG_PATH, ROOT } from './config.js';
import { Recorder } from './recorder.js';
import { analyzeStyle, testProvider, listModels, resolveProvider } from './deepseek.js';
import { buildPersona } from './persona.js';
import { PRESETS, PARAM_META, describePersona, STICKER_LEVELS } from './persona-presets.js';
import { scanStickers, stickerSummary, ensureStickerDir, stickerDir, FACE_TABLE, IMAGE_EXT } from './stickers.js';
import { parseReply, countMarkers } from './reply-parser.js';

// 端口可以用环境变量覆盖，方便同一台机器上临时再开一个面板做测试/对比
const PORT = Number(process.env.QQBOT_PORT) || 4399;
const PUBLIC = resolve(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

const config = loadConfig();
const recorder = new Recorder(config.record?.dir || 'records');

// ---- bot child process manager ----
let botProc = null;
let botLog = [];
function log(line) {
  const s = `[${new Date().toLocaleTimeString()}] ${line}`;
  botLog.push(s);
  if (botLog.length > 800) botLog = botLog.slice(-800);
  console.log(s);
}

function startBot() {
  if (botProc) return { ok: true, running: true, pid: botProc.pid };
  botProc = spawn(process.execPath, ['src/bot.js'], { cwd: ROOT, windowsHide: true });
  botProc.stdout.on('data', (d) => log(d.toString().trimEnd()));
  botProc.stderr.on('data', (d) => log('[err] ' + d.toString().trimEnd()));
  botProc.on('exit', (code) => {
    log(`bot exited (code ${code})`);
    botProc = null;
  });
  log(`bot started (pid ${botProc.pid})`);
  return { ok: true, running: true, pid: botProc.pid };
}

function stopBot() {
  if (!botProc) return { ok: true, running: false, stopped: false };
  const pid = botProc.pid;
  // Force-kill on Windows so it terminates promptly.
  spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true });
  botProc = null;
  log(`bot stop requested (pid ${pid})`);
  return { ok: true, running: false, stopped: true };
}

// ---- napcat launch ----
// 诊断用的端口探测器：NapCat 起来后 6099（WebUI）会先通，QQ 登录成功后 3001 才通。
// 用端口当唯一可信判据，而不是「我 spawn 出去的那个进程还在不在」——因为
// launcher 会把活交给提权后的新进程，自己立刻退出，用进程句柄判断必然误报。
function probePort(port, timeoutMs = 600) {
  return new Promise((done) => {
    let finished = false;
    const sock = connect({ host: '127.0.0.1', port });
    const finish = (v) => {
      if (finished) return;
      finished = true;
      try { sock.destroy(); } catch { /* ignore */ }
      done(v);
    };
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

// 读 NapCat 自己的 WebUI 配置，把 token 告诉用户（用户不知道去哪儿找这个）
function napcatWebuiInfo() {
  const f = resolve(ROOT, 'napcat', 'config', 'webui.json');
  if (!existsSync(f)) {
    return { ok: false, error: '还没有 napcat\\config\\webui.json —— NapCat 至少启动过一次之后才会生成这个文件。' };
  }
  let j = {};
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) {
    return { ok: false, error: 'webui.json 读不出来：' + e.message };
  }
  // NapCat 默认 host 是 "::" 或 "0.0.0.0"，浏览器要用 127.0.0.1 访问
  const rawHost = String(j.host || '');
  const host = (!rawHost || rawHost === '::' || rawHost === '0.0.0.0') ? '127.0.0.1' : rawHost;
  const port = Number(j.port) || 6099;
  return {
    ok: true,
    url: `http://${host}:${port}/webui`,
    host,
    port,
    token: j.token || '',
    disabled: Boolean(j.disableWebUI),
    accessControlMode: j.accessControlMode || 'none',
    file: f
  };
}

// 自己是不是已经在管理员权限下跑？
// 这决定了启动 NapCat 时要走「直接起」还是「先提权」——
// 已经提权了还硬加 -Verb RunAs，在部分机器上会把请求再转一道，反而起不来。
let cachedIsAdmin = null;
function isElevated() {
  if (cachedIsAdmin !== null) return cachedIsAdmin;
  try {
    const r = spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' });
    cachedIsAdmin = r.status === 0;
  } catch {
    cachedIsAdmin = false;
  }
  return cachedIsAdmin;
}

async function startNapcat() {
  // 已经跑起来了就别再起一份（重复注入 QQ 会出问题）
  const webuiUp = await probePort(6099);
  const wsUp = await probePort(3001);
  if (webuiUp || wsUp) {
    // 用户点「启动 NapCat」的真实意图是「让它能用」，而不只是「让 NapCat 进程在」。
    // 所以这里顺手把机器人也拉起来，否则会出现「一切显示正常、但机器人根本没跑」的死角。
    let botStarted = false;
    let botRunning = Boolean(botProc);
    if (wsUp && !botProc) {
      try { startBot(); botStarted = true; botRunning = true; } catch { /* ignore */ }
    }
    let note;
    if (!wsUp) {
      note = 'NapCat 已经在跑了（6099 WebUI 通），但 QQ 还没登录成功 —— 去 QQ 窗口扫码。';
    } else if (botStarted) {
      note = 'NapCat 早就在跑了，QQ 也登录好了（3001 通）。机器人刚帮你启动，现在应该已经在回消息了。';
    } else if (botRunning) {
      note = '一切正常：NapCat 在跑、QQ 已登录、机器人在跑。不用再点了。';
    } else {
      note = 'NapCat 在跑、QQ 已登录，但机器人启动失败了 —— 看下面的日志窗口。';
    }
    return {
      ok: true, running: true, alreadyRunning: true,
      webui: webuiUp, loggedIn: wsUp, botStarted, botRunning, note
    };
  }

  // 优先用「一键启动.bat」——它是给小白准备的总入口：会自检 Node / NapCat / QQ、
  // 缺 config.json 就自动走向导、然后拉起 NapCat。比在 JS 里拼 cmd 参数可靠得多，
  // 而且脚本本身已经在真实环境里反复跑通过。
  const oneClick = resolve(ROOT, '一键启动.bat');
  // 其次用自动登录脚本（免扫码）
  const autoLogin = resolve(ROOT, 'napcat', 'launcher-autologin.bat');
  const win10 = resolve(ROOT, 'napcat', 'launcher-win10.bat');
  const configured = config.napcat?.command;

  const useOneClick = existsSync(oneClick);
  const cmd = useOneClick
    ? oneClick
    : (existsSync(autoLogin) ? autoLogin : (existsSync(win10) ? win10 : configured));

  if (!cmd) {
    return { ok: false, error: '找不到 一键启动.bat，也没有 napcat\\launcher-autologin.bat，config.json 里也没配 napcat.command。' };
  }
  if (!existsSync(cmd)) {
    return { ok: false, error: '启动脚本不存在：' + cmd };
  }

  const args = useOneClick ? [] : (Array.isArray(config.napcat.args) ? config.napcat.args : []);
  const isBat = /\.(bat|cmd)$/i.test(cmd);
  const batDir = dirname(cmd);
  const usingAuto = !useOneClick && cmd === autoLogin;

  // 关键修复：原来用 spawn(cmd.exe /c launcher) 且 windowsHide:true，
  // launcher 内部的 Start-Process -Verb RunAs 弹 UAC 时没有任何可见反馈，
  // UAC 被拒 / 被策略拦截时面板完全静默 —— 用户看到的就是「点了没反应」。
  // 现在直接从面板发起提权（-Verb RunAs），UAC 弹窗必定可见，且能拿到退出码。
  try {
    // PowerShell 参数列表：每一项都要单引号包住，且不能出现空项。
    // 之前用 JSON.stringify(args).replace(...) 拼，args 为空数组时会留下一个
    // 尾随逗号变成 `-ArgumentList '/c','"x"',` —— PowerShell 直接语法错误，
    // 表现就是「点了没反应」（进程起来又秒退，什么也没发生）。
    const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    // .bat/.cmd 且没有额外参数时，直接 Start-Process -FilePath 让它自己走
    // ShellExecute（Unicode 路径安全）。只有真需要传参数时才包一层 cmd.exe ——
    // 包 cmd.exe 意味着路径要过一遍 ANSI 转换，中文路径容易翻车。
    const directBat = isBat && args.length === 0;
    // 已经是管理员就不要再加 -Verb RunAs（多此一举，还会让部分机器上直接失败）
    const elevate = isElevated() ? '' : ' -Verb RunAs';
    let psArgs;
    if (directBat) {
      psArgs = [
        '-NoProfile', '-Command',
        `$p = Start-Process -FilePath ${psQuote(cmd)} -WorkingDirectory ${psQuote(batDir)}${elevate} -PassThru; $p.Id`
      ];
    } else if (isBat) {
      const argList = ['/c', `"${cmd}"`, ...args].map(psQuote).join(',');
      psArgs = [
        '-NoProfile', '-Command',
        `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${argList} -WorkingDirectory ${psQuote(batDir)}${elevate} -PassThru; $p.Id`
      ];
    } else {
      const argList = args.length ? ` -ArgumentList ${args.map(psQuote).join(',')}` : '';
      psArgs = [
        '-NoProfile', '-Command',
        `$p = Start-Process -FilePath ${psQuote(cmd)}${argList} -WorkingDirectory ${psQuote(batDir)}${elevate} -PassThru; $p.Id`
      ];
    }

    log(`启动 NapCat: ${basename(cmd)}（${isElevated() ? '当前已是管理员，直接启动' : '需要提权，会弹 UAC'}）`);

    // 已经是管理员时，不要 detached+ignore —— 让输出能落进我们日志，方便排错
    const child = spawn('powershell.exe', psArgs, {
      windowsHide: true,
      detached: !isElevated(),
      stdio: isElevated() ? ['ignore', 'pipe', 'pipe'] : 'ignore'
    });
    child.on('error', (e) => log(`NapCat 提权启动失败: ${e.message}`));
    if (child.stdout) child.stdout.on('data', (c) => log(`[napcat] ${String(c).trim()}`));
    if (child.stderr) child.stderr.on('data', (c) => log(`[napcat:err] ${String(c).trim()}`));

    const result = await new Promise((done) => {
      const t = setTimeout(() => done({ code: null, late: true }), 15000);
      child.on('close', (code) => { clearTimeout(t); done({ code, late: false }); });
    });

    if (result.late) {
      // 15 秒还没退：UAC 弹窗正挂着等用户点击
      log('NapCat 提权请求已发出，但 PowerShell 还没返回（UAC 在等用户点击）');
      return {
        ok: true, launching: true, autoLogin: usingAuto, cmd,
        note: '已经发起启动，但还没拿到管理员授权 —— 屏幕上应该有「用户账户控制」窗口，去点「是」。'
      };
    }

    if (result.code !== 0) {
      log(`NapCat 提权启动返回码 ${result.code}`);
      return {
        ok: false,
        error: '提权启动失败了（返回码 ' + result.code + '）。最常见：UAC 弹窗上点了「否」，或这个账户不是管理员。',
        hint: '换个更稳的方式：右键 一键启动.bat → 以管理员身份运行。'
      };
    }

    // powershell 正常退出只代表"提权请求发出去了"，不代表 NapCat 真起来了。
    // 自己盯端口，把真实结果告诉用户，别让人猜。
    log('NapCat 启动已发起，开始等待 6099 端口…');
    const t0 = Date.now();
    const waitMs = 20000;
    while (Date.now() - t0 < waitMs) {
      if (await probePort(6099)) {
        log('NapCat 已起来（6099 通）');
        return {
          ok: true, launching: true, started: true, autoLogin: usingAuto, cmd,
          note: 'NapCat 已经起来了。接下来会弹出 QQ 窗口 —— 第一次要扫码登录，登录成功后这个状态就会变成「QQ 已登录」。'
        };
      }
      await new Promise((r) => setTimeout(r, 800));
    }

    log('NapCat 启动后 20 秒内 6099 仍未监听');
    return {
      ok: false,
      error: '已经发起了启动，但 20 秒内 NapCat 没起来（6099 端口还是不通）。',
      hint: '多半是 UAC 那一关没过。改用「右键 一键启动.bat → 以管理员身份运行」最稳。'
    };
  } catch (e) {
    return { ok: false, error: '启动 NapCat 失败: ' + e.message };
  }
}

// ---- http helpers ----
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolveBody({});
      try { resolveBody(JSON.parse(data)); } catch (e) { reject(new Error('bad json: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function saveConfig(partial) {
  let existing = {};
  if (existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { existing = {}; }
  }
  const merge = (base, over) => {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over;
    const o = { ...base };
    for (const k of Object.keys(over)) {
      if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && typeof over[k] === 'object' && !Array.isArray(over[k])) {
        o[k] = merge(base[k], over[k]);
      } else {
        o[k] = over[k];
      }
    }
    return o;
  };
  const next = merge(existing, partial);
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---- routes ----
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    serveStatic(res, join(PUBLIC, 'index.html'));
    return;
  }
  if (req.method === 'GET' && path.startsWith('/public/')) {
    serveStatic(res, join(PUBLIC, path.slice('/public/'.length)));
    return;
  }
  // 表情包图片预览：/sticker-file/<相对路径>
  if (req.method === 'GET' && path.startsWith('/sticker-file/')) {
    const rel = decodeURIComponent(path.slice('/sticker-file/'.length));
    const base = stickerDir(config);
    const full = resolve(base, rel);
    // 防目录穿越：必须仍在表情库目录内
    if (!full.startsWith(resolve(base))) { res.writeHead(403); res.end('forbidden'); return; }
    if (!IMAGE_EXT.has(extname(full).toLowerCase())) { res.writeHead(403); res.end('forbidden'); return; }
    serveStatic(res, full);
    return;
  }

  try {
    if (path === '/api/config' && req.method === 'GET') {
      sendJson(res, loadConfig());
      return;
    }
    if (path === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const saved = saveConfig(body);
      // Refresh in-process config values used by this server.
      for (const [k, v] of Object.entries(saved)) config[k] = v;
      sendJson(res, { ok: true, config: loadConfig() });
      return;
    }

    if (path === '/api/bot/start' && (req.method === 'POST' || req.method === 'GET')) {
      sendJson(res, startBot());
      return;
    }
    if (path === '/api/bot/stop' && (req.method === 'POST' || req.method === 'GET')) {
      sendJson(res, stopBot());
      return;
    }
    if (path === '/api/bot/status' && req.method === 'GET') {
      sendJson(res, { running: !!botProc, pid: botProc?.pid || null });
      return;
    }
    if (path === '/api/bot/stats' && req.method === 'GET') {
      const statsFile = join(ROOT, config.record?.dir || 'records', 'runtime.json');
      let stats = { connected: false, repliesToday: 0, lastReplyAt: 0, lastFrom: '' };
      if (existsSync(statsFile)) {
        try { stats = JSON.parse(readFileSync(statsFile, 'utf8')); } catch { /* keep defaults */ }
      }
      sendJson(res, { running: !!botProc, ...stats });
      return;
    }
    if (path === '/api/logs' && req.method === 'GET') {
      sendJson(res, { logs: botLog });
      return;
    }

    // ---------- 小本本 ----------
    if (path === '/api/notebook/list' && req.method === 'GET') {
      const { listNotebooks } = await import('./notebook.js');
      sendJson(res, { ok: true, people: listNotebooks() });
      return;
    }
    if (path === '/api/notebook/get' && req.method === 'GET') {
      const userId = url.searchParams.get('userId') || '';
      if (!userId) { sendJson(res, { ok: false, error: '缺少 userId' }); return; }
      const { loadNotebook, notebookStats } = await import('./notebook.js');
      const nb = loadNotebook(userId);
      sendJson(res, {
        ok: true, userId, name: nb.name,
        notes: [...nb.notes].reverse(),
        stats: notebookStats(userId),
        strategy: nb.strategy || null
      });
      return;
    }
    if (path === '/api/notebook/strategy' && req.method === 'POST') {
      const body = await readBody(req);
      const userId = String(body.userId || '');
      if (!userId) { sendJson(res, { ok: false, error: '缺少 userId' }); return; }
      const { refreshStrategy } = await import('./notebook-writer.js');
      const r = await refreshStrategy(config, userId);
      sendJson(res, r.ok ? { ok: true, strategy: r.strategy } : { ok: false, error: r.reason });
      return;
    }
    if (path === '/api/notebook/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const { removeNote } = await import('./notebook.js');
      const ok = removeNote(String(body.userId || ''), String(body.id || ''));
      sendJson(res, { ok });
      return;
    }
    if (path === '/api/notebook/add' && req.method === 'POST') {
      const body = await readBody(req);
      const { addNote } = await import('./notebook.js');
      const r = addNote(String(body.userId || ''), {
        kind: body.kind, gist: body.gist, quote: body.quote,
        place: body.place || 'manual', intensity: body.intensity
      });
      sendJson(res, r.ok ? { ok: true, note: r.note } : { ok: false, error: r.reason });
      return;
    }
    if (path === '/api/notebook/clear' && req.method === 'POST') {
      const body = await readBody(req);
      const userId = String(body.userId || '');
      const { loadNotebook, saveNotebook } = await import('./notebook.js');
      const nb = loadNotebook(userId);
      nb.notes = [];
      saveNotebook(userId, nb);
      sendJson(res, { ok: true });
      return;
    }

    // 让面板自己重启（改完代码不用请用户去关窗口）。
    // 新进程继承同样的权限，所以不需要再弹 UAC。
    if (path === '/api/panel/restart' && req.method === 'POST') {
      sendJson(res, { ok: true, note: '面板正在重启，2 秒后刷新页面即可。' });
      setTimeout(() => {
        try {
          const child = spawn(process.execPath, [process.argv[1] || 'src/web-ui.js'], {
            cwd: ROOT, detached: true, stdio: 'ignore', env: process.env
          });
          child.unref();
          log('[panel] 已拉起新实例，旧实例退出');
        } catch (e) {
          log('[panel] 重启失败: ' + e.message);
        }
        process.exit(0);
      }, 300);
      return;
    }

    if (path === '/api/napcat/start' && (req.method === 'POST' || req.method === 'GET')) {
      sendJson(res, await startNapcat());
      return;
    }

    // NapCat WebUI 的地址和 token —— 用户不知道 token 去哪儿找，这里直接给出来
    if (path === '/api/napcat/webui' && (req.method === 'GET' || req.method === 'POST')) {
      sendJson(res, napcatWebuiInfo());
      return;
    }

    // 端口/进程实时状态，给面板轮询用
    if (path === '/api/napcat/state' && (req.method === 'GET' || req.method === 'POST')) {
      const [webui, ws] = await Promise.all([probePort(6099), probePort(3001)]);
      const qq = spawn('tasklist', ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/NH'], { windowsHide: true });
      let out = '';
      qq.stdout.on('data', (c) => { out += c; });
      const boot = await new Promise((done) => {
        qq.on('close', () => done(/NapCatWinBootMain/i.test(out)));
        qq.on('error', () => done(false));
      });
      sendJson(res, { ok: true, webui, loggedIn: ws, bootRunning: boot });
      return;
    }

    // ---------- NapCat / QQ 掉线重启 ----------
    if (path === '/api/napcat/restart' && req.method === 'POST') {
      // 先停 bot（它会一直重连刷日志）
      stopBot();
      try {
        const { tryRestartNapCat } = await import('./drop-alert.js');
        const r = tryRestartNapCat({ log: (m) => log(m) });
        sendJson(res, {
          ok: r.ok,
          method: r.method,
          error: r.error,
          note: r.method === 'task' ? '已通过计划任务重启（免 UAC）'
              : r.method === 'direct' ? '已直接重启'
              : r.method === 'uac' ? '已弹出 UAC 确认框，请点「是」'
              : '重启失败'
        });
      } catch (e) {
        sendJson(res, { ok: false, error: e.message });
      }
      return;
    }
    if (path === '/api/diag' && req.method === 'GET') {
      const { readDiagnostics, DIAG_FILE } = await import('./drop-diagnose.js');
      sendJson(res, { ok: true, file: DIAG_FILE, records: readDiagnostics(5) });
      return;
    }
    if (path === '/api/diag/snapshot' && req.method === 'POST') {
      const { snapshot } = await import('./drop-diagnose.js');
      const text = snapshot('手动触发（用于测试）');
      sendJson(res, { ok: true, text });
      return;
    }
    if (path === '/api/napcat/health' && req.method === 'GET') {
      // 检查 NapCat 是否真的在工作（端口 + QQ 在线状态）
      const { OneBotClient } = await import('./onebot.js');
      const c = new OneBotClient(config.onebot);
      const out = { listening: false, online: null, error: null };
      // 先看端口
      try {
        const net = await import('node:net');
        out.listening = await new Promise((resolve) => {
          const s = net.createConnection({ host: config.onebot.host, port: config.onebot.port }, () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false));
          setTimeout(() => { s.destroy(); resolve(false); }, 3000);
        });
      } catch { /* 忽略 */ }

      if (out.listening) {
        try {
          await new Promise((res2, rej) => {
            const t = setTimeout(() => rej(new Error('连接超时')), 6000);
            c.once('status', (kind) => { if (kind === 'connected') { clearTimeout(t); res2(); } });
            c.start();
          });
          const r = await c.call('get_status', {}, 8000);
          out.online = r?.data?.online ?? null;
        } catch (e) {
          out.error = e.message;
        } finally {
          try { c.stop(); } catch {}
        }
      }
      // 计划任务是否已授权
      let taskReady = false;
      try {
        const { execSync } = await import('node:child_process');
        const q = execSync('schtasks /Query /TN "QQBot_NapCatRestart"', { encoding: 'utf8', stdio: 'pipe' });
        taskReady = !!q && !/错误|ERROR/i.test(q);
      } catch { taskReady = false; }

      sendJson(res, { ok: true, ...out, taskReady });
      return;
    }
    if (path === '/api/napcat/status' && req.method === 'GET') {
      sendJson(res, {
        configured: !!(config.napcat?.command),
        running: !!napcatProc,
        command: config.napcat?.command || null
      });
      return;
    }

    // ---------- 群聊 ----------
    if (path === '/api/group/live' && req.method === 'GET') {
      // 直接问 OneBot 要群列表/好友列表（bot 没在跑时会超时失败，面板会提示）
      const { OneBotClient } = await import('./onebot.js');
      const c = new OneBotClient(config.onebot);
      const result = { ok: false, groups: [], friends: [], error: null };
      try {
        await new Promise((res2, rej) => {
          const t = setTimeout(() => rej(new Error('连接 OneBot 超时（机器人可能没在运行）')), 6000);
          c.once('status', (kind, d) => {
            if (kind === 'connected') { clearTimeout(t); res2(); }
          });
          c.on('error', () => {});
          c.start();
        });
        const [groups, friends] = await Promise.all([c.getGroupList(), c.getFriendList()]);
        result.ok = true;
        result.groups = groups.map((g) => ({ group_id: String(g.group_id), group_name: g.group_name, member_count: g.member_count, max_member_count: g.max_member_count }));
        result.friends = friends.map((f) => ({ user_id: String(f.user_id), nickname: f.nickname || f.remark || '' }));
      } catch (e) {
        result.error = e.message;
      } finally {
        try { c.stop(); } catch {}
      }
      sendJson(res, result);
      return;
    }
    if (path === '/api/group/status' && req.method === 'GET') {
      const g = config.bot.group || {};
      sendJson(res, {
        enabled: !!g.enabled,
        allowedGroups: g.allowedGroups || [],
        replyWhenAt: g.replyWhenAt !== false,
        autoJudge: g.autoJudge !== false,
        judgeThreshold: g.judgeThreshold ?? 3,
        replyCooldownMs: g.replyCooldownMs ?? 20000,
        maxRepliesPerGroupPerHour: g.maxRepliesPerGroupPerHour ?? 20,
        judgeModel: g.judgeModel || ''
      });
      return;
    }

    if (path === '/api/qq/upgrade' && req.method === 'POST') {
      const ps1 = join(ROOT, 'tools', 'upgrade-qq.ps1');
      // Launch the upgrade script with elevation (UAC prompt on the user's screen).
      const psCmd = `Start-Process -FilePath "powershell.exe" -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${ps1}"' -Verb RunAs`;
      try {
        spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        sendJson(res, { ok: true, note: '已发起 QQ 升级，请在 UAC 弹窗点「是」，安装完成后重新登录 QQ。' });
      } catch (e) {
        sendJson(res, { ok: false, error: 'QQ 升级启动失败: ' + e.message });
      }
      return;
    }

    if (path === '/api/record/set' && req.method === 'POST') {
      const body = await readBody(req);
      recorder.setEnabled(!!body.enabled);
      sendJson(res, { ok: true, enabled: recorder.isEnabled() });
      return;
    }
    if (path === '/api/record/status' && req.method === 'GET') {
      sendJson(res, { enabled: recorder.isEnabled(), users: recorder.usersOnRecord() });
      return;
    }
    if (path === '/api/record/export' && req.method === 'POST') {
      const body = await readBody(req);
      const userId = String(body.userId || '').trim();
      if (!userId) { sendJson(res, { ok: false, error: '需要目标 QQ 号' }); return; }
      const pathOut = recorder.exportFor(userId);
      const my = recorder.myMessages(userId);
      const them = recorder.theirMessages(userId);
      sendJson(res, { ok: true, path: pathOut, myCount: my.length, themCount: them.length });
      return;
    }
    if (path === '/api/record/style' && req.method === 'POST') {
      const body = await readBody(req);
      const userId = String(body.userId || '').trim();
      const samples = Array.isArray(body.samples) && body.samples.length
        ? body.samples
        : recorder.myMessages(userId);
      if (!samples.length) {
        sendJson(res, { ok: false, error: '没有「我的消息」可分析——先录制会话并导出，或直接用「粘贴我的消息」方式提供样本。' });
        return;
      }
      try {
        const style = await analyzeStyle(samples, config);
        sendJson(res, { ok: true, style });
      } catch (e) {
        sendJson(res, { ok: false, error: '风格分析失败: ' + e.message });
      }
      return;
    }
    if (path === '/api/record/applyStyle' && req.method === 'POST') {
      const body = await readBody(req);
      const styleDesc = String(body.style || '').trim();
      if (!styleDesc) { sendJson(res, { ok: false, error: '缺少风格描述' }); return; }
      const saved = saveConfig({ persona: { stylePrompt: styleDesc } });
      for (const [k, v] of Object.entries(saved)) config[k] = v;
      sendJson(res, { ok: true, personaPreview: buildPersona(config).slice(0, 400) });
      return;
    }
    if (path === '/api/persona' && req.method === 'GET') {
      sendJson(res, { persona: buildPersona(config, 'private') });
      return;
    }

    // ---------- 性格（可视化编辑） ----------
    if (path === '/api/persona/meta' && req.method === 'GET') {
      sendJson(res, {
        presets: PRESETS.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, intro: p.intro, style: p.style, params: p.params })),
        paramMeta: PARAM_META,
        stickerLevels: Object.entries(STICKER_LEVELS).map(([id, v]) => ({ id, label: v.label, desc: v.desc })),
        current: {
          preset: config.persona?.preset || 'custom',
          customStyle: config.persona?.customStyle || '',
          params: config.persona?.params || {},
          catchphrases: config.persona?.catchphrases || [],
          forbiddenWords: config.persona?.forbiddenWords || [],
          botNickname: config.persona?.botNickname || '',
          ownerCall: config.persona?.ownerCall || '',
          stylePrompt: config.persona?.stylePrompt || ''
        }
      });
      return;
    }
    if (path === '/api/persona/save' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      for (const k of ['preset', 'customStyle', 'params', 'catchphrases', 'forbiddenWords', 'botNickname', 'ownerCall', 'owner']) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      const saved = saveConfig({ persona: patch });
      for (const [k, v] of Object.entries(saved)) config[k] = v;
      sendJson(res, { ok: true, preview: buildPersona(config, 'private') });
      return;
    }
    if (path === '/api/persona/preview' && req.method === 'POST') {
      const body = await readBody(req);
      // 用「当前配置 + 传入的改动」临时算一次提示词，不写盘
      const tmp = JSON.parse(JSON.stringify(config));
      tmp.persona = { ...tmp.persona, ...(body.persona || body) };
      if (body.bot) tmp.bot = { ...tmp.bot, ...body.bot };
      const scene = body.scene === 'group' ? 'group' : 'private';
      sendJson(res, { ok: true, prompt: buildPersona(tmp, scene), length: buildPersona(tmp, scene).length });
      return;
    }
    if (path === '/api/persona/describe' && req.method === 'GET') {
      const scene = url.searchParams.get('scene') === 'group' ? 'group' : 'private';
      sendJson(res, describePersona(config, scene));
      return;
    }

    // ---------- 表情包 ----------
    if (path === '/api/sticker/summary' && req.method === 'GET') {
      try { ensureStickerDir(config); } catch (e) {}
      const s = stickerSummary(config);
      sendJson(res, { ok: true, ...s, dir: stickerDir(config), faceTable: FACE_TABLE });
      return;
    }

    // ---------- 自动抓取的表情包 ----------
    if (path === '/api/sticker/caught' && req.method === 'GET') {
      const { caughtStats } = await import('./sticker-catcher.js');
      const st = caughtStats(config);
      sendJson(res, { ok: true, count: st.count, bytes: st.bytes, dir: st.dir });
      return;
    }
    if (path === '/api/sticker/caught/clear' && req.method === 'POST') {
      const { clearCaught } = await import('./sticker-catcher.js');
      const r = clearCaught(config);
      sendJson(res, { ok: true, removed: r.removed });
      return;
    }
    if (path === '/api/sticker/list' && req.method === 'GET') {
      try { ensureStickerDir(config); } catch (e) {}
      const s = scanStickers(config);
      sendJson(res, {
        ok: true,
        dir: s.dir,
        count: s.count,
        missing: !!s.missing,
        images: s.images.map((i) => ({ rel: i.rel, name: i.name, tags: i.tags, size: i.size })),
        tags: s.tags
      });
      return;
    }
    if (path === '/api/sticker/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const rel = String(body.rel || '');
      const base = resolve(stickerDir(config));
      const full = resolve(base, rel);
      if (!rel || !full.startsWith(base) || !existsSync(full)) { sendJson(res, { ok: false, error: '文件不存在或路径非法' }); return; }
      if (!IMAGE_EXT.has(extname(full).toLowerCase())) { sendJson(res, { ok: false, error: '只能删图片' }); return; }
      try { unlinkSync(full); sendJson(res, { ok: true }); }
      catch (e) { sendJson(res, { ok: false, error: e.message }); }
      return;
    }
    if (path === '/api/sticker/test' && req.method === 'POST') {
      const body = await readBody(req);
      const kw = String(body.keyword || '笑死');
      const { pickSticker } = await import('./stickers.js');
      const r = pickSticker(config, kw, {});
      sendJson(res, r.ok ? { ok: true, rel: r.rel, matched: r.matched } : { ok: false, error: r.reason });
      return;
    }
    if (path === '/api/sticker/open-dir' && (req.method === 'POST' || req.method === 'GET')) {
      const dir = ensureStickerDir(config);
      try {
        spawn('explorer.exe', [dir], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        sendJson(res, { ok: true, dir });
      } catch (e) { sendJson(res, { ok: false, error: e.message }); }
      return;
    }
    if (path === '/api/sticker/parse-test' && req.method === 'POST') {
      // 输入一段带标记的回复，看会被解析成什么动作（不真发）
      const body = await readBody(req);
      const { pickSticker } = await import('./stickers.js');
      const actions = parseReply(String(body.reply || ''), (kw) => pickSticker(config, kw, {}), {
        allowSticker: config.bot.sticker?.enabled !== false,
        allowFace: config.bot.sticker?.allowFace !== false
      });
      sendJson(res, { ok: true, actions, counters: countMarkers(String(body.reply || '')) });
      return;
    }

    // ---------- LLM 双通道 ----------
    if (path === '/api/llm/info' && req.method === 'GET') {
      const reply = resolveProvider(config, 'reply');
      const judge = resolveProvider(config, 'judge');
      const style = resolveProvider(config, 'style');
      sendJson(res, {
        ok: true,
        llm: config.llm || {},
        deepseek: { baseUrl: config.deepseek?.baseUrl, model: config.deepseek?.model, hasKey: !!config.deepseek?.apiKey },
        resolved: { reply, judge, style }
      });
      return;
    }
    if (path === '/api/llm/test' && req.method === 'POST') {
      const body = await readBody(req);
      const tmp = JSON.parse(JSON.stringify(config));
      // 允许面板里「还没保存就测试」
      if (body.llm) tmp.llm = { ...tmp.llm, ...body.llm, openai: { ...(tmp.llm?.openai || {}), ...(body.llm?.openai || {}) } };
      if (body.deepseek) tmp.deepseek = { ...tmp.deepseek, ...body.deepseek };
      const which = body.purpose || 'reply';
      const r = await testProvider(tmp, which);
      sendJson(res, r);
      return;
    }
    if (path === '/api/llm/models' && req.method === 'POST') {
      const body = await readBody(req);
      const tmp = JSON.parse(JSON.stringify(config));
      if (body.llm) tmp.llm = { ...tmp.llm, ...body.llm, openai: { ...(tmp.llm?.openai || {}), ...(body.llm?.openai || {}) } };
      const r = await listModels(tmp, body.purpose || 'reply');
      sendJson(res, r);
      return;
    }
    if (path === '/api/style/clear' && req.method === 'POST') {
      const saved = saveConfig({ persona: { stylePrompt: '' } });
      for (const [k, v] of Object.entries(saved)) config[k] = v;
      const marker = resolve(ROOT, '.style_learned');
      if (existsSync(marker)) { try { rmSync(marker, { force: true }); } catch {} }
      sendJson(res, { ok: true, note: '已清空已学风格并移除学习标记；重启机器人会重新学。' });
      return;
    }
    if (path === '/api/style/relearn' && req.method === 'POST') {
      const saved = saveConfig({ persona: { stylePrompt: '' } });
      for (const [k, v] of Object.entries(saved)) config[k] = v;
      const marker = resolve(ROOT, '.style_learned');
      if (existsSync(marker)) { try { rmSync(marker, { force: true }); } catch {} }
      stopBot();
      setTimeout(() => startBot(), 900);
      sendJson(res, { ok: true, note: '已清空已学风格并重启机器人，正在从历史重新学…' });
      return;
    }

    sendJson(res, { ok: false, error: 'not found' }, 404);
  } catch (e) {
    sendJson(res, { ok: false, error: e.message }, 500);
  }
});

function serveStatic(res, filePath) {
  try {
    if (!existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ui] control panel: http://127.0.0.1:${PORT}`);
  // 面板一启动就把机器人拉起来。
  // 以前只有 /api/bot/start 才会起 bot，于是「一键启动.bat」实际只起了 NapCat + 面板，
  // 机器人一直没跑 —— 界面全绿但不回消息，非常难查。这里补上，语义才对：
  // 双击一次 = NapCat + 面板 + 机器人 三件套全起。
  // 3001 还没通也没关系，bot.js 自己会每 3 秒重连。
  if (config.bot?.autoStart !== false) {
    setTimeout(() => {
      try {
        const r = startBot();
        log(`[autoStart] bot ${r.pid ? `started (pid ${r.pid})` : 'already running'}`);
      } catch (e) {
        log('[autoStart] 启动机器人失败: ' + e.message);
      }
    }, 1500);
  }
  if (process.env.QQUI_NO_OPEN !== '1') {
    // Auto-open the default browser (robust method).
    try {
      spawn('powershell', ['-NoProfile', '-Command', `Start-Process 'http://127.0.0.1:${PORT}'`], { windowsHide: true, stdio: 'ignore' });
    } catch (e) { /* ignore */ }
  }
});
