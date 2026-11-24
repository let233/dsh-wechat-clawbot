/**
 * 微信 ClawBot（iLink Bot API）协议客户端。
 *
 * 参考：Tencent/openclaw-weixin docs/protocol_zh_CN.md
 *   - 基座：https://ilinkai.weixin.qq.com，路径 /ilink/bot/*
 *   - 登录：POST get_bot_qrcode?bot_type=3 → GET get_qrcode_status（长轮询，35s）
 *   - 收消息：POST getupdates（长轮询，返回 get_updates_buf 游标）
 *   - 发消息：POST sendmessage（必须回传入站消息的 context_token）
 *   - ret / errcode 为 -14 表示会话过期，需要重新扫码
 */

import crypto from "node:crypto";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CHANNEL_VERSION = "2.4.8";
export const DEFAULT_BOT_AGENT = "DeepSeekRuntime";
export const SESSION_EXPIRED = -14;

export class ILinkError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number, status?: number, payload?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "ILinkError";
    this.code = info.code;
    this.status = info.status;
    this.payload = info.payload;
  }

  get expired() {
    if (this.code === SESSION_EXPIRED) return true;
    const payload = this.payload;
    if (payload && typeof payload === "object") {
      const ret = Number(payload.ret);
      const errcode = Number(payload.errcode);
      return ret === SESSION_EXPIRED || errcode === SESSION_EXPIRED;
    }
    return false;
  }
}

/** 随机 uint32 → 十进制字符串 → base64，即 X-WECHAT-UIN。 */
function randomUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

/**
 * 版本号按 0x00MMNNPP 编码后转十进制字符串（iLink-App-ClientVersion）。
 * @param {string} version
 * @returns {string}
 */
function encodeClientVersion(version) {
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!match) return "1";
  const major = Number(match[1]) & 0xff;
  const minor = Number(match[2]) & 0xff;
  const patch = Number(match[3]) & 0xff;
  return String((major << 16) | (minor << 8) | patch);
}

