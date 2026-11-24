/**
 * 隧道管理：把「只在 127.0.0.1 上跑的入站网关」安全地暴露到公网。
 *
 * 支持两种 provider：
 *   - cloudflare：Cloudflare Quick Tunnel（trycloudflare.com），零配置、随机域名、临时有效，优先默认
 *   - frp：自建 frps，客户端 frpc 连过去，可用固定域名/端口
 *
 * 说明：微信 iLink 收消息是 getupdates 长轮询（出站），本身不需要入站隧道；
 * 这里暴露的是 /clawbot/hook 这个通用入站 webhook，用于对接支持回调的平台与自建集成。
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const LOG_LIMIT = 80;

/** 二进制来源：只认官方 GitHub Release。 */
const BINARIES = {
  cloudflared: {
    label: "cloudflared",
    repo: "cloudflare/cloudflared",
    asset: (() => {
      if (process.platform === "win32") return `cloudflared-windows-${process.arch === "arm64" ? "arm64" : "amd64"}.exe`;
      if (process.platform === "darwin") return "cloudflared-darwin-amd64.tgz";
      return `cloudflared-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
    })(),
    exe: process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  },
  frpc: {
    label: "frpc",
    repo: "fatedier/frp",
    asset: () => {
      const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
      const arch = process.arch === "arm64" ? "arm64" : "amd64";
      return { pattern: new RegExp(`frp_.*_${os}_${arch}\\.(zip|tar\\.gz)$`), inner: "frpc" };
    },
    exe: process.platform === "win32" ? "frpc.exe" : "frpc",
  },
};

function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

class TunnelError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "TunnelError";
    this.detail = detail;
  }
}

export class TunnelManager {
  /**
   * @param {{ store: any, log: (level: string, message: string) => void, hostPort: number | (() => number) }} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.log = deps.log || (() => {});
    this.hostPort = deps.hostPort;
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
    this.provider = "";
    this.publicUrl = "";
    this.startedAt = 0;
    this.state = "stopped";
    this.stateDetail = "";
    /** @type {string[]} */
    this.logs = [];
    this.gateway = null;
    this.installing = "";
  }

  // ---------------------------------------------------------------- 基础设施

  dir() {
    return this.store.paths().dir;
  }

  binDir() {
    return path.join(this.dir(), "bin");
  }

  push(line) {
    // frpc 的日志带 ANSI 色彩，写进 UI 会变成乱码转义，先剥掉
    const text = String(line ?? "").replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
    if (!text) return;
    this.logs.push(`${nowIso()} ${text}`);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
  }

  /** 在 PATH 里找一个可执行文件。 */
  which(name) {
    const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    const dirs = String(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
    for (const dir of dirs) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          /* 不存在继续找 */
        }
      }
    }
    return "";
  }

  /** 解析某个二进制：配置里指定的路径 → 插件 bin 目录 → PATH。 */
  resolveBinary(name) {
    const tunnel = this.store.get().tunnel || {};
    const configured = String(tunnel?.[name]?.binaryPath || "").trim();
    if (configured && fs.existsSync(configured)) return configured;
    const local = path.join(this.binDir(), BINARIES[name].exe);
    if (fs.existsSync(local)) return local;
    return this.which(BINARIES[name].label);
  }

  binaries() {
    return {
      cloudflared: this.resolveBinary("cloudflared") || "",
      frpc: this.resolveBinary("frpc") || "",
      dir: this.binDir(),
    };
  }

  /**
   * 下载 release 资产。
   *
   * 直连 github.com 的下载地址在部分网络会被重置，所以准备一组镜像；
   * 无论走哪个来源，都用 GitHub API 给出的 sha256 校验，镜像无法篡改内容。
   */
  async download(asset) {
    const configured = Array.isArray(this.store.get().tunnel?.download?.mirrors) ? this.store.get().tunnel.download.mirrors : [];
    const official = String(asset.browser_download_url || "");
    const mirrors = configured.length
      ? configured
      : ["https://gh-proxy.com/", "https://ghfast.top/"];
    const candidates = [official, ...mirrors.map((prefix) => `${prefix}${official}`)].filter(Boolean);
    const expected = String(asset.digest || "");
    const expectedHash = expected.startsWith("sha256:") ? expected.slice(7) : "";
    const failures = [];
    for (const url of candidates) {
      try {
        const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (asset.size && buffer.length !== Number(asset.size)) {
          throw new Error(`大小不符（${buffer.length} != ${asset.size}）`);
        }
        const digest = crypto.createHash("sha256").update(buffer).digest("hex");
        if (expectedHash && digest !== expectedHash) throw new Error("sha256 不匹配");
        if (url !== official) this.push(`（经镜像 ${new URL(url).host} 下载）`);
        return { buffer, digest };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${new URL(url).host}: ${message}`);
        this.push(`下载失败 ${new URL(url).host}：${message}`);
      }
    }
    throw new TunnelError(`所有下载源都失败：${failures.join("; ")}`);
  }

  /** 下载官方二进制（校验 sha256）。 */
  async install(name) {
    const spec = BINARIES[name];
    if (!spec) throw new TunnelError(`不认识的组件：${name}`);
    if (this.installing) throw new TunnelError(`正在安装 ${this.installing}，请稍候`);
    this.installing = spec.label;
    try {
      const release = await (await fetch(`https://api.github.com/repos/${spec.repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
      })).json();
      const wanted = typeof spec.asset === "function" ? spec.asset() : spec.asset;
      const asset = (release.assets || []).find((item) =>
        typeof wanted === "string" ? item.name === wanted : wanted.pattern.test(item.name),
      );
      if (!asset) throw new TunnelError(`在 ${release.tag_name || "latest"} 里找不到 ${spec.label} 的当前平台安装包`);
      this.push(`下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`);
      const { buffer, digest } = await this.download(asset);
      this.push(`已下载 ${(buffer.length / 1048576).toFixed(1)} MB，sha256 ${digest.slice(0, 16)}…`);
      await fsp.mkdir(this.binDir(), { recursive: true });
      const target = path.join(this.binDir(), spec.exe);
      if (/\.(zip|tar\.gz|tgz)$/.test(asset.name)) {
        const tmp = path.join(this.binDir(), asset.name);
        await fsp.writeFile(tmp, buffer);
        await this.extract(tmp, this.binDir(), spec.exe);
        await fsp.rm(tmp, { force: true });
      } else {
        await fsp.writeFile(target, buffer);
      }
      if (process.platform !== "win32") await fsp.chmod(target, 0o755).catch(() => {});
      this.push(`已安装 ${spec.exe} → ${target}`);
      return { ok: true, path: target, version: release.tag_name || "" };
    } finally {
      this.installing = "";
    }
  }

  /** 用系统自带 tar（Windows 10+ 的 bsdtar 支持 zip）解包，避免引入依赖。 */
  async extract(archive, destDir, exeName) {
    const args = /\.zip$/i.test(archive) ? ["-xf", archive, "-C", destDir] : ["-xzf", archive, "-C", destDir];
    await new Promise((resolve, reject) => {
      const proc = spawn("tar", args, { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("error", reject);
      proc.on("exit", (code) => (code === 0 ? resolve(undefined) : reject(new TunnelError(`解包失败：${stderr.trim() || code}`))));
    });
    // 压缩包里是 frp_x.y.z_os_arch/frpc[.exe]，平铺到 bin 根目录
    for (const entry of await fsp.readdir(destDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const inner = path.join(destDir, entry.name, exeName);
      if (fs.existsSync(inner)) {
        await fsp.rm(path.join(destDir, exeName), { force: true });
        await fsp.rename(inner, path.join(destDir, exeName));
        await fsp.rm(path.join(destDir, entry.name), { recursive: true, force: true });
        return;
      }
    }
    throw new TunnelError(`解包后没有找到 ${exeName}`);
  }

  // ---------------------------------------------------------------- 生命周期

  status() {
    const tunnel = this.store.get().tunnel || {};
    return {
      provider: this.provider || tunnel.provider || "cloudflare",
      configuredProvider: tunnel.provider || "cloudflare",
      state: this.state,
      stateDetail: this.stateDetail,
      running: this.state === "running",
      publicUrl: this.publicUrl,
      startedAt: this.startedAt,
      pid: this.child?.pid ?? 0,
      gateway: this.gateway ? this.gateway.info() : null,
      binaries: this.binaries(),
      installing: this.installing,
      logs: this.logs.slice(-25),
      config: {
        provider: tunnel.provider || "cloudflare",
        autoStart: tunnel.autoStart !== false,
        proxyPort: tunnel.proxyPort ?? 61499,
        hookPath: "/clawbot/hook",
        hookToken: tunnel.hook?.token || "",
        cloudflare: { ...(tunnel.cloudflare || {}) },
        frp: { ...(tunnel.frp || {}) },
      },
    };
  }

  setState(state, detail = "") {
    this.state = state;
    this.stateDetail = detail;
    if (detail) this.push(`${state}: ${detail}`);
  }

  ensureGateway() {
    if (!this.gateway) throw new TunnelError("网关未初始化");
    return this.gateway;
  }

  /** @param {{ gateway: any }} deps */
  attachGateway(gateway) {
    this.gateway = gateway;
  }

  async start(options = {}) {
    const tunnel = this.store.get().tunnel || {};
    const provider = String(tunnel.provider || "cloudflare");
    if (provider === "off") throw new TunnelError("隧道已关闭，请先在设置里选择 cloudflare 或 frp");
    // 已在运行且类型没变：直接返回；换了类型或显式要求重启则先停再起
    if (this.state === "running" && !options.restart && this.provider === provider) return this.status();
    if (this.state === "running" || this.child) await this.stop({ silent: true });
    const targetPort = typeof this.hostPort === "function" ? this.hostPort() : this.hostPort;
    const gatewayPort = Number(tunnel.proxyPort) || 61499;
    await this.ensureGateway().start(gatewayPort);
    this.provider = provider;
    this.setState("starting", `provider=${provider}`);
    try {
      if (provider === "cloudflare") await this.startCloudflare();
      else if (provider === "frp") await this.startFrp();
      else throw new TunnelError(`不支持的隧道类型：${provider}`);
      this.startedAt = Date.now();
      this.setState("running", this.publicUrl ? `公网入口 ${this.publicUrl}` : "已启动");
      this.log("info", `隧道已启动（${provider}）：${this.publicUrl || "未取到公网地址"}`);
      return this.status();
    } catch (error) {
      await this.stop({ silent: true });
      const message = error instanceof Error ? error.message : String(error);
      this.setState("error", message);
      throw error;
    }
  }

  async stop(options = {}) {
    if (this.child && !this.child.killed) {
      const child = this.child;
      this.child = null;
      await new Promise((resolve) => {
        child.once("exit", () => resolve(undefined));
        try {
          if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
          else child.kill("SIGTERM");
        } catch {
          /* 已经退出 */
        }
        setTimeout(resolve, 3000);
      });
    }
    this.publicUrl = "";
    this.startedAt = 0;
    if (this.gateway) await this.gateway.stop().catch(() => {});
    if (!options.silent) this.setState("stopped", "已停止");
    else this.state = "stopped";
    return this.status();
  }

  // ---------------------------------------------------------------- Cloudflare

  watch(child, matcher) {
    const onData = (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.push(line);
        if (matcher) matcher(line);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        if (this.state === "running") this.setState("error", `进程退出（code ${code}）`);
        else this.push(`进程退出（code ${code}）`);
      }
    });
  }

  /**
   * 生成 cloudflared 启动命令。
   *   quick = Quick Tunnel（免登录，trycloudflare 随机域名，临时有效）
   *   token = 命名隧道（Cloudflare 后台建隧道 + Public hostname，域名固定）
   */
  buildCloudflareCommand() {
    const binary = this.resolveBinary("cloudflared");
    if (!binary) throw new TunnelError("找不到 cloudflared，请先点「安装 cloudflared」或填写二进制路径");
    const tunnel = this.store.get().tunnel || {};
    const settings = tunnel.cloudflare || {};
    const mode = String(settings.mode || "quick").toLowerCase();
    const gatewayPort = Number(tunnel.proxyPort) || 61499;
    const extra = String(settings.extraArgs || "").trim();

    if (mode === "token") {
      const token = String(settings.tunnelToken || "").trim();
      if (!token) {
        throw new TunnelError("命名隧道需要先填写 Tunnel Token（Cloudflare 后台 → Networks → Tunnels → 该隧道的安装命令里 --token 后面那串）");
      }
      const args = ["tunnel", "--no-autoupdate", "run", "--token", token];
      // 本机/这类网络里 UDP 7844 常被拦，QUIC 会间歇掉线（边缘报 1033），默认走 http2 更稳
      if (!/--protocol/.test(extra)) args.push("--protocol", "http2");
      if (extra) args.push(...extra.split(/\s+/));
      return { binary, args, mode, gatewayPort, token };
    }

    const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${gatewayPort}`];
    if (!/--protocol/.test(extra)) args.push("--protocol", "http2");
    if (extra) args.push(...extra.split(/\s+/));
    return { binary, args, mode: "quick", gatewayPort, token: "" };
  }

  async startCloudflare() {
    const command = this.buildCloudflareCommand();
    const { binary, args, mode } = command;
    // 日志里不能出现真实 token
    const safeArgs = args.map((arg) => (command.token && arg === command.token ? "***" : arg));
    this.push(`$ ${binary} ${safeArgs.join(" ")}`);

    const child = spawn(binary, args, { windowsHide: true });
    this.child = child;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timeoutMessage =
        mode === "token"
          ? "等待 Cloudflare 隧道注册超时（30s），请检查 Token 是否正确、网络能否连到 Cloudflare 边缘"
          : "等待 Cloudflare 快速隧道地址超时（30s）";
      const timer = setTimeout(() => finish(reject, new TunnelError(timeoutMessage)), 30000);

      this.watch(child, (line) => {
        if (mode === "quick") {
          const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (match && !this.publicUrl) {
            this.publicUrl = match[0];
            finish(resolve);
          }
          return;
        }
        // 命名隧道：cloudflared 只在真正连上边缘后打印 Registered tunnel connection / connIndex=…
        if (/Registered tunnel connection|Connection [0-9a-f-]+ registered|connIndex=\d/i.test(line)) {
          finish(resolve);
        }
      });

      child.once("error", (error) => finish(reject, new TunnelError(`无法启动 cloudflared：${error.message}`)));
      child.once("exit", (code) => {
        if (settled) return;
        const hint = mode === "token" ? "；通常是 Token 失效或该隧道已在别处运行" : "";
        finish(reject, new TunnelError(`cloudflared 启动即退出（code ${code}）${hint}，详见日志`));
      });
    });

    if (mode === "token") {
      const configured = String(this.store.get().tunnel?.cloudflare?.publicUrl || "")
        .trim()
        .replace(/\/+$/, "");
      if (configured) {
        this.publicUrl = configured;
      } else {
        this.push("提示：隧道已连接，但没填「公共主机名」，界面拿不到公网地址；请在 Cloudflare 后台把 Public hostname 指向本机网关端口");
      }
    }
  }

  // ---------------------------------------------------------------- frp

  frpConfigPath() {
    return path.join(this.dir(), "frpc.toml");
  }

  /** 生成 frpc.toml：一个 tcp 或 http(s) proxy 指向本地网关。 */
  buildFrpConfig() {
    const frp = this.store.get().tunnel?.frp || {};
    const gatewayPort = Number(this.store.get().tunnel?.proxyPort) || 61499;
    const serverAddr = String(frp.serverAddr || "").trim();
    const serverPort = Number(frp.serverPort) || 7000;
    if (!serverAddr) throw new TunnelError("frp 服务端地址没填");
    const protocol = String(frp.protocol || "tcp").toLowerCase();
    const lines = [
      `serverAddr = ${JSON.stringify(serverAddr)}`,
      `serverPort = ${serverPort}`,
      `loginFailExit = false`,
      `transport.tls.enable = ${frp.tls === true ? "true" : "false"}`,
      `log.to = "console"`,
      `log.level = "info"`,
    ];
    if (frp.token) lines.push(`auth.method = "token"`, `auth.token = ${JSON.stringify(String(frp.token))}`);
    lines.push("", "[[proxies]]", `name = "dsh-clawbot-hook"`, `type = ${JSON.stringify(protocol)}`, `localIP = "127.0.0.1"`, `localPort = ${gatewayPort}`);
    if (protocol === "tcp") lines.push(`remotePort = ${Number(frp.remotePort) || 6000}`);
    if (protocol === "http" || protocol === "https") {
      const domains = String(frp.customDomains || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (!domains.length) throw new TunnelError("http(s) 模式需要填自定义域名（frps 的 vhost 域名）");
      lines.push(`customDomains = ${JSON.stringify(domains)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  async startFrp() {
    const binary = this.resolveBinary("frpc");
    if (!binary) throw new TunnelError("找不到 frpc，请先点「安装 frpc」或填写二进制路径");
    const toml = this.buildFrpConfig();
    await fsp.mkdir(this.dir(), { recursive: true });
    await fsp.writeFile(this.frpConfigPath(), toml, { mode: 0o600 });
    this.push(`写入 ${this.frpConfigPath()}`);
    const child = spawn(binary, ["-c", this.frpConfigPath()], { windowsHide: true });
    this.child = child;
    const frp = this.store.get().tunnel?.frp || {};
    const protocol = String(frp.protocol || "tcp").toLowerCase();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new TunnelError("等待 frpc 连接成功超时（25s），请检查服务端地址/token")), 25000);
      this.watch(child, (line) => {
        if (/start proxy success|start proxy success/i.test(line) && !this.publicUrl) {
          this.publicUrl = this.composeFrpUrl(frp, protocol);
          clearTimeout(timer);
          resolve(undefined);
        }
        if (/login to server failed|connect to server error|authorization failed/i.test(line)) {
          clearTimeout(timer);
          reject(new TunnelError(`frpc 连接失败：${line.trim()}`));
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new TunnelError(`无法启动 frpc：${error.message}`));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!this.publicUrl) reject(new TunnelError(`frpc 启动即退出（code ${code}），详见日志`));
      });
    });
  }

  composeFrpUrl(frp, protocol) {
    if (protocol === "tcp") {
      const domain = String(frp.publicHost || frp.serverAddr || "").trim();
      return `http://${domain}:${Number(frp.remotePort) || 6000}`;
    }
    const domains = String(frp.customDomains || "").split(",").map((item) => item.trim()).filter(Boolean);
    return `${protocol}://${domains[0] || ""}`;
  }
}

export { TunnelError };
