/**
 * dsh-wechat-clawbot · Host 侧入口
 *
 * 职责：
 *   1. 挂载 /clawbot/api 供客户端设置界面读写配置、扫码登录、测试推送
 *   2. 注册仅协调器会话可见的工具（查询会话 / 派发任务 / 切换目标 / 推送）
 *   3. 启动 ClawBot 长轮询（已登录且未关闭自动启动时）
 *   4. 内置隧道（Cloudflare Quick Tunnel / frp）+ 极窄入站网关，只放行 /clawbot/hook
 */

import { ConfigStore } from "./store.js";
import { SessionBridge } from "./bridge.js";
import { ClawBotRuntime } from "./bot.js";
import { createApi, createHook } from "./routes.js";
import { createTools } from "./tools.js";
import { createGateway } from "./gateway.js";
import { TunnelManager } from "./tunnel.js";

export const name = "dsh-wechat-clawbot";
export const inject = ["webServer", "tools"];

const API_PREFIX = "/clawbot/api";
const HOOK_PREFIX = "/clawbot/hook";
const HEALTH_PREFIX = "/clawbot/health";

export function apply(ctx, config) {
  const logger = typeof ctx.logger === "function" ? ctx.logger("wechat-clawbot") : null;
  const log = (level, message) => {
    try {
      if (logger && typeof logger[level] === "function") logger[level](message);
      else if (level === "error" || level === "warn") console.warn(`[wechat-clawbot] ${message}`);
    } catch {
      /* 日志失败不影响业务 */
    }
  };

  const store = new ConfigStore();
  if (config && typeof config === "object") {
    const initial = {};
    for (const key of ["ilink", "push", "reply", "routing", "tunnel", "log"]) {
      if (config[key] && typeof config[key] === "object") initial[key] = config[key];
    }
    if (Object.keys(initial).length) store.patch(initial);
  }

  /** DSH host 的真实监听端口：隧道网关要反向代理回它。 */
  const hostPort = () => {
    try {
      const origin = typeof ctx.webServer?.getOrigin === "function" ? ctx.webServer.getOrigin() : "";
      const parsed = new URL(String(origin || ""));
      return Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    } catch {
      return 0;
    }
  };

  const bridge = new SessionBridge(ctx, store, { log });
  const runtime = new ClawBotRuntime({ ctx, store, bridge, log });
  const gateway = createGateway({ targetPort: hostPort, log: (level, message) => log(level, message) });
  const tunnel = new TunnelManager({ store, log, hostPort });
  tunnel.attachGateway(gateway);

  const api = createApi({ runtime, store, bridge, tunnel });
  const hook = createHook({ runtime, store });

  // 1) 设置界面用的 HTTP API
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: API_PREFIX,
        handler: (req, res) => api(req, res, API_PREFIX),
      }),
    "wechat-clawbot:api",
  );

  // 2) 入站 webhook（隧道转发的唯一入口，走 hook token 校验）
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: HOOK_PREFIX,
        handler: (req, res) => hook(req, res),
      }),
    "wechat-clawbot:hook",
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: HEALTH_PREFIX,
        handler: (req, res) => {
          const body = JSON.stringify({ ok: true, service: "dsh-wechat-clawbot" });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
        },
      }),
    "wechat-clawbot:health",
  );

  // 3) 协调器专属工具
  for (const { definition, options } of createTools({ store, bridge, runtime })) {
    ctx.effect(() => ctx.tools.register(definition, options), `wechat-clawbot:tool:${definition.name}`);
  }

  // 4) 自动恢复长轮询 + 自动恢复隧道
  ctx.effect(() => {
    const settings = store.get();
    if (settings.ilink.botToken && settings.routing.autoStart !== false) {
      log("info", "检测到已保存的登录态，恢复长轮询");
      runtime.startPolling();
    }
    return () => {
      runtime.stopPolling();
    };
  }, "wechat-clawbot:runtime");

  ctx.effect(() => {
    const settings = store.get().tunnel || {};
    const provider = String(settings.provider || "cloudflare");
    const binary = tunnel.resolveBinary(provider === "frp" ? "frpc" : "cloudflared");
    if (provider !== "off" && settings.autoStart !== false && binary) {
      // 异步启动；失败只记日志，不阻塞 Host 启动
      tunnel.start().catch((error) => log("warn", `隧道自动启动失败：${error instanceof Error ? error.message : String(error)}`));
    }
    return () => {
      tunnel.stop({ silent: true }).catch(() => {});
    };
  }, "wechat-clawbot:tunnel");

  // 5) 供其它插件 / 控制台复用（可选）
  if (typeof ctx.provide === "function") {
    ctx.provide("wechatClawbot", { runtime, store, bridge, tunnel });
  }

  log("info", "插件已加载");
}

export default { name, inject, apply };
