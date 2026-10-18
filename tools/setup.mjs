#!/usr/bin/env node
/**
 * QQ 自动回复机器人 —— 第一次使用向导
 *
 * 由上一层的 setup.bat 调用，也可以直接跑：
 *     node tools/setup.mjs            自检 + 引导配置
 *     node tools/setup.mjs --check    只自检，不问问题、不写文件
 *
 * 它会做四件事：
 *   1. 检查运行环境（Node / 依赖 / NapCat / QQ / 配置文件）
 *   2. 缺 config.json 时，用问答帮你生成一份能直接跑的
 *   3. 按你的 QQ 号写好 NapCat 的 OneBot11 配置（WebSocket 固定在 3001）
 *   4. 生成 napcat\launcher-autologin.bat（下次启动免扫码）
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHECK_ONLY = process.argv.includes('--check');

/* ------------------------------------------------------------------ */
/*  终端输出                                                           */
/* ------------------------------------------------------------------ */

const TTY = Boolean(process.stdout.isTTY);
const paint = (code, s) => (TTY ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = (s) => paint(1, s);
const dim = (s) => paint(2, s);
const red = (s) => paint(31, s);
const green = (s) => paint(32, s);
const yellow = (s) => paint(33, s);
const cyan = (s) => paint(36, s);

const W = 64;
const out = (s = '') => console.log(s);
const line = () => out(dim('─'.repeat(W)));

function banner() {
  out('');
  out(cyan('═'.repeat(W)));
  out('  ' + bold('QQ 自动回复机器人 —— 第一次使用向导'));
  out(cyan('═'.repeat(W)));
  out('');
  out(dim('  这个向导会检查环境、生成配置。全程只问几个问题。'));
  out(dim('  出错了也不会弄坏东西，随时可以重新运行。'));
}

function section(no, text) {
  out('');
  out(cyan(`【${no}】`) + ' ' + bold(text));
  line();
}

const markOk = () => green('  ✓');
const markBad = () => red('  ✗');
const markWarn = () => yellow('  !');

/* ------------------------------------------------------------------ */
/*  输入                                                               */
/* ------------------------------------------------------------------ */

// 说明 1：不用 rl.question()，因为它只在「事件到达的瞬间」有监听器时才能收到那一行。
// 当输入是管道/重定向时，Node 会一口气把整个文件读完并连发好几个 'line'，
// 除了第一个问题以外的答案全都会被丢掉（旧版就是这么静默退出、config.json 也没生成的）。
// 这里改成常驻 'line' 监听 + 队列：先到的行排队，后面问什么问题都能取到。
//
// 说明 2：terminal 必须写死 false（哪怕 stdin 是 TTY）。
// readline 在 terminal:true 时会调用 stdin.setRawMode(true)，把控制台切成原始输入模式，
// 那样 Windows 控制台的「右键粘贴 / Ctrl+V」就全失效了 —— 用户粘不进 API Key 就是这个原因。
// terminal:false 时控制台保持正常行输入模式，粘贴、退格、方向键都由控制台自己处理，
// Node 收到的已经是编辑好的一整行，readline 只管按行切分。
const INTERACTIVE = Boolean(process.stdin.isTTY);
let rl = null;
const lineQueue = [];
let waiter = null;
let inputEnded = false;

function getRl() {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    rl.on('line', (l) => {
      if (waiter) { const w = waiter; waiter = null; w(l); }
      else lineQueue.push(l);
    });
    rl.on('close', () => {
      inputEnded = true;
      if (waiter) { const w = waiter; waiter = null; w(null); }
    });
  }
  return rl;
}
function closeRl() {
  if (rl) { rl.removeAllListeners(); rl.close(); rl = null; }
}

function nextLine() {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputEnded) return Promise.resolve(null);
  return new Promise((resolve) => { waiter = resolve; });
}

async function ask(q) {
  getRl();
  process.stdout.write(q);
  const a = await nextLine();
  if (a === null) {
    out('');
    out(yellow('  没有收到输入，向导提前结束了。'));
    out(yellow('  请直接双击「第一次用点我.bat」，在窗口里回答这几个问题。'));
    closeRl();
    process.exit(2);
  }
  return String(a).trim();
}

