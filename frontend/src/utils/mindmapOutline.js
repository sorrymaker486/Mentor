/** 从完整 Markdown 中取出 ```mermaid … ``` 内源码 */
export function extractMermaidSource(raw) {
  const m = raw.match(/```mermaid\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : '';
}

export function expandLeadingTabs(line) {
  const m = line.match(/^(\t*)(.*)$/);
  if (!m) return line;
  return '  '.repeat(m[1].length) + m[2];
}

/** 从 mindmap 行尾提取可读标签（root((…))、id["…"]、纯文本） */
export function extractMindmapNodeLabel(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const rootM = /^root\s*\(\(([\s\S]*?)\)\)\s*$/i.exec(trimmed);
  if (rootM) return rootM[1].trim();
  const br = /^[\w$][\w\d$]*\["([\s\S]*)"\]\s*$/i.exec(trimmed);
  if (br) return br[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const sq = /^[\w$][\w\d$]*\['([\s\S]*)'\]\s*$/i.exec(trimmed);
  if (sq) return sq[1].replace(/\\'/g, "'");
  const dbl = /^\(\(([\s\S]*?)\)\)\s*$/.exec(trimmed);
  if (dbl) return dbl[1].trim();
  return trimmed;
}

function sanitizeMarkmapLabel(label) {
  return String(label || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 从 flowchart / graph 定义中抽取节点文案，生成 Markmap 可用的扁平大纲（兜底）。 */
export function flowchartOrGraphToOutlineMd(definition) {
  const s = (definition || '').trim();
  if (!s) return null;
  const lines = s.split('\n');
  const gi = lines.findIndex((l) => /^\s*(flowchart|graph)\s+(TD|LR|TB|BT|RL)\b/i.test(l.trim()));
  if (gi < 0) return null;
  const seen = new Set();
  const labels = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('%%')) continue;
    const re = /\b([A-Za-z0-9_]+)\s*[\[(]([^\])]{1,200})[\])]/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      let lab = m[2].trim().replace(/<br\s*\/?>/gi, ' ');
      lab = lab.replace(/^\s*["']|["']\s*$/g, '');
      if (lab.length < 2 || lab.length > 160) continue;
      if (/^(end|subgraph|style|class|direction|click|linkStyle|accTitle|title)\b/i.test(lab)) continue;
      if (seen.has(lab)) continue;
      seen.add(lab);
      labels.push(lab);
    }
  }
  if (labels.length < 2) return null;
  const bullets = labels.slice(0, 48).map((l) => `- ${sanitizeMarkmapLabel(l)}`);
  return `# 知识结构\n\n${bullets.join('\n')}`;
}

/** 去掉围栏后，用正文中的 Markdown 标题生成大纲（无 mindmap 时的兜底）。 */
export function markdownHeadingsToOutlineMd(fullMarkdown) {
  const plain = String(fullMarkdown || '').replace(/```[\s\S]*?```/g, '\n');
  const heads = [];
  for (const line of plain.split(/\n/)) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    heads.push({ depth: m[1].length, text });
  }
  if (heads.length < 2) return null;
  if (heads.every((h) => h.depth === 1)) {
    return `# 知识结构\n\n${heads.map((h) => `- ${sanitizeMarkmapLabel(h.text)}`).join('\n')}`;
  }
  return heads.map((h) => `${'#'.repeat(Math.min(6, h.depth))} ${sanitizeMarkmapLabel(h.text)}`).join('\n');
}

const MARKMAP_ROW_CAP = 100;

/**
 * 将 Mermaid mindmap 定义转为 Markmap 友好的 Markdown：单一 `#` 根标题 + 嵌套无序列表。
 * Markmap 对「多个并列 # / ##」解析易挤成一团；列表 + 缩进层级更稳定。
 */
export function mermaidDefinitionToOutlineMd(definition) {
  const s = (definition || '').trim();
  const lines = s.split('\n');
  const mi = lines.findIndex((l) => /^\s*mindmap\b/i.test(l.trim()));
  if (mi < 0) return null;

  const body = lines.slice(mi + 1).map(expandLeadingTabs);
  const rows = [];
  for (const line of body) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)(.+)$/);
    if (!m) continue;
    let sp = m[1].length;
    if (sp % 2 === 1) sp += 1;
    const label = extractMindmapNodeLabel(m[2]);
    if (!label) continue;
    rows.push({ sp, label });
  }
  if (!rows.length) return null;
  if (rows.length > MARKMAP_ROW_CAP) rows.length = MARKMAP_ROW_CAP;

  const minSp = Math.min(...rows.map((r) => r.sp));
  const topSiblings = rows.filter((r) => r.sp === minSp).length;
  const firstTopIdx = rows.findIndex((r) => r.sp === minSp);
  const rootTitle =
    topSiblings > 1 ? '知识结构' : sanitizeMarkmapLabel(rows[firstTopIdx]?.label || '知识结构');

  const out = [`# ${rootTitle}`, ''];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (topSiblings === 1 && i === firstTopIdx) continue;
    const rel = Math.max(0, (row.sp - minSp) / 2);
    const listDepth = topSiblings > 1 ? rel : Math.max(0, rel - 1);
    const indent = '  '.repeat(listDepth);
    out.push(`${indent}- ${sanitizeMarkmapLabel(row.label)}`);
  }
  return out.join('\n');
}

export function markdownToMarkmapOutline(fullMarkdown) {
  const inner = extractMermaidSource(fullMarkdown);
  if (inner) {
    const o = mermaidDefinitionToOutlineMd(inner);
    if (o) return o;
    const fc = flowchartOrGraphToOutlineMd(inner);
    if (fc) return fc;
  }
  if (/^\s*mindmap\b/im.test(fullMarkdown || '')) {
    const o = mermaidDefinitionToOutlineMd(fullMarkdown.trim());
    if (o) return o;
  }
  const heads = markdownHeadingsToOutlineMd(fullMarkdown);
  if (heads) return heads;
  return null;
}
