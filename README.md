# dsh-wechat-clawbot

[![CI](https://github.com/let233/dsh-wechat-clawbot/actions/workflows/ci.yml/badge.svg)](https://github.com/let233/dsh-wechat-clawbot/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/let233/dsh-wechat-clawbot?include_prereleases&sort=semver)](https://github.com/let233/dsh-wechat-clawbot/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)


把 **DeepSeekRuntime（DSH）** 接到 **微信 ClawBot（iLink Bot API）**：在微信里跟一个专属的「协调器会话」聊天，让它查询所有工作区的会话、为某个会话开一个**专属指挥会话**、派发新任务，并把结果分批回到微信。微信侧有主动消息限制，所以另配了 **Bark / WxPusher** 推送兜底。

一条硬规则：**微信端所有消息只会落进插件自己创建的专属会话**（协调器，或某个目标会话的指挥会话），永远不会直接写进普通工作会话。

设置入口在 DSH 客户端侧边栏：**设置 → 微信 ClawBot**。

---

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| 扫码绑定 | 设置页点「绑定微信」出二维码（本地生成 SVG，不依赖外部图片服务），手机扫码即绑定 |
| 专属协调器会话 | 所有微信对话默认进入一个由插件创建的协调器会话，它可查询任意工作区会话、开专属指挥会话、派发任务 |
| 专属指挥会话 | 「切到某个对话」不是把消息直接塞进那个会话，而是**为它新开一个只负责指挥它的会话**；之后微信消息进这个指挥会话，由它用 `clawbot_relay` 把原话逐字转给目标并汇报进度 |
| 原样下发 | 派发/转达时把用户消息**逐字**交给目标会话，不 trim、不改写、不摘要（单测里用带首尾空白的多行文本逐字节比对） |
| 落点护栏 | 落点必须是插件自己创建的会话；子会话（subagent 派生）运行时不接受投递，插件会提前拦下并给出可读理由 |
| 分批回复 | 按 `maxChars`（默认 1800，微信侧兼容上限约 2000）先按段落、再按换行、再按句末标点切分，逐条发送并保留顺序 |
| 点击回微信 | Bark / WxPusher 推送默认附带 `url=weixin://`，手机点通知直接拉起微信回到对话（可在设置页改） |
| 推送兜底 | 微信通道发不出去（无 `context_token`、限流、断线）时自动转 Bark / WxPusher，内容不丢 |
| 大白话切换 | 「切到那个在改登录页的会话」「以后就聊 dsh插件 那个」——本机模糊匹配，唯一命中直接切，歧义回编号列表，回个数字就切 |
| 快捷指令 | `/help` `/sessions` `/switch` `/coord` `/status` `/new`，不进模型、不耗 token |
| 鉴权 | 可只允许指定微信用户（默认允许全部），消息按 `message_id` 去重 |

## 安装

```bash
# 方式一：官方 CLI（推荐，会自动把包加进 dsh.profile.bundles）
dsh plugin --profile <profile> add dsh-wechat-clawbot

# 本地开发目录
dsh plugin --profile desktop add file:D:\code\dsh插件
```

```bash
# 方式二：手动挂载（本机当前就是这样装的）
#   1) 把包放进 <profile>/node_modules/dsh-wechat-clawbot（或做目录联接）
#   2) 在 <profile>/cordis.patch.yml 末尾追加：
- insert:
    - id: dsh-wechat-clawbot
      name: 'dsh-wechat-clawbot'
```

> 行 `id` 与包名保持一致：DSH 的客户端模块层会把本包的浏览器半边（`lib/client.js`）挂到同一行上，设置入口无需额外注册。
> **不要同时**用 bundles 和手动挂载行，同一个 id 插两次会让插件树启动失败。

装上后刷新 GUI 页面（或重启 DSH），设置里就出现「微信 ClawBot」。

## 第一次使用

1. **设置 → 微信 ClawBot → 绑定微信**：出现二维码，手机微信扫码并确认；若提示输入 PIN，在页面 PIN 框填入后在手机端确认。
2. 绑定成功后状态变「在线」，插件开始长轮询收消息（`routing.autoStart` 打开时，DSH 启动后自动恢复）。
3. 在微信里给这个 bot 发消息，默认进入协调器会话。
4. 需要收推送时，在「推送兜底」里填 Bark 的 `deviceKey`（或 WxPusher 的 `AppToken` + UID/Topic），点「测试 Bark」确认能收到。

## 微信侧指令

```
/help            用法
/sessions        列出所有工作区的可见会话（标注 🧭协调器 / 🎯指挥→目标 / 🚫子会话）
/switch <序号>   为该会话开「专属指挥会话」，后续消息进指挥会话（不会直接写进目标）
/coord           回到协调器会话（指挥会话保留，可随时 /switch 回去）
/status          连接状态、bot、当前落点（指挥 → 目标）、计数
/new [目录]      在指定目录新建会话并切过去
/task new <原文>      新建会话并「逐字」派发，不经过模型改写
/task <序号|会话ID> <原文>   逐字派发给已有会话
```

**最省事的切换**：不用记序号，直接说人话——

```
切到那个在改登录页的会话
以后就聊 dsh插件 那个
帮我盯着跑 e2e 的会话
切回协调器
```

插件会在**本机**按标题/最近回复/工作区/目录做模糊匹配，不花 token：

- 唯一命中 → 立刻开（或复用）指挥会话，并告诉你落点已换过去；
- 命中多个 → 回一个编号列表，你回 `2` 就切（序号会记着，下一条回数字即可）；
- 完全不像切换请求（例如「把登录页重构一下」）→ 不接管，照常交给协调器。

匹配只看**工作会话**：协调器与指挥会话本身不会被当成「切过去」的目标。

**「切换」到底是什么**：`/switch 3` 会为目标会话开一个专属指挥会话（已开过就复用），并把微信落点切到它。你之后说的话由这个指挥会话负责：它用 `clawbot_relay` 把原话逐字转给目标、用 `clawbot_session_detail` 查进度。消息**不会**直接进入目标会话，所以目标会话的上下文不会被微信对话污染。协调器与指挥会话的分工：

| 会话 | 角色 | 能用的工具 |
| --- | --- | --- |
| 🧭 协调器 | 总管，跨工作区查询与派发 | `clawbot_sessions` `clawbot_session_detail` `clawbot_dispatch` `clawbot_focus` `clawbot_push` |
| 🎯 指挥会话 | 一对一指挥它绑定的那个目标 | `clawbot_sessions` `clawbot_session_detail`（默认查绑定目标）`clawbot_relay` `clawbot_push` |
| 普通工作会话 | 干活的会话 | 看不到任何 `clawbot_*` 工具 |

`/task` 是字节级保证的那条路：正文除「指令词 + 一个分隔符」之外原样进入目标会话的首条消息，含首尾空格、制表符、连续空行、全角标点。自然语言路径（直接说话让协调器派发）靠模型转达，措辞本身仍可能被模型调整；要绝对原样就用 `/task`。

## 工具

`clawbot_*` 工具只对**插件自己创建的专属会话**可见（按 `agent.id` 判定；执行时还会再校验一次，普通会话模型即使猜到名字也调不动）：

| 工具 | 可见于 | 作用 |
| --- | --- | --- |
| `clawbot_sessions` | 协调器 / 指挥会话 | 列出所有工作区会话（状态、排队、等待输入、最近回复、能否指挥） |
| `clawbot_session_detail` | 协调器 / 指挥会话 | 看某个会话的详细进度；指挥会话不传 `sessionId` 时默认看自己绑定的目标 |
| `clawbot_dispatch` | 仅协调器 | 向指定会话派发任务；不传 `sessionId` 时新建会话。**消息原样下发** |
| `clawbot_focus` | 仅协调器 | 为某个会话开专属指挥会话并切换落点；优先用 `query` 传用户原话（本机匹配，歧义回候选），已知 ID 才用 `sessionId`；`sessionId` 传空串回到协调器 |
| `clawbot_relay` | 仅指挥会话 | 把用户原话逐字转给它绑定的目标会话，并可等待结果 |
| `clawbot_push` | 协调器 / 指挥会话 | 走 Bark/WxPusher 主动推送一条通知（绕开微信主动消息限制） |

没有「让模型真的把投递目标改掉」的工具：路由是用户动作（`/switch`、`/coord`、设置页），模型只能建议。

## 配置项

配置文件：`<DSH_HOME>/wechat-clawbot/config.json`（默认 `~/.dsh/wechat-clawbot/config.json`；类 Unix 下以 0600 写入，Windows 由用户目录 ACL 保护）。设置页可改其中大部分，敏感字段（`botToken`、`deviceKey`、`appToken`）接口只回传「是否已保存」，留空表示不修改。

```jsonc
{
  "ilink": {
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "channelVersion": "2.4.8",
    "botAgent": "DeepSeekRuntime",
    "botToken": "...",            // 扫码后自动写入
    "getUpdatesBuf": "..."        // 长轮询游标
  },
  "routing": {
    "coordinatorSessionId": "...", // 插件创建
    "coordinatorCwd": "",          // 留空用 DSH 默认目录
    "activeSessionId": "",         // 当前落点：协调器 / 某个指挥会话，空 = 协调器
    "commands": {},                // 目标会话 → 专属指挥会话 的持久映射
    "allowAllUsers": true,
    "allowedUserIds": [],
    "autoStart": true
  },
  "reply": { "maxChars": 1800, "maxChunks": 0, "chunkDelayMs": 400, "typing": true, "showSessionTag": true },
  "push": {
    "enabled": true,
    "fallbackOnFailure": true,
    "bark": { "enabled": false, "serverUrl": "https://api.day.app", "deviceKey": "", "group": "DSH", "sound": "", "level": "", "openUrl": "weixin://" },
    "wxpusher": { "enabled": false, "appToken": "", "uids": "", "topicIds": "", "contentType": 1, "openUrl": "weixin://" }
  },
  "tunnel": {
    "provider": "cloudflare",      // cloudflare | frp | off
    "proxyPort": 61499,            // 本地网关端口，只放行 /clawbot/hook 与 /clawbot/health
    "hook": { "token": "", "forwardToCoordinator": true },
    "cloudflare": { "mode": "quick", "tunnelToken": "", "publicUrl": "", "binaryPath": "", "extraArgs": "" },
    "frp": { "serverAddr": "", "serverPort": 7000, "token": "", "protocol": "tcp", "remotePort": 6000, "customDomains": "", "publicHost": "", "tls": false, "binaryPath": "" }
  }
}
```

- `reply.maxChars`：单条上限；`maxChunks`：0 = 不限条数，>0 时超出部分合并进最后一条并注明；
- `reply.typing`：走 `getconfig` + `sendtyping` 显示「正在输入」；
- `push.fallbackOnFailure`：微信发送失败时是否转推送；
- `push.*.openUrl`：推送里附带的点击跳转地址，默认 `weixin://` —— 手机点通知会直接拉起微信；
- `routing.commands`：由插件维护的「目标会话 → 指挥会话」映射，设置页「专属指挥会话」卡片可以逐个切回或解除。

## HTTP API（设置页用，同源）

`/clawbot/api/*`：`state` `save` `login/start` `login/pin` `login/logout` `connect` `disconnect` `push/test` `send/test` `sessions` `coordinator` `focus`（开/切换指挥会话，`sessionId: ""` 回协调器）`commands`（列出映射）`commands/remove`（解除映射）`tunnel/*` `reset/cursor`，以及自检用的 `coordinator/ask`（把一句话交给协调器并等回复）、`command/run`（像微信发消息那样跑一条指令）、`session/detail`（最近记录，`raw: true` 可带原始事件）、`session/archive`（尽力归档）、`focus/query`（只读预览：一句大白话会命中哪个会话，`apply: true` 才真的切）、`chat/simulate`（模拟一条微信文本，只跑「大白话切换」这一层，不花 token）。

写操作需要请求头 `x-clawbot-client: 1`，且拒绝 `Sec-Fetch-Site: cross-site`。插件路由不经过壳层登录校验，这两条是防跨站写入的护栏：

```bash
node -e "fetch('http://127.0.0.1:61431/clawbot/api/sessions',{method:'POST',headers:{'content-type':'application/json','x-clawbot-client':'1'},body:'{}'}).then(r=>r.json()).then(j=>console.log(j.items.length))"
```

## 入站隧道（Cloudflare Quick Tunnel / frp）

微信侧的 iLink 接口本身只有**长轮询**（`getupdates`），公开文档里没有 webhook，所以**收微信消息不需要隧道**。隧道的作用是给「外部系统把消息推给 DSH」留一个入口：一个受限的公网 `POST /clawbot/hook`。

设计上刻意只暴露两个前缀，绝不放行 DSH 界面本身：

```
公网 https://xxx.trycloudflare.com
        │  cloudflared / frpc（插件自动拉起）
        ▼
127.0.0.1:61499  网关（lib/gateway.js）——只放行 /clawbot/hook 与 /clawbot/health，其余一律 404
        ▼
127.0.0.1:61431  DSH 主端口（真正的 /clawbot/hook 处理逻辑）
```

- 默认隧道类型 `cloudflare`（Quick Tunnel，零配置、临时域名），`frp` 需要你自己的 frps，`off` 关闭。
- 二进制不用手工装：设置页点「安装 cloudflared / 安装 frpc」，走 GitHub Releases 并按官方 `digest` 校验 sha256；**官方直连在这台机器上会 ECONNRESET**，插件内置镜像回退（`gh-proxy.com`、`ghfast.top`），校验和来自 api.github.com，镜像篡改不了。
- 本机 DNS 解析不了 `*.trycloudflare.com`，但公共 DNS 正常；浏览器/系统若同样解析失败，用 `nslookup <域名> 223.5.5.5` 看真实 IP。
- cloudflared 默认追加 `--protocol http2`：这类网络里 UDP 7844 常被拦，QUIC 会间歇掉线，边缘报 `error code: 1033`。
- 新域名生效有几秒延迟（边缘返回 `1016`/`1033` 属正常），重试即可。
- **命名隧道（固定域名，长期用推荐这个）**：Cloudflare Zero Trust → Networks → Tunnels 新建隧道，复制 **Tunnel Token**，在设置页「Cloudflare → 模式」选**命名隧道**，填入 Token 与绑定好的公网域名（如 `clawbot.example.com`）。插件执行 `cloudflared tunnel run --token …`，**出站连接，不用开任何入站端口**，域名也不会每次重启就变。Token 只存本地配置，接口只回传「是否已保存」。

### hook 契约

```bash
# 健康检查（不需要密钥）
curl https://<公网地址>/clawbot/health

# 把一句话交给 DSH 会话，并等同轮回复
curl -X POST https://<公网地址>/clawbot/hook \
  -H 'content-type: application/json' \
  -H 'x-clawbot-token: <设置页生成的 hook 密钥>' \
  -d '{"text":"帮我看看当前有几个会话在跑","wait":true}'
```

| 字段 | 说明 |
| --- | --- |
| `text` / `message` | 要下发的内容，**不做 trim、不做改写**，原样交给目标会话 |
| `sessionId` | 目标会话；省略时用 `routing.activeSessionId`，再退回协调器会话 |
| `wait` | `true` 等这轮跑完并返回 `reply`；`false` 只排队并立即返回，稍后用推送兜底 |
| `timeoutMs` | 等待上限，默认 300000 |
| `channel` | 推送兜底时显示在标题里的来源标识 |

返回：`{ ok, target, reply, reason, sessionId }`。token 可以放 `x-clawbot-token` 头、`Authorization: Bearer` 或 `?token=`，用 `crypto.timingSafeEqual` 比对；没配 token 直接 503，配错 401。关闭「默认转发到协调器」后，未带 `sessionId` 的请求会被拒（400），避免随便谁都能往默认会话里塞话。

设置页对应卡片：隧道类型、是否随启动自动开启、网关端口、公网地址、hook 入口（一键复制）、hook 密钥（生成/重新生成）、启动/停止、安装二进制、状态与最近日志。

## 协议要点（实测）

- `POST /ilink/bot/get_bot_qrcode?bot_type=3` 返回的 `qrcode_img_content` **不是图片**，而是一个 `https://liteapp.weixin.qq.com/q/...` 链接；所以插件自带二维码编码器（`lib/vendor/qrcode-generator.mjs`，MIT）生成 SVG 供页面显示。
- 长轮询 `POST /ilink/bot/getupdates`，本地超时视作空轮询；`ret/errcode = -14` 表示会话过期，插件暂停 1 小时并提示重新绑定。
- 回复必须携带入站消息的 `context_token`（路由锚点），且没有「主动开会话」的接口——这就是必须有 Bark/WxPusher 的原因。
- 文本上限按 2000 字符的兼容约定处理（非官方常量），插件默认 1800 留余量。
- 媒体（图片/语音/文件）目前只做展示：语音取转写文本，图片/文件/视频发占位提示。

## 已验证的行为（本机实测）

- 逐字派发：`/task new` 带「前导两空格 + 制表符 + 空行 + 全角括号 + 单双引号 + 行尾两空格」的正文，回读目标会话事件，`source.kind === "user"` 的那条消息与原文**逐字节相同**。
- 分批：1800 字上限下长回复按 `段落 → 换行 → 句末标点 → 空格 → 硬切` 顺序切分，段落间内容完整、顺序不变（离线管线测试断言）。
- 工具链：协调器会话能调用 `clawbot_sessions` 并拿到真实会话列表；工具返回值统一过一遍 JSON 往返，避免宿主「lossless JSON」校验拒绝。
- 护栏：跨站 GET 与缺少 `x-clawbot-client` 的写请求均返回 403；工具在非协调器会话里调用会被运行期门控拒绝。
- 客户端：`settings.section` / `settings.section.icon` 两个插槽在运行中的壳体里已挂载（`id=wechat-clawbot, order=120`）。

## 测试

```bash
node test/qr.test.mjs          # 二维码：矩阵 → 光栅 → jsqr 解码回原文
node test/smoke-host.mjs       # Host：路由/工具/接口/写保护（假 ctx）
node test/smoke-client.mjs     # 客户端：__ModuleLoader__ 包装 + 2 个设置槽位
node test/render-client.mjs    # 客户端渲染：设置页首帧不空白、配置到达后区块完整（jsdom）
node test/bridge-guard.test.mjs # 会话守卫：子会话不可指挥、注入旁白不算用户消息
node test/pipeline.test.mjs    # 端到端：原样下发、分批完整性、指令、兜底、去重、语音
node test/tunnel.test.mjs      # 隧道：网关白名单/转发、frp.toml 生成、状态视图
node test/push-openurl.test.mjs # 推送：Bark 默认带 weixin://、显式 url 优先、可自定义 scheme
node test/focus-nl.test.mjs    # 大白话切换：意图识别、模糊匹配、歧义候选、序号追问、工具 query 分支
```

联机自检（需要 Host 在跑）：

```bash
node test/live-check.mjs tunnel/state     # 打真实 Host 的 /clawbot/api
node test/reload.mjs                      # 改完代码后热重载插件
```

全部离线（`qr.test.mjs`、`pipeline.test.mjs`、`bridge-guard.test.mjs` 不联网；`smoke-*.mjs` 用假 ctx 直接跑 `apply()`）。`render-client.mjs` 需要开发依赖：`npm i --no-save react@18 react-dom@18 jsdom qrcode-generator jsqr`（这些不进发布包）。

## 目录

```
lib/index.js      插件入口：inject webServer+tools，注册 /clawbot/api、5 个工具、自动恢复轮询
lib/ilink.js      iLink Bot API 客户端（二维码登录、长轮询、发消息、正在输入）
lib/bot.js        运行时：登录状态机、消息管线、指令、分批投递、推送兜底
lib/bridge.js     会话桥：协调器/指挥会话创建与引导、跨工作区列表与详情、原样派发与转达
lib/tools.js      专属会话工具（6 个，按归属 + 角色双重门控）
lib/routes.js     设置页 HTTP API + 公网 hook 入口（含同源写保护、token 定时比较）
lib/push.js       Bark / WxPusher 推送
lib/store.js      配置读写（原子写、0600、密钥不回传）
lib/text.js       按微信习惯切分长文本
lib/qr.js         二维码 → SVG data URL
lib/gateway.js    公网入口网关：只放行 /clawbot/hook + /clawbot/health
lib/tunnel.js     隧道管理：cloudflared / frpc 的下载校验、启动、日志、frpc.toml 生成
lib/client.js     客户端半边：设置页「微信 ClawBot」
```

## 已知限制

- 群聊未实现（`group_id` 直接忽略）；
- **子会话（`origin: subagent`）不能作为指挥/派发目标**：运行时拒绝向它 `prompt`（`owned by subagent routing`），插件会在 `/sessions` 里标 `🚫子会话（不可指挥）` 并提前拦下；
- 「切换」是开指挥会话，不是把微信消息灌进目标会话——这是刻意的：目标会话的上下文只属于它自己的任务；
- 大白话匹配是**本地关键词/二元组打分**，不是语义模型：措辞完全对不上（比如会话里从没出现过你在说的词）会匹配失败，此时仍可用 `/sessions` + `/switch 序号`；
- 媒体收发未实现（协议里的加密上传流程没做）；
- 协调器会话由一个运行中的 Agent 承载，DSH 重启后按 `routing.coordinatorSessionId` 复用；
- 微信侧主动消息限制由平台决定，插件只能靠推送兜底绕开；
- Cloudflare Quick Tunnel 是匿名临时隧道（无 SLA，域名每次启动都变），正式用请换 Named Tunnel 或自建 frps 配自定义域名；
- 隧道只承载 `/clawbot/hook` 这一个入站入口，不是「把 DSH 界面开到公网」；
- 客户端半边在页面加载时取包，改完 `lib/client.js` 后需要刷新一次窗口（Host 侧热重载不刷新浏览器）。