async function askDefault(q, def) {
  const a = await ask(`${q} ${dim('[' + def + ']')}: `);
  return a || def;
}
async function askYesNo(q, defYes = true) {
  const hint = defYes ? 'Y/n' : 'y/N';
  const a = (await ask(`${q} ${dim('[' + hint + ']')}: `)).toLowerCase();
  if (!a) return defYes;
  return ['y', 'yes', '是', '好', '1', '对'].includes(a);
}
async function askQQ(q) {
  for (;;) {
    const a = await ask(q);
    if (/^\d{5,12}$/.test(a)) return a;
    out(red('    QQ 号看起来不对，应该是 5~12 位数字。再试一次。'));
  }
}

/* ------------------------------------------------------------------ */
/*  环境检查                                                           */
/* ------------------------------------------------------------------ */

function findQQExe() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQNT',
  ];
  for (const key of keys) {
    try {
      const raw = execFileSync('reg', ['query', key, '/v', 'UninstallString'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
        windowsHide: true,
      });
      const m = raw.match(/UninstallString\s+REG_SZ\s+(.+)/i);
      if (!m) continue;
      const dir = path.dirname(m[1].trim().replace(/^"|"$/g, ''));
      const exe = path.join(dir, 'QQ.exe');
      if (fs.existsSync(exe)) return exe;
    } catch { /* 查不到就跳过 */ }
  }
  return null;
}

function checkEnvironment() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const wsPkg = path.join(ROOT, 'node_modules', 'ws', 'package.json');
  const napcatDir = path.join(ROOT, 'napcat');
  const launcherExe = path.join(napcatDir, 'NapCatWinBootMain.exe');
  const napcatMain = path.join(napcatDir, 'napcat.mjs');
  const bundledNode = path.join(ROOT, 'runtime', 'node', 'node.exe');

  return {
    node: { version: process.version, major: nodeMajor, ok: nodeMajor >= 18 },
    bundledNode: { path: bundledNode, ok: fs.existsSync(bundledNode) },
    ws: { path: wsPkg, ok: fs.existsSync(wsPkg) },
    napcat: {
      dir: napcatDir,
      ok: fs.existsSync(launcherExe) && fs.existsSync(napcatMain),
      launcher: launcherExe,
    },
    qq: { exe: findQQExe() },
    config: { path: path.join(ROOT, 'config.json'), exists: fs.existsSync(path.join(ROOT, 'config.json')) },
  };
}

function printReport(r) {
  section(1, '运行环境检查');

  out(`${markOk()} Node.js  ${bold(r.node.version)}` +
    (r.node.ok ? '' : '   ' + red('版本太老，需要 18 或更高')));
  if (r.bundledNode.ok) out(dim('      用的是包里自带的，不用另外装'));

  out(`${r.ws.ok ? markOk() : markBad()} 依赖模块 ws` +
    (r.ws.ok ? '' : '   ' + red('缺失！机器人无法连接 NapCat')));

  out(`${r.napcat.ok ? markOk() : markBad()} NapCat  ${r.napcat.ok ? '' : red('缺失，请确认 napcat 文件夹完整')}`);

  out(`${r.qq.exe ? markOk() : markWarn()} 电脑上的 QQ  ${r.qq.exe ? dim(path.dirname(r.qq.exe)) : yellow('没找到 —— NapCat 必须依赖电脑版 QQ')}`);

  out(`${r.config.exists ? markOk() : markWarn()} 配置文件 config.json  ${r.config.exists ? '' : yellow('还没有，下面帮你生成')}`);

  return r.node.ok && r.ws.ok && r.napcat.ok;
}

/* ------------------------------------------------------------------ */
/*  生成文件                                                           */
/* ------------------------------------------------------------------ */

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function oneBotConfig() {
  return {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [
        {
          enable: true,
          name: 'qq-auto-reply',
          host: '127.0.0.1',
          port: 3001,
          reportSelfMessage: true,
          enableForcePushEvent: true,
          messagePostFormat: 'array',
          token: '',
          debug: false,
          heartInterval: 1500,
        },
      ],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: {
      baseTimeout: 10000,
      uploadSpeedKBps: 256,
      downloadSpeedKBps: 256,
      maxTimeout: 1800000,
    },
  };
}

