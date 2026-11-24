/**
 * 大白话切换会话：意图识别 + 本机模糊匹配 + 歧义候选 + 序号追问。
 * 目标：用户说「切到那个在改登录页的会话」就能切，不必记 /switch 序号；
 * 同时保证普通任务句子不会被误吞。
 */
import assert from "node:assert/strict";

import {
  sessionTokens,
  scoreSession,
  rankSessions,
  MATCH_MIN_SCORE,
} from "../lib/bridge.js";
import { SessionBridge } from "../lib/bridge.js";
import { detectFocusIntent, ClawBotRuntime } from "../lib/bot.js";
import { createTools } from "../lib/tools.js";

/* ---------- 1. 词元与打分 ---------- */

const tokens = sessionTokens("在改登录页的那个");
assert.ok(tokens.has("登录"), "应当切出中文二元组 登录");
assert.ok(!tokens.has("会话"), "无信息量的词应当被剔除");

const rows = [
  {
    sessionId: "session-aaaa1111",
    cwd: "D:\\code\\dsh插件",
    workspace: "dsh插件",
    topic: "修复登录页表单校验",
    lastReply: "已经定位到校验规则写错了",
    updatedAt: 300,
  },
  {
    sessionId: "session-bbbb2222",
    cwd: "D:\\code\\app",
    workspace: "app",
    topic: "重构支付回调",
    lastReply: "回调签名验证通过",
    updatedAt: 200,
  },
  {
    sessionId: "session-cccc3333",
    cwd: "D:\\code\\app",
    workspace: "app",
    topic: "登录页样式调整",
    lastReply: "按钮间距改了",
    updatedAt: 100,
  },
];

const rankedPay = rankSessions(rows, "支付");
assert.equal(rankedPay[0]?.row.sessionId, "session-bbbb2222", "「支付」应当命中支付回调那条");
assert.ok(rankedPay[0].score >= MATCH_MIN_SCORE, `分数应达到门槛，实际 ${rankedPay[0].score}`);

const rankedCss = rankSessions(rows, "按钮间距");
assert.equal(rankedCss[0]?.row.sessionId, "session-cccc3333", "应当能靠最近回复匹配到样式那条");

const rankedWorkspace = rankSessions(rows, "dsh插件");
assert.equal(rankedWorkspace[0]?.row.sessionId, "session-aaaa1111", "工作区名也要能匹配");

assert.equal(scoreSession(rows[0], "完全不相干的一句话").score, 0, "无关描述不应得分");
assert.ok(rankedPay.every((item) => item.score > 0), "排序结果不应包含 0 分项");

/* ---------- 2. 意图识别 ---------- */

const yes = [
  ["切到那个在改登录页的会话", "改登录页"],
  ["以后就聊 dsh插件 那个", "dsh插件"],
  ["帮我盯着跑测试的会话", "跑测试"],
  ["指挥那个在跑 e2e 的", "跑 e2e"],
  ["切到 3", "3"],
];
for (const [text, expect] of yes) {
  const intent = detectFocusIntent(text);
  assert.ok(intent, `「${text}」应当被识别成切换意图`);
  assert.equal(intent.query, expect, `「${text}」的查询词应为 ${expect}，实际 ${intent.query}`);
  assert.equal(intent.back, false);
}

for (const text of ["切回协调器", "回到协调器"]) {
  const intent = detectFocusIntent(text);
  assert.ok(intent?.back, `「${text}」应当识别成切回协调器`);
}

// 普通任务句子绝不能被抓走
for (const text of ["把登录页重构一下，顺便补个测试", "帮我看看登录页为什么报错", "/switch 2"]) {
  assert.equal(detectFocusIntent(text), null, `「${text}」不应被当成切换意图`);
}
// 超过 40 字的长句一律交给模型
assert.equal(detectFocusIntent("切到那个在改登录页的会话然后顺手把表单校验的报错文案也一起改掉吧"), null);

/* ---------- 3. matchTarget（基于真实 SessionBridge，注入假 controller） ---------- */

const controller = {
  async list() {
    return {
      items: rows.map((row) => ({
        sessionId: row.sessionId,
        updatedAt: row.updatedAt,
        running: false,
        blank: false,
        cwd: row.cwd,
      })),
    };
  },
  async state() {
    return { cursor: 1, active: true, running: false, queue: [], pendingInput: [] };
  },
  async events({ address }) {
    const row = rows.find((item) => item.sessionId === address.sessionId);
    return {
      records: [
        { type: "event", event: { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: row?.topic ?? "" }] } } },
        { type: "event", event: { type: "assistant/message", seq: 2, time: 2, data: { message: { content: [{ type: "text", text: row?.lastReply ?? "" }] } } } },
      ],
    };
  },
};

const store = {
  value: { routing: { coordinatorSessionId: "", activeSessionId: "", commands: {} } },
  get() {
    return this.value;
  },
  patch(patch) {
    this.value = { ...this.value, ...patch, routing: { ...this.value.routing, ...(patch.routing ?? {}) } };
  },
  mutate(fn) {
    this.value = fn(this.value) ?? this.value;
  },
};

