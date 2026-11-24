/**
 * 会话可投递性守卫测试（全离线）：
 *   - subagent 派生的子会话不能被 prompt（运行时会报 "owned by subagent routing"）
 *   - 所以 targetInfo/requireTargetable/focus/dispatch 都要在投递前拦住它，并给出人话解释
 *   - 普通会话不受影响
 *
 *   node test/bridge-guard.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../lib/store.js";
import { SessionBridge, extractUserText } from "../lib/bridge.js";

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbot-guard-"));

const sessions = {
  "coord-1": { sessionId: "coord-1", cwd: "D:\\code\\demo", blank: false, running: false, updatedAt: 2 },
  "work-1": { sessionId: "work-1", cwd: "D:\\code\\demo", blank: false, running: false, updatedAt: 1 },
  "sub-1": { sessionId: "sub-1", cwd: "D:\\code\\demo", blank: false, running: true, updatedAt: 3, origin: "subagent", parentSessionId: "work-1" },
};

const prompted = [];
const controller = {
  async list() {
    return { items: Object.values(sessions) };
  },
  async state({ sessionId }) {
    if (!sessions[sessionId]) throw new Error(`session "${sessionId}" not found`);
    return { cursor: 5, active: true, running: Boolean(sessions[sessionId].running), queue: [], pendingInput: [] };
  },
  async create() {
    return { sessionId: "created-1" };
  },
  async prompt(request) {
    if (request.sessionId === "sub-1") throw new Error('session "sub-1" is owned by subagent routing');
    prompted.push(request);
    return { accepted: true };
  },
  async events() {
    return { records: [] };
  },
  async wait() {
    return { reason: "idle", state: { cursor: 6 }, output: { records: [], truncated: false } };
  },
};

const ctx = { get: (name) => (name === "sessionController" ? controller : name === "workspaceRegistry" ? { list: () => [] } : undefined) };
const store = new ConfigStore(path.join(tmp, "cfg"));
store.patch({ routing: { coordinatorSessionId: "coord-1" } });
const bridge = new SessionBridge(ctx, store, { log: () => {} });

// ---- 可投递性判定 ----
const subInfo = await bridge.targetInfo("sub-1");
expect(subInfo.found === true, "sub-1 应该被找到");
expect(subInfo.origin === "subagent", `sub-1 的 origin 应为 subagent，实际 ${subInfo.origin}`);
expect(subInfo.targetable === false, "子会话不应可指挥");

const workInfo = await bridge.targetInfo("work-1");
expect(workInfo.targetable === true, "普通会话应可指挥");

const missingInfo = await bridge.targetInfo("nope");
expect(missingInfo.found === false && missingInfo.targetable === false, "不存在的会话不应可指挥");

// ---- 守卫抛出人话 ----
let guardError = "";
try {
  await bridge.requireTargetable("sub-1");
} catch (error) {
  guardError = error instanceof Error ? error.message : String(error);
}
expect(guardError.includes("子会话"), `拒绝理由应说明是子会话，实际：${guardError || "未抛错"}`);

let focusError = "";
try {
  await bridge.focus("sub-1");
} catch (error) {
  focusError = error instanceof Error ? error.message : String(error);
}
expect(focusError.includes("子会话"), `focus 子会话应被拒绝，实际：${focusError || "未抛错"}`);
expect(!store.get().routing.commands?.["sub-1"], "被拒绝时不应留下指挥会话映射");

let dispatchError = "";
try {
  await bridge.dispatch({ sessionId: "sub-1", message: "你好" });
} catch (error) {
  dispatchError = error instanceof Error ? error.message : String(error);
}
expect(dispatchError.includes("子会话"), `dispatch 子会话应被拒绝，实际：${dispatchError || "未抛错"}`);

// ---- prompt 把英文拒绝翻成人话 ----
let promptError = "";
try {
  await bridge.prompt("sub-1", "你好");
} catch (error) {
  promptError = error instanceof Error ? error.message : String(error);
}
expect(promptError.includes("subagent 派生的子会话"), `prompt 拒绝应被翻译，实际：${promptError || "未抛错"}`);

// ---- 会话列表标出子会话 ----
const rows = await bridge.listSessions({ limit: 10 });
const allRows = await bridge.listSessions({ limit: 10, includeSubagents: true });
expect(rows.every((row) => row.targetable !== false), "默认列表不应包含不可指挥的子会话");
const subRow = allRows.find((row) => row.sessionId === "sub-1");
expect(subRow?.targetable === false, "列表行的子会话应标记 targetable=false");
expect(subRow?.progress === "子会话（不可指挥）", `子会话进度文案不对：${subRow?.progress}`);
const workRow = allRows.find((row) => row.sessionId === "work-1");
expect(workRow?.targetable === true, "普通会话列表行应 targetable=true");
const coordRow = allRows.find((row) => row.sessionId === "coord-1");
expect(coordRow?.role === "coordinator", "协调器角色标记丢失");

// ---- 正常路径仍然可用 ----
const focused = await bridge.focus("work-1");
expect(Boolean(focused.sessionId) && focused.created === true, "普通会话应能开专属指挥会话");
expect(store.get().routing.commands?.["work-1"] === focused.sessionId, "映射未持久化");
expect(store.get().routing.activeSessionId === focused.sessionId, "落点未切到指挥会话");
expect(bridge.isOwned("work-1") === false, "被指挥的目标会话本身不算专属会话");
expect(bridge.isOwned(focused.sessionId) === true, "指挥会话应算专属会话");
expect(bridge.commandTargetOf(focused.sessionId) === "work-1", "指挥会话的目标反查失败");

// ---- 注入旁白不能被当成用户消息 ----
const mk = (text) => ({ event: { type: "user/message", data: { content: [{ type: "text", text }] } } });
const realText = "  第一行  含缩进\n最后一行  ";
expect(extractUserText([mk(realText)]) === realText, "真实用户消息必须逐字返回（含首尾空白）");
expect(
  extractUserText([
    mk(realText),
    mk("Time sampled while preparing turn 3: 2026-01-01"),
    mk("Browser time zone for this request: Asia/Shanghai"),
  ]) === realText,
  "宿主注入的 time-context / browser-context 不能被当作用户消息",
);
expect(extractUserText([mk("Time sampled while preparing turn 1: x")]) === "", "只有注入旁白时应返回空串");

// ---- 不能给「专属会话」再套一层指挥会话 ----
let nestError = "";
try {
  await bridge.focus(focused.sessionId);
} catch (error) {
  nestError = error instanceof Error ? error.message : String(error);
}
expect(nestError.includes("专属会话"), `给指挥会话再开指挥会话应被拒绝，实际：${nestError || "未抛错"}`);

if (failures.length) {
  console.error("会话守卫测试失败：");
  for (const item of failures) console.error(" -", item);
  process.exit(1);
}
console.log("会话守卫测试通过：子会话不可指挥、拒绝理由可读、列表标记、正常路径可用");
