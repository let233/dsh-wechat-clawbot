/**
 * 无 GUI 的宿主机冒烟测试：用假的 Cordis ctx 加载插件，验证路由与工具注册，
 * 并对 /clawbot/api 的几个只读接口做一次真实调用。
 *
 *   node test/smoke-host.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// 用临时目录当 DSH_HOME，避免测试把配置写进真实用户目录
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbot-test-"));
process.env.DSH_HOME = tempHome;

const { apply, name, inject } = await import("../lib/index.js");

const disposers = [];
const routes = [];
const tools = [];
const provided = {};
const logs = [];

const ctx = {
  logger: () => ({
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  }),
  effect(fn, label) {
    const dispose = fn();
    disposers.push({ label, dispose });
    return () => {};
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  tools: {
    register(definition, options) {
      tools.push({ definition, options });
      return () => {};
    },
  },
  provide(key, value) {
    provided[key] = value;
  },
  get(key) {
    if (key === "sessionController") {
      return {
        async list() {
          return { items: [] };
        },
        async state() {
          return { cursor: 1, active: false, running: false, queue: [], pendingInput: [] };
        },
      };
    }
    if (key === "workspaceRegistry") {
      return { list: () => [{ id: "w1", path: "D:\\code\\demo", title: "demo" }] };
    }
    return undefined;
  },
};

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

apply(ctx, {});

expect(name === "dsh-wechat-clawbot", "name 导出不正确");
expect(Array.isArray(inject) && inject.includes("webServer"), "inject 缺少 webServer");
expect(routes.length === 3, `路由注册数量应为 3，实际 ${routes.length}`);
const routePaths = routes.map((item) => item.path);
for (const expected of ["/clawbot/api", "/clawbot/hook", "/clawbot/health"]) {
  expect(routePaths.includes(expected), `缺少路由 ${expected}`);
}
expect(tools.length === 6, `工具数量应为 6，实际 ${tools.length}`);

const names = tools.map((item) => item.definition.name);
for (const expected of [
  "clawbot_sessions",
  "clawbot_session_detail",
  "clawbot_dispatch",
  "clawbot_relay",
  "clawbot_focus",
  "clawbot_push",
]) {
  expect(names.includes(expected), `缺少工具 ${expected}`);
}
for (const item of tools) {
  expect(typeof item.definition.execute === "function", `${item.definition.name} 缺少 execute`);
  expect(typeof item.definition.output?.render === "function", `${item.definition.name} 缺少 output.render`);
  expect(item.definition.parameters?.type === "object", `${item.definition.name} parameters 不是 object schema`);
  expect(typeof item.options?.when === "function", `${item.definition.name} 缺少 when 门控`);
  // 门控：非协调器会话不可见
  expect(item.options.when({ agent: { id: "other-session" } }) === false, `${item.definition.name} 门控对普通会话应返回 false`);
}

expect(typeof provided.wechatClawbot?.runtime?.describe === "function", "未提供 wechatClawbot 服务");
expect(typeof provided.wechatClawbot?.bridge?.listSessions === "function", "服务缺少 bridge");

// ---- 调用 HTTP API ----
function fakeReq(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = { "content-type": "application/json", "x-clawbot-client": "1" };
  return stream;
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? String(chunk) : "";
    },
  };
}

const handler = routes.find((item) => item.path === "/clawbot/api").handler;
const hookHandler = routes.find((item) => item.path === "/clawbot/hook").handler;

async function call(method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, raw: res.body };
}

const state = await call("GET", "/clawbot/api/state");
expect(state.status === 200, `state 接口状态码 ${state.status}`);
expect(state.json?.ok === true, `state 接口返回异常：${state.raw.slice(0, 200)}`);
expect(state.json?.status === "idle", `初始状态应为 idle，实际 ${state.json?.status}`);
expect(Array.isArray(state.json?.workspaces) && state.json.workspaces[0]?.title === "demo", "state 未返回工作区列表");
expect(typeof state.json?.config?.reply?.maxChars === "number", "state 未返回 reply 配置");

const unknown = await call("POST", "/clawbot/api/nope", {});
expect(unknown.status === 404, `未知接口应返回 404，实际 ${unknown.status}`);

const save = await call("POST", "/clawbot/api/save", { config: { reply: { maxChars: 1500 }, ilink: { botToken: "hack" } } });
expect(save.status === 200, `save 接口状态码 ${save.status}`);
expect(save.json?.state?.config?.reply?.maxChars === 1500, "save 未写入 reply.maxChars");
expect(!save.json?.state?.config?.ilink?.botToken, "save 不应允许写入 botToken");

const sendTest = await call("POST", "/clawbot/api/send/test", { text: "hi" });
expect(sendTest.status === 200 && sendTest.json?.ok === false, "未登录时 send/test 应返回 ok:false");

const pushTest = await call("POST", "/clawbot/api/push/test", { channel: "bark", text: "hi" });
expect(pushTest.status === 200, `push/test 状态码 ${pushTest.status}`);
expect(pushTest.json?.ok === false, "未配置 Bark 时 push/test 应返回 ok:false");

const badJson = fakeReq("POST", "/clawbot/api/save", undefined);
badJson.push = undefined;
const res503 = fakeRes();
// 直接塞入非法 JSON
const broken = Readable.from([Buffer.from("{not json")]);
broken.method = "POST";
broken.url = "/clawbot/api/save";
broken.headers = { "x-clawbot-client": "1" };
await handler(broken, res503);
expect(res503.statusCode === 400, `非法 JSON 应返回 400，实际 ${res503.statusCode}`);

// 写接口缺少 x-clawbot-client 头应被同源防护拦下
const noHeader = fakeReq("POST", "/clawbot/api/save", { config: { reply: { maxChars: 1200 } } });
noHeader.headers = { "content-type": "application/json" };
const resNoHeader = fakeRes();
await handler(noHeader, resNoHeader);
expect(resNoHeader.statusCode === 403, `缺头写操作应返回 403，实际 ${resNoHeader.statusCode}`);

// 工具的运行期门控：非协调器会话调用必须被拒绝
const sessionsTool = tools.find((item) => item.definition.name === "clawbot_sessions");
let guardedError = "";
try {
  await sessionsTool.definition.execute({ limit: 5 }, { agent: "session-someone-else" });
} catch (error) {
  guardedError = error instanceof Error ? error.message : String(error);
}
expect(guardedError.includes("只对微信 ClawBot 专属会话开放"), `普通会话调用应被拒绝，实际：${guardedError || "未抛错"}`);

// 角色分工需要真实的协调器身份：先把这个临时 DSH_HOME 的协调器会话登记进配置
provided.wechatClawbot.store.patch({ routing: { coordinatorSessionId: "coord-1" } });

// 角色分工：协调器不能用 relay；指挥会话不能用 focus
const relayTool = tools.find((item) => item.definition.name === "clawbot_relay");
let relayError = "";
try {
  await relayTool.definition.execute({ message: "x" }, { agent: "coord-1" });
} catch (error) {
  relayError = error instanceof Error ? error.message : String(error);
}
expect(relayError.includes("clawbot_relay"), `协调器调用 relay 应被拒绝，实际：${relayError || "未抛错"}`);

const focusTool = tools.find((item) => item.definition.name === "clawbot_focus");
let focusError = "";
try {
  await focusTool.definition.execute({ sessionId: "s1" }, { agent: "command-abc" });
} catch (error) {
  focusError = error instanceof Error ? error.message : String(error);
}
expect(focusError.length > 0, "非协调器调用 focus 应被拒绝");


// ---- 隧道接口 ----
const tunnelState = await call("GET", "/clawbot/api/tunnel/state");
expect(tunnelState.status === 200, `tunnel/state 状态码 ${tunnelState.status}`);
expect(tunnelState.json?.tunnel?.provider === "cloudflare", `默认隧道类型应为 cloudflare，实际 ${tunnelState.json?.tunnel?.provider}`);
expect(tunnelState.json?.tunnel?.config?.proxyPort === 61499, "默认网关端口应为 61499");
expect(tunnelState.json?.tunnel?.running === false, "初始不应处于运行中");

const badPort = await call("POST", "/clawbot/api/tunnel/save", { config: { proxyPort: 80 } });
expect(badPort.status === 400, `非法端口应返回 400，实际 ${badPort.status}`);

const tunnelSave = await call("POST", "/clawbot/api/tunnel/save", {
  config: { provider: "frp", proxyPort: 61500, frp: { serverAddr: "frp.example.com", protocol: "tcp", remotePort: 6100 } },
});
expect(tunnelSave.status === 200, `tunnel/save 状态码 ${tunnelSave.status}`);
expect(tunnelSave.json?.tunnel?.provider === "frp", "tunnel/save 未写入 provider");
expect(tunnelSave.json?.tunnel?.config?.frp?.serverAddr === "frp.example.com", "tunnel/save 未写入 frp.serverAddr");
expect(tunnelSave.json?.tunnel?.config?.proxyPort === 61500, "tunnel/save 未写入端口");

const badProtocol = await call("POST", "/clawbot/api/tunnel/save", { config: { frp: { protocol: "udp" } } });
expect(badProtocol.status === 400, `非法协议应返回 400，实际 ${badProtocol.status}`);

const token = await call("POST", "/clawbot/api/tunnel/token", { regenerate: true });
expect(token.status === 200 && /^[0-9a-f]{32}$/.test(token.json?.token ?? ""), `tunnel/token 未生成 32 位十六进制密钥：${token.raw.slice(0, 120)}`);
const hookToken = token.json.token;

// ---- 入站 hook 的鉴权 ----
const plainRes = (method, url, headers) => {
  const stream = Readable.from([]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers || {};
  return stream;
};
const missingToken = fakeRes();
await hookHandler(plainRes("POST", "/clawbot/hook", { "content-type": "application/json" }), missingToken);
expect(missingToken.statusCode === 401, `hook 缺 token 应返回 401，实际 ${missingToken.statusCode}`);

const wrongToken = fakeRes();
await hookHandler(plainRes("POST", "/clawbot/hook", { "x-clawbot-token": "deadbeef" }), wrongToken);
expect(wrongToken.statusCode === 401, `hook 错误 token 应返回 401，实际 ${wrongToken.statusCode}`);

const hookHealth = fakeRes();
await hookHandler(plainRes("GET", "/clawbot/hook", {}), hookHealth);
expect(hookHealth.statusCode === 200, `hook GET 健康检查应返回 200，实际 ${hookHealth.statusCode}`);

// 关闭「默认转发到协调器」后必须显式给 sessionId
await call("POST", "/clawbot/api/tunnel/save", { config: { hook: { token: hookToken, forwardToCoordinator: false } } });
const bodyOk = Readable.from([Buffer.from(JSON.stringify({ text: "hi" }))]);
bodyOk.method = "POST";
bodyOk.url = "/clawbot/hook";
bodyOk.headers = { "content-type": "application/json", "x-clawbot-token": hookToken };
const needSession = fakeRes();
await hookHandler(bodyOk, needSession);
expect(needSession.statusCode === 400 && String(needSession.body).includes("sessionId"), `应要求显式 sessionId，实际 ${needSession.statusCode} ${needSession.body}`);

// 清理
for (const item of disposers) {
  if (typeof item.dispose === "function") item.dispose();
}

if (failures.length) {
  console.error("冒烟测试失败：");
  for (const item of failures) console.error(` - ${item}`);
  process.exit(1);
}
console.log(`冒烟测试通过：路由 ${routes.length} 个、工具 ${tools.length} 个、接口 ${15} 项校验`);
console.log("日志：", logs.slice(0, 5).join(" | "));
console.log(`临时配置目录：${tempHome}`);
