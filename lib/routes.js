/**
 * 设置界面所用的 HTTP API（同源，挂在 /clawbot/api 下）。
 */

import crypto from "node:crypto";

const MAX_BODY = 1024 * 512;

/**
 * 插件路由不经过壳层的登录校验，这里补一层同源防护：
 * - 标记为 cross-site 的请求一律拒绝（跨站脚本读不到本接口）
 * - 写操作必须带 x-clawbot-client: 1。跨站请求无法在不触发 CORS 预检的情况下
 *   带上自定义头，而本服务不返回任何 CORS 头，因此跨站写入被挡住。
 *   本地脚本（node / curl）调用写接口时同样需要带这个头。
 */
function rejectForeignRequest(req) {
  if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return "跨站请求被拒绝";
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && String(req.headers["x-clawbot-client"] ?? "") !== "1") {
    return "缺少 x-clawbot-client 请求头";
  }
  return "";
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {{ runtime: any, store: any, bridge: any, tunnel: any }} deps
 */
export function createApi({ runtime, store, bridge, tunnel }) {
  /** 方法表：后缀 → 处理函数。 */
  const handlers = {
    async state() {
      const workspaces = await bridge.listWorkspaces().catch(() => []);
      return { ok: true, ...runtime.describe(), workspaces, tunnel: tunnel.status() };
    },

    async save({ body }) {
      const patch = body?.config && typeof body.config === "object" ? body.config : body ?? {};
      const allowed = ["ilink", "push", "reply", "routing", "log"];
      const clean = {};
      for (const key of allowed) {
        if (patch[key] && typeof patch[key] === "object") clean[key] = patch[key];
      }
      // 协调器会话由 Host 创建，界面只能改 activeSessionId 等偏好
      if (clean.routing) {
        delete clean.routing.coordinatorSessionId;
        delete clean.routing.agentPreset;
        // 指挥会话映射只由 Host 在真正建会话时写入
        delete clean.routing.commands;
        delete clean.routing.knownCommands;
        // 落点只能是插件自己的专属会话：界面要改就显式走 focus 接口
        if (typeof clean.routing.activeSessionId === "string" && clean.routing.activeSessionId) {
          delete clean.routing.activeSessionId;
        }
      }
      // 不允许通过 API 伪造登录态字段
      if (clean.ilink) {
        delete clean.ilink.botToken;
        delete clean.ilink.botId;
        delete clean.ilink.userId;
        delete clean.ilink.savedAt;
        delete clean.ilink.getUpdatesBuf;
        delete clean.ilink.lastContextToken;
        delete clean.ilink.lastContextUserId;
        delete clean.ilink.lastContextAt;
      }
      store.patch(clean);
      return { ok: true, state: runtime.describe() };
    },

    async "login/start"() {
      const result = await runtime.loginStart();
      return { ok: true, qrcode: result.qrcode, qrImg: result.qrImg, qrSvg: result.qrSvg, state: runtime.describe() };
    },

    async "login/pin"({ body }) {
      const code = String(body?.code ?? "").trim();
      if (!code) throw new Error("请输入手机端显示的 PIN");
      runtime.loginSubmitPin(code);
      return { ok: true, state: runtime.describe() };
    },

    async "login/logout"() {
      runtime.logout();
      return { ok: true, state: runtime.describe() };
    },

    async connect() {
      const result = runtime.startPolling();
      return { ok: Boolean(result.ok), reason: result.reason, state: runtime.describe() };
    },

    async disconnect() {
      runtime.stopPolling();
      return { ok: true, state: runtime.describe() };
    },

    async "push/test"({ body }) {
      const text = String(body?.text ?? "这是一条来自 DSH × 微信 ClawBot 的推送测试。").trim();
      const channel = String(body?.channel ?? "all");
      const inline = body?.config && typeof body.config === "object" ? body.config : {};
      const saved = store.get();
      const push = {
        ...saved.push,
        ...(inline.push && typeof inline.push === "object" ? inline.push : inline),
      };
      const missing = [];
      const barkOn = channel === "all" || channel === "bark";
      const wxOn = channel === "all" || channel === "wxpusher";
      push.enabled = true;
      push.bark = { ...saved.push.bark, ...(push.bark || {}) };
      push.wxpusher = { ...saved.push.wxpusher, ...(push.wxpusher || {}) };
      push.bark.enabled = barkOn && Boolean(String(push.bark.deviceKey ?? "").trim());
      push.wxpusher.enabled = wxOn && Boolean(String(push.wxpusher.appToken ?? "").trim());
      if (barkOn && !push.bark.enabled) missing.push("Bark 设备 Key");
      if (wxOn && !push.wxpusher.enabled) missing.push("WxPusher AppToken");
      if (!push.bark.enabled && !push.wxpusher.enabled) {
        return { ok: false, results: [], error: `没有可用的推送通道，请先填写：${missing.join("、") || "至少一个通道"}` };
      }
      const result = await runtime.pushNow(text, "DSH 推送测试", { ...saved, push });
      const failed = (result.results || []).filter((item) => !item?.ok);
      const error = failed.length ? failed.map((item) => `${item.channel}：${item.error || "失败"}`).join("; ") : missing.length ? `未测试：${missing.join("、")}` : "";
      return { ok: Boolean(result.ok), results: result.results || [], error };
    },


    async "send/test"({ body }) {
      const text = String(body?.text ?? "").trim();
      if (!text) throw new Error("请输入要发送的内容");
      const result = await runtime.sendActive(text);
      return result;
    },

    async sessions({ body }) {
      const rows = await bridge.listSessions({ limit: Number(body?.limit) || 30, withSnippet: true });
      return { ok: true, items: rows.map((row) => ({ ...row, label: bridge.label(row) })) };
    },

    async focus({ body }) {
      const sessionId = String(body?.sessionId ?? "").trim();
      if (!sessionId) {
        const cleared = await bridge.focus("");
        return { ok: true, cleared: true, state: runtime.describe() };
      }
      const row = (await bridge.listSessions({ limit: 100 })).find((item) => item.sessionId === sessionId);
      const focused = await bridge.focus(sessionId, { label: row ? bridge.label(row) : sessionId, cwd: row?.cwd });
      return {
        ok: true,
        sessionId: focused.sessionId,
        targetSessionId: focused.targetSessionId,
        created: focused.created,
        state: runtime.describe(),
      };
    },

    async "commands/remove"({ body }) {
      const target = String(body?.sessionId ?? "").trim();
      if (!target) throw Object.assign(new Error("sessionId 必填"), { statusCode: 400 });
      const commands = bridge.commands();
      const commandId = String(commands[target] ?? "");
      // 深合并删不掉 key，这里必须直接改后落盘
      store.mutate((config) => {
        config.routing = config.routing ?? {};
        config.routing.commands = config.routing.commands ?? {};
        delete config.routing.commands[target];
        if (commandId && String(config.routing.activeSessionId ?? "") === commandId) {
          config.routing.activeSessionId = "";
        }
      });
      return { ok: true, removed: Boolean(commandId), targetSessionId: target, commandSessionId: commandId };
    },

    async commands() {
      const commands = bridge.commands();
      return { ok: true, commands, count: Object.keys(commands).length };
    },

    async coordinator() {
      const coordinator = await bridge.ensureCoordinator();
      return { ok: true, sessionId: coordinator.sessionId, created: Boolean(coordinator.created) };
    },

    /** 归档 / 取消归档会话（临时会话清理用）。 */
    async "session/archive"({ body }) {
      const sessionId = String(body?.sessionId ?? "").trim();
      if (!sessionId) throw Object.assign(new Error("sessionId 必填"), { statusCode: 400 });
      return { ...(await bridge.archiveSession(sessionId, body?.archived !== false)) };
    },

    /** 调试入口：像微信里发了一条消息那样执行指令（不经过微信通道）。 */
    /**
     * 大白话匹配会话：只读预览，apply=true 时才真的开指挥会话。
     * 便于在设置页/命令行里先看「切到那个在改登录页的会话」会命中谁。
     */
    async "focus/query"({ body }) {
      const query = String(body?.query ?? "").trim();
      if (!query) throw Object.assign(new Error("query 不能为空"), { statusCode: 400 });
      const match = await bridge.matchTarget(query);
      const candidates = (match.candidates ?? []).slice(0, 5).map((item) => ({
        sessionId: item.row.sessionId,
        label: bridge.label(item.row),
        score: item.score,
        reason: Array.isArray(item.hits) ? item.hits.join("/") : "",
      }));
      const payload = { kind: match.kind, query, candidates, matchedId: match.kind === "one" ? match.row.sessionId : "" };
      if (body?.apply && match.kind === "one") {
        const focused = await bridge.focus(String(match.row.sessionId), {
          label: bridge.label(match.row),
          cwd: match.row.cwd || undefined,
        });
        payload.focused = {
          sessionId: focused.sessionId,
          targetSessionId: focused.targetSessionId,
          created: Boolean(focused.created),
        };
      }
      return payload;
    },

    /**
     * 模拟一条微信文本消息，只跑「大白话切换落点」这一层（不真的发微信、不花模型）。
     * 用来验证「切到那个在改登录页的会话」这类说法能不能被正确接管。
     */
    async "chat/simulate"({ body }) {
      const text = String(body?.text ?? "");
      if (!text.trim()) throw Object.assign(new Error("text 不能为空"), { statusCode: 400 });
      const intent = runtime.parseIntent(text);
      if (!intent) return { handled: false, text };
      const reply = await runtime.tryFocusIntent(intent);
      return reply ? { handled: true, intent, reply } : { handled: false, intent, text };
    },

    async "command/run"({ body }) {
      const text = String(body?.text ?? "");
      if (!text.trim()) throw Object.assign(new Error("text 不能为空"), { statusCode: 400 });
      const command = runtime.matchCommand(text);
      if (!command) {
        return { ok: false, error: "不是已知快捷指令（/help /sessions /switch /coord /status /new /task）" };
      }
      const output = await runtime.runCommand(command, String(body?.userId ?? "debug"));
      return { ok: true, command: command.name, output };
    },

    /** 会话详情：调试/自检用，返回最近若干条事件与最近一轮请求回复。 */
    async "session/detail"({ body }) {
      const sessionId = String(body?.sessionId ?? "").trim();
      if (!sessionId) throw Object.assign(new Error("sessionId 必填"), { statusCode: 400 });
      const detail = await bridge.sessionDetail(sessionId, {
        maxMessages: Math.min(Math.max(Number(body?.maxMessages) || 40, 1), 200),
        includeRecords: body?.raw === true,
      });
      return { ok: true, ...detail };
    },

    /** 调试入口：直接把一句话交给协调器会话，用于自检工具链是否可用。 */
    async "coordinator/ask"({ body }) {
      const text = String(body?.text ?? "");
      if (!text.trim()) throw Object.assign(new Error("text 不能为空"), { statusCode: 400 });
      const coordinator = await bridge.ensureCoordinator();
      if (body?.wait === false) {
        const accepted = await bridge.prompt(coordinator.sessionId, text, { mode: "queue" });
        return { ok: true, sessionId: coordinator.sessionId, accepted: accepted.accepted, reply: "" };
      }
      const result = await bridge.promptAndWait(coordinator.sessionId, text, {
        timeoutMs: Math.min(Math.max(Number(body?.timeoutMs) || 240000, 5000), 900000),
      });
      return { ok: true, sessionId: coordinator.sessionId, reply: result.text, reason: result.reason };
    },

    // ------------------------------------------------------------ 隧道 / 入站

    async "tunnel/state"() {
      return { ok: true, tunnel: tunnel.status() };
    },

    async "tunnel/save"({ body }) {
      const patch = body?.config && typeof body.config === "object" ? body.config : body ?? {};
      const clean = {};
      if (patch.provider !== undefined) {
        const provider = String(patch.provider || "cloudflare");
        if (!["off", "cloudflare", "frp"].includes(provider)) throw Object.assign(new Error("provider 只能是 off / cloudflare / frp"), { statusCode: 400 });
        clean.provider = provider;
      }
      if (patch.autoStart !== undefined) {
        clean.autoStart = patch.autoStart !== false;
      }
      if (patch.proxyPort !== undefined) {
        const port = Number(patch.proxyPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error("网关端口需在 1024-65535 之间"), { statusCode: 400 });
        clean.proxyPort = port;
      }
      if (patch.hook && typeof patch.hook === "object") {
        clean.hook = {
          token: String(patch.hook.token ?? "").trim(),
          forwardToCoordinator: patch.hook.forwardToCoordinator !== false,
        };
      }
      if (patch.download && typeof patch.download === "object") {
        const mirrors = Array.isArray(patch.download.mirrors) ? patch.download.mirrors : String(patch.download.mirrors ?? "").split(/[\s,]+/);
        clean.download = { mirrors: mirrors.map((item) => String(item || "").trim()).filter(Boolean) };
      }
      if (patch.cloudflare && typeof patch.cloudflare === "object") {
        const mode = String(patch.cloudflare.mode || "quick").toLowerCase();
        if (!["quick", "token"].includes(mode)) {
          throw Object.assign(new Error("Cloudflare 模式只能是 quick（快速隧道）/ token（命名隧道）"), { statusCode: 400 });
        }
        const publicUrl = String(patch.cloudflare.publicUrl ?? "").trim().replace(/\/+$/, "");
        if (publicUrl && !/^https?:\/\//i.test(publicUrl)) {
          throw Object.assign(new Error("公共主机名要以 http:// 或 https:// 开头，例如 https://clawbot.example.com"), { statusCode: 400 });
        }
        clean.cloudflare = {
          mode,
          tunnelToken: String(patch.cloudflare.tunnelToken ?? "").trim(),
          publicUrl,
          binaryPath: String(patch.cloudflare.binaryPath ?? "").trim(),
          extraArgs: String(patch.cloudflare.extraArgs ?? "").trim(),
        };
      }
      if (patch.frp && typeof patch.frp === "object") {
        const frp = patch.frp;
        const protocol = String(frp.protocol || "tcp").toLowerCase();
        if (!["tcp", "http", "https"].includes(protocol)) throw Object.assign(new Error("frp 协议只能是 tcp / http / https"), { statusCode: 400 });
        clean.frp = {
          serverAddr: String(frp.serverAddr ?? "").trim(),
          serverPort: Number(frp.serverPort) || 7000,
          token: String(frp.token ?? "").trim(),
          protocol,
          remotePort: Number(frp.remotePort) || 6000,
          customDomains: String(frp.customDomains ?? "").trim(),
          publicHost: String(frp.publicHost ?? "").trim(),
          tls: frp.tls === true,
          binaryPath: String(frp.binaryPath ?? "").trim(),
        };
      }
      store.patch({ tunnel: clean });
      return { ok: true, tunnel: tunnel.status() };
    },

    /** 生成（或查看）入站 webhook 的共享密钥。 */
    async "tunnel/token"({ body }) {
      const current = String(store.get().tunnel?.hook?.token ?? "");
      if (body?.regenerate === true || !current) {
        const token = crypto.randomBytes(16).toString("hex");
        store.patch({ tunnel: { hook: { token } } });
        return { ok: true, token, regenerated: true, tunnel: tunnel.status() };
      }
      return { ok: true, token: current, regenerated: false, tunnel: tunnel.status() };
    },

    async "tunnel/start"({ body }) {
      const state = await tunnel.start({ restart: body?.restart === true });
      return { ok: true, tunnel: state };
    },

    async "tunnel/stop"() {
      const state = await tunnel.stop();
      return { ok: true, tunnel: state };
    },

    /** 下载官方二进制（cloudflared 或 frpc），sha256 校验后放到插件目录。 */
    async "tunnel/install"({ body }) {
      const name = String(body?.name ?? "cloudflared");
      if (!["cloudflared", "frpc"].includes(name)) throw Object.assign(new Error("name 只能是 cloudflared 或 frpc"), { statusCode: 400 });
      const result = await tunnel.install(name);
      return { ok: true, ...result, tunnel: tunnel.status() };
    },

    async "tunnel/logs"() {
      return { ok: true, logs: tunnel.status().logs, state: tunnel.status().state, publicUrl: tunnel.status().publicUrl };
    },

    async "reset/cursor"() {
      store.patch({ ilink: { getUpdatesBuf: "" } });
      runtime.buf = "";
      return { ok: true, note: "已清空 getUpdates 游标，下次轮询重新拉取" };
    },
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} prefix
   */
  return async function handle(req, res, prefix) {
    const url = new URL(req.url ?? "/", "http://dsh.internal");
    let suffix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    suffix = suffix.replace(/^\/+/, "").replace(/\/+$/, "");
    const method = String(suffix || "state");

    const blocked = rejectForeignRequest(req);
    if (blocked) {
      writeJson(res, 403, { ok: false, error: blocked });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(handlers, method)) {
      writeJson(res, 404, { ok: false, error: `未知的接口：${method}` });
      return;
    }
    const readOnly = method === "state" || method === "sessions" || method === "tunnel/state" || method === "tunnel/logs";
    if (req.method === "GET" && !readOnly) {
      writeJson(res, 405, { ok: false, error: "该接口仅支持 POST" });
      return;
    }

    let body = {};
    if (req.method !== "GET") {
      try {
        body = await readJson(req);
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }

    try {
      const payload = await handlers[method]({ body, query: url.searchParams, req });
      writeJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = Number(error?.statusCode) || 500;
      if (status >= 500) runtime.log("error", `接口 ${method} 失败：${message}`);
      writeJson(res, status, { ok: false, error: message });
    }
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 入站 webhook（/clawbot/hook）：被隧道转发进来的唯一入口。
 *
 * 与 /clawbot/api 的区别：
 *   - 不需要 x-clawbot-client（调用方不是本套 GUI）；
 *   - 用 hook.token 做共享密钥校验，因为它暴露在公网；
 *   - 只做「把一句话交给 DSH 并返回结果」这一件事，没有配置读写能力。
 *
 * @param {{ runtime: any, store: any }} deps
 */
export function createHook({ runtime, store }) {
  return async function handle(req, res) {
    if (req.method === "GET" || req.method === "HEAD") {
      writeJson(res, 200, { ok: true, service: "dsh-wechat-clawbot", hook: true, time: new Date().toISOString() });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "只支持 POST" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://dsh.internal");
    const hook = store.get().tunnel?.hook ?? {};
    const expected = String(hook.token ?? "");
    if (!expected) {
      writeJson(res, 503, { ok: false, error: "尚未设置 hook token，请先在设置页生成" });
      return;
    }
    const provided =
      String(req.headers["x-clawbot-token"] ?? "") ||
      String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") ||
      String(url.searchParams.get("token") ?? "");
    if (!safeEqual(provided, expected)) {
      writeJson(res, 401, { ok: false, error: "token 不正确" });
      return;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const payload = body && typeof body === "object" ? body : {};
    if (hook.forwardToCoordinator === false && !String(payload.sessionId ?? "").trim()) {
      writeJson(res, 400, { ok: false, error: "未开启「默认转发到协调器」，请显式指定 sessionId" });
      return;
    }
    try {
      const result = await runtime.handleWebhook(payload);
      writeJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.log("error", `入站 hook 失败：${message}`);
      writeJson(res, 500, { ok: false, error: message });
    }
  };
}
