/**
 * 额外推送通道：Bark / WxPusher。
 *
 * 微信 ClawBot（iLink）的主动消息依赖入站消息带来的 context_token：
 * token 缺失或过期后无法主动推送到会话，所以任何「非当前对话内」的通知
 * 都优先走这里的通道。
 */

const BARK_DEFAULT_SERVER = "https://api.day.app";
const WXPUSHER_ENDPOINT = "https://wxpusher.zjiecode.com/api/send/message";
const WXPUSHER_SPT_ENDPOINT = "https://wxpusher.zjiecode.com/api/send/message/simple-push";

function trimSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

/**
 * Bark（iOS）推送。优先 POST 表单，失败再退回路径式 GET。
 * @param {object} options
 * @param {string} options.serverUrl 自建服务地址，默认 https://api.day.app
 * @param {string} options.deviceKey 设备 key
 * @param {string} [options.title]
 * @param {string} options.body
 * @param {string} [options.group]
 * @param {string} [options.sound]
 * @param {string} [options.level] active | timeSensitive | passive | critical
 * @param {string} [options.icon]
 * @param {string} [options.url]
 * @returns {Promise<{ ok: boolean, provider: string, detail?: unknown }>}
 */
export async function pushBark(options = {}) {
  const deviceKey = String(options.deviceKey ?? "").trim();
  if (!deviceKey) return { ok: false, provider: "bark", detail: "未配置 deviceKey" };
  const server = trimSlash(options.serverUrl) || BARK_DEFAULT_SERVER;
  const title = String(options.title ?? "DSH");
  const body = String(options.body ?? "").slice(0, 2400);
  const extras = {};
  for (const key of ["group", "sound", "level", "icon", "url"]) {
    const value = String(options[key] ?? "").trim();
    if (value) extras[key] = value;
  }

  try {
    const form = new URLSearchParams({ device_key: deviceKey, title, body, ...extras });
    const response = await fetch(`${server}/push`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await readJson(response);
    if (response.ok && (payload.code === undefined || payload.code === 200)) {
      return { ok: true, provider: "bark", detail: payload };
    }
    // 退回路径式接口
    const query = new URLSearchParams(extras);
    const path = `${server}/${encodeURIComponent(deviceKey)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
    const fallback = await fetch(query.toString() ? `${path}?${query}` : path, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });
    const fallbackPayload = await readJson(fallback);
    const ok = fallback.ok && (fallbackPayload.code === undefined || fallbackPayload.code === 200);
    return { ok, provider: "bark", detail: ok ? fallbackPayload : { httpStatus: fallback.status, payload: fallbackPayload } };
  } catch (error) {
    return { ok: false, provider: "bark", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * WxPusher 推送。支持 appToken 与免注册 SPT（以 SPT_ 开头）。
 * @param {object} options
 * @param {string} options.appToken
 * @param {string} options.content
 * @param {string} [options.summary]
 * @param {number} [options.contentType] 1 文本 2 HTML 3 Markdown
 * @param {string} [options.uids] 逗号或换行分隔
 * @param {string} [options.topicIds] 逗号或换行分隔
 * @param {string} [options.url]
 * @returns {Promise<{ ok: boolean, provider: string, detail?: unknown }>}
 */
export async function pushWxPusher(options = {}) {
  const appToken = String(options.appToken ?? "").trim();
  if (!appToken) return { ok: false, provider: "wxpusher", detail: "未配置 appToken / SPT" };
  const content = String(options.content ?? "").slice(0, 20000);
  const summary = String(options.summary ?? "").slice(0, 99);
  const contentType = Number(options.contentType) || 1;

  const toList = (value) =>
    String(value ?? "")
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);

  try {
    if (appToken.startsWith("SPT_")) {
      const response = await fetch(WXPUSHER_SPT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spt: appToken, content, summary, contentType }),
        signal: AbortSignal.timeout(15000),
      });
      const payload = await readJson(response);
      return { ok: response.ok && payload.code === 1000, provider: "wxpusher-spt", detail: payload };
    }

    const body = {
      appToken,
      content,
      summary,
      contentType,
      uids: toList(options.uids),
      topicIds: toList(options.topicIds).map((id) => Number(id)).filter((id) => Number.isFinite(id)),
    };
    const url = String(options.url ?? "").trim();
    if (url) body.url = url;
    const response = await fetch(WXPUSHER_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await readJson(response);
    return { ok: response.ok && payload.code === 1000, provider: "wxpusher", detail: payload };
  } catch (error) {
    return { ok: false, provider: "wxpusher", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 按配置并发推送所有启用的通道。
 * @param {{ push?: object }} config
 * @param {{ title?: string, text: string }} message
 * @returns {Promise<Array<{ ok: boolean, provider: string, detail?: unknown }>>}
 */
export async function pushAll(config, message) {
  const push = config?.push ?? {};
  const text = String(message?.text ?? "");
  if (push.enabled === false) return [];
  if (!text.trim()) return [];
  const title = String(message?.title ?? "DSH 通知");
  const tasks = [];
  // 点击通知默认拉起微信（weixin://），用户点开就能回到 ClawBot 继续对话。
  const openUrl = (channel) => {
    const explicit = String(channel?.url ?? "").trim();
    if (explicit) return explicit;
    const configured = String(channel?.openUrl ?? "").trim();
    return configured || "weixin://";
  };
  if (push?.bark?.enabled) {
    tasks.push(pushBark({ ...push.bark, title, body: text, url: openUrl(push.bark) }));
  }
  if (push?.wxpusher?.enabled) {
    tasks.push(
      pushWxPusher({
        ...push.wxpusher,
        url: openUrl(push.wxpusher),
        summary: push.wxpusher?.summary ? String(push.wxpusher.summary) : title,
        content: text,
      }),
    );
  }
  if (!tasks.length) return [];
  return Promise.all(tasks);
}

/**
 * 是否有任何推送通道可用（用于决定是否兜底）。
 * @param {{ push?: object }} config
 * @returns {boolean}
 */
export function hasPushChannel(config) {
  const push = config?.push ?? {};
  if (push.enabled === false) return false;
  return Boolean(push?.bark?.enabled && String(push?.bark?.deviceKey ?? "").trim())
    || Boolean(push?.wxpusher?.enabled && String(push?.wxpusher?.appToken ?? "").trim());
}
