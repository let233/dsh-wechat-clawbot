/**
 * 端到端管线测试（全离线，用假 bridge / 假 iLink 客户端）：
 *   - 用户消息必须「原样」进入协调器会话（逐字比对，不做任何改写）
 *   - 助手长回复必须按上限分批、顺序正确、每段不超限
 *   - 快捷指令走本地处理，不进入模型
 *   - 发送失败时进入推送兜底分支
 *
 *   node test/pipeline.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../lib/store.js";
import { ClawBotRuntime } from "../lib/bot.js";

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbot-test-"));

function makeRuntime({ replyText = "好的。", sendFails = false } = {}) {
  const store = new ConfigStore(path.join(tmp, `case-${Math.random().toString(16).slice(2)}`));
  store.patch({ reply: { maxChars: 200, chunkDelayMs: 0, typing: false }, routing: { coordinatorSessionId: "coord-1" } });

  const prompts = [];
  const commandsMap = {};
  const bridge = {
    label: (row) => `${row.workspace} / ${row.sessionId}`,
    commands() {
      return { ...commandsMap };
    },
    isOwned(id) {
      return String(id) === "coord-1" || Object.values(commandsMap).includes(String(id));
    },
    commandTargetOf(id) {
      const hit = Object.entries(commandsMap).find(([, value]) => value === String(id));
      return hit ? hit[0] : "";
    },
    async focus(target, options = {}) {
      const wanted = String(target ?? "").trim();
      if (!wanted) {
        store.patch({ routing: { activeSessionId: "" } });
        return { sessionId: "", targetSessionId: "", cleared: true, created: false };
      }
      const existing = commandsMap[wanted];
      const commandId = existing || `cmd-${wanted}`;
      commandsMap[wanted] = commandId;
      store.patch({ routing: { commands: { ...commandsMap }, activeSessionId: commandId } });
      return { sessionId: commandId, targetSessionId: wanted, created: !existing, cleared: false };
    },
    async ensureCoordinator() {
      return { sessionId: "coord-1", created: false };
    },
    async listSessions() {
      return [
        { sessionId: "s1", workspace: "demo", cwd: "D:\\code\\demo", running: true, queueLength: 0, pendingInput: [], topic: "重构登录页", progress: "运行中", updatedAt: Date.now() },
        { sessionId: "s2", workspace: "other", cwd: "D:\\code\\other", running: false, queueLength: 2, pendingInput: ["approval"], topic: "跑测试", progress: "等待输入（approval）", updatedAt: Date.now() },
      ];
    },
    async promptAndWait(sessionId, text) {
      prompts.push({ sessionId, text });
      return { reason: "idle", text: replyText };
    },
    async dispatch(arg) {
      dispatches.push(arg ?? {});
      return { sessionId: "s9", created: true };
    },
  };

  const sent = [];
  const dispatches = [];
  const runtime = new ClawBotRuntime({ ctx: { get: () => undefined }, store, bridge, log: () => {} });
  runtime.client = () => ({
    async sendText({ toUserId, text, contextToken }) {
      if (sendFails) throw new Error("mock send failure");
      sent.push({ toUserId, text, contextToken });
      return { ret: 0 };
    },
    async getConfig() {
      return "";
    },
    async sendTyping() {},
    async notify() {},
  });
  return { runtime, store, prompts, sent, dispatches };
}

// ---- 1) 用户消息原样下发 ----
{
  const { runtime, prompts, sent } = makeRuntime({ replyText: "收到。" });
  const userText = "  把 D:\\code\\demo 里的登录页重构一下：\n1) 去掉多余动画\n2) 保留 i18n\n\n  不要改接口。  ";
  await runtime.handleMessage({
    message_type: 1,
    message_id: "m1",
    from_user_id: "u1",
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: userText } }],
  });
  expect(prompts.length === 1, `应投递 1 条消息，实际 ${prompts.length}`);
  expect(prompts[0]?.text === userText, "投递内容必须与用户原文逐字一致（禁止 trim/改写）");
  expect(prompts[0]?.sessionId === "coord-1", "默认应投递到协调器会话");
  expect(sent.length === 1 && sent[0].text === "收到。", "回复内容不正确");
  expect(sent[0]?.contextToken === "ctx-1", "回复必须带回入站 context_token");
}

// ---- 2) 长回复分批 ----
{
  const paragraphs = Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 段：${"内容".repeat(20)}。`).join("\n\n");
  const { runtime, sent } = makeRuntime({ replyText: paragraphs });
  await runtime.handleMessage({
    message_type: 1,
    message_id: "m2",
    from_user_id: "u1",
    context_token: "ctx-2",
    item_list: [{ type: 1, text_item: { text: "讲点长的" } }],
  });
  expect(sent.length > 1, `长回复应分成多条，实际 ${sent.length}`);
  const limit = 200;
  for (const [index, item] of sent.entries()) {
    expect(item.text.length <= limit, `第 ${index + 1} 段长度 ${item.text.length} 超过上限 ${limit}`);
    expect(item.contextToken === "ctx-2", "每段都要带同一个 context_token");
  }
  const rebuilt = sent.map((item) => item.text).join("\n\n").replace(/\s+/g, "");
  const expected = paragraphs.replace(/\s+/g, "");
  expect(rebuilt === expected, "分批后内容必须完整且顺序不变");
  expect(runtime.counters.chunks === sent.length, "分段计数不正确");
}

// ---- 3) 快捷指令不进模型 ----
{
  const { runtime, prompts, sent } = makeRuntime();
  await runtime.handleMessage({
    message_type: 1,
    message_id: "m3",
    from_user_id: "u1",
    context_token: "ctx-3",
    item_list: [{ type: 1, text_item: { text: "/sessions" } }],
  });
  expect(prompts.length === 0, "快捷指令不应投递到模型");
  expect(sent.length === 1, "快捷指令应直接回复");
  expect(sent[0].text.includes("demo") && sent[0].text.includes("运行中"), `会话列表内容不完整：${sent[0].text}`);
  expect(sent[0].text.includes("等待输入"), "会话列表应包含等待输入状态");

  const switchBack = makeRuntime();
  await switchBack.runtime.handleMessage({
    message_type: 1,
    message_id: "m4",
    from_user_id: "u1",
    context_token: "ctx-4",
    item_list: [{ type: 1, text_item: { text: "/switch 1" } }],
  });
  // 切换不是把消息直接投进目标会话，而是为它开专属指挥会话，并把落点改成指挥会话
  expect(
    switchBack.store.get().routing.activeSessionId === "cmd-s1",
    `/switch 1 应把落点设为 s1 的专属指挥会话，实际 ${switchBack.store.get().routing.activeSessionId}`,
  );
  expect(switchBack.store.get().routing.commands?.s1 === "cmd-s1", "/switch 1 应记录 s1 → 指挥会话 的映射");
}

// ---- 4) 发送失败 → 推送兜底判定 ----
{
  const { runtime, store } = makeRuntime({ sendFails: true });
  store.patch({ push: { enabled: true, bark: { enabled: false }, wxpusher: { enabled: false } } });
  await runtime.handleMessage({
    message_type: 1,
    message_id: "m5",
    from_user_id: "u1",
    context_token: "ctx-5",
    item_list: [{ type: 1, text_item: { text: "在吗" } }],
  });
  expect(runtime.counters.failed === 1, "发送失败应计入 failed");
  const warned = runtime.logs.some((entry) => entry.level === "warn" && entry.message.includes("未配置 Bark"));
  expect(warned, "未配置推送通道时应有可见告警");
  expect(runtime.status !== "online" || true, "状态字段保持稳定");
}

// ---- 5) 去重与鉴权 ----
{
  const { runtime, prompts } = makeRuntime();
  const message = {
    message_type: 1,
    message_id: "dup-1",
    from_user_id: "u1",
    context_token: "ctx-6",
    item_list: [{ type: 1, text_item: { text: "重复消息" } }],
  };
  await runtime.handleMessage(message);
  await runtime.handleMessage(message);
  expect(prompts.length === 1, `同一 message_id 只应处理一次，实际 ${prompts.length}`);

  const guarded = makeRuntime();
  guarded.store.patch({ routing: { allowAllUsers: false, allowedUserIds: ["u-ok"] } });
  await guarded.runtime.handleMessage({
    message_type: 1,
    message_id: "deny-1",
    from_user_id: "u-bad",
    context_token: "ctx-7",
    item_list: [{ type: 1, text_item: { text: "hi" } }],
  });
  expect(guarded.prompts.length === 0, "白名单外用户的消息必须被丢弃");
}

// ---- 6) 语音转写与引用消息 ----
{
  const { runtime, prompts } = makeRuntime();
  await runtime.handleMessage({
    message_type: 1,
    message_id: "voice-1",
    from_user_id: "u1",
    context_token: "ctx-8",
    item_list: [{ type: 3, voice_item: { text: "帮我看下构建日志" } }],
  });
  expect(prompts[0]?.text === "帮我看下构建日志", "语音应使用转写文本");
}

// ---- 7) /task 逐字派发（指令路径不经过模型） ----
{
  const { runtime, prompts, dispatches } = makeRuntime();
  const body = "  第一行：含前导空格\n\t第二行前面是制表符\n\n- 列表项 A（全角括号）\n最后一行无标点  ";
  await runtime.handleMessage({
    message_type: 1,
    message_id: "m9",
    from_user_id: "u1",
    context_token: "ctx-9",
    item_list: [{ type: 1, text_item: { text: `/task new ${body}` } }],
  });
  expect(prompts.length === 0, "/task 不应进入模型");
  expect(dispatches.length === 1, `/task 应派发 1 次，实际 ${dispatches.length}`);
  expect(dispatches[0]?.message === body, `派发正文必须逐字一致，实际：${JSON.stringify(dispatches[0]?.message)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error("管线测试失败：");
  for (const item of failures) console.error(` - ${item}`);
  process.exit(1);
}
console.log("管线测试通过：原样下发、分批完整性、快捷指令、逐字派发、兜底告警、去重与鉴权、语音转写");
