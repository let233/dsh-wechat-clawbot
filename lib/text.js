/**
 * 文本分批（微信 ClawBot / iLink 单条消息约 2000 字符的兼容上限）。
 *
 * 切分偏好顺序：段落 → 换行 → 句末标点 → 空格 → 硬切。
 * 代码围栏尽量整体保留在一个分片里（围栏自身超过上限时只能硬切）。
 */

const HARD_MIN = 120;

/** @param {string} text @returns {string} */
function normalize(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

/**
 * 把一个超长文本切成若干 <= limit 的「单元」，切点尽量落在语义边界。
 * @param {string} source
 * @param {number} limit
 * @returns {string[]}
 */
function splitUnits(source, limit) {
  const units = [];
  // 先按段落切，段落之间保留一个空行作为分隔符
  const paragraphs = source.split(/\n{2,}/);
  for (let i = 0; i < paragraphs.length; i += 1) {
    const paragraph = paragraphs[i];
    const suffix = i === paragraphs.length - 1 ? "" : "\n\n";
    if (paragraph.length + suffix.length <= limit) {
      units.push(paragraph + suffix);
      continue;
    }
    // 段落过长：按行切
    const lines = paragraph.split("\n");
    let buffer = "";
    for (let j = 0; j < lines.length; j += 1) {
      const line = lines[j] + (j === lines.length - 1 ? "" : "\n");
      if (line.length > limit) {
        if (buffer) {
          units.push(buffer);
          buffer = "";
        }
        units.push(...splitLongLine(line, limit));
        continue;
      }
      if (buffer.length + line.length > limit) {
        units.push(buffer);
        buffer = line;
      } else {
        buffer += line;
      }
    }
    if (buffer) units.push(buffer + suffix);
    else if (suffix && units.length) units[units.length - 1] += suffix;
  }
  return units.filter((unit) => unit.length > 0);
}

/**
 * 单行超长：句末标点 → 空格 → 硬切。
 * @param {string} line
 * @param {number} limit
 * @returns {string[]}
 */
function splitLongLine(line, limit) {
  const out = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = -1;
    const window = rest.slice(0, limit);
    const sentence = Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf("；"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
    );
    if (sentence >= Math.floor(limit * 0.4)) cut = sentence + 1;
    if (cut < 0) cut = window.lastIndexOf(" ");
    if (cut < Math.floor(limit * 0.4)) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 按上限分批。
 * @param {string} text 原始回复
 * @param {number} maxChars 单条上限（建议 <= 2000）
 * @param {{ maxChunks?: number }} [options] maxChunks 只保留前 N 片（其余以省略提示收尾）
 * @returns {string[]}
 */
export function chunkText(text, maxChars = 1800, options = {}) {
  const limit = Math.max(HARD_MIN, Math.floor(Number(maxChars) || 1800));
  const source = normalize(text);
  if (!source) return [];
  if (source.length <= limit) return [source];

  const units = splitUnits(source, limit);
  const chunks = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    if (current.length + unit.length <= limit) {
      current += unit;
    } else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current) chunks.push(current);

  const cleaned = chunks.map((chunk) => chunk.replace(/\s+$/, "")).filter((chunk) => chunk.length > 0);
  const maxChunks = Math.floor(Number(options.maxChunks) || 0);
  if (maxChunks > 0 && cleaned.length > maxChunks) {
    const kept = cleaned.slice(0, maxChunks);
    kept[maxChunks - 1] = `${kept[maxChunks - 1]}\n\n……（内容较长，余下 ${cleaned.length - maxChunks} 段已省略，可在 DSH 客户端查看完整回复）`;
    return kept;
  }
  return cleaned;
}

/**
 * 单行摘要，用于通知标题/列表。
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function oneLine(text, max = 60) {
  const flat = normalize(text).replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