function napcatGlobalConfig() {
  return {
    fileLog: false,
    consoleLog: true,
    fileLogLevel: 'info',
    consoleLogLevel: 'info',
    packetBackend: 'auto',
    packetServer: '',
    o3HookMode: 1,
    bypass: { hook: false, window: false, module: false, process: false, container: false, js: false },
  };
}

/** 从模板生成真正可用的自动登录启动器 */
function writeAutologinLauncher(qq) {
  const tpl = path.join(ROOT, 'napcat-launcher-autologin.bat');
  const dest = path.join(ROOT, 'napcat', 'launcher-autologin.bat');
  if (!fs.existsSync(tpl)) return null;

  let text = fs.readFileSync(tpl, 'utf8');
  text = text.replace(/PUT_YOUR_QQ_HERE/g, qq);
  text = text.replace(/^title NapCat Auto Login\s*$/m, `title NapCat Auto Login (${qq})`);
  // 统一成 CRLF —— cmd 解析多行 if 块时必须的
  text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text, 'utf8');
  return dest;
}

/* ------------------------------------------------------------------ */
/*  问答：生成 config.json                                             */
/* ------------------------------------------------------------------ */

async function buildConfig() {
  const tmplPath = path.join(ROOT, 'config.example.json');
  const cfgPath = path.join(ROOT, 'config.json');

  if (!fs.existsSync(tmplPath)) {
    throw new Error('找不到 config.example.json，压缩包可能不完整');
  }

  out('');
  out(dim('  第一个问题：机器人用哪个 QQ 号？'));
  out(dim('  （就是你要挂机器人那个号，不是你自己常用的号也行）'));
  const botQQ = await askQQ('  机器人 QQ 号: ');

  out('');
  out(dim('  第二个问题：你自己的 QQ 号（主人）。'));
  out(dim('  填了才能用 /状态 /闭嘴 这些指令，也能让机器人对你更亲近。'));
  const ownerQQ = await askDefault('  你的 QQ 号', botQQ);

  out('');
  out(dim('  第三个问题：DeepSeek 的 API Key。'));
  out(dim('  去 https://platform.deepseek.com/api_keys 创建，形如 sk-xxxxxxxx'));
  out(dim('  粘贴：在这个黑窗口里按鼠标右键即可（Ctrl+V 也行）。'));
  out(dim('  直接回车可以先跳过，之后在面板「⑤ API 通道」里填也一样。'));
  const apiKey = await ask('  API Key: ');

  out('');
  const groups = await askYesNo('  要不要让它在群里也能回复？', false);

  const cfg = JSON.parse(fs.readFileSync(tmplPath, 'utf8'));

  cfg.deepseek.apiKey = apiKey || 'sk-在这里填你的API密钥';
  cfg.bot.admin = [ownerQQ];
  cfg.bot.allowedUsers = ['*'];
  if (cfg.bot.learnStyle) cfg.bot.learnStyle.userId = ownerQQ;
  if (cfg.bot.lowBalance) cfg.bot.lowBalance.notifyAdmin = ownerQQ;
  if (cfg.persona?.owner) cfg.persona.owner.userIds = [ownerQQ];
  cfg.bot.group.enabled = groups;
  cfg.napcat.command = path.join(ROOT, 'napcat', 'launcher-autologin.bat');

  writeJson(cfgPath, cfg);
  return { botQQ, ownerQQ, apiKey: Boolean(apiKey), groups, cfgPath };
}