const bridge = new SessionBridge({ get: (name) => (name === "sessionController" ? controller : undefined) }, store, {});

const one = await bridge.matchTarget("修复登录页表单校验");
assert.equal(one.kind, "one", "描述足够具体时应当唯一定位");
assert.equal(one.row.sessionId, "session-aaaa1111");

const byWorkspace = await bridge.matchTarget("dsh插件");
assert.equal(byWorkspace.kind, "one");
assert.equal(byWorkspace.row.sessionId, "session-aaaa1111");

const many = await bridge.matchTarget("登录页");
assert.equal(many.kind, "many", "两个会话都提到登录页时应当判为歧义");
assert.ok(many.candidates.length >= 2, "歧义时要给候选");

const none = await bridge.matchTarget("量子纠缠实验");
assert.equal(none.kind, "none", "匹配不上时要把控制权交回模型");

/* ---------- 4. clawbot_focus 工具走 query 分支 ---------- */

const focused = [];
const fakeBridge = {
  isOwned: () => true,
  commandTargetOf: () => "",
  label: (row) => `${row.workspace} / ${String(row.sessionId).slice(8, 16)}`,
  matchTarget: async (query) => (query.includes("多个") ? many : one),
  focus: async (sessionId, options) => {
    focused.push({ sessionId, options });
    return { sessionId: "cmd-" + sessionId, targetSessionId: sessionId, created: true };
  },
};
const toolStore = { get: () => ({ routing: { coordinatorSessionId: "coord-1" } }) };
const tools = createTools({ store: toolStore, bridge: fakeBridge, runtime: {} });
const focusTool = tools.find((item) => item.definition.name === "clawbot_focus");
assert.ok(focusTool, "clawbot_focus 应当存在");
assert.deepEqual(focusTool.definition.parameters.required ?? [], [], "sessionId 不再必填（可以只给 query）");
assert.ok(focusTool.definition.parameters.properties.query, "应当提供 query 参数");

const okResult = await focusTool.definition.execute({ query: "修复登录页表单校验" }, { agent: { id: "coord-1" } });
assert.equal(okResult.ambiguous, undefined);
assert.equal(okResult.matchedBy, "query");
assert.equal(okResult.targetSessionId, "session-aaaa1111");
assert.equal(focused.length, 1, "应当真的调用了一次 focus");

const ambiguous = await focusTool.definition.execute({ query: "多个都像" }, { agent: { id: "coord-1" } });
assert.equal(ambiguous.ambiguous, true);
assert.ok(ambiguous.candidates.length >= 2, "工具要把候选带回去让模型列给用户");
assert.equal(focused.length, 1, "歧义时不应擅自切换");

const rendered = focusTool.definition.output.render({}, ambiguous)[0].text;
assert.ok(/确认/.test(rendered), "歧义渲染要提示需要用户确认");

await assert.rejects(
  () => focusTool.definition.execute({ sessionId: "" }, { agent: { id: "commander-9" } }),
  /协调器会话可用/,
  "指挥会话不能调用 clawbot_focus",
);

/* ---------- 5. runtime 侧：歧义 → 候选 → 回序号 ---------- */

const runtimeStore = {
  get: () => ({
    routing: { coordinatorSessionId: "coord-1", activeSessionId: "", commands: {} },
    reply: { showSessionTag: true, maxChars: 1800, chunkDelayMs: 0, typing: false },
    ilink: { getUpdatesBuf: "", botToken: "", baseUrl: "https://ilinkai.weixin.qq.com" },
    push: { enabled: false },
    log: { maxEntries: 10 },
  }),
  patch: () => {},
};
const runtime = new ClawBotRuntime({
  ctx: {},
  store: runtimeStore,
  bridge: {
    ...fakeBridge,
    matchTarget: async (query) => (String(query) === "登录页" ? many : one),
    focus: async (sessionId, options) => {
      focused.push({ sessionId, options });
      return { sessionId: sessionId ? "cmd-" + sessionId : "coord-1", targetSessionId: sessionId, created: false };
    },
  },
  log: () => {},
});

const ambiguousText = await runtime.tryFocusIntent({ query: "登录页", back: false, raw: "切到登录页那个" });
assert.ok(/对上好几个会话/.test(ambiguousText), "歧义时应当回候选列表");
assert.ok(/\n1\. /.test(ambiguousText), "候选要编号");
assert.equal(runtime.lastCandidates.length, many.candidates.length, "候选要缓存下来供序号追问");

const expectedRow = runtime.lastCandidates[0];
focused.length = 0;
const second = await runtime.tryFocusIntent({ query: "1", back: false, raw: "1" });
assert.ok(/已切到/.test(second), "回序号应当直接切");
assert.equal(focused.length, 1, "回序号应当只切一次");
assert.equal(focused[0].sessionId, expectedRow.sessionId, "序号要对应上一条列出的第一个候选");
assert.deepEqual(runtime.lastCandidates, [], "切完之后候选缓存要清掉");

const back = await runtime.tryFocusIntent({ query: "", back: true, raw: "切回协调器" });
assert.ok(/已切回协调器/.test(back));

console.log("大白话切换测试通过：意图识别、模糊匹配、歧义候选、序号追问、工具 query 分支");
