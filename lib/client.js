/* eslint-disable */
/**
 * dsh-wechat-clawbot · 客户端（Web）侧设置界面
 *
 * 由 Host 的 client-modules 加载，入口必须是 window.__ModuleLoader__.load 包装。
 * 只依赖 react（Host 模块表提供）。
 */
window.__ModuleLoader__.load({
  id: "dsh-wechat-clawbot",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const h = React.createElement;
    const { Component, useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = "/clawbot/api";

    // ------------------------------------------------------------ 宿主路由地址

    function directoryBase(input) {
      const raw = String(input || "");
      const base = new URL(raw || "http://dsh.internal/");
      base.search = "";
      base.hash = "";
      if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
      return base;
    }

    function hostHttpBase() {
      const transport = globalThis.__DSH_TRANSPORT__;
      return document.baseURI || (transport && transport.streamBaseUrl) || "";
    }

    function hostRouteUrl(path) {
      return new URL(String(path).replace(/^\/+/, ""), directoryBase(hostHttpBase())).toString();
    }

    async function callApi(method, body) {
      const init = { method: body === undefined ? "GET" : "POST", headers: { "x-clawbot-client": "1" } };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetch(hostRouteUrl(`${API}/${method}`), init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || (payload && payload.ok === false)) {
        throw new Error((payload && (payload.error || payload.reason)) || `请求失败（HTTP ${response.status}）`);
      }
      return payload || {};
    }

    // ------------------------------------------------------------ 基础样式

    const S = {
      wrap: { display: "flex", flexDirection: "column", gap: "18px", paddingBottom: "24px", fontSize: "13px", lineHeight: 1.6 },
      card: { border: "1px solid rgba(127,127,127,0.22)", borderRadius: "10px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "12px" },
      title: { fontSize: "13px", fontWeight: 600, margin: 0 },
      hint: { fontSize: "12px", opacity: 0.62, margin: 0 },
      row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      grid: { display: "grid", gridTemplateColumns: "minmax(120px, 180px) 1fr", gap: "8px 12px", alignItems: "center" },
      label: { fontSize: "12px", opacity: 0.78 },
      input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: "6px", border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit", fontSize: "13px", outline: "none" },
      btn: { padding: "5px 12px", borderRadius: "6px", border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit", fontSize: "12px", cursor: "pointer" },
      btnPrimary: { padding: "5px 12px", borderRadius: "6px", border: "1px solid rgba(70,120,255,0.7)", background: "rgba(70,120,255,0.12)", color: "inherit", fontSize: "12px", cursor: "pointer", fontWeight: 600 },
      pill: (tone) => ({
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "2px 8px",
        borderRadius: "999px",
        fontSize: "11px",
        border: "1px solid rgba(127,127,127,0.35)",
        opacity: tone === "muted" ? 0.7 : 1,
        background: tone === "ok" ? "rgba(46,160,67,0.14)" : tone === "warn" ? "rgba(230,150,30,0.16)" : tone === "bad" ? "rgba(220,60,60,0.14)" : "transparent",
      }),
      qr: { width: "176px", height: "176px", objectFit: "contain", borderRadius: "8px", border: "1px solid rgba(127,127,127,0.25)", background: "#fff", padding: "6px" },
      pre: { margin: 0, padding: "8px 10px", borderRadius: "8px", background: "rgba(127,127,127,0.10)", maxHeight: "180px", overflow: "auto", fontSize: "11px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
      kv: { display: "flex", gap: "8px", fontSize: "12px" },
      kvKey: { opacity: 0.6, minWidth: "76px" },
    };

    // ------------------------------------------------------------ 小组件

    function Field({ label, children, hint }) {
      return h(
        "div",
        { style: { display: "contents" } },
        h("div", { style: S.label }, label),
        h(
          "div",
          null,
          children,
          hint ? h("div", { style: S.hint }, hint) : null,
        ),
      );
    }

    function TextInput({ value, onChange, placeholder, type, disabled }) {
      return h("input", {
        style: { ...S.input, opacity: disabled ? 0.6 : 1 },
        type: type || "text",
        value: value === undefined || value === null ? "" : value,
        placeholder: placeholder || "",
        disabled,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function Toggle({ checked, onChange, label }) {
      return h(
        "label",
        { style: { display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
        h("input", { type: "checkbox", checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
        h("span", { style: { fontSize: "12px" } }, label),
      );
    }

    function Btn({ children, onClick, primary, disabled, title }) {
      return h(
        "button",
        { type: "button", style: primary ? S.btnPrimary : S.btn, onClick, disabled, title, ...(disabled ? { "aria-disabled": true } : {}) },
        children,
      );
    }

    function Card({ title, hint, right, children }) {
      return h(
        "section",
        { style: S.card },
        h(
          "header",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" } },
          h(
            "div",
            null,
            h("h4", { style: S.title }, title),
            hint ? h("p", { style: S.hint }, hint) : null,
          ),
          right || null,
        ),
        children,
      );
    }

    const statusTone = (status) =>
      status === "online" ? "ok" : status === "login" ? "warn" : status === "error" ? "bad" : "muted";
    const statusLabel = (status) =>
      ({ online: "已连接", login: "登录中", paused: "已暂停", error: "异常", idle: "未连接" })[status] || String(status || "未知");

    function timeText(ms) {
      if (!ms) return "—";
      try {
        return new Date(ms).toLocaleString("zh-CN", { hour12: false });
      } catch {
        return "—";
      }
    }

    function qrSrc(raw) {
      const value = String(raw || "");
      if (!value) return "";
      if (/^(data:|https?:)/.test(value)) return value;
      return `data:image/png;base64,${value}`;
    }

    // ------------------------------------------------------------ 主界面

    // 设置页任何渲染期异常都不该把整块面板刷成空白：兜一层错误边界，把错误显示出来。
    class SectionBoundary extends Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error) {
          const message = this.state.error?.message || String(this.state.error);
          return h(
            "div",
            { style: { padding: "16px", fontSize: "13px", lineHeight: 1.7 } },
            h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "微信 ClawBot 设置页渲染失败"),
            h("div", { style: { opacity: 0.75, marginBottom: "10px", wordBreak: "break-word" } }, message),
            h(
              "button",
              { type: "button", onClick: () => this.setState({ error: null }), style: { cursor: "pointer" } },
              "重试",
            ),
          );
        }
        return this.props.children;
      }
    }

    function WeChatClawbotSection() {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");
      const [pin, setPin] = useState("");
      const [testText, setTestText] = useState("这是一条来自 DSH 的测试消息。");
      const [draft, setDraft] = useState(null);
      const draftReady = useRef(false);

      const refresh = useCallback(async () => {
        try {
          const next = await callApi("state");
          setData(next);
          setError("");
          if (!draftReady.current) {
            const cfg = next.config || {};
            setDraft({
              ilink: { baseUrl: cfg.ilink?.baseUrl || "", channelVersion: cfg.ilink?.channelVersion || "", botAgent: cfg.ilink?.botAgent || "", routeTag: cfg.ilink?.routeTag || "" },
              reply: {
                maxChars: cfg.reply?.maxChars ?? 1800,
                chunkDelayMs: cfg.reply?.chunkDelayMs ?? 300,
                maxChunks: cfg.reply?.maxChunks ?? 0,
                showSessionTag: cfg.reply?.showSessionTag !== false,
                typing: cfg.reply?.typing !== false,
              },
              push: {
                enabled: cfg.push?.enabled !== false,
                fallbackOnFailure: cfg.push?.fallbackOnFailure !== false,
                bark: {
                  enabled: Boolean(cfg.push?.bark?.enabled),
                  serverUrl: cfg.push?.bark?.serverUrl || "https://api.day.app",
                  deviceKey: cfg.push?.bark?.deviceKey || "",
                  group: cfg.push?.bark?.group || "DSH",
                  sound: cfg.push?.bark?.sound || "",
                  level: cfg.push?.bark?.level || "active",
                  openUrl: cfg.push?.bark?.openUrl ?? "weixin://",
                },
                wxpusher: {
                  enabled: Boolean(cfg.push?.wxpusher?.enabled),
                  appToken: cfg.push?.wxpusher?.appToken || "",
                  uids: String(cfg.push?.wxpusher?.uids ?? ""),
                  topicIds: String(cfg.push?.wxpusher?.topicIds ?? ""),
                  contentType: String(cfg.push?.wxpusher?.contentType ?? 1),
                  openUrl: cfg.push?.wxpusher?.openUrl ?? "weixin://",
                },
              },
              routing: {
                coordinatorCwd: cfg.routing?.coordinatorCwd || "",
                allowAllUsers: cfg.routing?.allowAllUsers !== false,
                allowedUserIds: (cfg.routing?.allowedUserIds || []).join(","),
                autoStart: cfg.routing?.autoStart !== false,
              },
              tunnel: {
                provider: cfg.tunnel?.provider || "cloudflare",
                autoStart: cfg.tunnel?.autoStart !== false,
                proxyPort: cfg.tunnel?.proxyPort ?? 61499,
                hookToken: cfg.tunnel?.hook?.token || "",
                forwardToCoordinator: cfg.tunnel?.hook?.forwardToCoordinator !== false,
                cfMode: cfg.tunnel?.cloudflare?.mode || "quick",
                cfToken: "",
                cfPublicUrl: cfg.tunnel?.cloudflare?.publicUrl || "",
                cfBinary: cfg.tunnel?.cloudflare?.binaryPath || "",
                cfArgs: cfg.tunnel?.cloudflare?.extraArgs || "",
                frp: {
                  serverAddr: cfg.tunnel?.frp?.serverAddr || "",
                  serverPort: cfg.tunnel?.frp?.serverPort ?? 7000,
                  token: "",
                  protocol: cfg.tunnel?.frp?.protocol || "tcp",
                  remotePort: cfg.tunnel?.frp?.remotePort ?? 6000,
                  customDomains: cfg.tunnel?.frp?.customDomains || "",
                  publicHost: cfg.tunnel?.frp?.publicHost || "",
                  tls: cfg.tunnel?.frp?.tls === true,
                  binaryPath: cfg.tunnel?.frp?.binaryPath || "",
                },
              },
            });
            draftReady.current = true;
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      useEffect(() => {
        let alive = true;
        const tick = () => {
          if (alive) refresh();
        };
        tick();
        const timer = setInterval(tick, 2500);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      const run = useCallback(
        async (method, body, tag) => {
          setBusy(tag);
          setNotice("");
          try {
            const payload = await callApi(method, body ?? {});
            if (payload.state) setData((prev) => ({ ...(prev || {}), ...payload.state }));
            setNotice(typeof payload.note === "string" ? payload.note : "");
            await refresh();
            return payload;
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return null;
          } finally {
            setBusy("");
          }
        },
        [refresh],
      );

      const patchDraft = (section, key, value) => {
        setDraft((prev) => (prev ? { ...prev, [section]: { ...prev[section], [key]: value } } : prev));
      };
      const patchDeep = (section, sub, key, value) => {
        setDraft((prev) => (prev ? { ...prev, [section]: { ...prev[section], [sub]: { ...prev[section][sub], [key]: value } } } : prev));
      };

      const save = async () => {
        if (!draft) return;
        const config = {
          ilink: {
            baseUrl: draft.ilink.baseUrl.trim() || undefined,
            channelVersion: draft.ilink.channelVersion.trim() || undefined,
            botAgent: draft.ilink.botAgent.trim() || undefined,
            routeTag: draft.ilink.routeTag.trim() || undefined,
          },
          reply: {
            maxChars: Number(draft.reply.maxChars) || 1800,
            chunkDelayMs: Number(draft.reply.chunkDelayMs) || 0,
            maxChunks: Number(draft.reply.maxChunks) || 0,
            showSessionTag: Boolean(draft.reply.showSessionTag),
            typing: Boolean(draft.reply.typing),
          },
          push: {
            enabled: Boolean(draft.push.enabled),
            fallbackOnFailure: Boolean(draft.push.fallbackOnFailure),
            bark: {
              enabled: Boolean(draft.push.bark.enabled),
              serverUrl: draft.push.bark.serverUrl.trim(),
              deviceKey: draft.push.bark.deviceKey.trim(),
              group: draft.push.bark.group.trim(),
              sound: draft.push.bark.sound.trim(),
              level: draft.push.bark.level,
              openUrl: draft.push.bark.openUrl.trim(),
            },
            wxpusher: {
              enabled: Boolean(draft.push.wxpusher.enabled),
              appToken: draft.push.wxpusher.appToken.trim(),
              uids: String(draft.push.wxpusher.uids || "").trim(),
              topicIds: String(draft.push.wxpusher.topicIds || "").trim(),
              contentType: Number(draft.push.wxpusher.contentType) || 1,
              openUrl: draft.push.wxpusher.openUrl.trim(),
            },
          },
          routing: {
            coordinatorCwd: draft.routing.coordinatorCwd.trim(),
            allowAllUsers: Boolean(draft.routing.allowAllUsers),
            allowedUserIds: String(draft.routing.allowedUserIds || "").split(/[,，\s]+/).filter(Boolean),
            autoStart: Boolean(draft.routing.autoStart),
          },
        };
        // 去掉 undefined 字段，避免覆盖；已保存的密钥留空时保持原值
        for (const key of Object.keys(config.ilink)) if (config.ilink[key] === undefined) delete config.ilink[key];
        if (!config.push.bark.deviceKey) delete config.push.bark.deviceKey;
        if (!config.push.wxpusher.appToken) delete config.push.wxpusher.appToken;

        const tunnelPatch = {
          provider: draft.tunnel.provider,
          autoStart: Boolean(draft.tunnel.autoStart),
          proxyPort: Number(draft.tunnel.proxyPort) || 61499,
          cloudflare: {
            mode: draft.tunnel.cfMode,
            publicUrl: draft.tunnel.cfPublicUrl.trim(),
            binaryPath: draft.tunnel.cfBinary.trim(),
            extraArgs: draft.tunnel.cfArgs.trim(),
          },
          frp: {
            serverAddr: draft.tunnel.frp.serverAddr.trim(),
            serverPort: Number(draft.tunnel.frp.serverPort) || 7000,
            protocol: draft.tunnel.frp.protocol,
            remotePort: Number(draft.tunnel.frp.remotePort) || 6000,
            customDomains: draft.tunnel.frp.customDomains.trim(),
            publicHost: draft.tunnel.frp.publicHost.trim(),
            tls: Boolean(draft.tunnel.frp.tls),
            binaryPath: draft.tunnel.frp.binaryPath.trim(),
          },
        };
        const hookToken = draft.tunnel.hookToken.trim();
        tunnelPatch.hook = { forwardToCoordinator: Boolean(draft.tunnel.forwardToCoordinator) };
        if (hookToken) tunnelPatch.hook.token = hookToken;
        if (draft.tunnel.frp.token.trim()) tunnelPatch.frp.token = draft.tunnel.frp.token.trim();
        // 命名隧道的 token 按密钥处理：留空表示不修改
        if (draft.tunnel.cfToken.trim()) tunnelPatch.cloudflare.tunnelToken = draft.tunnel.cfToken.trim();

        const tunnelSaved = await run("tunnel/save", { config: tunnelPatch }, "tunnelSave");
        if (!tunnelSaved) return;
        await run("save", { config }, "save");
        setNotice("配置已保存");
      };

      // 首帧还没有配置：必须在读取 draft 的字段之前返回，否则整页渲染直接抛错、设置页空白
      if (!draft) {
        return h("div", { style: S.wrap }, h("p", { style: S.hint }, error ? `加载失败：${error}` : "正在读取微信 ClawBot 配置…"));
      }

      const login = data?.login || {};
      const counters = data?.counters || {};
      const logs = Array.isArray(data?.log) ? data.log : [];
      const tunnelState = data?.tunnel || {};
      const tunnelRunning = Boolean(tunnelState.running);
      const tunnelLabel = tunnelRunning ? "运行中" : tunnelState.state === "starting" ? "启动中" : tunnelState.state === "error" ? "异常" : "已停止";
      const hookBase = tunnelState.publicUrl || "http://127.0.0.1:" + (tunnelState.gateway?.port || draft.proxyPort || 61499);
      const hookUrl = hookBase.replace(/\/+$/, "") + "/clawbot/hook";

      return h(
        "div",
        { style: S.wrap },

        // 状态
        h(
          Card,
          {
            title: "微信 ClawBot 连接",
            hint: "扫码把 DeepSeekRuntime 绑定成一个微信机器人，之后在微信里直接和它对话。",
            right: h(
              "div",
              { style: S.row },
              h("span", { style: S.pill(statusTone(data?.status)) }, statusLabel(data?.status)),
              data?.online ? h("span", { style: S.pill("muted") }, "长轮询中") : null,
            ),
          },
          h(
            "div",
            { style: S.kv },
            h("span", { style: S.kvKey }, "Bot"),
            h("span", null, data?.botId || "未登录"),
          ),
          h("div", { style: S.kv }, h("span", { style: S.kvKey }, "服务地址"), h("span", null, data?.baseUrl || "默认")),
          h("div", { style: S.kv }, h("span", { style: S.kvKey }, "最后轮询"), h("span", null, timeText(data?.lastPollAt))),
          data?.statusDetail ? h("div", { style: S.kv }, h("span", { style: S.kvKey }, "状态说明"), h("span", null, data.statusDetail)) : null,
          data?.lastError ? h("div", { style: S.kv }, h("span", { style: S.kvKey }, "最近错误"), h("span", null, data.lastError)) : null,

          h(
            "div",
            { style: S.row },
            h(Btn, { primary: true, onClick: () => run("login/start", {}, "login"), disabled: busy === "login" }, busy === "login" ? "正在获取二维码…" : login.active ? "重新生成二维码" : "绑定微信（扫码）"),
            h(Btn, { onClick: () => run("connect", {}, "connect"), disabled: busy === "connect" || data?.online }, "恢复轮询"),
            h(Btn, { onClick: () => run("disconnect", {}, "disconnect"), disabled: busy === "disconnect" || !data?.online }, "暂停轮询"),
            h(Btn, { onClick: () => run("login/logout", {}, "logout"), disabled: busy === "logout" || !data?.botId }, "退出登录"),
            h(Btn, { onClick: () => run("reset/cursor", {}, "cursor"), disabled: busy === "cursor" }, "重置消息游标"),
          ),

          login.active || login.qrSvg || login.qrImg
            ? h(
                "div",
                { style: { ...S.row, alignItems: "flex-start", gap: "16px" } },
                login.qrSvg || login.qrImg
                  ? h("img", { style: S.qr, src: qrSrc(login.qrSvg || login.qrImg), alt: "微信绑定二维码" })
                  : null,
                h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "8px", flex: "1 1 220px" } },
                  h("div", { style: S.hint }, "用手机微信扫码并在手机上确认；状态会自动刷新。"),
                  h("div", { style: S.kv }, h("span", { style: S.kvKey }, "扫码状态"), h("span", null, login.status || "wait")),
                  login.pinNeeded
                    ? h(
                        "div",
                        { style: { display: "flex", gap: "8px", alignItems: "center" } },
                        h(TextInput, { value: pin, onChange: setPin, placeholder: "输入手机端显示的 PIN" }),
                        h(Btn, { primary: true, onClick: () => run("login/pin", { code: pin }, "pin") }, "提交 PIN"),
                      )
                    : null,
                  login.error ? h("div", { style: { ...S.hint, color: "inherit" } }, `错误：${login.error}`) : null,
                ),
              )
            : null,
        ),

        // 回复策略
        h(
          Card,
          { title: "回复与分段", hint: "微信单条文本不宜过长，插件会把回复按段落切开、分批发送。" },
          h(
            "div",
            { style: S.grid },
            h(Field, { label: "单条字符上限", hint: "默认 1800，微信兼容上限约 2000" }, h(TextInput, { type: "number", value: draft.reply.maxChars, onChange: (v) => patchDraft("reply", "maxChars", v) })),
            h(Field, { label: "分段间隔(ms)", hint: "每段之间的等待时间，避免被判定为刷屏" }, h(TextInput, { type: "number", value: draft.reply.chunkDelayMs, onChange: (v) => patchDraft("reply", "chunkDelayMs", v) })),
            h(Field, { label: "最多分段数", hint: "0 表示不限制；超出的内容会转为推送" }, h(TextInput, { type: "number", value: draft.reply.maxChunks, onChange: (v) => patchDraft("reply", "maxChunks", v) })),
            h(Field, { label: "显示会话标签", hint: "切换到其它会话时，在回复前标注当前会话" }, h(Toggle, { checked: draft.reply.showSessionTag, onChange: (v) => patchDraft("reply", "showSessionTag", v), label: "开启" })),
            h(Field, { label: "正在输入状态", hint: "处理期间向微信显示「正在输入」" }, h(Toggle, { checked: draft.reply.typing, onChange: (v) => patchDraft("reply", "typing", v), label: "开启" })),
          ),
        ),

        // 推送兜底
        h(
          Card,
          { title: "推送兜底（Bark / WxPusher）", hint: "微信对机器人主动发消息有限制：当回复无法送达时，改用推送通道送出。" },
          h(Toggle, { checked: draft.push.enabled, onChange: (v) => patchDraft("push", "enabled", v), label: "启用推送通道" }),
          h(Toggle, { checked: draft.push.fallbackOnFailure, onChange: (v) => patchDraft("push", "fallbackOnFailure", v), label: "微信发送失败时自动兜底" }),
          h("hr", { style: { border: "none", borderTop: "1px solid rgba(127,127,127,0.18)", margin: "2px 0" } }),
          h(Toggle, { checked: draft.push.bark.enabled, onChange: (v) => patchDeep("push", "bark", "enabled", v), label: "Bark" }),
          h(
            "div",
            { style: S.grid },
            h(Field, { label: "服务地址", hint: "自建 Bark 时填自己的域名" }, h(TextInput, { value: draft.push.bark.serverUrl, onChange: (v) => patchDeep("push", "bark", "serverUrl", v), placeholder: "https://api.day.app" })),
            h(
              Field,
              { label: "设备 Key", hint: data?.config?.push?.bark?.hasDeviceKey ? "已保存，留空表示不修改" : "Bark App 里看到的 key" },
              h(TextInput, { value: draft.push.bark.deviceKey, onChange: (v) => patchDeep("push", "bark", "deviceKey", v), placeholder: "点按复制 Bark App 的 key" }),
            ),
            h(Field, { label: "分组" }, h(TextInput, { value: draft.push.bark.group, onChange: (v) => patchDeep("push", "bark", "group", v), placeholder: "DSH" })),
            h(Field, { label: "提示音" }, h(TextInput, { value: draft.push.bark.sound, onChange: (v) => patchDeep("push", "bark", "sound", v), placeholder: "留空为默认" })),
            h(Field, { label: "中断级别" }, h(TextInput, { value: draft.push.bark.level, onChange: (v) => patchDeep("push", "bark", "level", v), placeholder: "active / timeSensitive / passive / critical" })),
            h(
              Field,
              { label: "点击打开", hint: "点通知时打开的链接，默认 weixin:// 直接拉起微信回到对话" },
              h(TextInput, { value: draft.push.bark.openUrl, onChange: (v) => patchDeep("push", "bark", "openUrl", v), placeholder: "weixin://" }),
            ),
          ),
          h(Btn, { onClick: () => run("push/test", { channel: "bark", text: testText, config: draft.push }, "bark"), disabled: busy === "bark" }, "测试 Bark"),
          h("hr", { style: { border: "none", borderTop: "1px solid rgba(127,127,127,0.18)", margin: "2px 0" } }),
          h(Toggle, { checked: draft.push.wxpusher.enabled, onChange: (v) => patchDeep("push", "wxpusher", "enabled", v), label: "WxPusher" }),
          h(
            "div",
            { style: S.grid },
            h(
              Field,
              { label: "AppToken", hint: data?.config?.push?.wxpusher?.hasAppToken ? "已保存，留空表示不修改" : "WxPusher 应用 token，或 SPT_ 免注册 token" },
              h(TextInput, { value: draft.push.wxpusher.appToken, onChange: (v) => patchDeep("push", "wxpusher", "appToken", v), placeholder: "AT_xxxx / SPT_xxxx" }),
            ),
            h(Field, { label: "接收者 UID", hint: "多个用逗号分隔" }, h(TextInput, { value: draft.push.wxpusher.uids, onChange: (v) => patchDeep("push", "wxpusher", "uids", v), placeholder: "UID_xxx,UID_yyy" })),
            h(Field, { label: "主题 Topic", hint: "多个用逗号分隔，与 UID 二选一" }, h(TextInput, { value: draft.push.wxpusher.topicIds, onChange: (v) => patchDeep("push", "wxpusher", "topicIds", v), placeholder: "1234" })),
            h(Field, { label: "内容类型", hint: "1 纯文本 / 2 HTML / 3 Markdown" }, h(TextInput, { type: "number", value: draft.push.wxpusher.contentType, onChange: (v) => patchDeep("push", "wxpusher", "contentType", v) })),
            h(
              Field,
              { label: "点击打开", hint: "点通知时打开的链接，默认 weixin:// 直接拉起微信回到对话" },
              h(TextInput, { value: draft.push.wxpusher.openUrl, onChange: (v) => patchDeep("push", "wxpusher", "openUrl", v), placeholder: "weixin://" }),
            ),
          ),
          h(Btn, { onClick: () => run("push/test", { channel: "wxpusher", text: testText, config: draft.push }, "wxpusher"), disabled: busy === "wxpusher" }, "测试 WxPusher"),
        ),

        // 路由与权限
        h(
          Card,
          { title: "会话路由", hint: "微信消息默认进入专属协调器会话；协调器可以查询任意会话、派发新任务。" },
          h(
            "div",
            { style: S.grid },
            h(Field, { label: "协调器工作目录", hint: "留空使用默认目录" }, h(TextInput, { value: draft.routing.coordinatorCwd, onChange: (v) => patchDraft("routing", "coordinatorCwd", v), placeholder: "D:\\code\\某个项目" })),
            h(Field, { label: "允许所有微信用户", hint: "关闭后仅允许下面列出的用户 ID" }, h(Toggle, { checked: draft.routing.allowAllUsers, onChange: (v) => patchDraft("routing", "allowAllUsers", v), label: "允许" })),
            h(Field, { label: "白名单用户 ID", hint: "多个用逗号分隔" }, h(TextInput, { value: draft.routing.allowedUserIds, onChange: (v) => patchDraft("routing", "allowedUserIds", v), placeholder: "wxid_xxx" })),
            h(Field, { label: "启动时自动连接", hint: "DSH 启动后自动恢复长轮询" }, h(Toggle, { checked: draft.routing.autoStart, onChange: (v) => patchDraft("routing", "autoStart", v), label: "开启" })),
            h(Field, { label: "服务地址覆盖", hint: "一般留空；扫码重定向后会自动写入" }, h(TextInput, { value: draft.ilink.baseUrl, onChange: (v) => patchDraft("ilink", "baseUrl", v), placeholder: "https://ilinkai.weixin.qq.com" })),
          ),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.hint }, `协调器会话：${data?.config?.routing?.coordinatorSessionId || "尚未创建（收到第一条微信消息时创建）"}`),
            h(Btn, { onClick: () => run("coordinator", {}, "coord"), disabled: busy === "coord" }, "创建 / 复用协调器"),
            h(
              Btn,
              {
                onClick: async () => {
                  await run("focus", { sessionId: "" }, "resetTarget");
                  setNotice("已切回协调器会话");
                },
                disabled: busy === "resetTarget",
              },
              "切回协调器",
            ),
          ),
        ),

        // 专属指挥会话
        h(
          Card,
          {
            title: "专属指挥会话",
            hint: "微信消息只会进协调器会话或这些指挥会话，永不直接进普通工作会话。在微信里发 /switch 序号，或让协调器调用 clawbot_focus，就会为对应会话开一个指挥会话。",
          },
          (() => {
            const commands = data?.config?.routing?.commands || {};
            const entries = Object.entries(commands);
            if (!entries.length) return h("p", { style: S.hint }, "还没有指挥会话。");
            return h(
              "div",
              null,
              entries.map(([targetId, commandId]) =>
                h(
                  "div",
                  { key: targetId, style: { ...S.kv, display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
                  h("code", { style: { fontSize: "12px" } }, targetId),
                  h("span", { style: S.hint }, "→"),
                  h("code", { style: { fontSize: "12px" } }, commandId),
                  h(
                    Btn,
                    {
                      onClick: async () => {
                        const payload = await run("focus", { sessionId: targetId }, "focus");
                        if (payload) setNotice(`已切到该指挥会话：${payload.sessionId}`);
                      },
                      disabled: busy === "focus",
                    },
                    "切到它",
                  ),
                  h(
                    Btn,
                    {
                      onClick: async () => {
                        const payload = await run("commands/remove", { sessionId: targetId }, "unfocus");
                        if (payload) setNotice("已解除该指挥会话的绑定");
                      },
                      disabled: busy === "unfocus",
                    },
                    "解除",
                  ),
                ),
              ),
            );
          })(),
        ),

        // 入站隧道
        h(
          Card,
          {
            title: "入站隧道（Cloudflare / frp）",
            hint: "微信链路是长轮询（出站），不需要隧道。这里暴露的是 /clawbot/hook 入站接口，供外部平台回调与自建集成使用；网关只放行 hook 与 health，不会把 DSH 界面暴露到公网。",
            right: h(
              "div",
              { style: S.row },
              h("span", { style: S.pill(tunnelRunning ? "ok" : tunnelState.state === "error" ? "bad" : tunnelState.state === "starting" ? "warn" : "muted") }, tunnelLabel),
              tunnelState.publicUrl ? h("span", { style: S.pill("muted") }, "公网可达") : null,
            ),
          },
          h(
            "div",
            { style: S.grid },
            h(
              Field,
              { label: "隧道类型", hint: "Cloudflare Quick Tunnel 零配置（临时域名，进程退出即失效）；frp 需要你自己的 frps" },
              h(
                "select",
                {
                  style: S.input,
                  value: draft.tunnel.provider,
                  onChange: (event) => patchDraft("tunnel", "provider", event.target.value),
                },
                h("option", { value: "cloudflare" }, "Cloudflare Tunnel（Quick / 命名隧道）"),
                h("option", { value: "frp" }, "frp（自建服务端）"),
                h("option", { value: "off" }, "关闭"),
              ),
            ),
            h(
              Field,
              { label: "网关端口", hint: "隧道指向这个本地端口，只放行 /clawbot/hook 与 /clawbot/health" },
              h(TextInput, { type: "number", value: draft.tunnel.proxyPort, onChange: (v) => patchDraft("tunnel", "proxyPort", v) }),
            ),
            h(Field, { label: "公网地址" }, h("code", { style: { fontSize: "12px", wordBreak: "break-all" } }, tunnelState.publicUrl || "未建立隧道")),
            h(
              Field,
              { label: "hook 入口" },
              h(
                "div",
                { style: S.row },
                h("code", { style: { fontSize: "12px", wordBreak: "break-all" } }, hookUrl),
                h(
                  Btn,
                  {
                    onClick: async () => {
                      try {
                        await navigator.clipboard.writeText(hookUrl);
                        setNotice("hook 地址已复制");
                      } catch {
                        setNotice(`复制失败，请手动复制：${hookUrl}`);
                      }
                    },
                  },
                  "复制",
                ),
              ),
            ),
            h(
              Field,
              { label: "hook 密钥", hint: "调用方需带 x-clawbot-token 头（或 ?token=）；泄露就点「重新生成」" },
              h(
                "div",
                { style: S.row },
                h(TextInput, { value: draft.tunnel.hookToken, onChange: (v) => patchDraft("tunnel", "hookToken", v), placeholder: "点「生成密钥」或自己填一串随机字符" }),
                h(Btn, { onClick: () => run("tunnel/token", { regenerate: true }, "hookToken"), disabled: busy === "hookToken" }, "生成 / 重新生成"),
              ),
            ),
            h(
              Field,
              { label: "启动时自动开启", hint: "DSH 启动后自动拉起隧道；Cloudflare 快速隧道每次启动都是新域名" },
              h(Toggle, { checked: draft.tunnel.autoStart, onChange: (v) => patchDraft("tunnel", "autoStart", v), label: "开启" }),
            ),
            h(
              Field,
              { label: "默认转发到协调器", hint: "关闭后，hook 请求必须显式带 sessionId" },
              h(Toggle, { checked: draft.tunnel.forwardToCoordinator, onChange: (v) => patchDraft("tunnel", "forwardToCoordinator", v), label: "允许" }),
            ),
          ),
          h(
            "div",
            { style: S.row },
            h(Btn, { primary: true, onClick: () => run("tunnel/start", {}, "tunnelStart"), disabled: busy === "tunnelStart" || tunnelRunning }, "启动隧道"),
            h(Btn, { onClick: () => run("tunnel/stop", {}, "tunnelStop"), disabled: busy === "tunnelStop" || !tunnelRunning }, "停止隧道"),
            h(
              Btn,
              {
                onClick: async () => {
                  const payload = await run("tunnel/install", { name: "cloudflared" }, "cfInstall");
                  if (payload) setNotice(payload.ok ? `cloudflared 已安装：${payload.path}` : "安装失败");
                },
                disabled: busy === "cfInstall",
              },
              busy === "cfInstall" ? "下载中…" : "安装 cloudflared",
            ),
            h(
              Btn,
              {
                onClick: async () => {
                  const payload = await run("tunnel/install", { name: "frpc" }, "frpInstall");
                  if (payload) setNotice(payload.ok ? `frpc 已安装：${payload.path}` : "安装失败");
                },
                disabled: busy === "frpInstall",
              },
              busy === "frpInstall" ? "下载中…" : "安装 frpc",
            ),
          ),
          tunnelState.stateDetail ? h("div", { style: S.kv }, h("span", { style: S.kvKey }, "状态说明"), h("span", null, tunnelState.stateDetail)) : null,
          h(
            "div",
            { style: S.kv },
            h("span", { style: S.kvKey }, "已发现二进制"),
            h("span", null, `cloudflared: ${tunnelState.binaries?.cloudflared || "未安装"} ｜ frpc: ${tunnelState.binaries?.frpc || "未安装"}`),
          ),
          h(
            "div",
            { style: S.kv },
            h("span", { style: S.kvKey }, "网关统计"),
            h("span", null, `放行 ${tunnelState.gateway?.requests || 0} 次，拦截 ${tunnelState.gateway?.rejected || 0} 次`),
          ),
          draft.tunnel.provider === "cloudflare"
            ? h(
                "div",
                null,
                h("div", { style: { ...S.label, marginBottom: "6px" } }, "Cloudflare 选项"),
                h(
                  "div",
                  { style: S.grid },
                  h(
                    Field,
                    {
                      label: "Cloudflare 模式",
                      hint: "Quick = 免登录临时域名（每次启动都变）；命名隧道 = Cloudflare 后台建的固定域名，需要 tunnel token",
                    },
                    h(
                      "select",
                      { style: S.input, value: draft.tunnel.cfMode, onChange: (event) => patchDraft("tunnel", "cfMode", event.target.value) },
                      h("option", { value: "quick" }, "Quick Tunnel（临时域名，默认）"),
                      h("option", { value: "token" }, "命名隧道（固定域名）"),
                    ),
                  ),
                  h(Field, { label: "二进制路径", hint: "留空则用插件目录 bin/ 或 PATH 里的 cloudflared" }, h(TextInput, { value: draft.tunnel.cfBinary, onChange: (v) => patchDraft("tunnel", "cfBinary", v), placeholder: "自动查找" })),
                  h(Field, { label: "附加参数", hint: "例如 --protocol http2；空格分隔" }, h(TextInput, { value: draft.tunnel.cfArgs, onChange: (v) => patchDraft("tunnel", "cfArgs", v), placeholder: "留空即可" })),
                ),
                draft.tunnel.cfMode === "token"
                  ? h(
                      "div",
                      { style: S.grid },
                      h(
                        Field,
                        {
                          label: "Tunnel Token",
                          hint: data?.config?.tunnel?.cloudflare?.hasTunnelToken
                            ? "已保存，留空表示不修改（钉钉式密钥，只写不读）"
                            : "Cloudflare 后台 → Zero Trust → Networks → Tunnels → 该隧道的安装命令里 --token 后面那串",
                        },
                        h(TextInput, { value: draft.tunnel.cfToken, onChange: (v) => patchDraft("tunnel", "cfToken", v), placeholder: "eyJhIjoi..." }),
                      ),
                      h(
                        Field,
                        { label: "公网域名", hint: "后台给该隧道配的 Public Hostname，例如 clawbot.example.com；填了界面就能显示完整 hook 地址" },
                        h(TextInput, { value: draft.tunnel.cfPublicUrl, onChange: (v) => patchDraft("tunnel", "cfPublicUrl", v), placeholder: "https://clawbot.example.com" }),
                      ),
                    )
                  : null,
                draft.tunnel.cfMode === "token"
                  ? h("p", { style: S.hint }, "命名隧道由 Cloudflare 主动回连本机，无需开放端口；公网域名在后台绑定到 http://127.0.0.1:" + (draft.tunnel.proxyPort || 61499) + " 即可。")
                  : null,
              )
            : null,
          draft.tunnel.provider === "frp"
            ? h(
                "div",
                null,
                h("div", { style: { ...S.label, marginBottom: "6px" } }, "frp 选项"),
                h(
                  "div",
                  { style: S.grid },
                  h(Field, { label: "服务端地址", hint: "frps 的域名或 IP" }, h(TextInput, { value: draft.tunnel.frp.serverAddr, onChange: (v) => patchDeep("tunnel", "frp", "serverAddr", v), placeholder: "frp.example.com" })),
                  h(Field, { label: "服务端端口" }, h(TextInput, { type: "number", value: draft.tunnel.frp.serverPort, onChange: (v) => patchDeep("tunnel", "frp", "serverPort", v) })),
                  h(Field, { label: "鉴权 token", hint: data?.config?.tunnel?.frp?.hasToken ? "已保存，留空表示不修改" : "与 frps 的 token 一致" }, h(TextInput, { value: draft.tunnel.frp.token, onChange: (v) => patchDeep("tunnel", "frp", "token", v), placeholder: "留空表示不修改" })),
                  h(
                    Field,
                    { label: "代理类型", hint: "tcp 用公网端口；http/https 走 frps 的 vhost 域名" },
                    h(
                      "select",
                      { style: S.input, value: draft.tunnel.frp.protocol, onChange: (event) => patchDeep("tunnel", "frp", "protocol", event.target.value) },
                      h("option", { value: "tcp" }, "tcp"),
                      h("option", { value: "http" }, "http"),
                      h("option", { value: "https" }, "https"),
                    ),
                  ),
                  draft.tunnel.frp.protocol === "tcp"
                    ? h(Field, { label: "远端端口", hint: "frps 上对外开放的端口" }, h(TextInput, { type: "number", value: draft.tunnel.frp.remotePort, onChange: (v) => patchDeep("tunnel", "frp", "remotePort", v) }))
                    : h(Field, { label: "自定义域名", hint: "多个用逗号分隔，需在 frps 的 subdomain/vhost 里可用" }, h(TextInput, { value: draft.tunnel.frp.customDomains, onChange: (v) => patchDeep("tunnel", "frp", "customDomains", v), placeholder: "clawbot.example.com" })),
                  h(Field, { label: "公网入口显示", hint: "tcp 模式下拼地址用；留空则用服务端地址" }, h(TextInput, { value: draft.tunnel.frp.publicHost, onChange: (v) => patchDeep("tunnel", "frp", "publicHost", v), placeholder: "example.com" })),
                  h(Field, { label: "TLS", hint: "frps 开了 transport.tls.force 时必须打开" }, h(Toggle, { checked: draft.tunnel.frp.tls, onChange: (v) => patchDeep("tunnel", "frp", "tls", v), label: "启用" })),
                  h(Field, { label: "frpc 路径", hint: "留空则用插件目录 bin/ 或 PATH" }, h(TextInput, { value: draft.tunnel.frp.binaryPath, onChange: (v) => patchDeep("tunnel", "frp", "binaryPath", v), placeholder: "自动查找" })),
                ),
              )
            : null,
          h(
            "div",
            null,
            h("div", { style: { ...S.label, marginBottom: "6px" } }, "调用示例"),
            h(
              "pre",
              { style: S.pre },
              `curl -X POST ${hookUrl} \\\n  -H "content-type: application/json" \\\n  -H "x-clawbot-token: ${draft.tunnel.hookToken || "<先点生成密钥>"}" \\\n  -d '{"text":"帮我看下当前会话进度","wait":true}'`,
            ),
          ),
          Array.isArray(tunnelState.logs) && tunnelState.logs.length
            ? h("pre", { style: { ...S.pre, maxHeight: "120px" } }, tunnelState.logs.join("\n"))
            : h("p", { style: S.hint }, "暂无隧道日志"),
        ),

        // 测试发送
        h(
          Card,
          { title: "测试发送", hint: "直接向最近一次联系的微信用户发一条文本，用于验证链路。" },
          h(TextInput, { value: testText, onChange: setTestText, placeholder: "测试内容" }),
          h(
            "div",
            { style: S.row },
            h(
              Btn,
              {
                primary: true,
                onClick: async () => {
                  const payload = await run("send/test", { text: testText }, "send");
                  if (payload) setNotice(payload.ok ? `已发送给 ${payload.userId}` : `发送失败：${payload.reason || "未知原因"}`);
                },
                disabled: busy === "send",
              },
              "发送到微信",
            ),
          ),
        ),

        // 统计与日志
        h(
          Card,
          {
            title: "运行状态",
            hint: "统计自本次启动以来。",
            right: h(Btn, { onClick: refresh, disabled: busy === "refresh" }, "刷新"),
          },
          h(
            "div",
            { style: { ...S.row, gap: "14px", fontSize: "12px" } },
            h("span", null, `收到 ${counters.received || 0}`),
            h("span", null, `回复 ${counters.replied || 0}`),
            h("span", null, `分段 ${counters.chunks || 0}`),
            h("span", null, `推送 ${counters.pushed || 0}`),
            h("span", null, `失败 ${counters.failed || 0}`),
          ),
          logs.length
            ? h(
                "pre",
                { style: S.pre },
                logs
                  .slice()
                  .reverse()
                  .map((entry) => `${new Date(entry.time).toLocaleTimeString("zh-CN", { hour12: false })} [${entry.level}] ${entry.message}`)
                  .join("\n"),
              )
            : h("p", { style: S.hint }, "暂无日志"),
        ),

        // 底部操作条
        h(
          "div",
          { style: { ...S.row, position: "sticky", bottom: 0, justifyContent: "flex-end", paddingTop: "8px" } },
          notice ? h("span", { style: S.hint }, notice) : null,
          error ? h("span", { style: { ...S.hint, color: "inherit" } }, `错误：${error}`) : null,
          h(Btn, { primary: true, onClick: save, disabled: busy === "save" }, busy === "save" ? "保存中…" : "保存配置"),
        ),
      );
    }

    // ------------------------------------------------------------ 插件入口

    // 设置页图标：内联 SVG（不用 emoji）。stroke/fill 都用 currentColor，
    // 跟随侧边栏主题色；尺寸由槽位传入（缺省 18px）。
    function WeChatClawbotIcon(props) {
      const raw = Number(props && props.size);
      const size = raw > 0 ? raw : 18;
      const dot = (cx) => h("circle", { cx, cy: 9.9, r: 1.05, fill: "currentColor", stroke: "none" });
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          role: "img",
          "aria-label": "微信 ClawBot",
          focusable: "false",
          style: { display: "block" },
        },
        h("path", {
          d: "M4.2 7.1A3.1 3.1 0 0 1 7.3 4h9.4a3.1 3.1 0 0 1 3.1 3.1v5.6a3.1 3.1 0 0 1-3.1 3.1h-4.9l-4.2 3.05a.62.62 0 0 1-.97-.51V15.8h-.1a3.1 3.1 0 0 1-3.1-3.1Z",
        }),
        dot(8.6),
        dot(12),
        dot(15.4),
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== "function") return;

      ctx.slots.inject("settings.section.icon", () =>
        ctx.slots.register(
          { name: "settings.section.icon", id: "wechat-clawbot", order: 120, label: () => "微信 ClawBot" },
          (props) => h(WeChatClawbotIcon, props || null),
        ),
      );

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "wechat-clawbot", order: 120, label: () => "微信 ClawBot" },
          () => h(SectionBoundary, null, h(WeChatClawbotSection, null)),
        ),
      );
    }

    module.exports = { apply, inject, name: "dsh-wechat-clawbot" };
    module.exports.default = module.exports;
    return module.exports;
  },
});