/** 全局唯一的 client_id（发消息幂等/排障用）。 */
export function newClientId(prefix = "dsh-clawbot") {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** 读取 JSON，非 JSON 时返回原文包装。 */
async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * 判断业务返回码是否成功：ret 缺省视为成功（sendmessage 等空响应）。
 * @param {any} payload
 */
function assertOk(payload, path) {
  if (!payload || typeof payload !== "object") return;
  const ret = payload.ret;
  const errcode = payload.errcode;
  const failed = (ret !== undefined && Number(ret) !== 0) || (errcode !== undefined && Number(errcode) !== 0);
  if (!failed) return;
  throw new ILinkError(
    `${path} 失败：ret=${ret ?? "-"} errcode=${errcode ?? "-"} ${payload.errmsg ?? ""}`.trim(),
    { code: Number(ret ?? errcode), payload },
  );
}

export class ILinkClient {
  /**
   * @param {{ baseUrl?: string, token?: string, channelVersion?: string, botAgent?: string, routeTag?: string }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = String(options.token ?? "");
    this.channelVersion = String(options.channelVersion || DEFAULT_CHANNEL_VERSION);
    this.botAgent = String(options.botAgent || DEFAULT_BOT_AGENT);
    this.routeTag = String(options.routeTag ?? "");
  }

  /** @param {{ auth?: boolean, plain?: boolean }} [options] */
  headers(options = {}) {
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": options.plain ? "1" : encodeClientVersion(this.channelVersion),
      "X-WECHAT-UIN": randomUin(),
    };
    if (options.auth) {
      headers.AuthorizationType = "ilink_bot_token";
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (this.routeTag) headers.SKRouteTag = this.routeTag;
    return headers;
  }

  /** @param {string} path */
  url(path) {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("_cradle_hostname", "g");
    return url;
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, auth?: boolean, plain?: boolean, timeoutMs?: number }} [options]
   */
  async request(path, options = {}) {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const signal = AbortSignal.timeout(Math.max(1000, Number(options.timeoutMs) || 20000));
    const response = await fetch(this.url(path), {
      method,
      headers: this.headers({ auth: options.auth !== false, plain: options.plain }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new ILinkError(`${path} HTTP ${response.status}`, { status: response.status, payload });
    }
    assertOk(payload, path);
    return payload;
  }

  /** base_info：每个业务 POST 都要带。 */
  baseInfo() {
    return { channel_version: this.channelVersion, bot_agent: this.botAgent };
  }

  /**
   * 获取绑定二维码。
   * @returns {Promise<{ qrcode: string, qrImg: string }>}
   */
  async getBotQrcode() {
    const payload = await this.request("/ilink/bot/get_bot_qrcode?bot_type=3", {
      method: "POST",
      body: { local_token_list: [] },
      auth: false,
      timeoutMs: 20000,
    });
    const qrcode = String(payload.qrcode ?? "");
    const qrImg = String(payload.qrcode_img_content ?? payload.qrcode_url ?? "");
    if (!qrcode) throw new ILinkError("绑定二维码响应缺少 qrcode", { payload });
    return { qrcode, qrImg };
  }

  /**
   * 轮询扫码状态（服务端长轮询约 35s；本地超时视为 wait）。
   * @param {{ qrcode: string, verifyCode?: string, timeoutMs?: number }} input
   */
  async getQrcodeStatus({ qrcode, verifyCode, timeoutMs = 40000 }) {
    const url = this.url("/ilink/bot/get_qrcode_status");
    url.searchParams.set("qrcode", qrcode);
    if (verifyCode) url.searchParams.set("verify_code", verifyCode);
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers({ auth: false, plain: true }),
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 40000)),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      // 轮询失败按 wait 处理，让上层继续
      return { status: "wait", payload, httpStatus: response.status };
    }
    return { status: String(payload.status ?? "wait"), payload, httpStatus: response.status };
  }

  /**
   * 长轮询拉取新消息。
   * @param {{ buf?: string, timeoutMs?: number }} [input]
   * @returns {Promise<{ msgs: any[], buf?: string, timeoutMs?: number, expired?: boolean }>}
   */
  async getUpdates({ buf = "", timeoutMs = 40000 } = {}) {
    try {
      const payload = await this.request("/ilink/bot/getupdates", {
        method: "POST",
        body: { get_updates_buf: buf, base_info: this.baseInfo() },
        timeoutMs,
      });
      const next = typeof payload.get_updates_buf === "string" ? payload.get_updates_buf : undefined;
      return {
        msgs: Array.isArray(payload.msgs) ? payload.msgs : [],
        buf: next || undefined,
        timeoutMs: Number(payload.longpolling_timeout_ms) || undefined,
      };
    } catch (error) {
      if (error instanceof ILinkError) {
        if (error.expired) return { msgs: [], expired: true };
        // 服务端长轮询超时/网络抖动：当作空轮询
        if (!error.code && !error.status) return { msgs: [] };
        throw error;
      }
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return { msgs: [] };
      }
      throw error;
    }
  }

  /**
   * 发送文本消息（单条，不做分批）。
   * @param {{ toUserId: string, text: string, contextToken?: string }} input
   */
  async sendText({ toUserId, text, contextToken }) {
    const msg = {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: newClientId(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    };
    if (contextToken) msg.context_token = contextToken;
    const payload = await this.request("/ilink/bot/sendmessage", {
      method: "POST",
      body: { msg, base_info: this.baseInfo() },
      timeoutMs: 25000,
    });
    return payload;
  }

  /**
   * 取 typing ticket。
   * @param {{ userId: string, contextToken?: string }} input
   */
  async getConfig({ userId, contextToken }) {
    const body = { ilink_user_id: userId, base_info: this.baseInfo() };
    if (contextToken) body.context_token = contextToken;
    const payload = await this.request("/ilink/bot/getconfig", { method: "POST", body, timeoutMs: 15000 });
    return typeof payload.typing_ticket === "string" ? payload.typing_ticket : "";
  }

  /**
   * 设置/取消输入状态。
   * @param {{ userId: string, ticket: string, typing: boolean }} input
   */
  async sendTyping({ userId, ticket, typing }) {
    return this.request("/ilink/bot/sendtyping", {
      method: "POST",
      body: { ilink_user_id: userId, typing_ticket: ticket, status: typing ? 1 : 2, base_info: this.baseInfo() },
      timeoutMs: 12000,
    });
  }

  /** 生命周期：客户端启动/停止通知（失败不影响主流程）。 */
  async notify(kind) {
    const path = kind === "start" ? "/ilink/bot/msg/notifystart" : "/ilink/bot/msg/notifystop";
    try {
      await this.request(path, { method: "POST", body: { base_info: this.baseInfo() }, timeoutMs: 12000 });
      return true;
    } catch {
      return false;
    }
  }
}
