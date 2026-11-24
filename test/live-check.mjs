/**
 * 本地自检脚本：直接打运行中的 DSH host 的 /clawbot/api。
 *
 *   node test/live-check.mjs                 # 只读检查
 *   node test/live-check.mjs tunnel/state    # 指定接口（GET）
 *   node test/live-check.mjs tunnel/token '{"regenerate":true}'   # POST
 */

const BASE = process.env.CLAWBOT_BASE || "http://127.0.0.1:61431";
const API = `${BASE}/clawbot/api`;

const method = process.argv[2] || "state";
const body = process.argv[3] ? JSON.parse(process.argv[3]) : undefined;

const response = await fetch(`${API}/${method}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { "content-type": "application/json", "x-clawbot-client": "1" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const text = await response.text();
let json = null;
try {
  json = JSON.parse(text);
} catch {
  /* 保持原始输出 */
}
console.log(`HTTP ${response.status} ${method}`);
console.log(JSON.stringify(json ?? text, null, 2).slice(0, 4000));
