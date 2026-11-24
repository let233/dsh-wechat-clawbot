/**
 * 配置持久化：<DSH_HOME>/wechat-clawbot/config.json
 *
 * 单独落盘（不走 DSH settings）的原因：
 *   - 里面是微信 bot_token / 推送密钥这类凭据，需要 0600 权限与独立备份；
 *   - 扫码登录是一条动态流程，需要频繁写入 token / botId / 游标。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR_NAME = "wechat-clawbot";
const FILE_NAME = "config.json";

/** @returns {any} */
export function defaultConfig() {
  return {
    ilink: {
      baseUrl: "https://ilinkai.weixin.qq.com",
      channelVersion: "2.4.8",
      botAgent: "DeepSeekRuntime",
      routeTag: "",
      botToken: "",
      botId: "",
      userId: "",
      savedAt: 0,
      /** get_updates 游标（不透明 blob，按 bot 账号保存） */
      getUpdatesBuf: "",
      /** 最近一次入站消息的 context_token（主动发送/重启后回复的唯一锚点） */
      lastContextToken: "",
      lastContextUserId: "",
      lastContextAt: 0,
    },
    routing: {
      coordinatorSessionId: "",
      coordinatorCwd: "",
      agentPreset: "",
      /** 微信端当前对话目标：只能是插件自己创建的专属会话；空 = 协调器会话 */
      activeSessionId: "",
      /**
       * 目标会话 → 专属指挥会话 的映射。
       * 微信端「切到某个会话」不会把消息直接投进那个会话，
       * 而是为它开一个专属指挥会话，由指挥会话原样转发并汇报。
       */
      commands: {},
      // 曾经创建过的指挥会话（映射被解除后仍然记得它们，避免被当成普通工作会话）
      knownCommands: [],
      allowAllUsers: true,
      allowedUserIds: [],
      autoStart: true,
    },
    reply: {
      maxChars: 1800,
      maxChunks: 0,
      chunkDelayMs: 400,
      typing: true,
      showSessionTag: true,
    },
    push: {
      enabled: true,
      fallbackOnFailure: true,
      bark: {
        enabled: false,
        serverUrl: "https://api.day.app",
        deviceKey: "",
        group: "DSH",
        sound: "",
        level: "active",
        icon: "",
        /** 点击通知时打开的链接：默认直接拉起微信，回到 ClawBot 对话 */
        openUrl: "weixin://",
      },
      wxpusher: {
        enabled: false,
        appToken: "",
        uids: "",
        topicIds: "",
        contentType: 1,
        /** 点击通知时打开的链接：默认直接拉起微信 */
        openUrl: "weixin://",
      },
    },
    tunnel: {
      /** off | cloudflare | frp —— cloudflare（Quick Tunnel）零配置，作为默认 */
      provider: "cloudflare",
      /** 是否随 DSH 启动自动拉起隧道（关掉后只能手动点「启动隧道」） */
      autoStart: true,
      /** 网关监听端口（只放行 /clawbot/hook），隧道指向它而不是 DSH 主端口 */
      proxyPort: 61499,
      hook: {
        /** 入站 webhook 的共享密钥，没带 token 的请求一律拒绝 */
        token: "",
        /** 是否允许 hook 直接把消息送进协调器会话 */
        forwardToCoordinator: true,
      },
      /** 二进制下载源：留空用内置镜像列表，每个条目是前缀（拼接官方 URL） */
      download: {
        mirrors: [],
      },
      cloudflare: {
        /** quick = 免登录 Quick Tunnel（trycloudflare 随机域名）；token = 命名隧道（Cloudflare 后台配置，固定域名） */
        mode: "quick",
        /** 命名隧道凭据：cloudflared tunnel run --token <token>，按密钥处理 */
        tunnelToken: "",
        /** 命名隧道的公网地址（后台配的 Public hostname），留空则启动后只显示“已连接” */
        publicUrl: "",
        binaryPath: "",
        extraArgs: "",
      },
      frp: {
        serverAddr: "",
        serverPort: 7000,
        token: "",
        /** tcp（公网 IP:端口）或 http/https（走 frps 的 vhost 域名） */
        protocol: "tcp",
        remotePort: 6000,
        customDomains: "",
        publicHost: "",
        tls: false,
        binaryPath: "",
      },
    },
    log: {
      maxEntries: 60,
    },
  };
}

/** @param {any} base @param {any} patch */
export function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 解析配置目录。 */
export function resolveConfigDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, DIR_NAME);
}

export class ConfigStore {
  /** @param {string} [dir] */
  constructor(dir = resolveConfigDir()) {
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.config = defaultConfig();
    this.loadError = "";
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.config = deepMerge(defaultConfig(), parsed);
      this.loadError = "";
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        this.loadError = error instanceof Error ? error.message : String(error);
      }
      this.config = defaultConfig();
    }
    return this.config;
  }

  get() {
    return this.config;
  }

  /** 原子写入，文件权限 0600。 */
  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* Windows 上无实际意义 */
      }
      return true;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** @param {any} patch */
  patch(patch) {
    this.config = deepMerge(this.config, patch);
    this.save();
    return this.config;
  }

  /**
   * 直接改配置并落盘。
   * patch() 是深合并，删不掉 key；需要在配置里「移除」条目（比如解除某条指挥会话映射）时用这个。
   * @param {(config: any) => void} mutator
   */
  mutate(mutator) {
    const next = JSON.parse(JSON.stringify(this.config));
    mutator(next);
    this.config = next;
    this.save();
    return this.config;
  }

  /** 恢复默认（保留推送与路由偏好之外的一切重置）。 */
  reset() {
    this.config = defaultConfig();
    this.save();
    return this.config;
  }

  /**
   * 面向客户端的视图：密钥字段一律置空并用 hasX 标记是否已保存。
   * 这样界面回写时不会把掩码当成新密钥保存。
   */
  redacted() {
    const config = this.config;
    return {
      ...config,
      ilink: {
        ...config.ilink,
        botToken: "",
        hasToken: Boolean(config.ilink.botToken),
        getUpdatesBuf: config.ilink.getUpdatesBuf ? "***(已保存游标)" : "",
        lastContextToken: config.ilink.lastContextToken ? "***(已保存)" : "",
      },
      push: {
        ...config.push,
        bark: { ...config.push.bark, deviceKey: "", hasDeviceKey: Boolean(config.push.bark.deviceKey) },
        wxpusher: {
          ...config.push.wxpusher,
          appToken: "",
          hasAppToken: Boolean(config.push.wxpusher.appToken),
        },
      },
      // hook.token 需要在界面上复制给调用方，这个值本身就是一次性的共享密钥，
      // 只暴露给同源的设置页；frp 的 token 则按密钥处理（留空 = 不修改）。
      tunnel: {
        ...config.tunnel,
        hook: { ...config.tunnel.hook },
        cloudflare: {
          ...config.tunnel.cloudflare,
          tunnelToken: "",
          hasTunnelToken: Boolean(config.tunnel.cloudflare.tunnelToken),
        },
        frp: {
          ...config.tunnel.frp,
          token: "",
          hasToken: Boolean(config.tunnel.frp.token),
        },
      },
    };
  }

  /** 路径信息，便于界面展示。 */
  paths() {
    return { dir: this.dir, file: this.file, loadError: this.loadError };
  }
}
