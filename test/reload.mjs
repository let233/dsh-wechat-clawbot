/**
 * 热重载 helper：从 profile 的 cordis.patch.yml 里摘掉本插件挂载行，等 Cordis 卸载，
 * 再写回去触发重新加载。写完等待就绪后探一次 /clawbot/api/state 并打印状态码。
 *
 *   node test/reload.mjs
 *
 * 说明：两次写盘之间必须留出间隔，否则 loader 认为文件内容「净变化为零」不会重载。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const patchFile = path.join(os.homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml");
const block = `# >>> dsh-wechat-clawbot: 本 profile 的手动挂载行（id 与包名一致，客户端半边随之挂载） >>>
- insert:
    - id: dsh-wechat-clawbot
      name: 'dsh-wechat-clawbot'
# <<< dsh-wechat-clawbot <<<
`;
const START = "# >>> dsh-wechat-clawbot";
const END = "# <<< dsh-wechat-clawbot <<<";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function read() {
  return fs.readFileSync(patchFile, "utf8");
}
function write(text) {
  fs.writeFileSync(patchFile, text, "utf8");
}

const original = read();
if (!original.includes(START)) {
  write(`${original.replace(/\s+$/, "")}\n\n${block}`);
  console.log("原本未挂载，已写入挂载行");
  await sleep(10000);
} else {
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  const without = `${original.slice(0, start)}${original.slice(end + END.length)}`.replace(/\n{3,}$/, "\n");
  write(without);
  console.log("已摘掉挂载行，等待卸载…");
  await sleep(8000);
  write(`${read().replace(/\s+$/, "")}\n\n${block}`);
  console.log("已写回挂载行，等待加载…");
  await sleep(11000);
}

const response = await fetch("http://127.0.0.1:61431/clawbot/api/state", {
  headers: { "x-clawbot-client": "1" },
}).catch((error) => ({ status: `fetch 失败：${error.message}` }));
console.log(`/clawbot/api/state → ${response.status}`);
