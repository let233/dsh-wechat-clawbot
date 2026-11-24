/**
 * 协调器会话专属工具：查询所有会话进度、派发任务、切换回复目标、主动推送。
 *
 * 这些工具只对「微信 ClawBot 协调器」会话可见（通过 tools.register 的 when 门控），
 * 其它会话的模型看不到它们，避免污染普通对话。
 */

import { oneLine } from "./text.js";

const textBlock = (text) => [{ type: "text", text: String(text ?? "") }];

/**
 * 工具返回值必须先过一遍 JSON 往返：
 * 宿主会校验「lossless JSON」，undefined / 类实例 / Date 都会让整次调用失败。
 */
const lossless = (value) => JSON.parse(JSON.stringify(value ?? null));

function formatTime(ms) {
  const value = Number(ms);
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/**
 * @param {{ store: any, bridge: any, runtime: any }} deps
 * @returns {Array<any>} ToolDefinition 列表
 */
export function createTools({ store, bridge, runtime }) {
  const coordinatorId = () => String(store.get().routing.coordinatorSessionId ?? "");

  /**
   * 只对「插件自己的专属会话」开放：协调器会话，或为某个目标会话开的指挥会话。
   * 普通工作会话里的模型看不到这些工具。
   */
  const when = (context) => bridge.isOwned(String(context?.agent?.id ?? ""));

  const callerId = (exec) => String(exec?.agent?.id ?? exec?.agent ?? "");

  /** 协调器专属工具的运行期守卫。 */
  const requireCoordinator = (exec) => {
    const caller = callerId(exec);
    if (!bridge.isOwned(caller)) throw new Error("clawbot_* 工具只对微信 ClawBot 专属会话开放");
    if (caller !== coordinatorId()) {
      throw new Error("这个工具只在协调器会话可用；指挥会话请用 clawbot_relay 指挥它绑定的会话");
    }
    return caller;
  };

  /** 指挥会话专属工具的运行期守卫：返回它绑定的目标会话 ID。 */
  const requireCommander = (exec) => {
    const caller = callerId(exec);
    if (!bridge.isOwned(caller)) throw new Error("clawbot_* 工具只对微信 ClawBot 专属会话开放");
    const target = bridge.commandTargetOf(caller);
    if (!target) throw new Error("clawbot_relay 只在专属指挥会话可用；协调器请用 clawbot_dispatch");
    return target;
  };

  /**
   * 运行期再确认一次调用者身份：when 门控由宿主在装配工具表时评估，
   * 这里守住 execute 入口，避免任何装配差异把工具暴露给普通会话。
   */
  const guard = (definition) => {
    const run = definition.execute;
    return {
      ...definition,
      async execute(args, exec) {
        if (!bridge.isOwned(callerId(exec))) {
          throw new Error("clawbot_* 工具只对微信 ClawBot 专属会话开放");
        }
        return lossless(await run.call(definition, args, exec));
      },
    };
  };

  /** @type {any} */
  const sessionsTool = {
    name: "clawbot_sessions",
    description:
      "列出 DeepSeekRuntime 里所有工作区的会话及其实时进度（是否运行、是否排队、是否在等待审批/提问，最近一条用户请求与回复摘要）。当用户问「别的会话在干什么 / 进度如何」时先调用它。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "最多返回多少个会话，默认 20，上限 50" },
        withSnippet: { type: "boolean", description: "是否附带最近请求与回复摘要，默认 true" },
        includeSubagents: { type: "boolean", description: "是否包含 subagent 派生的子会话（它们不可指挥），默认 false" },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render(args, value) {
        const rows = Array.isArray(value?.sessions) ? value.sessions : [];
        if (!rows.length) return textBlock("当前没有可列出的会话。");
        const lines = rows.map((row) => {
          const flags = [row.running ? "运行中" : "空闲", row.queueLength ? `排队${row.queueLength}` : ""]
            .concat(row.pendingInput?.length ? [`等待${row.pendingInput.join("/")}`] : [])
            .filter(Boolean)
            .join(" · ");
          const tail = row.lastReply ? `｜最近回复：${row.lastReply}` : "";
          return `${row.index}. [${row.label}] ${flags}${tail}`;
        });
        return textBlock(`共 ${rows.length} 个会话：\n${lines.join("\n")}`);
      },
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
      const rows = await bridge.listSessions({ limit, withSnippet: args?.withSnippet !== false });
      const sessions = rows.map((row, index) => ({
        index: index + 1,
        sessionId: row.sessionId,
        workspace: row.workspace,
        cwd: row.cwd,
        label: bridge.label(row),
        progress: row.progress,
        running: row.running,
        queueLength: row.queueLength,
        pendingInput: row.pendingInput,
        origin: row.origin,
        parentSessionId: row.parentSessionId,
        updatedAt: formatTime(row.updatedAt),
        lastUserMessage: row.topic,
        lastReply: row.lastReply,
        isCoordinator: row.sessionId === coordinatorId(),
      }));
      return { count: sessions.length, sessions };
    },
  };

  /** @type {any} */
  const detailTool = {
    name: "clawbot_session_detail",
    description:
      "查看某个会话的详细情况：当前状态、最近一条用户请求、最近一条助手回复、最近的工具调用、消息总量。用于回答「某个任务卡在哪一步」。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "会话 ID（可先调用 clawbot_sessions 获取）" },
        maxMessages: { type: "number", description: "回看多少条事件，默认 40" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render(args, value) {
        const state = value?.state ?? {};
        const lines = [
          `会话：${value?.sessionId ?? "-"}`,
          `状态：${state.running ? "运行中" : "空闲"}${state.pendingInput?.length ? `（等待${state.pendingInput.join("/")}）` : ""}`,
          `最近用户请求：${oneLine(value?.lastUserMessage, 200) || "-"}`,
          `最近回复：${oneLine(value?.lastAssistantReply, 400) || "-"}`,
        ];
        const calls = Array.isArray(value?.recentToolCalls) ? value.recentToolCalls : [];
        if (calls.length) lines.push(`最近工具调用：${calls.slice(-8).join("、")}`);
        return textBlock(lines.join("\n"));
      },
    },
    async execute(args, exec) {
      const sessionId = String(args?.sessionId ?? "").trim() || bridge.commandTargetOf(callerId(exec));
      if (!sessionId) throw new Error("sessionId 必填");
      const detail = await bridge.sessionDetail(sessionId, { maxMessages: Number(args?.maxMessages) || 40 });
      return {
        sessionId: detail.sessionId,
        state: detail.state,
        lastUserMessage: detail.userText,
        lastAssistantReply: detail.assistantText,
        recentToolCalls: detail.toolCalls,
        events: detail.records,
        hasMore: detail.hasMore,
      };
    },
  };

  /** @type {any} */
  const dispatchTool = {
    name: "clawbot_dispatch",
    description:
      "把用户的消息原样派发到一个已有会话，或新建会话后派发。message 必须是用户的原始文本：逐字照抄，禁止改写、精简、润色、翻译、补充背景或摘要。wait=true 时会等待该会话回复并把回复文本带回来。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "用户原始消息，逐字照抄，不得改写" },
        sessionId: { type: "string", description: "目标会话 ID；留空则新建会话" },
        cwd: { type: "string", description: "新建会话时的工作目录；留空使用默认目录" },
        wait: { type: "boolean", description: "是否等待该会话完成本轮并返回回复，默认 false" },
        timeoutMs: { type: "number", description: "wait=true 时的等待上限，默认 240000" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render(args, value) {
        return textBlock(typeof value === "string" ? value : JSON.stringify(value));
      },
    },
    async execute(args, exec) {
      requireCoordinator(exec);
      const message = String(args?.message ?? "");
      if (!message.trim()) throw new Error("message 不能为空");
      const result = await bridge.dispatch({
        sessionId: args?.sessionId ? String(args.sessionId) : undefined,
        cwd: args?.cwd ? String(args.cwd) : undefined,
        message,
        wait: Boolean(args?.wait),
        timeoutMs: Number(args?.timeoutMs) || undefined,
      });
      return {
        sessionId: result.sessionId,
        created: result.created,
        accepted: result.accepted,
        waited: Boolean(args?.wait),
        reason: result.reason,
        reply: result.reply,
        note: result.created ? "已新建会话并原样派发用户消息" : "已把用户消息原样投递给目标会话",
      };
    },
  };

  /** @type {any} */
  const focusTool = {
    name: "clawbot_focus",
    description:
      "把微信端对话「移交给某个会话的专属指挥会话」：不会把用户消息直接投进目标会话，而是为它准备（复用或新建）一个专属指挥会话，之后手机消息都进那个指挥会话，由它原样转发给目标会话并汇报进度。用户说「切到某会话 / 以后就聊那个 / 帮我盯着它」时调用。优先用 query 传用户的大白话（如「在改登录页的那个」「dsh插件 里跑测试的」），插件会在本机做匹配：唯一命中就直接切，命中多个会返回候选让用户选；只有已知 ID 时才传 sessionId。sessionId 传空字符串表示切回协调器。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "要接管的目标会话 ID（已知时用）；传空字符串切回协调器" },
        query: { type: "string", description: "不知道该会话 ID 时，填用户的原话描述（标题/工作区/文件名/最近在做什么）" },
        label: { type: "string", description: "可选的会话标签，便于在指挥会话里辨认" },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render(args, value) {
        if (value?.ambiguous) {
          const lines = Array.isArray(value?.candidates) ? value.candidates : [];
          return textBlock(
            [
              `「${value.query}」对上 ${lines.length} 个会话，需要用户确认（不要自己猜）：`,
              ...lines.map((item, index) => `${index + 1}. ${item.label}（${item.sessionId}）`),
            ].join("\n"),
          );
        }
        if (value?.cleared) return textBlock("已切回协调器会话。");
        const verb = value?.created ? "新建了" : "复用了";
        const whose = value?.matchedLabel ? `「${value.matchedLabel}」` : value?.targetSessionId;
        return textBlock(
          `已为 ${whose} ${verb}专属指挥会话 ${value?.sessionId}；后续微信消息会进指挥会话，由它原样转发并汇报，不会直接进入目标会话。`,
        );
      },
    },
    async execute(args, exec) {
      requireCoordinator(exec);
      const sessionId = String(args?.sessionId ?? "").trim();
      const query = String(args?.query ?? "").trim();
      const labelArg = String(args?.label ?? "").trim() || undefined;

      if (!sessionId && query) {
        const match = await bridge.matchTarget(query);
        if (match.kind === "none") {
          throw new Error(`没有匹配到「${query}」对应的会话；先用 clawbot_sessions 看看有哪些会话，或让用户说得更具体些`);
        }
        if (match.kind === "many") {
          return {
            ambiguous: true,
            query,
            candidates: match.candidates.map((item) => ({
              sessionId: item.row.sessionId,
              label: bridge.label(item.row),
              score: item.score,
            })),
          };
        }
        const target = match.row;
        const focused = await bridge.focus(String(target.sessionId), { label: labelArg ?? bridge.label(target), cwd: target.cwd || undefined });
        return {
          sessionId: focused.sessionId,
          targetSessionId: focused.targetSessionId,
          created: Boolean(focused.created),
          cleared: false,
          coordinator: false,
          matchedBy: "query",
          matchedLabel: bridge.label(target),
        };
      }

      const result = await bridge.focus(sessionId, { label: labelArg });
      return {
        sessionId: result.sessionId,
        targetSessionId: result.targetSessionId,
        created: Boolean(result.created),
        cleared: Boolean(result.cleared),
        coordinator: Boolean(result.coordinator),
      };
    },
  };

  /** @type {any} */
  const relayTool = {
    name: "clawbot_relay",
    description:
      "把你绑定的目标会话当作执行者：把用户消息原样转发给它（message 逐字照抄，禁止改写、精简、润色、翻译、补充或摘要），可选等待它本轮结束并把回复带回来。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "用户原始消息，逐字照抄，不得改写" },
        wait: { type: "boolean", description: "是否等待目标会话完成本轮并返回回复，默认 true" },
        timeoutMs: { type: "number", description: "wait=true 时的等待上限，默认 240000" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render(args, value) {
        return textBlock(typeof value === "string" ? value : JSON.stringify(value));
      },
    },
    async execute(args, exec) {
      const target = requireCommander(exec);
      const message = String(args?.message ?? "");
      if (!message.trim()) throw new Error("message 不能为空");
      const wait = args?.wait !== false;
      const result = await bridge.dispatch({
        sessionId: target,
        message,
        wait,
        timeoutMs: Number(args?.timeoutMs) || undefined,
      });
      return {
        ok: true,
        targetSessionId: target,
        waited: wait,
        reason: result.reason,
        reply: result.reply,
        note: "已把用户消息原样转发给目标会话",
      };
    },
  };

  /** @type {any} */
  const pushTool = {
    name: "clawbot_push",
    description:
      "通过 Bark / WxPusher 主动推送一条通知到用户设备，用于微信主动消息受限的场景（后台任务完成、长时间任务结果通知）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "推送正文" },
        title: { type: "string", description: "推送标题，默认「DSH 通知」" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render(args, value) {
        return textBlock(typeof value === "string" ? value : JSON.stringify(value));
      },
    },
    async execute(args) {
      const text = String(args?.text ?? "").trim();
      if (!text) throw new Error("text 不能为空");
      const result = await runtime.pushNow(text, String(args?.title ?? "DSH 通知"));
      return { ok: result.ok, results: result.results };
    },
  };

  return [
    { definition: guard(sessionsTool), options: { when } },
    { definition: guard(detailTool), options: { when } },
    { definition: guard(dispatchTool), options: { when } },
    { definition: guard(relayTool), options: { when } },
    { definition: guard(focusTool), options: { when } },
    { definition: guard(pushTool), options: { when } },
  ];
}
