/**
 * 二维码渲染。
 *
 * iLink 的 get_bot_qrcode 返回的 qrcode_img_content 实际是「二维码里的内容」
 * （https://liteapp.weixin.qq.com/q/... 链接），并不是图片字节流，
 * 所以这里用内置的 MIT 级编码器把它渲染成 SVG data URL 供界面直接 <img> 显示。
 *
 * 编码器：qrcode-generator 2.0.4（Kazuhiko Arase, MIT），见 lib/vendor/。
 */

import qrcodeFactory from "./vendor/qrcode-generator.mjs";

/**
 * @param {string} text 二维码承载的内容
 * @param {{ cellSize?: number, margin?: number, level?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {string} data URL（image/svg+xml）
 */
export function qrSvgDataUrl(text, options = {}) {
  const content = String(text ?? "").trim();
  if (!content) return "";
  const cellSize = Math.max(2, Math.min(12, Number(options.cellSize) || 5));
  const margin = Math.max(0, Math.min(16, Number(options.margin ?? 4)));
  const level = ["L", "M", "Q", "H"].includes(String(options.level)) ? String(options.level) : "M";
  const qr = qrcodeFactory(0, level);
  qr.addData(content);
  qr.make();
  const svg = qr.createSvgTag(cellSize, margin);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 只取模块矩阵，便于测试与自定义渲染。 */
export function qrMatrix(text, level = "M") {
  const qr = qrcodeFactory(0, level);
  qr.addData(String(text ?? ""));
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const line = [];
    for (let column = 0; column < count; column += 1) line.push(qr.isDark(row, column) ? 1 : 0);
    rows.push(line);
  }
  return rows;
}
