/**
 * 推送点击跳转测试（离线）：Bark / WxPusher 的推送里必须带上可点击的 url。
 * 默认值是 weixin:// —— 手机点通知就能直接拉起微信。
 *
 *   node test/push-openurl.test.mjs
 */

import http from "node:http";
import { pushAll, pushBark, hasPushChannel } from "../lib/push.js";

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const received = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    received.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 200, message: "success" }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// 1) 默认 openUrl = weixin://，且随表单一起发出
{
  received.length = 0;
  const results = await pushAll(
    { push: { enabled: true, bark: { enabled: true, serverUrl: base, deviceKey: "demo-key" }, wxpusher: { enabled: false } } },
    { title: "完成", text: "任务跑完了" },
  );
  expect(results.length === 1 && results[0].ok === true, `Bark 推送应成功，实际 ${JSON.stringify(results)}`);
  const sent = received[0];
  expect(Boolean(sent), "Bark 没有收到请求");
  const decoded = decodeURIComponent(String(sent?.body ?? ""));
  expect(decoded.includes("url=weixin://"), `推送里应带 url=weixin://，实际 ${decoded.slice(0, 200)}`);
  expect(decoded.includes("demo-key"), "推送里应带 device_key");
}

// 2) 显式 channel.url 优先于 openUrl
{
  received.length = 0;
  await pushBark({ serverUrl: base, deviceKey: "k", title: "t", body: "b", url: "https://example.com/x?y=1" });
  const decoded = decodeURIComponent(String(received[0]?.body ?? ""));
  expect(decoded.includes("https://example.com/x?y=1"), `显式 url 未生效：${decoded.slice(0, 200)}`);
}

// 3) openUrl 可改成其它 scheme
{
  received.length = 0;
  await pushAll(
    { push: { enabled: true, bark: { enabled: true, serverUrl: base, deviceKey: "k", openUrl: "weixin://dl/chat" } } },
    { title: "t", text: "b" },
  );
  const decoded = decodeURIComponent(String(received[0]?.body ?? ""));
  expect(decoded.includes("url=weixin://dl/chat"), `自定义 openUrl 未生效：${decoded.slice(0, 200)}`);
}

// 4) 关闭推送时什么都不发
{
  received.length = 0;
  const results = await pushAll(
    { push: { enabled: false, bark: { enabled: true, serverUrl: base, deviceKey: "k" } } },
    { title: "t", text: "b" },
  );
  expect(results.length === 0, "push.enabled=false 时不应推送");
  expect(received.length === 0, "关闭后不应发出请求");
}

// 5) 没有配置任何通道时 hasPushChannel=false
{
  const none = hasPushChannel({ push: { enabled: true, bark: { enabled: true, deviceKey: "" }, wxpusher: { enabled: false } } });
  expect(none === false, "没有 deviceKey 时不应认为有可用通道");
}

server.close();

if (failures.length) {
  console.error("推送跳转测试失败：");
  for (const item of failures) console.error(" -", item);
  process.exit(1);
}
console.log("推送跳转测试通过：Bark 默认带 weixin://、显式 url 优先、可自定义 scheme、关闭时不推送");
