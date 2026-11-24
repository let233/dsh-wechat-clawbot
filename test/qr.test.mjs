/**
 * 二维码正确性验证：用 jsqr（devDependency，仅测试用）解码我们生成的矩阵，
 * 断言解出来的内容与输入完全一致。
 *
 *   node test/qr.test.mjs
 */

import jsQR from "jsqr";
import { qrMatrix, qrSvgDataUrl } from "../lib/qr.js";

const failures = [];

function rasterize(matrix, scale = 6, quiet = 4) {
  const count = matrix.length;
  const size = (count + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!matrix[row][column]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = (column + quiet) * scale + dx;
          const y = (row + quiet) * scale + dy;
          const offset = (y * size + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

const samples = [
  "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=b8df35b44fe6405d6f31a48c31f59516&bot_type=3",
  "4197f5a07908b402c1d476fb35fc313a",
  "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=0123456789abcdef0123456789abcdef",
];

for (const sample of samples) {
  const matrix = qrMatrix(sample);
  const { data, size } = rasterize(matrix);
  const decoded = jsQR(data, size, size);
  if (!decoded) {
    failures.push(`解码失败：${sample.slice(0, 40)}…`);
    continue;
  }
  if (decoded.data !== sample) {
    failures.push(`解码内容不一致：期望 ${sample} 实际 ${decoded.data}`);
  }
}

const svg = qrSvgDataUrl("https://liteapp.weixin.qq.com/q/test?bot_type=3");
if (!svg.startsWith("data:image/svg+xml;charset=utf-8,")) failures.push("SVG data URL 前缀不正确");
if (!decodeURIComponent(svg.split(",", 2)[1]).includes("<svg")) failures.push("SVG data URL 内没有 svg 标签");
if (qrSvgDataUrl("") !== "") failures.push("空内容应返回空字符串");

if (failures.length) {
  console.error("二维码测试失败：");
  for (const item of failures) console.error(` - ${item}`);
  process.exit(1);
}
console.log(`二维码测试通过：${samples.length} 组内容解码一致，SVG data URL 正常`);
