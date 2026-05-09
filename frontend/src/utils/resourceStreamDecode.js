/**
 * 模型偶发把整段 Markdown 包进 JSON（或双引号字符串）里输出，导致界面出现 \n、\"。
 * 「代码实操」还可能输出 `json { ... }` 或 ```json { "任务描述": ... } ```，此处展开为标准 Markdown。
 * 练习包 JSON 数组不要走本文件的展开逻辑（由调用方只对非 practice 使用）。
 */

function tryParseJsonField(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = ['markdown', 'content', 'text', 'body', 'answer', 'message', 'output', 'data'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 2) return v;
  }
  return null;
}

/** 是否为「代码实操」那种中文字段 JSON 对象 */
function looksLikeCodeLabJsonObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Object.keys(obj).some((k) =>
    /任务描述|环境假设|分步思路|完整可运行|示例代码|常见错误|调试|代码说明|运行示例/i.test(k)
  );
}

function stripLeadingJsonKeyword(t) {
  return t.replace(/^\s*json\s*/im, '').trim();
}

/** 将代码实操 JSON 对象转为 Markdown 章节（便于 ChatLikeMarkdown 渲染） */
export function codeLabJsonObjectToMarkdown(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const order = [
    '任务描述',
    '环境假设',
    '分步思路',
    '完整可运行示例代码',
    '示例代码',
    '代码',
    '常见错误',
    '常见错误与调试提示',
    '调试提示',
  ];
  const used = new Set();
  const parts = [];

  const emit = (key, val) => {
    if (val == null) return;
    let str = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    str = str.trim();
    if (!str) return;
    const codeish =
      /代码|示例|python|程序/i.test(key) ||
      (/^\s*(import |from |def |class |#|if __name__)/m.test(str) && str.includes('\n'));
    if (codeish) {
      const lang = /python|pytorch|numpy/i.test(str) ? 'python' : 'text';
      parts.push(`## ${key}\n\n\`\`\`${lang}\n${str}\n\`\`\`\n\n`);
    } else {
      parts.push(`## ${key}\n\n${str}\n\n`);
    }
    used.add(key);
  };

  for (const k of order) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && !used.has(k)) emit(k, obj[k]);
  }
  for (const k of Object.keys(obj)) {
    if (!used.has(k)) emit(k, obj[k]);
  }
  return parts.join('').trim();
}

function tryParseCodeLabJsonString(inner) {
  let t = stripLeadingJsonKeyword(String(inner || '').trim());
  if (!t.startsWith('{')) return null;
  try {
    const obj = JSON.parse(t);
    if (!looksLikeCodeLabJsonObject(obj)) return null;
    return codeLabJsonObjectToMarkdown(obj);
  } catch {
    return null;
  }
}

/** 把正文里的 ```json … ``` 若为代码实操结构则替换为 Markdown（不误伤 ```python 等围栏） */
function expandEmbeddedJsonFences(s) {
  return s.replace(/```json\s*([\s\S]*?)```/gi, (full, inner) => {
    const md = tryParseCodeLabJsonString(inner);
    return md ? `${md}\n\n` : full;
  });
}

/** 整段为 json { … } 或纯 { … } 且为代码实操结构 */
function expandWholeStringJson(s) {
  let t = String(s || '').trim();
  if (!t) return null;
  const hl = Math.floor(t.length / 2);
  if (hl > 20 && t.slice(0, hl) === t.slice(hl)) t = t.slice(0, hl).trim();
  t = stripLeadingJsonKeyword(t);
  if (t.startsWith('"')) {
    try {
      const inner = JSON.parse(t);
      if (typeof inner === 'string') return expandWholeStringJson(inner);
    } catch {
      return null;
    }
  }
  if (!t.startsWith('{')) return null;

  const md = tryParseCodeLabJsonString(t);
  if (md) return md;

  try {
    const obj = JSON.parse(t);
    const inner = tryParseJsonField(obj);
    if (inner) return inner;
  } catch {
    /* ignore */
  }
  return null;
}

function decodeJsonEnvelope(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s.trim()) return s;

  const t = s.trim();
  if (t.startsWith('"')) {
    try {
      const inner = JSON.parse(t);
      if (typeof inner === 'string' && inner.includes('\n')) return inner;
    } catch {
      /* ignore */
    }
  }
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t);
      const inner = tryParseJsonField(obj);
      if (inner) return inner;
    } catch {
      /* ignore */
    }
  }
  return s;
}

/**
 * 资源流展示用：解包 JSON 信封 + 展开代码实操 JSON + 展开正文内 json 围栏。
 */
export function decodeResourceMarkdownStream(raw) {
  let s = typeof raw === 'string' ? raw : '';
  if (!s.trim()) return s;

  s = decodeJsonEnvelope(s);

  const whole = expandWholeStringJson(s);
  if (whole) return expandEmbeddedJsonFences(whole);

  const expanded = expandEmbeddedJsonFences(s);
  if (expanded !== s) return expanded;

  return s;
}
