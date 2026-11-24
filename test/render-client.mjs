/**
 * 真 React + 真 DOM（jsdom）把设置页渲染一遍，专门抓「点开设置空白」这类渲染期异常：
 * 首帧（配置还没到）不能抛错，数据到达后必须出现各个卡片区块。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");
const ReactDOMClient = require("react-dom/client");
const { JSDOM } = require("jsdom");
const { act } = require("react-dom/test-utils");

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:61431/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let registration = null;
const moduleLoader = {
  load(entry) {
    const module = { exports: {} };
    const loaded = entry.factory((name) => {
      if (name === "react") return React;
      throw new Error(`客户端 bundle 依赖了未提供的模块：${name}`);
    });
    Object.assign(module.exports, loaded ?? module.exports);
    registration = { id: entry.id, exports: module.exports };
  },
};
globalThis.__ModuleLoader__ = moduleLoader;
dom.window.__ModuleLoader__ = moduleLoader;

const state = {
  ok: true,
  status: "idle",
  statusDetail: "",
  online: false,
  startedAt: 0,
  lastPollAt: 0,
  lastMessageAt: 0,
  lastError: "",
  botId: "",
  userId: "",
  baseUrl: "https://ilinkai.weixin.qq.com",
  pausedUntil: 0,
  counters: { received: 0, replied: 0, chunks: 0, pushed: 0, failed: 0 },
  login: { active: false },
  log: [{ time: "2024-01-01 00:00:00", level: "info", text: "插件已加载" }],
  config: {
    ilink: { baseUrl: "https://ilinkai.weixin.qq.com", channelVersion: "2.4.8", botAgent: "DeepSeekRuntime", routeTag: "", hasToken: false },
    reply: { maxChars: 1800, maxChunks: 0, chunkDelayMs: 400, typing: true, showSessionTag: true },
    push: {
      enabled: true,
      fallbackOnFailure: true,
      bark: { enabled: false, serverUrl: "https://api.day.app", deviceKey: "", group: "DSH", sound: "", level: "active", hasDeviceKey: false },
      wxpusher: { enabled: false, appToken: "", uids: "", topicIds: "", contentType: 1, hasAppToken: false },
    },
    routing: { coordinatorCwd: "", agentPreset: "", activeSessionId: "", allowAllUsers: true, allowedUserIds: [], autoStart: true },
    tunnel: {
      provider: "cloudflare",
      autoStart: true,
      proxyPort: 61499,
      hookPath: "/clawbot/hook",
      hookToken: "deadbeef",
      cloudflare: { binaryPath: "", extraArgs: "" },
      frp: { serverAddr: "", serverPort: 7000, protocol: "tcp", remotePort: 6000, customDomains: "", publicHost: "", tls: false, binaryPath: "", hasToken: false },
    },
    log: { maxEntries: 60 },
  },
  tunnel: {
    provider: "cloudflare",
    state: "running",
    running: true,
    publicUrl: "https://demo.trycloudflare.com",
    gateway: { running: true, port: 61499, url: "http://127.0.0.1:61499", targetPort: 61431, requests: 3, rejected: 1 },
    binaries: { cloudflared: "", frpc: "", dir: "" },
    logs: [],
  },
  workspaces: [{ id: "w1", title: "dsh插件" }],
  paths: { config: "C:/x/config.json", dir: "C:/x" },
};

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => state, text: async () => JSON.stringify(state) });

await import("../lib/client.js");
if (!registration) throw new Error("bundle 没有调用 __ModuleLoader__.load");

const slots = [];
const ctx = { slots: { inject: (_name, fn) => fn(), register: (meta, component) => slots.push({ ...meta, component }) } };
registration.exports.apply(ctx);

const section = slots.find((slot) => slot.name === "settings.section");
if (!section || typeof section.component !== "function") throw new Error("settings.section 没有注册组件");

const container = document.getElementById("root");
const root = ReactDOMClient.createRoot(container);

// 1) 首帧：配置还没取回来，必须渲染出「正在读取」而不是整页空白/抛错
await act(async () => {
  root.render(React.createElement(section.component));
});
const firstFrame = container.textContent || "";
if (!firstFrame.trim()) throw new Error("首帧渲染为空白");
console.log(`首帧：${firstFrame.trim().slice(0, 30)}…`);

// 2) 等 fetch + setState 落定（轮询组件里有 setTimeout，这里只跑一轮）
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});
const html = container.innerHTML || "";
const text = container.textContent || "";
const blocks = [
  "微信 ClawBot 连接",
  "回复与分段",
  "推送兜底",
  "会话路由",
  "专属指挥会话",
  "入站隧道",
  "运行状态",
];
const missing = blocks.filter((key) => !text.includes(key));
if (missing.length) throw new Error(`数据到达后缺少区块：${missing.join("、")}（渲染 ${html.length} 字符）`);
if (!html.includes("demo.trycloudflare.com")) throw new Error("隧道卡片没有渲染公网地址");
// 命名隧道（固定域名）与「点击拉起微信」的入口都必须在设置页可见/可配
if (!text.includes("命名隧道")) throw new Error("Cloudflare 命名隧道选项缺失");
if (!text.includes("点击打开")) throw new Error("推送点击跳转（openUrl）配置缺失");
console.log(`数据到达后：${html.length} 字符，区块齐全：${blocks.join(" / ")}`);
root.unmount();
console.log("客户端渲染测试通过：设置页首帧不空白，配置到达后区块完整");
