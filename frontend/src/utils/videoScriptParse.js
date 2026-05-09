import { decodeResourceMarkdownStream } from './resourceStreamDecode';

function dedupeEcho(s) {
  const t = String(s || '').trim();
  if (!t) return t;
  const hl = Math.floor(t.length / 2);
  if (hl > 20 && t.slice(0, hl) === t.slice(hl)) return t.slice(0, hl).trim();
  return t;
}

function stripJsonKeyword(t) {
  return String(t || '').replace(/^\s*json\s*/i, '').trim();
}

/** 从文本中尝试解析出 JSON 对象（支持 json 前缀、整段 ```json 围栏、内嵌围栏）。 */
function tryParseJsonObjectFromText(text) {
  let s = dedupeEcho(String(text || '').trim());
  const bodies = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().length > 2) bodies.push(fence[1].trim());
  const wholeFence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (wholeFence && wholeFence[1].trim().length > 2) bodies.push(wholeFence[1].trim());
  bodies.push(s);

  const seen = new Set();
  for (let body of bodies) {
    const key = body.slice(0, 240);
    if (seen.has(key)) continue;
    seen.add(key);
    body = stripJsonKeyword(body);
    if (body.startsWith('"')) {
      try {
        const inner = JSON.parse(body);
        if (typeof inner === 'string') body = inner.trim();
        else continue;
      } catch {
        continue;
      }
    }
    if (!body.startsWith('{')) continue;
    try {
      return JSON.parse(body);
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** 从含杂讯的正文中截取第一层平衡花括号并 JSON.parse（流式前后缀、说明文字等）。 */
function tryParseBalancedObject(s) {
  const t = String(s || '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function pickShotsArray(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = ['分镜表', '分镜头表', '分镜', 'storyboard', 'shots', 'scenes'];
  for (const k of keys) {
    if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
  }
  if (obj.data && typeof obj.data === 'object') {
    for (const k of keys) {
      if (Array.isArray(obj.data[k]) && obj.data[k].length) return obj.data[k];
    }
  }
  return null;
}

function buildShotMarkdown(r) {
  const parts = [];
  if (r.duration) parts.push(`**时长建议**：${r.duration}`);
  if (r.visual) parts.push(`### 画面 / 板书要点\n\n${r.visual}`);
  if (r.voice) parts.push(`### 口播稿\n\n${r.voice}`);
  return parts.join('\n\n').trim() || `### ${r.title}\n\n（本条暂无正文）`;
}

function rowToShot(row, idx) {
  if (!row || typeof row !== 'object') return null;
  const shotNo = row['镜号'] ?? row['镜头号'] ?? row['序号'] ?? idx + 1;
  const visual = String(row['画面/板书要点'] ?? row['画面要点'] ?? row['画面'] ?? row['板书要点'] ?? '').trim();
  const voice = String(row['口播稿'] ?? row['口播'] ?? row['解说词'] ?? row['配音稿'] ?? '').trim();
  const duration = String(row['时长建议'] ?? row['时长'] ?? row['时间'] ?? '').trim();
  const name = String(row['镜头名称'] ?? row['标题'] ?? '').trim();
  const title = name ? name.slice(0, 72) : `镜号 ${shotNo}`;
  const r = { shotNo, title, duration, visual, voice };
  return {
    id: idx,
    shotNo,
    title,
    subtitle: duration,
    markdown: buildShotMarkdown(r),
  };
}

/**
 * 若正文为微课脚本 JSON（含分镜表），解析为结构化分镜；否则返回 null。
 * 兼容：`json { … }`、` ```json … ``` `、流式重复拼接。
 */
export function parseStructuredVideoScript(raw) {
  const chain = [raw, decodeResourceMarkdownStream(raw || '')];
  const seenSrc = new Set();
  for (const src of chain) {
    const sk = String(src || '').slice(0, 8000);
    if (!sk.trim() || seenSrc.has(sk)) continue;
    seenSrc.add(sk);
    let obj = tryParseJsonObjectFromText(src);
    if (!obj) obj = tryParseBalancedObject(stripJsonKeyword(dedupeEcho(String(src || ''))));
    if (!obj) continue;
    const table = pickShotsArray(obj);
    if (!table) continue;
    const shots = [];
    for (let i = 0; i < table.length; i++) {
      const shot = rowToShot(table[i], i);
      if (shot) shots.push(shot);
    }
    if (!shots.length) continue;
    const meta = {
      title: String(obj['微课标题'] ?? obj['标题'] ?? obj['title'] ?? '').trim(),
      chapter: String(obj['所属章节'] ?? obj['章节'] ?? '').trim(),
      totalDuration: String(obj['建议总时长'] ?? obj['总时长'] ?? '').trim(),
    };
    return { meta, shots };
  }
  return null;
}
