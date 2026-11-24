/**
 * ClawBot 运行时：扫码登录 → 长轮询收消息 → 交给 DSH 会话 → 分批回复 / 推送兜底。
 */

import { ILinkClient, ILinkError, DEFAULT_BASE_URL } from "./ilink.js";
import { chunkText, oneLine } from "./text.js";
import { pushAll, hasPushChannel } from "./push.js";
import { qrSvgDataUrl } from "./qr.js";

const MAX_SEEN = 500;
const TYPING_TTL = 20 * 60 * 1000;
const HELP_TEXT = [
  "DSH × 微信 ClawBot 已就绪。",
  "",
  "直接发消息 = 和协调器会话对话；协调器可以查询任意工作区的会话进度、派发新任务。",
  "",
  "所有微信对话只发生在 ClawBot 专属会话里：协调器会话，或为某个会话单独开的指挥会话。",
  "「切到某个会话」= 为它开一个专属指挥会话，由指挥会话原样转发并汇报，消息不会直接进那个会话。",
  "",
  "快捷指令：",
  "/sessions —— 列出所有工作区会话（标注🎯指挥 / 🧭协调器）",
  "也可以直接说大白话：「切到那个在改登录页的会话」「以后就聊 dsh插件 那个」—— 会自动找到并开指挥会话",
  "/switch <序号|会话ID> —— 为该会话开专属指挥会话，后续消息交给它",
  "/coord —— 切回协调器会话",
  "/task new <原文> —— 逐字派发新任务到新会话（不经过模型改写）",
  "/task <序号|会话ID> <原文> —— 逐字派发给已有会话",
  "/status —— 查看连接与当前目标",
].join("\n");

const FOCUS_VERBS = /^(?:请|麻烦|帮我|给我)?\s*(?:切换|切|换|转|跳到|进入|接管|盯住|盯着|跟着|跟随|指挥|回到|回)\s*(?:到|去|成|过去|着)?\s*/;
const FOCUS_SOFT = /^(?:以后|之后|接下来|后面|今后)\s*(?:就|都)?\s*(?:聊|用|跟|在|切到|进入|盯着)?\s*/;
const BACK_WORDS = /^(?:协调器|协调会话|总管|总控|总调度|主页|首页|大盘|你这里|你这边|原来那个|原来的会话)$/;

/**
 * 识别「大白话切换会话」的意图。
 * 只认很短的一句话，并且必须带明确的切换动词，避免把普通任务描述吞掉。
 * @param {string} text
 * @returns {{ query: string, back: boolean, raw: string } | null}
 */
