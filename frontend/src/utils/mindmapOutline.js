const MERMAID_START_RE = /^\s*(mindmap|flowchart|graph)\b/i;
const MARKMAP_ROW_CAP = 120;

/** Extract Mermaid source from Markdown; supports ```/~~~, attrs, open fences, and raw source. */
export function extractMermaidSource(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const fencedRe = /(```|~~~)\s*mermaid[^\n]*\n([\s\S]*?)\1/gi;
  let fenced;
  while ((fenced = fencedRe.exec(text)) !== null) {
    if (fenced?.[2]?.trim()) return fenced[2].trim();
  }

  const openFence = text.match(/(?:```|~~~)\s*mermaid[^\n]*\n([\s\S]*)$/i);
  if (openFence?.[1]?.trim()) return openFence[1].trim();

  const lines = text.split(/\n/);
  const start = lines.findIndex((line) => MERMAID_START_RE.test(line));
  if (start >= 0) {
    const picked = [];
    for (const line of lines.slice(start)) {
      if (/^\s*(```|~~~)/.test(line)) break;
      picked.push(line);
    }
    return picked.join('\n').trim();
  }

  return '';
}

export function expandLeadingTabs(line) {
  const match = String(line || '').match(/^(\t*)(.*)$/);
  if (!match) return line;
  return '  '.repeat(match[1].length) + match[2];
}

function stripMermaidDecorators(text) {
  return String(text || '')
    .replace(/:::.*$/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

/** Extract a readable label from Mermaid mindmap nodes: root((...)), id["..."], ((...)), (...) and plain text. */
export function extractMindmapNodeLabel(text) {
  let trimmed = stripMermaidDecorators(text);
  if (!trimmed) return '';

  const rootM = /^root\s*\(\(([\s\S]*?)\)\)\s*$/i.exec(trimmed);
  if (rootM) return rootM[1].trim();

  const bracketM = /^[\w$][\w\d$-]*\s*(?:\[\s*["']?([\s\S]*?)["']?\s*\]|\(\s*["']?([\s\S]*?)["']?\s*\)|\{\s*["']?([\s\S]*?)["']?\s*\})\s*$/i.exec(trimmed);
  if (bracketM) return (bracketM[1] || bracketM[2] || bracketM[3] || '').trim();

  const doubleCircleM = /^\(\(([\s\S]*?)\)\)\s*$/.exec(trimmed);
  if (doubleCircleM) return doubleCircleM[1].trim();

  const singleCircleM = /^\(([\s\S]*?)\)\s*$/.exec(trimmed);
  if (singleCircleM) return singleCircleM[1].trim();

  trimmed = trimmed.replace(/^\s*root\s+/i, '').trim();
  return trimmed;
}

function sanitizeMarkmapLabel(label) {
  return String(label || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/->/g, '→')
    .replace(/=>/g, '⇒')
    .replace(/[`*_~#[\]<>]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeMindmapRows(lines) {
  const rawRows = [];

  for (const original of lines) {
    const line = expandLeadingTabs(original).replace(/\s+$/g, '');
    if (!line.trim() || /^\s*%%/.test(line)) continue;
    const match = line.match(/^(\s*)(.+)$/);
    if (!match) continue;

    const label = sanitizeMarkmapLabel(extractMindmapNodeLabel(match[2]));
    if (!label || /^(direction|classDef|class|style|linkStyle)\b/i.test(label)) continue;
    rawRows.push({ sp: match[1].length, label });
  }

  if (!rawRows.length) return [];

  const sortedIndents = [...new Set(rawRows.map((row) => row.sp))].sort((a, b) => a - b);
  const indentRank = new Map(sortedIndents.map((sp, index) => [sp, index]));
  return rawRows.slice(0, MARKMAP_ROW_CAP).map((row) => ({
    depth: indentRank.get(row.sp) || 0,
    label: row.label,
  }));
}

/** Convert Mermaid mindmap definition into Markmap-friendly Markdown. */
export function mermaidDefinitionToOutlineMd(definition) {
  const source = String(definition || '').trim();
  if (!source) return null;

  const lines = source.split(/\n/);
  const mindmapIndex = lines.findIndex((line) => /^\s*mindmap\b/i.test(line.trim()));
  if (mindmapIndex < 0) return null;

  const rows = normalizeMindmapRows(lines.slice(mindmapIndex + 1));
  if (!rows.length) return null;

  const rootIndex = rows.findIndex((row) => row.depth === 0);
  const root = rows[rootIndex] || rows[0];
  const rootTitle = sanitizeMarkmapLabel(root?.label || '知识导图') || '知识导图';
  const hasExplicitRoot = rootIndex >= 0;

  const out = [`# ${rootTitle}`, ''];
  rows.forEach((row, index) => {
    if (hasExplicitRoot && index === rootIndex) return;
    const listDepth = hasExplicitRoot ? Math.max(0, row.depth - root.depth - 1) : row.depth;
    out.push(`${'  '.repeat(listDepth)}- ${row.label}`);
  });

  return out.length > 2 ? out.join('\n') : null;
}

/** Extract node labels from flowchart / graph definitions as a fallback. */
export function flowchartOrGraphToOutlineMd(definition) {
  const source = String(definition || '').trim();
  if (!source) return null;

  const lines = source.split(/\n/);
  const graphIndex = lines.findIndex((line) => /^\s*(flowchart|graph)\s+(TD|LR|TB|BT|RL)\b/i.test(line.trim()));
  if (graphIndex < 0) return null;

  const seen = new Set();
  const labels = [];
  const nodeRe = /\b([A-Za-z0-9_]+)\s*(?:\[\s*["']?([^\]"']{1,200})["']?\s*\]|\(\s*["']?([^\)"']{1,200})["']?\s*\)|\{\s*["']?([^}"']{1,200})["']?\s*\})/g;

  for (const line of lines.slice(graphIndex + 1)) {
    const text = line.trim();
    if (!text || text.startsWith('%%')) continue;
    let match;
    while ((match = nodeRe.exec(text)) !== null) {
      const label = sanitizeMarkmapLabel(match[2] || match[3] || match[4] || '');
      if (label.length < 2 || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
  }

  if (labels.length < 2) return null;
  return `# 知识导图\n\n${labels.slice(0, 48).map((label) => `- ${label}`).join('\n')}`;
}

/** Fallback: generate a Markmap outline from Markdown headings. */
export function markdownHeadingsToOutlineMd(fullMarkdown) {
  const plain = String(fullMarkdown || '').replace(/(```|~~~)[\s\S]*?\1/g, '\n');
  const headings = [];

  for (const line of plain.split(/\n/)) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const text = sanitizeMarkmapLabel(match[2]);
    if (text) headings.push({ depth: match[1].length, text });
  }

  if (headings.length < 2) return null;
  if (headings.every((heading) => heading.depth === 1)) {
    return `# 知识导图\n\n${headings.map((heading) => `- ${heading.text}`).join('\n')}`;
  }

  return headings.map((heading) => `${'#'.repeat(Math.min(6, heading.depth))} ${heading.text}`).join('\n');
}

/** Fallback: generate a Markmap outline from a normal Markdown bullet list. */
export function markdownListsToOutlineMd(fullMarkdown) {
  const plain = String(fullMarkdown || '').replace(/(```|~~~)[\s\S]*?\1/g, '\n');
  const lines = plain.split(/\n/);
  const heading = lines.find((line) => /^#{1,6}\s+/.test(line));
  const rootTitle = sanitizeMarkmapLabel(heading?.replace(/^#{1,6}\s+/, '') || '知识导图') || '知识导图';
  const rows = [];

  for (const original of lines) {
    const line = expandLeadingTabs(original).replace(/\s+$/g, '');
    const match = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (!match) continue;
    const label = sanitizeMarkmapLabel(match[2]);
    if (!label) continue;
    rows.push({ sp: match[1].length, label });
  }

  if (rows.length < 2) return null;
  const sortedIndents = [...new Set(rows.map((row) => row.sp))].sort((a, b) => a - b);
  const indentRank = new Map(sortedIndents.map((sp, index) => [sp, index]));
  const out = [`# ${rootTitle}`, ''];
  rows.slice(0, MARKMAP_ROW_CAP).forEach((row) => {
    const depth = indentRank.get(row.sp) || 0;
    out.push(`${'  '.repeat(depth)}- ${row.label}`);
  });
  return out.join('\n');
}

export function markdownToMarkmapOutline(fullMarkdown) {
  const markdown = String(fullMarkdown || '');
  const inner = extractMermaidSource(markdown);

  if (inner) {
    const mindmap = mermaidDefinitionToOutlineMd(inner);
    if (mindmap) return mindmap;
    const flowchart = flowchartOrGraphToOutlineMd(inner);
    if (flowchart) return flowchart;
  }

  if (/^\s*mindmap\b/im.test(markdown)) {
    const mindmap = mermaidDefinitionToOutlineMd(markdown.trim());
    if (mindmap) return mindmap;
  }

  if (/^\s*(flowchart|graph)\s+(TD|LR|TB|BT|RL)\b/im.test(markdown)) {
    const flowchart = flowchartOrGraphToOutlineMd(markdown.trim());
    if (flowchart) return flowchart;
  }

  const headings = markdownHeadingsToOutlineMd(markdown);
  if (headings) return headings;

  const lists = markdownListsToOutlineMd(markdown);
  if (lists) return lists;

  return null;
}
