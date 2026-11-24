/**
 * 入站网关：一个只放行 /clawbot/hook* 的极窄反向代理。
 *
 * 为什么需要它：Cloudflare Quick Tunnel / frp 都是「把本机某个端口整段暴露到公网」。
 * 如果直接指向 DSH 的 Web 端口，等于把整个 GUI（含所有会话、文件读写）暴露出去。
 * 所以隧道只连这个网关，网关只把 hook 路径转发给 DSH，其余一律 404。
 */

import http from "node:http";

const DEFAULT_HOST = "127.0.0.1";

/** 只允许这两个前缀穿过隧道。 */
const ALLOWED_PREFIXES = ["/clawbot/hook", "/clawbot/health"];

export function isAllowedPath(pathname) {
  const value = String(pathname || "");
  return ALLOWED_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`));
}

/**
 * @param {{ targetPort: number | (() => number), targetHost?: string, log?: (level: string, message: string) => void }} options
 */
export function createGateway(options) {
  const targetHost = options.targetHost || DEFAULT_HOST;
  const resolveTarget = typeof options.targetPort === "function" ? options.targetPort : () => Number(options.targetPort) || 0;
  const log = options.log || (() => {});

  /** @type {import("node:http").Server | null} */
  let server = null;
  let port = 0;
  let requests = 0;
  let rejected = 0;

  function handle(req, res) {
    const url = new URL(req.url || "/", "http://gateway.local");
    if (!isAllowedPath(url.pathname)) {
      rejected += 1;
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    const targetPort = resolveTarget();
    if (!targetPort) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "目标端口未知" }));
      return;
    }
    requests += 1;
    const headers = { ...req.headers };
    delete headers.host;
    headers["x-forwarded-proto"] = "https";
    headers["x-clawbot-tunnel"] = "1";
    const upstream = http.request(
      { host: targetHost, port: targetPort, method: req.method, path: req.url, headers },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      log("warn", `网关转发失败：${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "upstream unreachable" }));
      }
    });
    req.pipe(upstream);
  }

  return {
    /** 启动网关；端口被占用时抛错，由调用方提示用户改端口。 */
    async start(preferredPort) {
      if (server) return { ok: true, port };
      const listenPort = Number(preferredPort) || 0;
      const instance = http.createServer(handle);
      instance.keepAliveTimeout = 5000;
      await new Promise((resolve, reject) => {
        instance.once("error", reject);
        instance.listen(listenPort, DEFAULT_HOST, () => resolve(undefined));
      });
      server = instance;
      port = instance.address()?.port ?? listenPort;
      log("info", `入站网关已启动：http://${DEFAULT_HOST}:${port}（仅放行 /clawbot/hook）`);
      return { ok: true, port };
    },

    async stop() {
      if (!server) return { ok: true };
      const instance = server;
      server = null;
      await new Promise((resolve) => instance.close(() => resolve(undefined)));
      log("info", "入站网关已停止");
      return { ok: true };
    },

    info() {
      return {
        running: Boolean(server),
        port,
        url: server ? `http://${DEFAULT_HOST}:${port}` : "",
        targetPort: resolveTarget(),
        requests,
        rejected,
      };
    },
  };
}
