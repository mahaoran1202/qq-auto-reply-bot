import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

/**
 * Minimal OneBot v11 client over forward WebSocket (client connects to
 * NapCat/Lagrange's ws server). Handles auth, reconnect, message events
 * and a small action API.
 */
export class OneBotClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg; // { mode, host, port, accessToken, reconnectDelayMs }
    this.ws = null;
    this.closed = false;
    this.echoCounter = 0;
    this.pending = new Map();
  }

  url() {
    const { mode, host, port, accessToken } = this.cfg;
    const token = accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : '';
    return `ws://${host}:${port}${token}`;
  }

  start() {
    const url = this.url();
    const headers = {};
    if (this.cfg.accessToken) headers['Authorization'] = `Bearer ${this.cfg.accessToken}`;

    const ws = new WebSocket(url, { headers });
    this.ws = ws;

    ws.on('open', () => {
      this.emit('status', 'connected', url);
    });

    ws.on('message', (data) => this.handleRaw(data));

    ws.on('error', (err) => this.emit('status', 'error', err.message));

    ws.on('close', (code, reason) => {
      this.emit('status', 'disconnected', `${code} ${reason || ''}`);
      this.rejectAll(`socket closed (${code})`);
      if (!this.closed && this.cfg.reconnectDelayMs > 0) {
        setTimeout(() => {
          if (!this.closed) this.start();
        }, this.cfg.reconnectDelayMs);
      }
    });
  }

  handleRaw(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.echo !== undefined) {
      const pending = this.pending.get(msg.echo);
      if (pending) {
        this.pending.delete(msg.echo);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
      return;
    }

    if (msg.post_type === 'meta_event') {
      if (msg.meta_event_type === 'lifecycle' && msg.sub_type === 'connect') {
        this.emit('ready');
      }
      return;
    }

    if (msg.post_type === 'message') {
      this.emit('message', msg);
    }
  }

  /**
   * 调用 OneBot 接口。
   * 注意默认超时给到 30 秒：发图片（尤其几 MB 的 GIF）上传慢，
   * 10 秒经常不够，会导致「action timeout」把消息丢掉。
   */
  call(action, params, timeoutMs = 10000) {
    // 发消息类动作一律用更长的超时
    if (/^(send_|set_|upload_)/.test(action) && timeoutMs < 30000) timeoutMs = 30000;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('onebot socket not open'));
        return;
      }
      const echo = `e_${Date.now()}_${this.echoCounter++}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`action timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /** 统一检查 action 返回，失败就抛错 */
  static checkOk(action, res) {
    if (res.status === 'failed' || (res.retcode !== 0 && res.retcode !== undefined && res.retcode !== 'ok')) {
      throw new Error(`${action} failed: ${JSON.stringify(res).slice(0, 300)}`);
    }
    return res;
  }

  async sendPrivateMsg(userId, message, autoEscape = true) {
    const res = await this.call('send_private_msg', { user_id: userId, message, auto_escape: autoEscape });
    return OneBotClient.checkOk('send_private_msg', res);
  }

  /** 发群消息。message 可以是字符串，也可以是消息段数组。 */
  async sendGroupMsg(groupId, message, autoEscape = true) {
    const res = await this.call('send_group_msg', { group_id: groupId, message, auto_escape: autoEscape });
    return OneBotClient.checkOk('send_group_msg', res);
  }

  /**
   * 发一张本地图片（表情包）。
   * 用 file:// 绝对路径形式，OneBot 实现会自行读取并上传。
   */
  async sendImage(target, filePath, isGroup = false) {
    const normalized = String(filePath).replace(/\\/g, '/');
    const uri = normalized.startsWith('file://') ? normalized : 'file:///' + normalized.replace(/^\//, '');
    const message = [{ type: 'image', data: { file: uri } }];
    return isGroup
      ? this.sendGroupMsg(target, message, false)
      : this.sendPrivateMsg(target, message, false);
  }

  /** 发 QQ 内置小黄脸表情（face id） */
  async sendFace(target, faceId, isGroup = false) {
    const message = [{ type: 'face', data: { id: String(faceId) } }];
    return isGroup
      ? this.sendGroupMsg(target, message, false)
      : this.sendPrivateMsg(target, message, false);
  }

  /** 发一条纯文本到任意会话 */
  async sendText(target, text, isGroup = false) {
    return isGroup
      ? this.sendGroupMsg(target, text, true)
      : this.sendPrivateMsg(target, text, true);
  }

  /** 群成员信息（拿群名片，让 AI 知道在跟谁说话） */
  async getGroupMemberInfo(groupId, userId) {
    try {
      const res = await this.call('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: false }, 8000);
      return res?.data || null;
    } catch {
      return null;
    }
  }

  /** 群列表（面板里一键选群用） */
  async getGroupList() {
    try {
      const res = await this.call('get_group_list', {}, 10000);
      return Array.isArray(res?.data) ? res.data : [];
    } catch {
      return [];
    }
  }

  /** 好友列表 */
  async getFriendList() {
    try {
      const res = await this.call('get_friend_list', {}, 10000);
      return Array.isArray(res?.data) ? res.data : [];
    } catch {
      return [];
    }
  }

  /** 群历史消息（NapCat 扩展接口，用于学习群里说话习惯） */
  async fetchGroupHistory(groupId, messageCount = 50) {
    try {
      const res = await this.call('get_group_msg_history', { group_id: groupId, message_count: messageCount }, 12000);
      const data = res?.data;
      if (data && Array.isArray(data.messages)) return { ok: true, messages: data.messages };
      if (Array.isArray(data)) return { ok: true, messages: data };
      return { ok: false, reason: 'unexpected shape: ' + JSON.stringify(res).slice(0, 200) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /** 图片 OCR（NapCat 支持时可用，用于「看图说话」） */
  async ocrImage(imageUrl) {
    for (const action of ['ocr_image', 'ocr_image_new']) {
      try {
        const res = await this.call(action, { image: imageUrl }, 20000);
        const texts = res?.data?.texts || res?.data?.result || res?.data;
        if (Array.isArray(texts)) {
          const joined = texts.map((t) => (typeof t === 'string' ? t : t?.text || '')).filter(Boolean).join(' ');
          if (joined) return { ok: true, text: joined };
        } else if (typeof texts === 'string' && texts.trim()) {
          return { ok: true, text: texts.trim() };
        }
      } catch { /* 换下一个 action 名再试 */ }
    }
    return { ok: false, reason: 'ocr unsupported' };
  }

  /** The bot's own QQ id, via get_login_info. */
  async getSelfId() {
    try {
      const res = await this.call('get_login_info', {}, 8000);
      const userId = res?.data?.user_id;
      return userId ? { ok: true, userId } : { ok: false, reason: 'no user_id in get_login_info' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Try to pull private-chat history with a friend (nonstandard extension,
   * supported by some adapters like NapCat). Returns { ok, messages } where
   * messages are OneBot message objects, or { ok:false, reason }.
   */
  async fetchFriendHistory(userId, messageCount = 50) {
    try {
      const res = await this.call('get_friend_msg_history', { user_id: userId, message_count: messageCount }, 10000);
      const data = res?.data;
      if (data && typeof data === 'object' && Array.isArray(data.messages)) {
        return { ok: true, messages: data.messages };
      }
      if (Array.isArray(data)) {
        return { ok: true, messages: data };
      }
      return { ok: false, reason: 'unexpected shape from get_friend_msg_history: ' + JSON.stringify(res).slice(0, 200) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  rejectAll(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  stop() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}
