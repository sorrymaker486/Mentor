import React, { useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import ChatLikeMarkdown from './ChatLikeMarkdown';
import MindmapOutlineView from './MindmapOutlineView';
import { extractMermaidSource, expandLeadingTabs } from '../utils/mindmapOutline';
import { decodeResourceMarkdownStream } from '../utils/resourceStreamDecode';
import { parseStructuredVideoScript } from '../utils/videoScriptParse';

/** 学习工作室通用浮层外壳（固定尺寸，不可拖拽改窗体大小） */
export function ResizableStudioShell({ title, subtitle, onClose, children, footer }) {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[120] flex items-center justify-center bg-[#1a1f24]/40 p-3 backdrop-blur-[2px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="res-studio-title"
    >
      <button
        type="button"
        className="pointer-events-auto absolute inset-0 z-[1]"
        aria-label="关闭"
        onClick={onClose}
      />
      <div className="pointer-events-auto relative z-10 flex max-h-[min(88vh,900px)] w-[min(96vw,920px)] min-h-[280px] min-w-[min(96vw,320px)] flex-col overflow-hidden rounded-2xl border border-[#1a1f24]/[0.12] bg-[#faf9f7] shadow-[0_28px_80px_rgba(26,31,36,0.22)]">
        <div className="flex shrink-0 cursor-grab items-start justify-between gap-3 border-b border-[#1a1f24]/[0.08] bg-white/90 px-4 py-3 select-none active:cursor-grabbing sm:px-5">
          <div className="min-w-0">
            <h2 id="res-studio-title" className="font-display text-lg font-medium text-[#1a1f24]">
              {title}
            </h2>
            {subtitle && <p className="mt-1 truncate text-[11px] text-[#1a1f24]/45">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-[#1a1f24]/[0.1] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#1a1f24]/65 hover:border-[#b8955c]/45"
          >
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {footer && <div className="shrink-0 border-t border-[#1a1f24]/[0.06] bg-white/85 px-4 py-2">{footer}</div>}
      </div>
    </div>
  );
}

export function ChatDocResizableWindow({ open, title, subtitle, markdown, streaming, onClose, onCancel }) {
  if (!open) return null;
  return (
    <ResizableStudioShell title={title} subtitle={subtitle} onClose={onClose}>
      <div className="flex h-[min(72vh,640px)] min-h-[320px] flex-col">
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-[#1a1f24]/[0.05] bg-[#fdfcfa] px-4 py-2">
          {streaming && (
            <button type="button" onClick={onCancel} className="text-[11px] font-semibold text-red-700 hover:underline">
              停止生成
            </button>
          )}
          {streaming && (
            <span className="flex items-center gap-2 text-[11px] text-[#1a1f24]/45">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#1a1f24]/12 border-t-[#b8955c]" />
              流式输出中…
            </span>
          )}
        </div>
        <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto bg-white px-5 py-6 sm:px-8 sm:py-8">
          {markdown ? (
            <ChatLikeMarkdown content={markdown} />
          ) : (
            <p className="text-sm text-[#1a1f24]/40">{streaming ? '等待首字节…' : '暂无内容'}</p>
          )}
        </div>
      </div>
    </ResizableStudioShell>
  );
}

/**
 * Mermaid mindmap 只能有单一根节点；模型常生成多个同缩进顶层或奇数缩进导致「No parent」。
 * 先规整缩进，若存在多个顶层条目则自动包一层 root((知识结构))。
 */
function normalizeMindmapMermaid(chart) {
  const s = (chart || '').trim();
  if (!s) return chart;
  const lines = s.split('\n');
  const mi = lines.findIndex((l) => /^\s*mindmap\b/i.test(l.trim()));
  if (mi < 0) return chart;

  const head = lines.slice(0, mi + 1).map((l, i) => (i === mi ? 'mindmap' : l));
  const rawBody = lines.slice(mi + 1).map(expandLeadingTabs);

  const rows = [];
  for (const line of rawBody) {
    if (!line.trim()) {
      rows.push({ blank: true, raw: line });
      continue;
    }
    const m = line.match(/^(\s*)(.*)$/);
    const sp = (m[1] || '').length;
    let evenSp = sp;
    if (evenSp % 2 === 1) evenSp += 1;
    rows.push({ blank: false, sp: evenSp, rest: m[2], raw: `${' '.repeat(evenSp)}${m[2]}` });
  }

  const nonempty = rows.filter((r) => !r.blank);
  if (!nonempty.length) return [...head, ...rawBody].join('\n');

  const minSp = Math.min(...nonempty.map((r) => r.sp));
  const topSiblings = nonempty.filter((r) => r.sp === minSp);
  if (topSiblings.length <= 1) {
    return [...head, ...rows.map((r) => (r.blank ? r.raw : r.raw))].join('\n');
  }

  const wrapped = rows.map((r) => {
    if (r.blank) return r.raw;
    return `${' '.repeat(r.sp + 2)}${r.rest}`;
  });
  return [...head, '  root((知识结构))', ...wrapped].join('\n');
}

/** 渲染失败时兜底：统一包一层中心根节点（仍保持相对层次）。 */
function wrapMindmapWithFallbackRoot(chart) {
  const s = (chart || '').trim();
  if (!s) return chart;
  const lines = s.split('\n');
  const mi = lines.findIndex((l) => /^\s*mindmap\b/i.test(l.trim()));
  if (mi < 0) return chart;
  const head = ['mindmap'];
  const body = lines.slice(mi + 1).map(expandLeadingTabs);
  const shifted = body.map((l) => {
    if (!l.trim()) return l;
    return `  ${l}`;
  });
  return [...head, '  root((知识结构))', ...shifted].join('\n');
}

/** mindmap 一行里若含空格、括号、冒号等，词法会变成 SPACELIST 报错；包成 id["…"] 再交给 Mermaid。 */
function mindmapLineNeedsQuotedForm(trimmed) {
  if (!trimmed) return false;
  if (/\s/u.test(trimmed)) return true;
  return /[:.;,，。、；:!？！（）()\[\]{}<>+=\/\\|^&$%#@*"'`·…—]/.test(trimmed);
}

function isSkippableMindmapLine(trimmed) {
  if (!trimmed) return true;
  if (trimmed.startsWith('%%')) return true;
  if (/^\w+\[["']/.test(trimmed)) return true;
  if (/^root\s*\(\(/i.test(trimmed)) return true;
  if (/^\w+\(\([\s\S]*\)\)\s*$/.test(trimmed)) return true;
  if (/^\(\([\s\S]*\)\)\s*$/.test(trimmed)) return true;
  return false;
}

function sanitizeMindmapLineLabels(chart) {
  const s = (chart || '').trim();
  if (!s) return chart;
  const lines = s.split('\n');
  const mi = lines.findIndex((l) => /^\s*mindmap\b/i.test(l.trim()));
  if (mi < 0) return chart;

  let seq = 0;
  const nextId = () => {
    seq += 1;
    return `mmn${seq}`;
  };

  for (let i = mi + 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;
    const m = rawLine.match(/^(\s*)(.*)$/);
    const indent = m[1];
    const body = m[2].trimEnd();
    const trimmed = body.trim();
    if (isSkippableMindmapLine(trimmed)) continue;
    if (!mindmapLineNeedsQuotedForm(trimmed)) continue;
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines[i] = `${indent}${nextId()}["${escaped}"]`;
  }
  return lines.join('\n');
}

let mermaidReady = false;

function ensureMermaid() {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'neutral',
    themeVariables: {
      fontFamily: 'ui-sans-serif, "Noto Sans SC", system-ui',
      primaryColor: '#fdfcfa',
      primaryTextColor: '#1a1f24',
      lineColor: 'rgba(184,149,92,0.55)',
      secondaryColor: '#f6f4ef',
      tertiaryColor: '#ebe8e0',
      mainBkg: '#ffffff',
      nodeBorder: '#b8955c',
      clusterBkg: 'rgba(246,244,239,0.9)',
    },
    mindmap: { useMaxWidth: true },
  });
  mermaidReady = true;
}

export function MermaidMindMapWindow({ open, rawMarkdown, streaming, onClose, onCancel }) {
  const hostRef = useRef(null);
  const [viewTab, setViewTab] = useState('interactive');
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const pan = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  const extractedMermaid = useMemo(() => extractMermaidSource(rawMarkdown || ''), [rawMarkdown]);
  const normChart = useMemo(() => normalizeMindmapMermaid(extractedMermaid), [extractedMermaid]);
  const chart = useMemo(() => sanitizeMindmapLineLabels(normChart), [normChart]);

  useEffect(() => {
    if (!open) return;
    setScale(1);
    setTx(0);
    setTy(0);
  }, [open, chart]);

  useEffect(() => {
    if (viewTab !== 'mermaid') return undefined;
    if (!open || !chart || streaming) {
      if (hostRef.current) hostRef.current.innerHTML = '';
      return undefined;
    }
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    const id = `mm-${Date.now()}`;
    (async () => {
      try {
        ensureMermaid();
        const candidates = [];
        const pushDef = (def) => {
          if (!def || !String(def).trim()) return;
          if (!candidates.includes(def)) candidates.push(def);
        };
        pushDef(chart);
        pushDef(normChart);
        pushDef(sanitizeMindmapLineLabels(wrapMindmapWithFallbackRoot(extractedMermaid)));
        pushDef(normalizeMindmapMermaid(wrapMindmapWithFallbackRoot(extractedMermaid)));
        let svg = '';
        let lastErr = null;
        for (let i = 0; i < candidates.length; i++) {
          const def = candidates[i];
          try {
            ;({ svg } = await mermaid.render(`${id}-${i}`, def));
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (lastErr) throw lastErr;
        if (!cancelled && hostRef.current) {
          hostRef.current.innerHTML = svg;
          const svgEl = hostRef.current.querySelector('svg');
          if (svgEl) {
            svgEl.style.display = 'block';
            svgEl.style.width = '100%';
            svgEl.style.maxWidth = '100%';
            svgEl.style.height = 'auto';
            svgEl.style.margin = '0 auto';
            svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          }
        }
      } catch (e) {
        if (!cancelled && hostRef.current) {
          const msg = String(e?.message || e);
          const pre = document.createElement('pre');
          pre.className =
            'whitespace-pre-wrap rounded-lg border border-red-200/80 bg-red-50/90 p-4 font-sans text-xs leading-relaxed text-red-900';
          pre.textContent = msg;
          hostRef.current.replaceChildren(pre);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chart, normChart, streaming, extractedMermaid, viewTab]);

  if (!open) return null;

  const tabBtn = (id, label) => (
    <button
      key={id}
      type="button"
      onClick={() => setViewTab(id)}
      className={`rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors ${
        viewTab === id ? 'bg-[#1a1f24] text-[#faf9f7]' : 'text-[#1a1f24]/55 hover:bg-white'
      }`}
    >
      {label}
    </button>
  );

  return (
    <ResizableStudioShell
      title="知识点思维导图"
      subtitle="交互大纲可折叠节点；Mermaid 页为矢量导图，可缩放拖拽"
      onClose={onClose}
    >
      <div className="relative flex h-[min(72vh,680px)] min-h-[300px] flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#1a1f24]/[0.06] bg-[#faf9f7] px-3 py-2 sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            {tabBtn('interactive', '交互大纲')}
            {tabBtn('mermaid', 'Mermaid 导图')}
            {viewTab === 'mermaid' && (
              <>
                <span className="hidden h-4 w-px bg-[#1a1f24]/15 sm:inline" aria-hidden />
                <button
                  type="button"
                  className="rounded border border-[#1a1f24]/[0.1] bg-white px-2 py-1 text-[11px] font-semibold"
                  onClick={() => setScale((s) => Math.min(2.6, s + 0.15))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="rounded border border-[#1a1f24]/[0.1] bg-white px-2 py-1 text-[11px] font-semibold"
                  onClick={() => setScale((s) => Math.max(0.35, s - 0.15))}
                >
                  −
                </button>
                <button
                  type="button"
                  className="rounded border border-[#1a1f24]/[0.1] bg-white px-2 py-1 text-[11px] font-semibold"
                  onClick={() => {
                    setScale(1);
                    setTx(0);
                    setTy(0);
                  }}
                >
                  复位
                </button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            {streaming && (
              <button type="button" onClick={onCancel} className="text-[11px] font-semibold text-red-700">
                停止
              </button>
            )}
            {streaming && <span className="text-[11px] text-[#1a1f24]/45">生成中…</span>}
          </div>
        </div>

        {viewTab === 'interactive' ? (
          <div className="min-h-0 flex-1 overflow-hidden bg-[#faf9f7] p-3 sm:p-4">
            <MindmapOutlineView
              mermaidDefinition={chart}
              fullMarkdown={rawMarkdown || ''}
              streaming={streaming}
            />
          </div>
        ) : (
          <div
            className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-[radial-gradient(circle_at_center,rgba(184,149,92,0.06),transparent_55%)] active:cursor-grabbing"
            onWheel={(e) => {
              e.preventDefault();
              setScale((s) => Math.max(0.35, Math.min(2.8, s - e.deltaY * 0.0018)));
            }}
            onMouseDown={(e) => {
              pan.current = { active: true, sx: e.clientX, sy: e.clientY, ox: tx, oy: ty };
            }}
            onMouseMove={(e) => {
              if (!pan.current.active) return;
              setTx(pan.current.ox + (e.clientX - pan.current.sx));
              setTy(pan.current.oy + (e.clientY - pan.current.sy));
            }}
            onMouseUp={() => {
              pan.current.active = false;
            }}
            onMouseLeave={() => {
              pan.current.active = false;
            }}
          >
            <div
              className="flex h-full w-full min-w-0 items-center justify-center p-6"
              style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
            >
              <div
                ref={hostRef}
                className="mmd-host max-w-full min-h-[200px] min-w-0 flex-1 [&_svg]:max-h-[min(68vh,620px)] [&_svg]:drop-shadow-sm"
              />
            </div>
          </div>
        )}

        {streaming && !extractedMermaid.trim() && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/60 text-sm text-[#1a1f24]/45">
            等待 Mermaid 代码块闭合…
          </div>
        )}
        {!streaming && !extractedMermaid.trim() && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-relaxed text-[#1a1f24]/45">
            未识别到 Mermaid 导图代码。请关闭后重新在「资源生成」中生成思维导图。
          </div>
        )}
      </div>
    </ResizableStudioShell>
  );
}

function normalizePracticeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const question = raw.question ?? raw.Question ?? '';
  const options = Array.isArray(raw.options)
    ? raw.options
    : Array.isArray(raw.Options)
      ? raw.Options
      : [];
  const type = String(raw.type ?? raw.Type ?? 'single').toLowerCase() || 'single';
  let correct_index = raw.correct_index ?? raw.correctIndex;
  let correct_indices = raw.correct_indices ?? raw.correctIndices;
  if (!Array.isArray(correct_indices)) correct_indices = [];
  if (type !== 'multi' && correct_index == null && correct_indices.length === 1) {
    correct_index = correct_indices[0];
  }
  if (type === 'multi' && correct_indices.length === 0 && correct_index != null) {
    correct_indices = [correct_index];
  }
  return {
    ...raw,
    question,
    options,
    type,
    correct_index,
    correct_indices,
    explain: raw.explain ?? raw.Explain,
  };
}

function formatOptionLabel(opts, i) {
  if (i == null || Number.isNaN(Number(i))) return '—';
  const o = opts[Number(i)];
  if (o !== undefined && o !== null && String(o).trim()) return String(o);
  return `选项 ${Number(i) + 1}`;
}

function formatCorrectAnswerSummary(qq) {
  const opts = qq?.options || [];
  const t = String(qq?.type || 'single').toLowerCase();
  if (t === 'multi') {
    const idxs = Array.isArray(qq.correct_indices) ? qq.correct_indices : [];
    if (!idxs.length) return '—';
    return idxs.map((i) => formatOptionLabel(opts, i)).join('；');
  }
  return formatOptionLabel(opts, qq.correct_index);
}

function formatUserAnswerSummary(qq, answers, qi) {
  const opts = qq?.options || [];
  const t = String(qq?.type || 'single').toLowerCase();
  const pick = answers[qi];
  if (t === 'multi') {
    const arr = Array.isArray(pick) ? pick : [];
    if (!arr.length) return '未作答';
    return arr.map((i) => formatOptionLabel(opts, i)).join('；');
  }
  if (pick == null) return '未作答';
  return formatOptionLabel(opts, pick);
}

function extractPracticeQuestions(text) {
  const blocks = [...(text || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const m of blocks) {
    try {
      const j = JSON.parse(m[1].trim());
      if (Array.isArray(j) && j.length && (j[0].question != null || j[0].Question != null)) {
        return j.map(normalizePracticeItem).filter(Boolean);
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

export function PracticePackQuizWindow({ open, rawMarkdown, onClose }) {
  const questions = useMemo(() => extractPracticeQuestions(rawMarkdown || '') || [], [rawMarkdown]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [phase, setPhase] = useState('answer');
  useEffect(() => {
    if (open) {
      setIdx(0);
      setAnswers({});
      setPhase('answer');
    }
  }, [open, rawMarkdown]);

  if (!open) return null;
  const q = questions[idx];
  const total = questions.length;

  const setPick = (qi, v) => {
    setAnswers((a) => ({ ...a, [qi]: v }));
  };

  const scoreLocal = () => {
    let ok = 0;
    questions.forEach((qq, i) => {
      const t = (qq.type || '').toLowerCase();
      const pick = answers[i];
      if (t === 'multi') {
        const want = Array.isArray(qq.correct_indices) ? qq.correct_indices : [];
        const got = Array.isArray(pick) ? pick : [];
        if (want.length === got.length && want.every((x) => got.includes(x))) ok += 1;
      } else {
        const want = qq.correct_index;
        if (want != null && pick != null && Number(pick) === Number(want)) ok += 1;
      }
    });
    return { ok, total };
  };

  if (!total) {
    return (
      <ResizableStudioShell title="混合题型练习包" subtitle="未解析到题目 JSON，请查看原文" onClose={onClose}>
        <div className="max-h-[70vh] overflow-y-auto p-6">
          <ChatLikeMarkdown content={rawMarkdown || ''} />
        </div>
      </ResizableStudioShell>
    );
  }

  if (phase === 'result') {
    const { ok, total: t } = scoreLocal();
    return (
      <ResizableStudioShell title="练习结果" subtitle={`答对 ${ok} / ${t}`} onClose={onClose}>
        <div className="flex max-h-[min(78vh,720px)] min-h-[280px] flex-col">
          <div className="shrink-0 space-y-4 px-6 pb-4 pt-6">
            <p className="font-display text-2xl text-[#1a1f24]">{ok >= Math.ceil(t * 0.6) ? '通过自测门槛' : '可再试一轮'}</p>
            <button
              type="button"
              onClick={() => {
                setPhase('answer');
                setIdx(0);
                setAnswers({});
              }}
              className="rounded-lg border border-[#1a1f24]/[0.12] bg-[#1a1f24] px-5 py-2.5 text-sm font-semibold text-[#faf9f7]"
            >
              重新作答
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1f24]/40">逐题解析</p>
            <ul className="space-y-5">
              {questions.map((qq, qi) => {
                const isMulti = (qq.type || '').toLowerCase() === 'multi';
                let isOk = false;
                if (isMulti) {
                  const w = Array.isArray(qq.correct_indices) ? qq.correct_indices : [];
                  const got = Array.isArray(answers[qi]) ? answers[qi] : [];
                  isOk = w.length === got.length && w.every((x) => got.includes(x));
                } else {
                  isOk =
                    qq.correct_index != null &&
                    answers[qi] != null &&
                    Number(answers[qi]) === Number(qq.correct_index);
                }
                const explain = qq.explain ?? qq.Explain ?? '';
                return (
                  <li
                    key={qi}
                    className="list-none rounded-xl border border-[#1a1f24]/[0.08] bg-[#fdfcfa] p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-[#1a1f24]/[0.1] bg-white px-2 py-0.5 font-mono text-[10px] text-[#8a6f42]">
                        第 {qi + 1} 题
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          isOk ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'
                        }`}
                      >
                        {isOk ? '正确' : '错误'}
                      </span>
                    </div>
                    <p className="mt-3 text-[15px] font-medium leading-relaxed text-[#1a1f24]">{qq.question}</p>
                    <div className="mt-3 grid gap-2 text-[13px] leading-relaxed sm:grid-cols-2">
                      <div className="rounded-lg border border-[#1a1f24]/[0.06] bg-white/90 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#1a1f24]/38">正确答案</p>
                        <p className="mt-1 text-[#1a1f24]/88">{formatCorrectAnswerSummary(qq)}</p>
                      </div>
                      <div className="rounded-lg border border-[#1a1f24]/[0.06] bg-white/90 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#1a1f24]/38">你的作答</p>
                        <p className="mt-1 text-[#1a1f24]/88">{formatUserAnswerSummary(qq, answers, qi)}</p>
                      </div>
                    </div>
                    {explain ? (
                      <div className="studio-md-scroll mt-4 rounded-lg border border-[#b8955c]/25 bg-[#faf6ef]/90 px-3 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8a6f42]">解析</p>
                        <div className="mt-2 text-[13px] leading-relaxed text-[#1a1f24]/85">
                          <ChatLikeMarkdown content={String(explain)} className="!prose-sm" />
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </ResizableStudioShell>
    );
  }

  const opts = q?.options || [];
  const t = (q?.type || 'single').toLowerCase();
  const cur = answers[idx];

  return (
    <ResizableStudioShell title="混合题型练习包" subtitle={`第 ${idx + 1} / ${total} 题`} onClose={onClose}>
      <div className="flex max-h-[min(78vh,720px)] min-h-[360px] flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#1a1f24]/38">Question</p>
          <p className="mt-3 text-[16px] font-medium leading-relaxed text-[#1a1f24]">{q?.question}</p>
          <div className="mt-6 space-y-2">
            {opts.map((opt, oi) =>
              t === 'multi' ? (
                <label
                  key={oi}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#1a1f24]/[0.08] bg-white px-4 py-3 transition-colors hover:border-[#b8955c]/45"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={Array.isArray(cur) && cur.includes(oi)}
                    onChange={() => {
                      const arr = Array.isArray(cur) ? [...cur] : [];
                      const i = arr.indexOf(oi);
                      if (i >= 0) arr.splice(i, 1);
                      else arr.push(oi);
                      setPick(idx, arr);
                    }}
                  />
                  <span className="text-[14px] leading-relaxed text-[#1a1f24]/85">{opt}</span>
                </label>
              ) : (
                <label
                  key={oi}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#1a1f24]/[0.08] bg-white px-4 py-3 transition-colors hover:border-[#b8955c]/45"
                >
                  <input
                    type="radio"
                    className="mt-1"
                    name={`pq-${idx}`}
                    checked={cur === oi}
                    onChange={() => setPick(idx, oi)}
                  />
                  <span className="text-[14px] leading-relaxed text-[#1a1f24]/85">{opt}</span>
                </label>
              )
            )}
          </div>
          {q?.explain && phase === 'answer' && (
            <p className="mt-6 rounded-lg border border-dashed border-[#b8955c]/35 bg-[#faf6ef]/80 p-3 text-[12px] text-[#1a1f24]/55">
              提示：提交后可对照解析。
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[#1a1f24]/[0.06] bg-white/90 px-6 py-4">
          <button
            type="button"
            disabled={idx === 0}
            onClick={() => setIdx((i) => i - 1)}
            className="rounded-lg border border-[#1a1f24]/[0.1] px-4 py-2 text-sm disabled:opacity-35"
          >
            上一题
          </button>
          {idx < total - 1 ? (
            <button
              type="button"
              onClick={() => setIdx((i) => i + 1)}
              className="rounded-lg bg-[#1a1f24] px-5 py-2 text-sm font-semibold text-[#faf9f7]"
            >
              下一题
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPhase('result')}
              className="rounded-lg bg-[#b8955c] px-5 py-2 text-sm font-semibold text-[#1a1f24]"
            >
              提交全部
            </button>
          )}
        </div>
      </div>
    </ResizableStudioShell>
  );
}

/** 去掉从 Markdown / 标点里「粘连」的多余字符，尽量得到浏览器可打开的 http(s) URL。 */
function normalizeExtractedUrl(raw) {
  let u = String(raw || '').trim();
  u = u.replace(/^[`"'「『（(<'<]+|[`"'」』）)>.'"\]]+$/g, '');
  for (let k = 0; k < 10 && u.length > 10; k++) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {
      /* try trim trailing junk */
    }
    const prev = u;
    u = u.replace(/[),.;:!?'"»，。）、】」』\]]+$/u, '');
    if (u === prev) break;
  }
  return '';
}

function extractAllUrls(md) {
  const s = md || '';
  const out = [];
  const seen = new Set();
  const push = (url, label) => {
    const u = normalizeExtractedUrl(url);
    if (!u || u.length < 12) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push({ href: u, label: (label || u).trim() });
  };
  const mdLink = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = mdLink.exec(s)) !== null) push(m[2], m[1]);
  const bare = /(^|[\s(])((https?:\/\/[\w\-./?#&=%+~@[\]:;!$*+,;\u4e00-\u9fff]+))/gi;
  while ((m = bare.exec(s)) !== null) push(m[2], m[2]);
  return out;
}

/** 去掉站点根路径等过浅链接（如仅 https://arxiv.org/） */
function filterShallowHomepageUrls(urls) {
  return urls.filter(({ href }) => {
    try {
      const u = new URL(href);
      const path = u.pathname.replace(/\/+$/, '');
      return !!path && path !== '/';
    } catch {
      return false;
    }
  });
}

/** 去掉明显为「检索占位」的链接，只保留正文里出现的具体资源地址 */
function filterNonSearchUrls(urls) {
  return urls.filter(({ href }) => {
    try {
      const u = new URL(href);
      const h = u.hostname.replace(/^www\./i, '').toLowerCase();
      const path = `${u.pathname}${u.search}`.toLowerCase();
      if (/^google\./i.test(h) && path.includes('/search')) return false;
      if (h === 'baidu.com' && (u.pathname === '/s' || u.searchParams.has('wd') || u.searchParams.has('word')))
        return false;
      if (/\.bing\.com$/i.test(h) && path.includes('/search')) return false;
      if (h === 'duckduckgo.com' && u.searchParams.has('q')) return false;
      if (h === 'scholar.google.com' && u.searchParams.has('q')) return false;
      if (h === 'so.com' && u.searchParams.has('q')) return false;
      return true;
    } catch {
      return false;
    }
  });
}

/** 优先从「### 相关延伸链接」小节抽取网址，否则退回全文（均已过滤检索与浅主页） */
function extractReadingRelatedUrls(md) {
  const full = filterShallowHomepageUrls(filterNonSearchUrls(extractAllUrls(md || '')));
  const rel = /#{1,4}\s*相关(?:延伸)?链接[^\n]*\r?\n/i;
  const s = md || '';
  const i = s.search(rel);
  if (i < 0) return full;
  const after = s.slice(i).replace(rel, '');
  const next = after.search(/\n#{1,4}\s+/);
  const section = (next >= 0 ? after.slice(0, next) : after).trim();
  if (!section) return full;
  const fromSec = filterShallowHomepageUrls(filterNonSearchUrls(extractAllUrls(section)));
  return fromSec.length ? fromSec : full;
}

export function ExtendedReadingWindow({ open, rawMarkdown, streaming, onClose, onCancel }) {
  const bodyMd = useMemo(() => decodeResourceMarkdownStream(rawMarkdown || ''), [rawMarkdown]);
  const urls = useMemo(() => extractReadingRelatedUrls(bodyMd), [bodyMd]);
  if (!open) return null;
  return (
    <ResizableStudioShell
      title="拓展阅读材料"
      subtitle="正文紧扣资料；文末「相关延伸链接」仅列与本节直接相关的具体页面"
      onClose={onClose}
    >
      <div className="flex max-h-[min(80vh,760px)] min-h-[320px] flex-col">
        {streaming && (
          <div className="flex shrink-0 items-center justify-end gap-3 border-b border-[#1a1f24]/[0.05] bg-[#fdfcfa] px-4 py-2">
            <button type="button" onClick={onCancel} className="text-[11px] font-semibold text-red-700 hover:underline">
              停止生成
            </button>
            <span className="flex items-center gap-2 text-[11px] text-[#1a1f24]/45">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#1a1f24]/12 border-t-[#b8955c]" />
              流式输出中…
            </span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto bg-white">
          <div className="studio-md-scroll px-6 py-6">
            {bodyMd?.trim() ? (
              <ChatLikeMarkdown content={bodyMd} />
            ) : (
              <p className="text-sm text-[#1a1f24]/40">{streaming ? '等待首字节…' : '暂无内容'}</p>
            )}
          </div>
          <div className="shrink-0 border-t border-[#1a1f24]/[0.06] bg-[#f6f4ef]/90 px-6 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1f24]/40">相关延伸链接</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#1a1f24]/42">
              优先展示文末「相关延伸链接」小节中的地址；须为具体文档页并已过滤搜索页与站点首页。
            </p>
            {urls.length > 0 ? (
              <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto pr-1">
                {urls.map((u) => (
                  <li key={u.href}>
                    <a
                      href={u.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block break-all rounded-md border border-[#1a1f24]/[0.06] bg-white px-3 py-2 text-[12px] text-[#8a6f42] underline-offset-2 hover:underline"
                      title={u.href}
                    >
                      {u.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[12px] leading-relaxed text-[#1a1f24]/38">
                {streaming ? '生成完成后，若正文含有效外链将在此列出。' : '本次正文中未解析到符合条件的具体链接；可在对话区请模型补充「相关延伸链接」小节。'}
              </p>
            )}
          </div>
        </div>
      </div>
    </ResizableStudioShell>
  );
}

function extractFencedCodes(text) {
  const out = [];
  const re = /(```|~~~)[ \t]*([^\n`]*)\n([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    const lang = (m[2] || 'text').trim().split(/\s+/)[0].toLowerCase() || 'text';
    if (lang === 'mermaid') continue;
    const code = m[3].trim();
    if (code) out.push({ lang, code });
  }
  return out;
}

/** 微课脚本：优先按标题拆卡，其次按「镜号 / 分镜」等行首拆卡，最后按空行分段。 */
function splitVideoScriptToShots(markdown) {
  const t = String(markdown || '').trim();
  if (!t) return [];
  const headerParts = t.split(/\n(?=#{1,6}\s)/g).map((c) => c.trim()).filter(Boolean);
  if (headerParts.length > 1) {
    return headerParts.map((c, i) => {
      const titleLine = c.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
      return { id: i, title: titleLine || `片段 ${i + 1}`, body: c };
    });
  }
  const shotPatterns = [
    /\n(?=\*{0,2}(?:镜号|分镜|镜头|场景|画面)(?:[：:]|＿|\s))/,
    /\n(?=【[^】]{1,48}】)/,
    /\n(?=(?:镜号|分镜|镜头|场景)\s*[：:])/,
    /\n(?=\d{1,2}[\.、]\s*(?:\*\*)?(?:镜|镜头|分镜|画面))/,
    /\n(?=第[一二三四五六七八九十百千零〇\d]+(?:镜|段|场))/,
  ];
  for (const re of shotPatterns) {
    const parts = t.split(re).map((c) => c.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts.map((c, i) => {
        const first = c.split('\n')[0].replace(/^#+\s*/, '').replace(/^\*\*\s*/, '').slice(0, 80);
        return { id: i, title: first || `镜 ${i + 1}`, body: c };
      });
    }
  }
  const paras = t.split(/\n{2,}/).map((c) => c.trim()).filter(Boolean);
  if (paras.length > 2) {
    return paras.map((c, i) => ({ id: i, title: `段落 ${i + 1}`, body: c }));
  }
  return [{ id: 0, title: '全文脚本', body: t }];
}

export function CodeLabWorkshopWindow({ open, rawMarkdown, streaming, onClose, onCancel }) {
  const [tab, setTab] = useState('doc');
  const docMarkdown = useMemo(() => decodeResourceMarkdownStream(rawMarkdown || ''), [rawMarkdown]);
  const blocks = useMemo(() => extractFencedCodes(docMarkdown), [docMarkdown]);
  if (!open) return null;
  return (
    <ResizableStudioShell
      title="代码实操案例"
      subtitle="分栏：讲义全文 · 代码聚合 · 要点回顾（与练习包相同「进入专用界面」交互）"
      onClose={onClose}
    >
      <div className="flex h-[min(74vh,700px)] min-h-[300px] flex-col">
        <div className="flex shrink-0 gap-1 border-b border-[#1a1f24]/[0.08] bg-[#faf9f7] px-3 py-2">
          {[
            { id: 'doc', label: '讲义全文' },
            { id: 'code', label: '代码聚合' },
            { id: 'tips', label: '要点与排错' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-2 text-[12px] font-semibold transition-colors ${
                tab === t.id ? 'bg-[#1a1f24] text-[#faf9f7]' : 'text-[#1a1f24]/55 hover:bg-white'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {streaming && (
              <button type="button" onClick={onCancel} className="text-[11px] text-red-700">
                停止
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden overflow-x-hidden bg-white">
          {tab === 'doc' && (
            <div className="studio-md-scroll max-h-full overflow-y-auto px-6 py-6">
              <ChatLikeMarkdown content={docMarkdown} />
            </div>
          )}
          {tab === 'code' && (
            <div className="max-h-full overflow-y-auto px-6 py-6">
              {blocks.length === 0 && <p className="text-sm text-[#1a1f24]/45">暂无围栏代码块</p>}
              {blocks.map((b, i) => (
                <div key={i} className="mb-6 last:mb-0 rounded-xl border border-[#1a1f24]/[0.08] bg-[#fdfcfa] p-3">
                  <p className="text-[11px] font-mono text-[#8a6f42]">{b.lang}</p>
                  <pre className="mt-2 min-h-[min(52vh,480px)] max-h-[min(72vh,680px)] overflow-auto whitespace-pre-wrap rounded-lg border border-[#1a1f24]/[0.1] bg-[#f6f4ef] p-4 font-mono text-[12px] leading-relaxed text-[#1a1f24]">
                    {b.code}
                  </pre>
                </div>
              ))}
            </div>
          )}
          {tab === 'tips' && (
            <div className="studio-md-scroll max-h-full overflow-y-auto px-6 py-6">
              <p className="mb-4 rounded-lg border border-[#1a1f24]/[0.06] bg-[#faf9f7] px-3 py-2 text-[12px] leading-relaxed text-[#1a1f24]/55">
                与「讲义全文」相同稿面，便于在代码与说明之间来回对照；生成完成后可结合「代码聚合」分屏自查。
              </p>
              <ChatLikeMarkdown content={docMarkdown} />
            </div>
          )}
        </div>
      </div>
    </ResizableStudioShell>
  );
}

/** 将正文按「镜号/分镜」等关键词拆成卡片，并附简易「走镜」高亮 */
export function VideoScriptBoardWindow({ open, rawMarkdown, onClose }) {
  const { meta, shots } = useMemo(() => {
    const structured = parseStructuredVideoScript(rawMarkdown || '');
    if (structured?.shots?.length) {
      return { meta: structured.meta, shots: structured.shots };
    }
    const decoded = decodeResourceMarkdownStream(rawMarkdown || '');
    const parts = splitVideoScriptToShots(decoded);
    return {
      meta: null,
      shots: parts.map((p) => ({
        id: p.id,
        shotNo: p.id + 1,
        title: p.title,
        subtitle: '',
        markdown: p.body,
      })),
    };
  }, [rawMarkdown]);

  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    setPlaying(false);
  }, [open, rawMarkdown]);

  useEffect(() => {
    if (!playing || !shots.length) return;
    const id = setInterval(() => {
      setActive((a) => (a + 1 >= shots.length ? 0 : a + 1));
    }, 4200);
    return () => clearInterval(id);
  }, [playing, shots.length]);

  useEffect(() => {
    if (!open || !shots.length) return;
    const el = typeof document !== 'undefined' ? document.getElementById(`vs-shot-${active}`) : null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [active, open, shots.length, playing]);

  if (!open) return null;

  return (
    <ResizableStudioShell
      title="微课视频脚本"
      subtitle="支持模型输出的 JSON 分镜表：顶栏概览、镜号快速跳转、下方逐卡展示画面与口播"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="rounded-lg border border-[#b8955c]/45 bg-[#faf6ef] px-4 py-2 text-[12px] font-semibold text-[#5c4a28]"
          >
            {playing ? '暂停走镜' : '开始走镜预览'}
          </button>
          <span className="text-[11px] text-[#1a1f24]/45">
            走镜时自动滚动到当前镜；点击上方镜号可定位。默认每镜约 4.2s。
          </span>
        </div>
      }
    >
      <div className="flex max-h-[min(78vh,760px)] min-h-[320px] flex-col overflow-hidden bg-white">
        {(meta?.title || meta?.chapter || meta?.totalDuration) && (
          <div className="shrink-0 border-b border-[#1a1f24]/[0.06] bg-[#faf9f7] px-4 py-3 sm:px-5">
            {meta.title ? (
              <h3 className="font-display text-base font-medium text-[#1a1f24]">{meta.title}</h3>
            ) : null}
            <p className="mt-1 text-[12px] leading-relaxed text-[#1a1f24]/50">
              {[meta.chapter, meta.totalDuration].filter(Boolean).join(' · ') || ' '}
            </p>
          </div>
        )}

        <div className="shrink-0 border-b border-[#1a1f24]/[0.06] bg-[#f6f4ef]/80 px-3 py-2">
          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#1a1f24]/38">
            镜号
          </p>
          <div className="flex flex-wrap gap-2">
            {shots.map((s, i) => (
              <button
                key={s.id}
                type="button"
                id={`vs-pill-${i}`}
                onClick={() => {
                  setActive(i);
                  setPlaying(false);
                }}
                className={`rounded-full border px-3 py-1.5 text-left text-[11px] font-semibold transition-colors ${
                  i === active
                    ? 'border-[#b8955c]/55 bg-white text-[#1a1f24] shadow-sm'
                    : 'border-[#1a1f24]/[0.08] bg-white/60 text-[#1a1f24]/55 hover:border-[#b8955c]/35 hover:bg-white'
                }`}
              >
                <span className="font-mono text-[#b8955c]">{String(s.shotNo ?? i + 1).padStart(2, '0')}</span>
                {s.subtitle ? (
                  <span className="ml-1.5 font-normal text-[#1a1f24]/45">· {s.subtitle}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {shots.length === 0 ? (
            <p className="text-sm text-[#1a1f24]/45">暂无脚本内容</p>
          ) : (
            <div className="space-y-4 pb-4">
              {shots.map((s, i) => (
                <article
                  key={s.id}
                  id={`vs-shot-${i}`}
                  className={`scroll-mt-4 rounded-xl border border-[#1a1f24]/[0.08] bg-[#fdfcfa] p-4 transition-shadow ${
                    i === active ? 'shadow-[0_0_0_2px_rgba(184,149,92,0.45)]' : ''
                  }`}
                >
                  <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-[#1a1f24]/[0.06] pb-2">
                    <div className="min-w-0">
                      <span className="font-mono text-[12px] font-semibold text-[#b8955c]">
                        镜 {String(s.shotNo ?? i + 1).padStart(2, '0')}
                      </span>
                      <h4 className="mt-0.5 text-[13px] font-semibold text-[#1a1f24]">{s.title}</h4>
                    </div>
                    {s.subtitle ? (
                      <span className="shrink-0 rounded-md bg-[#f6f4ef] px-2 py-0.5 text-[10px] text-[#1a1f24]/55">
                        {s.subtitle}
                      </span>
                    ) : null}
                  </header>
                  <div className="studio-md-scroll text-[13px] leading-relaxed">
                    <ChatLikeMarkdown content={s.markdown} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </ResizableStudioShell>
  );
}
