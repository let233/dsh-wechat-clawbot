/**
 * 隧道与网关的单元测试（不联网、不启动真实隧道进程）。
 *
 *   node test/tunnel.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createGateway, isAllowedPath } from "../lib/gateway.js";
import { TunnelManager, TunnelError } from "../lib/tunnel.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbot-tunnel-"));

function fakeStore(config) {
  const state = config;
  return {
    paths: () => ({ dir: tempDir, file: path.join(tempDir, "config.json") }),
    get: () => state,
    patch: (patch) => Object.assign(state, patch),
  };
}

// ---------------------------------------------------------------- 路径白名单

assert.equal(isAllowedPath("/clawbot/hook"), true);
assert.equal(isAllowedPath("/clawbot/hook/abc"), true);
assert.equal(isAllowedPath("/clawbot/health"), true);
assert.equal(isAllowedPath("/clawbot/hook?token=x"), true, "原始请求串带查询参数时也应放行");
assert.equal(isAllowedPath("/"), false);
assert.equal(isAllowedPath("/api/sessions"), false);
assert.equal(isAllowedPath("/clawbot/api/state"), false, "管理接口不允许穿过隧道");

// ---------------------------------------------------------------- 网关转发

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url, tunnel: req.headers["x-clawbot-tunnel"] || "", proto: req.headers["x-forwarded-proto"] || "" }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const gateway = createGateway({ targetPort: upstreamPort });
const started = await gateway.start(0);
assert.ok(started.port > 0, "网关应拿到端口");
const base = `http://127.0.0.1:${started.port}`;

const forwarded = await fetch(`${base}/clawbot/hook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "hi" }),
});
assert.equal(forwarded.status, 200, "允许的路径应被转发");
const forwardedBody = await forwarded.json();
assert.equal(forwardedBody.tunnel, "1", "转发请求应打上 x-clawbot-tunnel");
assert.equal(forwardedBody.proto, "https", "转发请求应标记 x-forwarded-proto=https");

const blocked = await fetch(`${base}/clawbot/api/state`);
assert.equal(blocked.status, 404, "管理接口不允许穿过隧道");
const blockedRoot = await fetch(`${base}/`);
assert.equal(blockedRoot.status, 404, "根路径不允许穿过隧道");

const health = await fetch(`${base}/clawbot/health`);
assert.equal(health.status, 200, "health 应放行");

const info = gateway.info();
assert.equal(info.rejected, 2, `应拦截 2 次，实际 ${info.rejected}`);
assert.equal(info.requests, 2, `应放行 2 次，实际 ${info.requests}`);
await gateway.stop();
const stopped = gateway.info();
assert.equal(stopped.running, false, "stop 后应停止");

// 上游不可用时返回 502
const deadGateway = createGateway({ targetPort: 1 });
await deadGateway.start(0);
const deadRes = await fetch(`http://127.0.0.1:${deadGateway.info().port}/clawbot/hook`).catch(() => null);
if (deadRes) assert.ok([502, 503].includes(deadRes.status), `上游不可用应返回 502/503，实际 ${deadRes?.status}`);
await deadGateway.stop();

// ---------------------------------------------------------------- frp 配置生成

const frpStore = fakeStore({
  tunnel: {
    provider: "frp",
    proxyPort: 61500,
    hook: { token: "", forwardToCoordinator: true },
    cloudflare: { binaryPath: "", extraArgs: "" },
    frp: {
      serverAddr: "frp.example.com",
      serverPort: 7000,
      token: "s3cret",
      protocol: "tcp",
      remotePort: 6100,
      customDomains: "",
      publicHost: "example.com",
      tls: true,
      binaryPath: "",
    },
  },
});
const manager = new TunnelManager({ store: frpStore, log: () => {}, hostPort: () => 61431 });

const toml = manager.buildFrpConfig();
assert.match(toml, /serverAddr = "frp\.example\.com"/);
assert.match(toml, /serverPort = 7000/);
assert.match(toml, /auth\.token = "s3cret"/);
assert.match(toml, /transport\.tls\.enable = true/);
assert.match(toml, /name = "dsh-clawbot-hook"/);
assert.match(toml, /type = "tcp"/);
assert.match(toml, /localPort = 61500/, "本地端口应指向网关");
assert.match(toml, /remotePort = 6100/);
assert.equal(manager.composeFrpUrl(frpStore.get().tunnel.frp, "tcp"), "http://example.com:6100");

// http 模式必须有自定义域名
frpStore.get().tunnel.frp.protocol = "http";
assert.throws(() => manager.buildFrpConfig(), (error) => error instanceof TunnelError && /自定义域名/.test(error.message));
frpStore.get().tunnel.frp.customDomains = "clawbot.example.com, alt.example.com";
const httpToml = manager.buildFrpConfig();
assert.match(httpToml, /type = "http"/);
assert.match(httpToml, /customDomains = \["clawbot\.example\.com","alt\.example\.com"\]/);
assert.equal(manager.composeFrpUrl(frpStore.get().tunnel.frp, "http"), "http://clawbot.example.com");

// 缺服务端地址要报错
frpStore.get().tunnel.frp.serverAddr = "";
assert.throws(() => manager.buildFrpConfig(), (error) => error instanceof TunnelError && /服务端地址/.test(error.message));

// 找不到二进制时 resolveBinary 返回空串（不抛错）
assert.equal(typeof manager.resolveBinary("frpc"), "string");

// status() 结构
const status = manager.status();
assert.equal(status.state, "stopped");
assert.equal(typeof status.binaries.cloudflared, "string");
assert.equal(status.config.hookPath, "/clawbot/hook");

console.log("隧道测试通过：网关白名单/转发、frp 配置生成、状态视图");
console.log(`临时目录：${tempDir}`);
await new Promise((resolve) => upstream.close(resolve));
