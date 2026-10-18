/**
 * 单实例锁：防止两个机器人同时连 NapCat。
 *
 * 为什么需要：两个实例同时跑，每条消息会被处理两遍（各自回一遍），
 * 而且两边上下文互相污染，回复会变成乱码/胡言乱语。
 *
 * 做法：启动时在 records/ 下写一个 .lock 文件记录自己的 pid；
 * 如果发现锁存在且那个进程还活着，就退出。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

let lockPath = null;

/** 进程还活着吗 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';   // 存在但没权限，也算活着
  }
}

/**
 * 尝试获取锁。
 * @returns {{ok:true}|{ok:false, pid:number}}
 */
export function acquireLock(dir = 'records') {
  mkdirSync(dir, { recursive: true });
  lockPath = resolve(join(dir, '.bot.lock'));

  if (existsSync(lockPath)) {
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8'));
      const pid = Number(info.pid);
      if (pid && pid !== process.pid && isAlive(pid)) {
        return { ok: false, pid };
      }
      // 陈旧锁（进程已经没了），可以接管
    } catch { /* 文件坏了，直接覆盖 */ }
  }

  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString()
  }), 'utf8');
  return { ok: true };
}

/** 释放锁（退出时调用） */
export function releaseLock() {
  try {
    if (!lockPath || !existsSync(lockPath)) return;
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (Number(info.pid) === process.pid) unlinkSync(lockPath);
  } catch { /* 忽略 */ }
}

/** 退出时自动释放 */
export function autoRelease() {
  for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
    process.on(sig, () => { releaseLock(); if (sig !== 'exit') process.exit(0); });
  }
}
