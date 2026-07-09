// Shared Markdown math cleanup used by chat, resources, and modal readers.
// It keeps authored Markdown intact while repairing the common model output
// pattern where short math symbols are emitted as separate lines.

const mathFencePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const delimitedMathPattern = /(\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]+?\$(?!\$))/g;

const blockLike = /^\s*(#{1,6}\s|[-*+]\s+|\d+\.\s+|>|```|~~~|\|)/;
const listItemLike = /^\s*(?:[-*+]\s+|\d+\.\s+)/;
const connectorOnly = /^[,，.。;；:：()（）[\]{}=<>+\-*/|]+$/;
const mathSymbolOnly =
  /^(?=.{1,28}$)(?!.*[\p{Script=Han}，。！？、；：])[\p{Letter}\p{Number}_{}^\\+\-*/=<>|.,()[\]∅∞∈∉⊂⊆⊃⊇∪∩∘°±√]+$/u;
const looseMathExpression =
  /^(?=.{1,56}$)(?!.*[\p{Script=Han}，。！？、；：])[\p{Letter}\p{Number}\s_{}^\\+\-*/=<>|.,()[\]∅∞∈∉⊂⊆⊃⊇∪∩∘°±√]+$/u;

const cleanMathBody = (value) => {
  const body = String(value || '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body || body.length > 96 || /\\begin|\\\\/.test(body)) return null;
  if (/[\p{Script=Han}，。！？、；：]/u.test(body)) return null;
  if (!/[\p{Letter}\p{Number}\\∅∞∈∉⊂⊆⊃⊇∪∩∘°±√]/u.test(body)) return null;
  return body;
};

const inlineMathPart = (value) => {
  const part = String(value || '').trim();
  const inlineMatch = part.match(/^\s*\$(?!\$)([\s\S]{1,160}?)\$(?!\$)\s*$/);
  if (inlineMatch) {
    const body = cleanMathBody(inlineMatch[1]);
    return body ? `$${body}$` : part;
  }
  const wrappedMatch = part.match(/^\s*(\$\$|\$)([\s\S]{1,160}?)\1\s*$/);
  if (wrappedMatch) {
    const body = cleanMathBody(wrappedMatch[2]);
    return body ? `$${body}$` : null;
  }
  const body = cleanMathBody(part);
  if (/^\d{1,4}(?:[.)]|\u3001|\uff0e)$/.test(body || '')) return null;
  if (body && (mathSymbolOnly.test(body) || looseMathExpression.test(body))) return `$${body}$`;
  return null;
};

const isDetachedMathLine = (line) => {
  const value = String(line || '').trim();
  if (!value || blockLike.test(value)) return false;
  if (value.length > 42 || /[\p{Script=Han}，。！？、；：]/u.test(value)) return false;
  return Boolean(inlineMathPart(value) || connectorOnly.test(value));
};

const joinMathRun = (lines) => {
  const joined = lines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[，]/g, ',')
    .replace(/\s+([,，.。;；:：)\]}])/g, '$1')
    .replace(/([(（[{])\s+/g, '$1')
    .replace(/([\p{Letter}\p{Number}_])\s+\(/gu, '$1(')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
  const body = cleanMathBody(joined);
  return body ? `$${body}$` : joined;
};

const collapseDetachedMathRuns = (value) => {
  const lines = String(value || '').split('\n');
  const out = [];
  let run = [];
  let blanks = 0;

  const flushRun = () => {
    if (!run.length) return;
    const collapsed = run.length >= 2 ? joinMathRun(run) : inlineMathPart(run[0]) || run[0].trim();
    out.push(collapsed);
    run = [];
    blanks = 0;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (run.length) {
        blanks += 1;
        if (blanks <= 2) continue;
        flushRun();
      }
      out.push('');
      continue;
    }
    if (isDetachedMathLine(line)) {
      run.push(line);
      blanks = 0;
      continue;
    }
    flushRun();
    out.push(raw);
  }
  flushRun();

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([^\n])\n(\$[^$\n]{1,120}\$)\n([^\n])/g, '$1 $2 $3')
    .replace(/([^\n])\n(\$[^$\n]{1,120}\$)(?=\n|$)/g, '$1 $2')
    .replace(/(^|\n)(\$[^$\n]{1,120}\$)\n([^\n])/g, '$1$2 $3');
};

const combineAdjacentInlineMath = (value) => {
  let next = value;
  for (let i = 0; i < 6; i += 1) {
    const prev = next;
    next = next
      .replace(/\$([^$\n]+?)\$\s*([,，;；:：])\s*\$([^$\n]+?)\$/g, (_, a, op, b) => {
        if (a.trim() === b.trim()) return `$${a.trim()}$ ${op} $${b.trim()}$`;
        return `$${a.trim()}${op} ${b.trim()}$`;
      })
      .replace(
        /\$([^$\n]+?)\$\s+([=+\-*/<>|∈∉⊂⊆⊃⊇∪∩∘±])\s+\$([^$\n]+?)\$/g,
        (_, a, op, b) => {
          if (a.trim() === b.trim()) return `$${a.trim()}$ ${op} $${b.trim()}$`;
          return `$${a.trim()} ${op} ${b.trim()}$`;
        },
      )
      .replace(/\$([^$\n]+?)\$\s+\$([^$\n]+?)\$/g, (_, a, b) => {
        if (a.trim() === b.trim()) return `$${a.trim()}$ $${b.trim()}$`;
        return `$${a.trim()} ${b.trim()}$`;
      });
    if (next === prev) break;
  }
  return next;
};

const compactInlineMathParagraphs = (value) => {
  let next = value;
  const inlineMath = String.raw`\$[^$\n]{1,120}\$`;
  const beforeInline = new RegExp(String.raw`([^\n])\n{2,}(${inlineMath})(?=\s+[^\n]|\n{2,}[^\n]|$)`, 'g');
  const afterInline = new RegExp(String.raw`(${inlineMath})\n{2,}([^\n#>*+\-\d])`, 'g');
  const aroundInline = new RegExp(String.raw`([^\n])\n{2,}(${inlineMath})\n{2,}([^\n#>*+\-\d])`, 'g');
  for (let i = 0; i < 5; i += 1) {
    const prev = next;
    next = next
      .replace(aroundInline, '$1 $2 $3')
      .replace(beforeInline, '$1 $2')
      .replace(afterInline, '$1 $2')
      .replace(/\s+([,，.。;；:：])/g, '$1')
      .replace(/([(（[{])\s+/g, '$1');
    if (next === prev) break;
  }
  return next;
};

const tidyInlineMath = (value) =>
  String(value || '').replace(/\$([^$\n]{1,160})\$/g, (_, body) => {
    const cleaned = String(body || '')
      .replace(/[，]/g, ',')
      .replace(/\s+([,.;:)\]}])/g, '$1')
      .replace(/([(（[{])\s+/g, '$1')
      .replace(/([\p{Letter}\p{Number}_])\s+\(/gu, '$1(')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/\s+/g, ' ')
      .trim();
    return `$${cleaned}$`;
  });

const embeddedEquationPattern =
  /(^|[^$\w\\])([A-Za-z]\s*=\s*(?:\\pm\s*)?(?:\\sqrt\{[^{}\n]+\}|[A-Za-z0-9]+(?:\s*\^\s*(?:\{[^{}\n]+\}|[-+A-Za-z0-9]+))?))(?=$|[\s\u3002\uff0c\uff1b\uff1a,;:])/gm;
const embeddedRelationPattern =
  /(^|[^$\w\\])([A-Za-z]\s*(?:\\ge|\\le|>=|<=|\u2265|\u2264|>|<)\s*-?\d+(?:\.\d+)?)(?=$|[\s\u3002\uff0c\uff1b\uff1a,;:])/gm;

const repairLooseMathMarkup = (value) =>
  String(value || '')
    // This function only receives text outside a complete math region, so
    // remaining display markers are unmatched model output.
    .replace(/\$\$/g, '')
    .replace(embeddedEquationPattern, (_, lead, expression) => `${lead}$${expression.trim()}$`)
    .replace(embeddedRelationPattern, (_, lead, expression) => {
      const normalized = expression
        .replace(/\u2265|>=/g, String.raw`\ge `)
        .replace(/\u2264|<=/g, String.raw`\le `)
        .replace(/\s+/g, ' ')
        .trim();
      return `${lead}$${normalized}$`;
    });

const mergeLooseInlineMath = (chunk) => {
  const prepared = collapseDetachedMathRuns(repairLooseMathMarkup(chunk)).replace(
    /(^|\n)\s*\$\$\s*([\s\S]{1,160}?)\s*\$\$\s*(?=\n|$)/g,
    (match, lead, body) => {
      const expr = cleanMathBody(body);
      if (!expr) return match;
      return `${lead}$${expr}$`;
    },
  );
  const parts = prepared.split(/\n{2,}/);
  const out = [];
  let mergeNext = false;

  const joinSoftBreaks = (value) => {
    const trimmed = value.trim();
    const containsSplitListMarker = value
      .split('\n')
      .some((line) => listItemLike.test(line) || /^\s*\d+\.\s*$/.test(line));
    return blockLike.test(trimmed) || containsSplitListMarker
      ? trimmed
      : trimmed.replace(/[ \t]*\n[ \t]*/g, ' ');
  };

  for (let i = 0; i < parts.length; i += 1) {
    const part = joinSoftBreaks(parts[i]);
    if (!part) continue;

    const prev = out[out.length - 1] || '';
    const mathPart = inlineMathPart(part);
    const prevCanAcceptInline = prev && (!blockLike.test(prev) || listItemLike.test(prev));
    const canMergeMath = mathPart && prevCanAcceptInline;
    const canContinueMathPhrase = mergeNext && !blockLike.test(part);

    if (canMergeMath || canContinueMathPhrase) {
      out[out.length - 1] = `${prev.replace(/\s+$/, '')} ${mathPart || part}`;
      mergeNext = canMergeMath || Boolean(mathPart) || connectorOnly.test(part.trim());
    } else {
      out.push(part);
      mergeNext = false;
    }
  }

  return tidyInlineMath(compactInlineMathParagraphs(combineAdjacentInlineMath(out.join('\n\n'))));
};

const normalizeOutsideDelimitedMath = (chunk) => {
  const normalized = String(chunk || '')
    .split(delimitedMathPattern)
    .map((part) => {
      if (
        (/^\$\$[\s\S]*\$\$$/.test(part) || /^\$(?!\$)[^$\n]+\$(?!\$)$/.test(part)) &&
        part.length >= 3
      ) {
        const inner = part.replace(/^\$\$|\$\$$/g, '');
        if (/[\p{Script=Han}，。！？、；：]/u.test(inner)) {
          return mergeLooseInlineMath(part);
        }
        return part;
      }
      return mergeLooseInlineMath(part);
    })
    .join('');
  return normalized.replace(/(^|\n)(\s*\d+\.)\$(?!\$)/g, '$1$2 $');
};

export function normalizeMathText(text) {
  if (!text) return text;

  let t = String(text).replace(/\r\n?/g, '\n').replace(/\u2028|\u2029/g, '\n');

  t = t
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim()}$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m.trim()}$$`);

  t = t.replace(/`([^`]*?(?:\\frac|\\lim|\\sum|\\int|\\sqrt|\\to|=|\^|_)[^`]*)`/g, (_, m) => m);

  const displayMarkerCount = t.match(/\$\$/g)?.length || 0;
  if (displayMarkerCount % 2 !== 0) {
    t = t.replace(/\$\$/g, '');
  }

  t = t.replace(/\$\$([^\n$]{1,200}?)\$\$/g, (match, body) => {
    if (/[\p{Script=Han}，。！？、；：]/u.test(body)) {
      return body.trim();
    }
    return match;
  });

  for (let i = 0; i < 3; i += 1) {
    const next = t
      .replace(
        /(\\frac\{[^{}\n]+\}\{[^{}\n]+\}|\\sqrt\{[^{}\n]+\}|\\(?:lim|sum|int)[^$\n]{0,80})\$\1/g,
        (_, m) => `$${m}$`,
      )
      .replace(/(\\frac\{[^{}\n]+\})\$\1/g, (_, m) => m);
    if (next === t) break;
    t = next;
  }

  return t
    .split(mathFencePattern)
    .map((chunk) => (/^(```|~~~)/.test(chunk) ? chunk : normalizeOutsideDelimitedMath(chunk)))
    .join('');
}