/* ------------------------------------------------------------------ */
/*  主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  banner();

  const report = checkEnvironment();
  const envOk = printReport(report);

  if (CHECK_ONLY) {
    closeRl();
    out('');
    out(envOk ? green('  自检通过。') : red('  自检发现问题，见上面。'));
    out('');
    process.exit(envOk ? 0 : 1);
  }

  /* ---- 2. 配置文件 ---- */
  let answers = null;
  if (!report.config.exists) {
    section(2, '生成配置文件');
    answers = await buildConfig();
  } else {
    section(2, '配置文件');
    out(`${markOk()} config.json 已存在，跳过。`);
    const again = await askYesNo('  要重新配置一遍吗？（会覆盖现有配置）', false);
    if (again) answers = await buildConfig();
  }

  /* ---- 3. NapCat 配置 ---- */
  section(3, 'NapCat 配置（让机器人能连上 QQ）');

  const napcatConfigDir = path.join(ROOT, 'napcat', 'config');
  const globalCfg = path.join(napcatConfigDir, 'napcat.json');
  if (!fs.existsSync(globalCfg)) {
    writeJson(globalCfg, napcatGlobalConfig());
    out(`${markOk()} 已写入 napcat\\config\\napcat.json`);
  } else {
    out(`${markOk()} napcat\\config\\napcat.json 已存在，保留`);
  }

  let botQQ = answers?.botQQ || null;
  if (!botQQ) {
    const existing = fs.existsSync(napcatConfigDir)
      ? fs.readdirSync(napcatConfigDir).filter((f) => /^onebot11_\d+\.json$/.test(f))
      : [];
    const m = existing[0]?.match(/_(\d+)\.json$/);
    if (m) botQQ = m[1];
  }

  if (botQQ) {
    const onebotFile = path.join(napcatConfigDir, `onebot11_${botQQ}.json`);
    if (!fs.existsSync(onebotFile)) {
      writeJson(onebotFile, oneBotConfig());
      out(`${markOk()} 已写入 napcat\\config\\onebot11_${botQQ}.json`);
      out(dim(`      WebSocket 服务端口固定 3001，机器人就连这里`));
    } else {
      out(`${markOk()} napcat\\config\\onebot11_${botQQ}.json 已存在，保留`);
    }

    const launcher = writeAutologinLauncher(botQQ);
    if (launcher) {
      out(`${markOk()} 已生成 napcat\\launcher-autologin.bat（绑定 ${botQQ}，下次启动免扫码）`);
    }
  } else {
    out(`${markWarn()} 没拿到机器人 QQ 号，跳过 OneBot11 配置。`);
    out(dim('      首次登录后 NapCat 会自己生成，但端口默认可能不是 3001，'));
    out(dim('      到时候在 http://127.0.0.1:6099 里确认一下。'));
  }

  /* ---- 4. 目录 ---- */
  for (const d of ['notebooks', 'records', 'stickers', 'exports']) {
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  }

  /* ---- 5. 总结 ---- */
  section(4, '检查结果');

  const problems = [];
  if (!report.node.ok) problems.push('Node.js 版本过低');
  if (!report.ws.ok) problems.push('缺少 node_modules\\ws');
  if (!report.napcat.ok) problems.push('napcat 文件夹不完整');
  if (!report.qq.exe) problems.push('电脑上没装 QQ');
  if (answers && !answers.apiKey) problems.push('还没有填 DeepSeek API Key');

  if (problems.length === 0) {
    out(green('  一切就绪，可以开始用了。'));
  } else {
    out(yellow('  还有这些问题要处理：'));
    for (const p of problems) out('    · ' + p);
  }

  out('');
  out('  ' + bold('下一步：'));
  out('');
  out('  · 如果你是从 ' + bold('一键启动.bat') + ' 过来的：');
  out('    什么都不用做，它已经接手了，等十几秒就全自动起来。');
  out('');
  out('  · 如果你是单独跑的 ' + bold('setup.bat') + '：');
  out('    双击 ' + bold('一键启动.bat') + '（它会自己提权、起 QQ/NapCat、起机器人）。');
  out('    第一次会弹 QQ 登录窗口，用手机 QQ 扫一下登录机器人号。');
  out('    面板地址：http://127.0.0.1:4399');
  out('');
  out('  用你自己的 QQ 给机器人发条消息就能试了。');
  out('');
  out(dim('  「QQ 机器人控制面板」和「NapCat Auto Login」这两个窗口别关，关了机器人就停了。'));
  out(dim('  详细说明看 README.md，每个 bat 干嘛的看「脚本对照表.md」。'));
  out('');

  closeRl();
}

main().catch((err) => {
  closeRl();
  out('');
  out(red('  出错了：' + (err?.message || err)));
  out(dim('  可以把上面这段发给分享给你的人。'));
  out('');
  process.exit(1);
});

process.on('SIGINT', () => {
  closeRl();
  out('');
  out(dim('  已取消。'));
  process.exit(130);
});