export function detectFocusIntent(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.startsWith("/") || raw.length > 40) return null;
  if (/[?\uFF1F]$/.test(raw)) return null;
  let rest = null;
  if (FOCUS_VERBS.test(raw)) rest = raw.replace(FOCUS_VERBS, "");
  else if (FOCUS_SOFT.test(raw) && /(聊|用|跟|盯着|切到|进入)/.test(raw)) rest = raw.replace(FOCUS_SOFT, "");
  if (rest === null) return null;
  let query = rest
    .replace(/^[\s「『"'\u201c\u2018]+|[\s」』"'\u201d\u2019]+$/g, "")
    .replace(/^(?:(?:那个|这个|一个|在|正在|去|到|回)\s*)+/, "")
    .replace(/(?:那个|这个)?(?:会话|对话|任务|吧|呢|啊|了)?[。！!\s]*$/u, "")
    .replace(/的$/, "")
    .trim();
  if (!query) return null;
  // 带「然后/顺便/另外」或是长句子的，多半是任务描述而不是切换请求，交回模型
  if (query.length > 24 || /(?:然后|顺便|并且|同时|另外|接着)/.test(query)) return null;
  if (BACK_WORDS.test(query) || /(?:协调器|协调会话|总管)$/.test(query)) {
    return { query: "", back: true, raw };
  }
  return { query, back: false, raw };
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

export class ClawBotRuntime {
  /**
   * @param {{ ctx: any, store: any, bridge: any, log?: (level: string, message: string) => void }} options
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.store = options.store;
    this.bridge = options.bridge;
    this.onLog = options.log ?? (() => {});

    /** @type {'idle'|'login'|'online'|'paused'|'error'} */
    this.status = "idle";
    this.statusDetail = "";
    this.startedAt = 0;
    this.lastPollAt = 0;
    this.lastMessageAt = 0;
    this.lastError = "";
    this.counters = { received: 0, replied: 0, chunks: 0, pushed: 0, failed: 0 };

    this.login = { active: false, qrcode: "", qrImg: "", qrSvg: "", status: "", pinNeeded: false, scanned: false, error: "", startedAt: 0, refreshCount: 0 };
    this.logs = [];

    this.buf = String(this.store.get().ilink.getUpdatesBuf ?? "");
    this.seen = new Set();
    this.contexts = new Map();
    this.typingTickets = new Map();

    this.pollAbort = null;
    this.loginAbort = null;
    this.chain = Promise.resolve();
    this.pausedUntil = 0;
  }

  // ---------------------------------------------------------------- 基础工具

  log(level, message) {
    const entry = { time: Date.now(), level, message: String(message ?? "") };
    this.logs.push(entry);
    const max = Number(this.store.get().log?.maxEntries) || 60;
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max);
    this.onLog(level, entry.message);
    return entry;
  }

  client() {
    const ilink = this.store.get().ilink;
    return new ILinkClient({
      baseUrl: ilink.baseUrl || DEFAULT_BASE_URL,
      token: ilink.botToken,
      channelVersion: ilink.channelVersion,
      botAgent: ilink.botAgent,
      routeTag: ilink.routeTag,
    });
  }

  get online() {
    return this.status === "online" && Boolean(this.store.get().ilink.botToken);
  }

  /** 面向设置界面的状态快照。 */
  describe() {
    const config = this.store.get();
    return {
      status: this.status,
      statusDetail: this.statusDetail,
      online: this.online,
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      botId: config.ilink.botId,
      userId: config.ilink.userId,
      baseUrl: config.ilink.baseUrl,
      pausedUntil: this.pausedUntil,
      counters: { ...this.counters },
      pendingQueue: Boolean(this.pending),
      login: { ...this.login },
      log: this.logs.slice(-25),
      config: this.store.redacted(),
      paths: this.store.paths(),
    };
  }

  // ---------------------------------------------------------------- 登录流程

  /** 开始扫码登录：拿二维码并在后台轮询状态。 */
  async loginStart() {
    this.stopPolling();
    this.loginAbort?.abort();
    this.loginAbort = new AbortController();
    const client = new ILinkClient({
      baseUrl: this.store.get().ilink.baseUrl || DEFAULT_BASE_URL,
      channelVersion: this.store.get().ilink.channelVersion,
      botAgent: this.store.get().ilink.botAgent,
      routeTag: this.store.get().ilink.routeTag,
    });
    const { qrcode, qrImg } = await client.getBotQrcode();
    const qrSvg = qrSvgDataUrl(qrImg || qrcode);
    this.login = {
      active: true,
      qrcode,
      qrImg,
      qrSvg,
      status: "wait",
      pinNeeded: false,
      scanned: false,
      error: "",
      startedAt: Date.now(),
      refreshCount: 0,
    };
    this.status = "login";
    this.statusDetail = "等待微信扫码确认";
    this.log("info", "已获取绑定二维码，等待扫码");
    this.loginLoop(client, this.loginAbort.signal).catch((error) => {
      this.login.error = error instanceof Error ? error.message : String(error);
      this.log("error", `登录轮询异常：${this.login.error}`);
    });
    return { qrcode, qrImg, qrSvg };
  }

  /** 提交手机端 PIN（响应含 need_verifycode 时）。 */
  loginSubmitPin(code) {
    this.login.pin = String(code ?? "").trim();
    this.login.pinNeeded = false;
    this.log("info", "已提交 PIN，等待校验");
    return { ok: true };
  }

  /** @param {ILinkClient} client @param {AbortSignal} signal */
  async loginLoop(client, signal) {
    let verifyCode = "";
    while (!signal.aborted && this.login.active) {
      let result;
      try {
        result = await client.getQrcodeStatus({ qrcode: this.login.qrcode, verifyCode: verifyCode || undefined, timeoutMs: 40000 });
      } catch (error) {
        if (signal.aborted) return;
        this.login.status = "wait";
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      if (signal.aborted) return;

      const status = String(result.status || "wait");
      this.login.status = status;
      if (this.login.pin && !verifyCode) verifyCode = this.login.pin;

      if (status.includes("need_verifycode")) {
        verifyCode = "";
        this.login.pin = "";
        this.login.pinNeeded = true;
        this.statusDetail = "需要手机端输入数字 PIN";
        continue;
      }

      if (status === "scaned") {
        this.login.scanned = true;
        this.login.pinNeeded = false;
        verifyCode = "";
        this.login.pin = "";
        this.statusDetail = "已扫码，等待手机确认";
        continue;
      }

      if (status === "scaned_but_redirect") {
        const host = String(result.payload?.redirect_host ?? "");
        if (host) {
          const next = host.startsWith("http") ? host : `https://${host}`;
          this.store.patch({ ilink: { baseUrl: next } });
          client.baseUrl = next.replace(/\/+$/, "");
          this.log("info", `扫码后重定向到 ${next}`);
        }
        this.statusDetail = "已扫码，正在切换服务地址";
        continue;
      }

      if (status === "confirmed") {
        const payload = result.payload ?? {};
        const token = String(payload.bot_token ?? "");
        if (!token) {
          this.login.error = "确认成功但未返回 bot_token";
          this.status = "error";
          return;
        }
        this.login.active = false;
        this.store.patch({
          ilink: {
            botToken: token,
            botId: String(payload.ilink_bot_id ?? ""),
            userId: String(payload.ilink_user_id ?? ""),
            baseUrl: String(payload.baseurl ?? this.store.get().ilink.baseUrl ?? DEFAULT_BASE_URL),
            savedAt: Date.now(),
            getUpdatesBuf: "",
          },
        });
        this.buf = "";
        this.status = "online";
        this.statusDetail = "已连接";
        this.lastError = "";
        this.log("info", `登录成功：${this.store.get().ilink.botId || "未知 bot"}`);
        this.startPolling();
        return;
      }

      if (status === "expired" || status === "verify_code_blocked") {
        this.login.refreshCount += 1;
        this.log("warn", `二维码${status === "expired" ? "已过期" : "PIN 错误次数过多"}，刷新第 ${this.login.refreshCount} 次`);
        if (this.login.refreshCount > 3) {
          this.login.active = false;
          this.login.error = "二维码多次失效，请重新发起登录";
          this.status = "error";
          return;
        }
        verifyCode = "";
        this.login.pin = "";
        try {
          const next = await client.getBotQrcode();
          this.login.qrcode = next.qrcode;
          this.login.qrImg = next.qrImg;
          this.login.qrSvg = qrSvgDataUrl(next.qrImg || next.qrcode);
        } catch (error) {
          this.login.error = error instanceof Error ? error.message : String(error);
          this.status = "error";
          return;
        }
        continue;
      }

      if (status === "binded_redirect") {
        this.login.active = false;
        this.login.error = "该 bot 已绑定到其它客户端，请先在手机上解除绑定";
        this.status = "error";
        return;
      }
      // wait：继续轮询
    }
  }

  /** 退出登录：清理凭据与游标。 */
  logout() {
    this.stopPolling();
    this.loginAbort?.abort();
    this.login = { active: false, qrcode: "", qrImg: "", qrSvg: "", status: "", pinNeeded: false, scanned: false, error: "", startedAt: 0, refreshCount: 0 };
    this.contexts.clear();
    this.typingTickets.clear();
    this.buf = "";
    this.store.patch({ ilink: { botToken: "", botId: "", userId: "", savedAt: 0, getUpdatesBuf: "", lastContextToken: "", lastContextUserId: "" } });
    this.status = "idle";
    this.statusDetail = "已退出登录";
    this.log("info", "已退出微信 ClawBot 登录");
    return { ok: true };
  }

  // ---------------------------------------------------------------- 消息轮询

  /** 启动长轮询（幂等）。 */
  startPolling() {
    if (this.polling) return { ok: true, already: true };
    if (!this.store.get().ilink.botToken) {
      this.status = "idle";
      this.statusDetail = "未登录";
      return { ok: false, reason: "未登录" };
    }
    this.pollAbort = new AbortController();
    this.polling = true;
    this.status = "online";
    this.statusDetail = "已连接";
    this.startedAt = Date.now();
    this.client().notify("start").catch(() => {});
    this.pollLoop(this.pollAbort.signal).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log("error", `轮询异常：${this.lastError}`);
    });
    return { ok: true };
  }

  stopPolling() {
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.polling = false;
    if (this.status === "online") {
      this.statusDetail = "已停止";
    }
  }

  /** @param {AbortSignal} signal */
  async pollLoop(signal) {
    let backoff = 0;
    while (!signal.aborted) {
      if (this.pausedUntil && Date.now() < this.pausedUntil) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      const client = this.client();
      let result;
      try {
        result = await client.getUpdates({ buf: this.buf, timeoutMs: 40000 });
        backoff = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        backoff = Math.min(backoff + 1, 6);
        this.lastError = message;
        this.status = "error";
        this.statusDetail = `轮询失败：${message}`;
        this.log("error", `getUpdates 失败：${message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff * 3000));
        this.status = "online";
        continue;
      }
      if (signal.aborted) return;
      this.lastPollAt = Date.now();

      if (result.expired) {
        this.status = "paused";
        this.pausedUntil = Date.now() + 60 * 60 * 1000;
        this.statusDetail = "微信会话已过期（ret=-14），已暂停 1 小时，请重新扫码登录";
        this.log("warn", "微信会话过期（-14），暂停 1 小时后需重新扫码");
        this.stopPolling();
        return;
      }

      if (result.buf && result.buf !== this.buf) {
        this.buf = result.buf;
        this.store.patch({ ilink: { getUpdatesBuf: this.buf } });
      }

      for (const message of result.msgs) {
        this.enqueue(message);
      }
    }
  }

  /** 串行处理入站消息，避免多轮回复交叉。 */
  enqueue(message) {
    this.chain = this.chain
      .then(() => this.handleMessage(message))
      .catch((error) => {
        this.counters.failed += 1;
        this.log("error", `处理消息失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return this.chain;
  }

  /** 去重。 */
  markSeen(message) {
    const key = String(message?.message_id ?? message?.seq ?? "");
    if (!key) return true;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > MAX_SEEN) {
      const first = this.seen.values().next().value;
      this.seen.delete(first);
    }
    return true;
  }

  /** 从 MessageItem 列表里取文本（含语音转写、引用消息）。 */
  static extractText(message) {
    const items = Array.isArray(message?.item_list) ? message.item_list : [];
    const parts = [];
    for (const item of items) {
      const type = Number(item?.type);
      if (type === 1 && item.text_item?.text) parts.push(String(item.text_item.text));
      else if (type === 3 && item.voice_item?.text) parts.push(String(item.voice_item.text));
      else if (type === 4 && item.file_item?.file_name) parts.push(`[文件] ${item.file_item.file_name}`);
      else if (type === 5) parts.push("[视频]");
      else if (type === 2) parts.push("[图片]");
      if (item?.ref_msg?.message_item?.text_item?.text) {
        parts.push(`（引用：${String(item.ref_msg.message_item.text_item.text)}）`);
      }
    }
    // 注意：不做 trim —— 用户消息必须逐字下发（含首尾空白/换行）
    return parts.join("\n");
  }

  /** 用户是否被允许。 */
  allowUser(userId) {
    const routing = this.store.get().routing;
    if (routing.allowAllUsers !== false) return true;
    const list = Array.isArray(routing.allowedUserIds) ? routing.allowedUserIds : [];
    return list.map((item) => String(item).trim()).filter(Boolean).includes(String(userId));
  }

  /** 记下 context_token：主动推送（以及重启后的回复）依赖它。 */
  rememberContext(userId, contextToken) {
    const previous = this.store.get().ilink;
    this.store.patch({
      ilink: {
        lastContextUserId: String(userId ?? ""),
        lastContextToken: String(contextToken ?? previous.lastContextToken ?? ""),
        lastContextAt: Date.now(),
      },
    });
    this.contexts.set(String(userId), { token: contextToken, at: Date.now() });
  }

  contextFor(userId) {
    const cached = this.contexts.get(String(userId));
    if (cached?.token) return cached.token;
    const ilink = this.store.get().ilink;
    if (String(ilink.lastContextUserId ?? "") === String(userId)) return String(ilink.lastContextToken ?? "");
    return "";
  }

  async typing(userId, on, contextToken) {
    const config = this.store.get();
    if (!config.reply?.typing) return;
    try {
      const cached = this.typingTickets.get(userId);
      let ticket = cached && Date.now() - cached.at < TYPING_TTL ? cached.ticket : "";
      if (!ticket) {
        ticket = await this.client().getConfig({ userId, contextToken });
        if (ticket) this.typingTickets.set(userId, { ticket, at: Date.now() });
      }
      if (!ticket) return;
      await this.client().sendTyping({ userId, ticket, typing: on });
    } catch {
      /* typing 失败不影响主流程 */
    }
  }

  // ---------------------------------------------------------------- 主处理

  /** @param {any} message */
  async handleMessage(message) {
    if (!message || Number(message.message_type) !== 1) return;
    if (message.group_id) {
      this.log("info", "忽略群聊消息（当前仅支持单聊）");
      return;
    }
    if (!this.markSeen(message)) return;

    const userId = String(message.from_user_id ?? "");
    const contextToken = String(message.context_token ?? "");
    this.counters.received += 1;
    this.lastMessageAt = Date.now();

    if (!this.allowUser(userId)) {
      this.log("warn", `拒绝未授权用户：${userId}`);
      return;
    }
    if (contextToken) this.rememberContext(userId, contextToken);

    const text = ClawBotRuntime.extractText(message);
    if (!text.trim()) {
      await this.deliver(userId, contextToken, "这条消息暂时只支持文字（图片/文件/视频解析尚未开放）。");
      return;
    }

    this.log("info", `收到消息（${userId}）：${oneLine(text, 40)}`);

    // 快捷指令
    const command = this.matchCommand(text);
    if (command) {
      const output = await this.runCommand(command, userId).catch((error) => `指令执行失败：${error instanceof Error ? error.message : String(error)}`);
      await this.deliver(userId, contextToken, output);
      return;
    }

    // 大白话切换会话：本地解析，能确定落点就直接切，不必记序号，也不必花一轮模型
    const intent = this.parseIntent(text);
    if (intent) {
      const local = await this.tryFocusIntent(intent).catch((error) => {
        this.log("warn", `大白话切换失败：${error instanceof Error ? error.message : String(error)}`);
        return "";
      });
      if (local) {
        await this.deliver(userId, contextToken, local);
        return;
      }
    }

    await this.typing(userId, true, contextToken);
    let reply = "";
    let reason = "idle";
    try {
      const target = await this.resolveTarget();
      const result = await this.bridge.promptAndWait(target.sessionId, text, { timeoutMs: 10 * 60 * 1000 });
      reply = result.text;
      reason = result.reason;
      if (!reply) reply = reason === "timeout" ? "（这一轮还没跑完，可以稍后用 /sessions 看进度，或让协调器继续跟进。）" : "（本轮没有产生文本回复。）";
      const prefix = target.tag && this.store.get().reply?.showSessionTag ? `${target.tag}\n\n` : "";
      reply = prefix + reply;
      if (reason === "timeout") reply = `${reply}\n\n（仍在处理中，完成后可再询问进度。）`;
    } catch (error) {
      this.counters.failed += 1;
      const message2 = error instanceof Error ? error.message : String(error);
      this.log("error", `处理失败：${message2}`);
      reply = `处理失败：${message2}`;
    } finally {
      this.typing(userId, false, contextToken).catch(() => {});
    }
    await this.deliver(userId, contextToken, reply);
  }

  /**
   * 解析一条消息是不是「切换落点」请求。
   * 除了大白话，也接受上一条列过候选之后直接回的数字。
   * @param {string} text
   */
  parseIntent(text) {
    const direct = detectFocusIntent(text);
    if (direct) return direct;
    const raw = String(text ?? "").trim();
    if (this.lastCandidates?.length && /^#?\d{1,2}$/.test(raw)) {
      return { query: raw, back: false, raw };
    }
    return null;
  }

  /**
   * 按大白话切换落点：确定就直接切，歧义就给候选，没匹配上返回空串交给模型。
   * @param {{ query: string, back: boolean, raw: string }} intent
   * @returns {Promise<string>} 要回给用户的文字；空串表示不接管
   */
  async tryFocusIntent(intent) {
    if (intent.back) {
      await this.bridge.focus("");
      this.lastCandidates = [];
      return "已切回协调器会话。已开的指挥会话都保留着，说「切回某某会话」可以接着用。";
    }
    // 上一条是候选列表时，允许用户直接回一个序号
    const numeric = intent.query.match(/^#?(\d{1,2})$/);
    if (numeric && Array.isArray(this.lastCandidates) && this.lastCandidates.length) {
      const row = this.lastCandidates[Number(numeric[1]) - 1];
      if (row) {
        this.lastCandidates = [];
        return await this.focusRow(row);
      }
    }
    const match = await this.bridge.matchTarget(intent.query);
    if (match.kind === "none") return "";
    if (match.kind === "many") {
      this.lastCandidates = match.candidates.map((item) => item.row);
      return [
        `「${intent.query}」对上好几个会话，你指的是哪个？`,
        "",
        ...match.candidates.map((item, index) => `${index + 1}. ${this.bridge.label(item.row)}`),
        "",
        "直接回序号就行，或者说细一点（带上工作区/文件名）。",
      ].join("\n");
    }
    this.lastCandidates = [];
    return await this.focusRow(match.row);
  }

  /** 真的开/复用指挥会话，并返回一句人话。 */
  async focusRow(row) {
    const label = this.bridge.label(row);
    const result = await this.bridge.focus(String(row.sessionId), { label, cwd: row.cwd || undefined });
    const verb = result.created ? "新建了" : "复用了";
    return [
      `已切到「${label}」的专属指挥会话（${verb}）。`,
      "接下来你发的消息会进这个指挥会话，由它把你的话原样转给那个会话并汇报进度；那个会话本身不会直接收到你的微信消息。",
      "想回到协调器就说「切回协调器」。",
    ].join("\n");
  }

  /**
   * 解析当前对话落点。
   * 只可能是插件自己的专属会话：协调器，或某个目标会话的指挥会话。
   * 普通工作会话永远不会直接收到微信消息。
   */
  async resolveTarget() {
    const routing = this.store.get().routing;
    const active = String(routing.activeSessionId ?? "");
    if (active && this.bridge.isOwned(active)) {
      const rows = await this.bridge.listSessions({ limit: 100 }).catch(() => []);
      const row = rows.find((item) => item.sessionId === active);
      if (row) {
        const bound = this.bridge.commandTargetOf(active);
        const boundRow = bound ? rows.find((item) => item.sessionId === bound) : null;
        const tag = bound
          ? `【指挥 · ${boundRow ? this.bridge.label(boundRow) : bound}】`
          : `【当前会话 · ${this.bridge.label(row)}】`;
        return { sessionId: active, tag };
      }
      this.log("warn", `对话落点 ${active} 不可用，回退到协调器`);
      this.store.patch({ routing: { activeSessionId: "" } });
    } else if (active) {
      // 历史配置里可能残留着直接指向普通会话的值：一律拒收，回到协调器
      this.log("warn", `对话落点 ${active} 不是 ClawBot 专属会话，已回退到协调器`);
      this.store.patch({ routing: { activeSessionId: "" } });
    }
    const coordinator = await this.bridge.ensureCoordinator();
    return { sessionId: coordinator.sessionId, tag: "" };
  }

  /** 指令匹配：只有整条消息以已知指令开头才算。 */
  matchCommand(text) {
    const raw = String(text ?? "");
    const first = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const known = new Set(["/help", "/sessions", "/switch", "/coord", "/status", "/new", "/task"]);
    if (!known.has(first)) return null;
    if (first === "/task") {
      // /task 的正文必须逐字保留（含换行、缩进、连续空格），因此只切掉指令词本身
      const trimmed = raw.replace(/^\s+/, "");
      const body = trimmed.slice("/task".length).replace(/^[ \t]+/, "");
      return { name: first, args: [], body };
    }
    const [, ...rest] = raw.trim().split(/\s+/);
    return { name: first, args: rest };
  }

  async runCommand(command, userId) {
    const routing = this.store.get().routing;
    if (command.name === "/help") return HELP_TEXT;

    if (command.name === "/status") {
      const rows = await this.bridge.listSessions({ limit: 100 }).catch(() => []);
      const active = routing.activeSessionId ? rows.find((row) => row.sessionId === routing.activeSessionId) : null;
      const bound = routing.activeSessionId ? this.bridge.commandTargetOf(routing.activeSessionId) : "";
      return [
        `连接状态：${this.status}${this.statusDetail ? `（${this.statusDetail}）` : ""}`,
        `Bot：${this.store.get().ilink.botId || "未登录"}`,
        `协调器会话：${routing.coordinatorSessionId || "未创建"}`,
        `当前落点：${active ? `${this.bridge.label(active)}${bound ? `（指挥 → ${bound}）` : ""}` : "协调器会话"}`,
        `已开的指挥会话：${Object.keys(routing.commands || {}).length} 个`,
        `已收到 ${this.counters.received} 条 / 已回复 ${this.counters.replied} 条 / 分段 ${this.counters.chunks} 条`,
      ].join("\n");
    }

    if (command.name === "/sessions") {
      const rows = await this.bridge.listSessions({ limit: 20, withSnippet: true });
      if (!rows.length) return "还没有可见会话。";
      this.lastSessions = rows;
      const lines = rows.map((row, index) => {
        const flags = [
          row.targetable === false ? "🚫子会话（不可指挥）" : "",
          row.running ? "▶运行中" : "",
          row.pendingInput?.length ? `⚠等待输入（${row.pendingInput.join("/")}）` : "",
          row.queueLength ? `排队${row.queueLength}` : "",
        ].filter(Boolean).join(" ");
        const role =
          row.role === "coordinator" ? "🧭协调器" : row.role === "command" ? `🎯指挥→${row.boundTarget || ""}` : "";
        const here = row.sessionId === routing.activeSessionId ? "◀当前" : "";
        const marks = [role, here].filter(Boolean).join(" ");
        return `${index + 1}. ${this.bridge.label(row)}${marks ? ` ${marks}` : ""}${flags ? ` ${flags}` : ""}${row.topic ? `\n   ${row.topic}` : ""}`;
      });
      return [
        `共 ${rows.length} 个可指挥会话（发送 /switch 序号 开专属指挥会话；子会话已隐藏）：`,
        "",
        ...lines,
      ].join("\n");
    }

    if (command.name === "/switch") {
      const target = command.args[0];
      if (!target) return "用法：/switch <序号|会话ID>，先发送 /sessions 查看列表。";
      let rows = this.lastSessions;
      if (!rows?.length) rows = await this.bridge.listSessions({ limit: 20, withSnippet: true });
      const byIndex = /^\d+$/.test(target) ? rows[Number(target) - 1] : undefined;
      const row = byIndex ?? rows.find((item) => item.sessionId === target || item.sessionId.startsWith(target));
      if (!row) return `没有找到会话 ${target}，请先发送 /sessions。`;
      if (row.sessionId === routing.coordinatorSessionId) {
        this.store.patch({ routing: { activeSessionId: "" } });
        return "已经是协调器会话，无需切换。";
      }
      if (row.targetable === false) {
        return `不能指挥这个会话：它是 subagent 派生的子会话，运行时不允许向它投递消息。请挑 /sessions 里没有「子会话」标记的会话。`;
      }
      const focused = await this.bridge.focus(row.sessionId, { label: this.bridge.label(row), cwd: row.cwd || undefined });
      this.log("info", `指挥目标 → ${row.sessionId}（指挥会话 ${focused.sessionId}）`);
      return [
        `已为这个会话准备好专属指挥会话：${this.bridge.label(row)}`,
        `${focused.created ? "新建" : "复用"}指挥会话 ${focused.sessionId}`,
        "接下来你的消息会进这个指挥会话，由它把你的原话逐字转发给目标会话并汇报进度；消息不会直接进目标会话。",
        "发送 /coord 可切回协调器。",
      ].join("\n");
    }

    if (command.name === "/coord") {
      await this.bridge.focus("");
      return "已切回协调器会话（各会话的专属指挥会话仍然保留，可随时 /switch 回去）。";
    }

    if (command.name === "/task") {
      const body = String(command.body ?? "");
      if (!body.trim()) return "用法：/task new <原文> 或 /task <序号|会话ID> <原文>；正文会逐字派发，不做任何改写。";
      // 目标与正文之间只吃掉「一个」分隔符，其余空白都属于正文
      const match = body.match(/^(\S+)(?:[ \t]*\n[ \t]?|[ \t])([\s\S]*)$/);
      if (!match) return "用法：/task new <原文> 或 /task <序号|会话ID> <原文>；正文会逐字派发，不做任何改写。";
      const target = match[1];
      const message = match[2];
      if (!message.trim()) return "派发内容为空，已取消。";
      let sessionId;
      let created = false;
      let commandSessionId = "";
      if (target.toLowerCase() === "new") {
        const dispatched = await this.bridge.dispatch({ message, wait: false });
        sessionId = dispatched.sessionId;
        created = true;
        commandSessionId = (await this.bridge.focus(sessionId, { label: sessionId })).sessionId;
      } else {
        let rows = this.lastSessions;
        if (!rows?.length) rows = await this.bridge.listSessions({ limit: 50, withSnippet: false });
        const byIndex = /^\d+$/.test(target) ? rows[Number(target) - 1] : undefined;
        const row = byIndex ?? rows.find((item) => item.sessionId === target || item.sessionId.startsWith(target));
        if (!row) return `没有找到会话 ${target}，请先发送 /sessions。`;
        sessionId = row.sessionId;
        await this.bridge.dispatch({ sessionId, message, wait: false });
        commandSessionId = (await this.bridge.focus(sessionId, { label: this.bridge.label(row), cwd: row.cwd || undefined })).sessionId;
      }
      this.log("info", `逐字派发 → ${sessionId}（${message.length} 字）`);
      return [
        `已${created ? "新建并" : ""}派发到 ${sessionId}`,
        `正文长度：${message.length} 字（原样下发，未做任何改写）`,
        commandSessionId ? `已准备好专属指挥会话 ${commandSessionId}，后续消息由它原样转发并汇报；发送 /coord 可切回协调器。` : "",
      ].filter(Boolean).join("\n");
    }

    if (command.name === "/new") {
      const cwd = command.args.join(" ").trim() || undefined;
      const created = await this.bridge.dispatch({ cwd, message: "（新会话已创建，等待你的第一条任务）", wait: false });
      const focused = await this.bridge.focus(created.sessionId, { label: created.sessionId, cwd });
      return `已新建会话 ${created.sessionId}${cwd ? `（${cwd}）` : ""}，并准备好它的专属指挥会话 ${focused.sessionId}。`;
    }

    return HELP_TEXT;
  }

  // ---------------------------------------------------------------- 出站

  /**
   * 分批发送回复；全部失败时走推送兜底。
   * @param {string} userId
   * @param {string} contextToken
   * @param {string} text
   */
  async deliver(userId, contextToken, text) {
    const config = this.store.get();
    const chunks = chunkText(text, config.reply?.maxChars ?? 1800, { maxChunks: config.reply?.maxChunks ?? 0 });
    if (!chunks.length) return { ok: true, chunks: 0 };

    let delivered = 0;
    let lastError = "";
    for (let index = 0; index < chunks.length; index += 1) {
      try {
        await this.client().sendText({ toUserId: userId, text: chunks[index], contextToken });
        delivered += 1;
        this.counters.chunks += 1;
        if (index < chunks.length - 1) {
          const delay = Math.max(0, Number(config.reply?.chunkDelayMs) || 0);
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.log("error", `发送失败：${lastError}`);
        break;
      }
    }

    if (delivered === chunks.length) {
      this.counters.replied += 1;
      return { ok: true, chunks: delivered };
    }

    this.counters.failed += 1;
    // 部分成功：剩余内容整体走推送，避免用户丢内容
    const remaining = chunks.slice(delivered).join("\n\n");
    const pushed = await this.fallbackPush(remaining || text, `微信回复失败${lastError ? `：${lastError}` : ""}`);
    return { ok: delivered > 0 || pushed, chunks: delivered, pushed, error: lastError };
  }

  /** 推送兜底：Bark + WxPusher。 */
  async fallbackPush(text, note) {
    const config = this.store.get();
    if (config.push?.fallbackOnFailure === false) return false;
    if (!hasPushChannel(config)) {
      this.log("warn", "回复未能送达微信，且未配置 Bark/WxPusher，内容已丢弃");
      return false;
    }
    const results = await pushAll(config, { title: "DSH 回复（微信不可达）", text: note ? `${text}\n\n— ${note}` : text });
    const ok = results.some((item) => item.ok);
    if (ok) {
      this.counters.pushed += 1;
      this.log("info", "已通过推送通道兜底发出");
    } else {
      this.log("error", `推送兜底失败：${JSON.stringify(results).slice(0, 300)}`);
    }
    return ok;
  }

  /** 主动推送（设置页测试 / 工具调用）。overrideConfig 仅供设置页按通道测试。 */
  async pushNow(text, title = "DSH 主动通知", overrideConfig) {
    const config = overrideConfig ?? this.store.get();
    const results = await pushAll(config, { title, text });
    const ok = results.some((item) => item.ok);
    if (ok) this.counters.pushed += 1;
    return { ok, results };
  }

  /** 向最近联系的微信用户发一条文本（用于设置页的“测试发送”）。 */
  async sendActive(text) {
    const ilink = this.store.get().ilink;
    const userId = String(ilink.lastContextUserId ?? "");
    if (!userId) return { ok: false, reason: "还没有收到过任何微信消息，无法确定发送对象" };
    const token = this.contextFor(userId);
    try {
      await this.client().sendText({ toUserId: userId, text: String(text ?? "").slice(0, 1800), contextToken: token });
      return { ok: true, userId, usedContextToken: Boolean(token) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = error instanceof ILinkError && error.expired ? "（微信会话已过期，需要重新扫码）" : "";
      return { ok: false, reason: `${message}${hint}`, userId, usedContextToken: Boolean(token) };
    }
  }

  /**
   * 入站 webhook：让外部（隧道转发进来的请求、自建集成、其他平台回调）把一句话交给 DSH。
   * 与微信链路的区别：这里没有 context_token，所以「回复」只能靠 HTTP 响应体 + 推送通道。
   *
   * @param {{ text?: string, message?: string, sessionId?: string, wait?: boolean, timeoutMs?: number, push?: boolean, channel?: string }} payload
   */
  async handleWebhook(payload = {}) {
    const raw = payload.text ?? payload.message ?? "";
    const text = String(raw ?? "");
    if (!text.trim()) throw new Error("text 不能为空");
    const timeoutMs = Number(payload.timeoutMs) || 300000;
    const explicit = String(payload.sessionId || "").trim();
    // 入站消息也只能落在 ClawBot 专属会话里，绝不直接投进普通工作会话
    if (explicit && !this.bridge.isOwned(explicit)) {
      throw new Error(`sessionId ${explicit} 不是 ClawBot 专属会话；请改用协调器或指挥会话的 ID`);
    }
    const resolved = explicit ? { sessionId: explicit, tag: "" } : await this.resolveTarget();
    const target = resolved.sessionId;
    const title = String(payload.channel || "Webhook");
    this.log("info", `[${title}] 收到入站消息 → ${target}（${text.length} 字）`);

    // wait:false → 只下发、不等结果（任务型派发用这个，避免长时间占用连接）
    if (payload.wait === false) {
      const result = await this.bridge.dispatch({ sessionId: target, message: text, wait: false });
      if (payload.push !== false) {
        const summary = text.length > 80 ? `${text.slice(0, 80)}…` : text;
        await this.pushNow(`已派发到 ${target}\n${summary}`, "DSH 已接收入站任务").catch(() => {});
      }
      return { ok: true, target, queued: true, sessionId: result.sessionId, createdAt: result.created ?? false };
    }

    const result = await this.bridge.promptAndWait(target, text, { timeoutMs });
    const body = result.text || (result.reason === "input-required" ? "（会话在等待人工确认，请到 DSH 客户端处理）" : "（本轮没有产生文本回复）");
    const tagged = resolved.tag && this.store.get().reply?.showSessionTag !== false ? `${resolved.tag} ${body}` : body;
    const reply = tagged;
    if (payload.push !== false) {
      await this.pushNow(reply.slice(0, 1500), "DSH 入站消息回复").catch(() => {});
    }
    return { ok: true, target, reply, reason: result.reason, sessionId: target };
  }

  /** 供外部（工具）复用的时间戳格式。 */
  static nowText = nowText;
}
