import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { markdownRemarkPlugins, markdownRehypePlugins } from '../markdownMathSetup';
import 'katex/dist/katex.min.css';

/** 与主对话区 AI 气泡内相同的数学预处理 */
export function normalizeMathText(text) {
  if (!text) return text;
  let t = String(text).replace(/\r\n?/g, '\n').replace(/\u2028|\u2029/g, '\n');
  t = t
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim()}$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m.trim()}$$`);
  t = t.replace(
    /`([^`]*?(?:\\frac|\\lim|\\sum|\\int|\\sqrt|\\to|=|\^|_)[^`]*)`/g,
    (_, m) => m
  );
  for (let i = 0; i < 3; i += 1) {
    const next = t
      .replace(
        /(\\frac\{[^{}\n]+\}\{[^{}\n]+\}|\\sqrt\{[^{}\n]+\}|\\(?:lim|sum|int)[^$\n]{0,80})\$\1/g,
        (_, m) => `$${m}$`
      )
      .replace(/(\\frac\{[^{}\n]+\})\$\1/g, (_, m) => m);
    if (next === t) break;
    t = next;
  }

  const inlineMathOnly = /^\s*\$(?!\$)([\s\S]{1,160}?)\$(?!\$)\s*$/;
  const mathOnly = /^\s*(\$\$|\$)([\s\S]{1,160}?)\1\s*$/;
  const blockLike = /^\s*(#{1,6}\s|[-*+]\s+|\d+\.\s+|>|```|~~~|\|)/;
  const listItemLike = /^\s*(?:[-*+]\s+|\d+\.\s+)/;
  const connectorOnly = /^[,，.。;；:：()（）[\]{}=<>+\-*/|]+$/;
  const mathSymbolOnly =
    /^(?=.{1,28}$)(?!.*[\p{Script=Han}，。！？、；：])[\p{Letter}\p{Number}_{}^\\+\-*/=<>|.,()[\]∅∞∈∉⊂⊆⊃⊇∪∩∘°]+$/u;
  const looseMathExpression =
    /^(?=.{1,40}$)(?!.*[\p{Script=Han}，。！？、；：])[\p{Letter}\p{Number}\s_{}^\\+\-*/=<>|.,()[\]∅∞∈∉⊂⊆⊃⊇∪∩∘°]+$/u;
  const cleanMathBody = (value) => {
    const body = String(value).replace(/\s+/g, ' ').trim();
    if (!body || body.length > 80 || /\\begin|\\\\/.test(body)) return null;
    if (/[\p{Script=Han}，。！？、；：]/u.test(body)) return null;
    if (!/[\p{Letter}\p{Number}\\∅∞∈∉⊂⊆⊃⊇∪∩∘°]/u.test(body)) return null;
    return body;
  };
  const shortMathPart = (value) => {
    const match = String(value).trim().match(mathOnly);
    if (!match) return null;
    const body = cleanMathBody(match[2]);
    if (!body) return null;
    return `$${body}$`;
  };
  const inlineMathPart = (value) => {
    const part = String(value).trim();
    const inlineMatch = part.match(inlineMathOnly);
    if (inlineMatch) {
      const body = cleanMathBody(inlineMatch[1]);
      return body ? `$${body}$` : part;
    }
    const mathPart = shortMathPart(part);
    if (mathPart) return mathPart;
    const body = cleanMathBody(part);
    if (body && mathSymbolOnly.test(body)) return `$${body}$`;
    if (body && looseMathExpression.test(body)) return `$${body}$`;
    return null;
  };
  const combineAdjacentInlineMath = (value) => {
    let next = value;
    for (let i = 0; i < 6; i += 1) {
      const prev = next;
      next = next
        .replace(
          /\$([^$\n]+?)\$\s*([,，;；:：])\s*\$([^$\n]+?)\$/g,
          (_, a, op, b) => `$${a.trim()}${op} ${b.trim()}$`
        )
        .replace(
          /\$([^$\n]+?)\$\s+([=+\-*/<>|∈∉⊂⊆⊃⊇∪∩∘])\s+\$([^$\n]+?)\$/g,
          (_, a, op, b) => `$${a.trim()} ${op} ${b.trim()}$`
        )
        .replace(
          /\$([^$\n]+?)\$\s+\$([^$\n]+?)\$/g,
          (_, a, b) => `$${a.trim()} ${b.trim()}$`
        );
      if (next === prev) break;
    }
    return next;
  };
  const mergeLooseInlineMath = (chunk) => {
    const prepared = chunk.replace(
      /(^|\n)\s*\$\$\s*([\s\S]{1,160}?)\s*\$\$\s*(?=\n|$)/g,
      (match, lead, body) => {
        const expr = cleanMathBody(body);
        if (!expr) return match;
        return `${lead}$${expr}$`;
      }
    );
    const parts = prepared.split(/\n{2,}/);
    const out = [];
    let mergeNext = false;

    const joinSoftBreaks = (value) => {
      const trimmed = value.trim();
      return blockLike.test(trimmed) ? trimmed : trimmed.replace(/[ \t]*\n[ \t]*/g, ' ');
    };

    for (let i = 0; i < parts.length; i += 1) {
      const part = joinSoftBreaks(parts[i]);
      if (!part) continue;

      const next = joinSoftBreaks(parts[i + 1] || '');
      const prev = out[out.length - 1] || '';
      const inlinePart = inlineMathPart(part);
      const prevCanAcceptInline = prev && (!blockLike.test(prev) || listItemLike.test(prev));
      const canMergeMath =
        inlinePart &&
        prevCanAcceptInline;
      const canContinueMathPhrase = mergeNext && !blockLike.test(part);

      if (canMergeMath || canContinueMathPhrase) {
        out[out.length - 1] = `${prev.replace(/\s+$/, '')} ${inlinePart || part}`;
        mergeNext = canMergeMath || Boolean(inlinePart) || connectorOnly.test(part.trim());
      } else {
        out.push(part);
        mergeNext = false;
      }
    }

    return combineAdjacentInlineMath(out.join('\n\n'));
  };

  t = t
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((chunk) => (/^(```|~~~)/.test(chunk) ? chunk : mergeLooseInlineMath(chunk)))
    .join('');

  return t;
}

function CodeBlock({ language, value }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="relative group my-4">
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="absolute right-2 top-2 z-10 rounded-sm border border-[#1a1f24]/10 bg-white/90 px-2.5 py-1 text-[11px] font-medium tracking-wide text-[#1a1f24]/70 opacity-0 shadow-sm transition-opacity hover:bg-white group-hover:opacity-100"
      >
        {copied ? '已复制' : '复制'}
      </button>
      <SyntaxHighlighter
        style={oneLight}
        language={language}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: '1rem 1.1rem',
          background: '#f6f4ef',
          border: '1px solid rgba(26,31,36,0.1)',
          borderRadius: '12px',
          fontSize: '13px',
          lineHeight: 1.55,
        }}
        codeTagProps={{
          style: {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          },
        }}
        className="!m-0 shadow-sm"
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}

/**
 * 与 ChatView 中 AI 助手消息一致的 Markdown + 公式 + 代码块渲染。
 */
export default function ChatLikeMarkdown({ content, className = '' }) {
  return (
    <div
      className={`chat-prose prose prose-sm max-w-none prose-neutral text-[#1a1f24] break-words [word-break:normal] [overflow-wrap:break-word] prose-img:max-w-full ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={{
          code({ inline, className, children }) {
            const match = /language-(\w+)/.exec(className || '');
            return !inline && match ? (
              <CodeBlock language={match[1]} value={String(children).replace(/\n$/, '')} />
            ) : (
              <code className="rounded border border-[#1a1f24]/[0.08] bg-[#ebe8e0]/80 px-1.5 py-0.5 font-mono text-[0.9em] text-[#5c4a28]">{children}</code>
            );
          },
        }}
      >
        {normalizeMathText(content || '')}
      </ReactMarkdown>
    </div>
  );
}
