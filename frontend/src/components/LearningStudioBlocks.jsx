import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ChatDocResizableWindow,
  CodeLabWorkshopWindow,
  ExtendedReadingWindow,
  MermaidMindMapWindow,
  PracticePackQuizWindow,
  VideoScriptBoardWindow,
} from './StudioResourceModals';
import { decodeResourceMarkdownStream } from '../utils/resourceStreamDecode';

const formatApiDetail = (data) => {
  const d = data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d
      .map((x) => (typeof x === 'object' && x != null ? x.msg ?? JSON.stringify(x) : String(x)))
      .join('；');
  }
  if (d && typeof d === 'object') return JSON.stringify(d);
  return '';
};

/** 与后端 PORTRAIT_DIMENSION_KEYS 顺序一致，保证雷达顶点稳定 */
const PORTRAIT_AXIS_ORDER = [
  '知识基础',
  '认知风格',
  '学习目标对齐度',
  '易错点偏好',
  '学习节奏',
  '兴趣与拓展倾向',
];

function shortenLabel(s, max = 5) {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 六维雷达（多边形） */
function PortraitRadarChart({ dimensions }) {
  const gradId = `pa-radar-grad-${useId().replace(/:/g, '')}`;
  const cx = 100;
  const cy = 100;
  const maxR = 68;
  const n = PORTRAIT_AXIS_ORDER.length;

  const vertex = (radius, i) => {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return { x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) };
  };

  const dataPoly = PORTRAIT_AXIS_ORDER.map((key, i) => {
    const raw = dimensions?.[key]?.score;
    const score = Math.max(0, Math.min(1, Number(raw) || 0.5));
    const r = 0.12 * maxR + score * 0.88 * maxR;
    const p = vertex(r, i);
    return { ...p, key, score, label: key };
  });
  const dataPoints = dataPoly.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');

  const gridPolys = [0.25, 0.5, 0.75, 1].map((t) =>
    Array.from({ length: n }, (_, i) => {
      const p = vertex(t * maxR, i);
      return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    }).join(' ')
  );

  const axisLines = PORTRAIT_AXIS_ORDER.map((_, i) => {
    const p = vertex(maxR, i);
    return { x1: cx, y1: cy, x2: p.x, y2: p.y, i };
  });

  const labelR = maxR + 26;
  const labels = PORTRAIT_AXIS_ORDER.map((key, i) => {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return {
      key,
      x: cx + labelR * Math.cos(ang),
      y: cy + labelR * Math.sin(ang),
      short: shortenLabel(key, 4),
    };
  });

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <svg
        viewBox="0 0 200 200"
        className="h-[168px] w-[168px] shrink-0 text-[#1a1f24]/55"
        role="img"
        aria-label="六维学习画像雷达图"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(184,149,92,0.55)" />
            <stop offset="100%" stopColor="rgba(184,149,92,0.12)" />
          </linearGradient>
        </defs>
        {gridPolys.map((points, gi) => (
          <polygon
            key={gi}
            points={points}
            fill="none"
            stroke="rgba(26,31,36,0.08)"
            strokeWidth={gi === 3 ? 1.2 : 0.75}
          />
        ))}
        {axisLines.map((ln) => (
          <line key={ln.i} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} stroke="rgba(26,31,36,0.1)" strokeWidth={0.75} />
        ))}
        <polygon points={dataPoints} fill={`url(#${gradId})`} stroke="rgba(184,149,92,0.85)" strokeWidth={1.35} strokeLinejoin="round" />
        {dataPoly.map((p) => (
          <circle key={p.key} cx={p.x} cy={p.y} r={3.2} fill="#faf9f7" stroke="rgba(184,149,92,0.95)" strokeWidth={1.2} />
        ))}
        {labels.map((lb) => (
          <text
            key={lb.key}
            x={lb.x}
            y={lb.y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-[#1a1f24]/48"
            style={{ fontSize: '9px', fontWeight: 600 }}
          >
            {lb.short}
          </text>
        ))}
      </svg>
      <div className="grid w-full grid-cols-2 gap-x-2 gap-y-1.5 text-[10px] leading-snug text-[#1a1f24]/58">
        {dataPoly.map((p) => (
          <div key={p.key} className="flex min-w-0 items-baseline justify-between gap-1 border-b border-[#1a1f24]/[0.06] pb-1">
            <span className="truncate font-medium text-[#1a1f24]/72" title={p.label}>
              {p.label}
            </span>
            <span className="shrink-0 font-mono text-[#8a6f42]">{Math.round(p.score * 100)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MentorOverviewBody({ overview, loading, err, resourceEntries }) {
  return (
    <div className="px-6 pb-10 pt-6 sm:px-10 sm:pb-12">
      {loading && (
        <div className="flex items-center gap-2 text-[13px] text-[#1a1f24]/48">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#1a1f24]/15 border-t-[#b8955c]" />
          正在拉取编排与安全策略…
        </div>
      )}
      {err && (
        <div className="rounded-lg border border-amber-200/90 bg-amber-50/95 px-4 py-3 text-[13px] leading-relaxed text-amber-950">{err}</div>
      )}
      {overview && (
        <div className="mt-2 space-y-10">
          <section>
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#1a1f24]/[0.07] pb-3">
              <h3 className="font-display text-lg font-medium text-[#1a1f24]">智能体编排</h3>
              <p className="max-w-md text-[12px] leading-relaxed text-[#1a1f24]/45">按协同顺序展示；实际调用由后端路由与提示词编排完成。</p>
            </div>
            <ol className="mt-6 grid list-none gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(overview.agents || []).map((a, idx) => (
                <li
                  key={a.id}
                  className="relative rounded-xl border border-[#1a1f24]/[0.07] bg-white/90 p-5 pl-12 shadow-[0_6px_22px_rgba(26,31,36,0.04)]"
                >
                  <span className="absolute left-4 top-5 flex h-7 w-7 items-center justify-center rounded-full bg-[#1a1f24] font-mono text-[11px] font-bold text-[#faf9f7]">
                    {idx + 1}
                  </span>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#b8955c]/90">{a.id}</p>
                  <h4 className="mt-2 font-display text-[15px] font-medium leading-snug text-[#1a1f24]">{a.name}</h4>
                  <p className="mt-3 text-[13px] leading-[1.65] text-[#1a1f24]/58">{a.role}</p>
                </li>
              ))}
            </ol>
          </section>

          <section>
            <div className="border-b border-[#1a1f24]/[0.07] pb-3">
              <h3 className="font-display text-lg font-medium text-[#1a1f24]">六类个性化资源</h3>
              <p className="mt-2 max-w-2xl text-[13px] leading-[1.65] text-[#1a1f24]/48">
                与赛题资源类型对齐；在课堂右侧「资源生成」中，会按当前小节教材摘录与可选补充要求流式输出。
              </p>
            </div>
            <ul className="mt-5 grid list-none grid-cols-1 gap-3 sm:grid-cols-2">
              {resourceEntries.map((x, i) => (
                <li key={x.key} className="flex gap-4 rounded-xl border border-[#1a1f24]/[0.06] bg-white/88 px-4 py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f6f4ef] font-mono text-[12px] font-semibold text-[#b8955c]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <p className="font-display text-[15px] font-medium text-[#1a1f24]">{x.title}</p>
                    <p className="mt-1 font-mono text-[11px] text-[#1a1f24]/35">{x.key}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-[#1a1f24]/[0.08] bg-white/95 p-6 sm:p-8">
            <h3 className="font-display text-lg font-medium text-[#1a1f24]">分层安全与防幻觉</h3>
            <p className="mt-2 max-w-3xl text-[13px] leading-[1.65] text-[#1a1f24]/50">
              从输入到模型输出多层约束，降低注入、越狱与脱离课纲的幻觉风险；以下为策略摘要。
            </p>
            <ul className="mt-6 space-y-4">
              {(overview.safety?.layers || []).map((layer, i) => (
                <li key={i} className="flex gap-4 border-b border-[#1a1f24]/[0.05] pb-4 last:border-0 last:pb-0">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#b8955c]/12 text-[12px] font-bold text-[#8a6f42]">
                    {i + 1}
                  </span>
                  <p className="min-w-0 flex-1 text-[14px] leading-[1.7] text-[#1a1f24]/72">{layer}</p>
                </li>
              ))}
            </ul>
            {overview.safety?.policy && (
              <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg bg-[#f6f4ef]/90 px-4 py-3 text-[12px] text-[#1a1f24]/55">
                <span>策略标识</span>
                <code className="rounded border border-[#1a1f24]/[0.08] bg-white px-2 py-1 font-mono text-[12px] text-[#8a6f42]">
                  {overview.safety.policy}
                </code>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** 看板顶栏：弹层展示多智能体与安全说明 */
export function StudioMentorOverviewModal({ open, onClose, apiBase }) {
  const [overview, setOverview] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const r = await fetch(`${apiBase}/learning/studio/overview`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '加载失败');
      setOverview(j);
    } catch (e) {
      setErr(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const resourceEntries = useMemo(() => {
    const rt = overview?.resource_types;
    if (!rt || typeof rt !== 'object') return [];
    return Object.entries(rt).map(([key, v]) => ({ key, title: v?.title || key }));
  }, [overview]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-[#1a1f24]/45 p-4 pb-16 pt-10 backdrop-blur-[2px] sm:p-8 sm:pt-14">
      <button type="button" className="fixed inset-0" aria-label="关闭" onClick={onClose} />
      <div className="relative z-10 w-full max-w-4xl overflow-hidden rounded-2xl border border-[#1a1f24]/[0.1] bg-gradient-to-b from-white/98 to-[#faf9f7]/98 shadow-[0_28px_90px_rgba(26,31,36,0.22)]">
        <div className="pa-hline-runner relative" aria-hidden />
        <div className="flex items-start justify-between gap-4 border-b border-[#1a1f24]/[0.06] px-6 py-5 sm:px-8">
          <div>
            <p className="pa-label text-[10px] font-medium text-[#1a1f24]/35">A3 · 多智能体学习系统</p>
            <h2 className="mt-1 font-display text-[clamp(1.2rem,2.6vw,1.55rem)] font-medium text-[#1a1f24]">多智能体与安全说明</h2>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[#1a1f24]/52">
              进入课堂后：左侧为学习画像，右侧「资源生成」可按小节流式生成六类材料。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-[#1a1f24]/[0.1] bg-white px-4 py-2 text-[11px] font-semibold tracking-wide text-[#1a1f24]/65 hover:border-[#b8955c]/45"
          >
            关闭
          </button>
        </div>
        <div className="max-h-[min(78vh,820px)] overflow-y-auto scrollbar-hide">
          <MentorOverviewBody overview={overview} loading={loading} err={err} resourceEntries={resourceEntries} />
        </div>
      </div>
    </div>
  );
}

/** 对话页左侧：学习画像（进入课程即加载，可展开六维） */
export function StudioPortraitCard({ apiBase, username, subject, sessionId }) {
  const [portrait, setPortrait] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!username || !subject) return;
    setLoading(true);
    setErr('');
    try {
      const r = await fetch(
        `${apiBase}/learning/studio/portrait?username=${encodeURIComponent(username)}&subject=${encodeURIComponent(subject)}`
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '加载失败');
      setPortrait(j.portrait || null);
      setMeta(j.updated_at || null);
    } catch (e) {
      setErr(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [apiBase, username, subject]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    if (!username || !subject) return;
    setLoading(true);
    setErr('');
    try {
      const r = await fetch(`${apiBase}/learning/studio/portrait/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, subject, session_id: sessionId || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '刷新失败');
      setPortrait(j.portrait || null);
      setMeta(new Date().toISOString());
    } catch (e) {
      setErr(e?.message || '刷新失败');
    } finally {
      setLoading(false);
    }
  };

  const dimObj = portrait?.dimensions && typeof portrait.dimensions === 'object' ? portrait.dimensions : {};

  return (
    <div className="relative mt-4 border border-[#1a1f24]/[0.08] bg-gradient-to-b from-white/85 to-[#faf9f7]/90 p-4 shadow-sm">
      <div className="pa-corners opacity-40" aria-hidden>
        <span />
      </div>
      <div className="pa-label text-[10px] text-[#1a1f24]/35">Portrait</div>
      <div className="mt-1 flex items-start justify-between gap-2">
        <h3 className="font-display text-lg text-[#1a1f24]">学习画像</h3>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-[10px] font-semibold text-[#b8955c] hover:underline"
        >
          {expanded ? '收起说明' : '各维说明'}
        </button>
      </div>
      {meta && <p className="mt-1 text-[10px] text-[#1a1f24]/38">更新 {meta}</p>}
      {err && <p className="mt-2 text-[11px] text-red-700">{err}</p>}

      <div className="mt-3 rounded-lg border border-[#1a1f24]/[0.06] bg-white/80 px-2 py-3">
        <PortraitRadarChart dimensions={dimObj} />
      </div>

      {portrait?.summary && (
        <p className={`mt-3 text-[12px] leading-[1.65] text-[#1a1f24]/58 ${expanded ? '' : 'line-clamp-4'}`}>{portrait.summary}</p>
      )}

      {expanded && (
        <ul className="mt-4 space-y-3 border-t border-[#1a1f24]/[0.06] pt-4">
          {PORTRAIT_AXIS_ORDER.map((k) => {
            const v = dimObj[k] || {};
            const score = typeof v?.score === 'number' ? v.score : Number(v?.score) || 0.5;
            const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
            return (
              <li key={k} className="rounded-md border border-[#1a1f24]/[0.06] bg-white/70 px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-semibold text-[#1a1f24]">{k}</span>
                  <span className="font-mono text-[11px] text-[#8a6f42]">{pct}</span>
                </div>
                {v?.note && <p className="mt-1.5 text-[11px] leading-relaxed text-[#1a1f24]/52">{v.note}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        disabled={loading}
        onClick={() => void refresh()}
        className="pa-motion-ui mt-4 w-full border border-[#1a1f24]/[0.1] bg-[#1a1f24] py-2.5 text-[10px] font-semibold tracking-[0.16em] text-[#faf9f7] transition-all hover:bg-[#242b32] disabled:opacity-50"
      >
        {loading ? '处理中…' : '用 LLM 刷新画像'}
      </button>
    </div>
  );
}

/** 对话页右侧：学习路径 */
export function StudioPathPanel({ apiBase, username, subject }) {
  const [pathData, setPathData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!username || !subject) return;
    setLoading(true);
    setErr('');
    try {
      const r = await fetch(
        `${apiBase}/learning/studio/path?username=${encodeURIComponent(username)}&subject=${encodeURIComponent(subject)}`
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '加载失败');
      setPathData(j.path || null);
    } catch (e) {
      setErr(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [apiBase, username, subject]);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuild = async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await fetch(`${apiBase}/learning/studio/path/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, subject }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '重建失败');
      setPathData(j.path || null);
    } catch (e) {
      setErr(e?.message || '重建失败');
    } finally {
      setLoading(false);
    }
  };

  const steps = pathData?.steps || [];
  const focusIdx = pathData?.focus_index;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2 sm:p-3">
      <p className="px-1 text-[11px] leading-relaxed text-[#1a1f24]/48">
        按教材顺序列出小节；结合你已通过的测验标记进度。与左侧「章节目录」一致，便于对照跳转。
      </p>
      <div className="mt-3 flex flex-wrap gap-2 px-1">
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="rounded-sm border border-[#1a1f24]/[0.1] bg-white px-3 py-1.5 text-[10px] font-semibold text-[#1a1f24]/70 hover:border-[#b8955c]/45"
        >
          刷新
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => void rebuild()}
          className="rounded-sm border border-[#1a1f24]/[0.12] bg-[#1a1f24] px-3 py-1.5 text-[10px] font-semibold text-[#faf9f7] hover:bg-[#242b32] disabled:opacity-50"
        >
          重建并归档
        </button>
      </div>
      {err && <div className="mx-1 mt-3 rounded border border-red-200 bg-red-50/90 p-2 text-[11px] text-red-900">{err}</div>}
      {pathData?.hint && <p className="mx-1 mt-3 text-[11px] text-[#1a1f24]/50">{pathData.hint}</p>}
      <ol className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1 scrollbar-hide pb-4">
        {steps.map((s, i) => {
          const focus = focusIdx === i;
          const done = s.status === 'done';
          return (
            <li
              key={`${s.chapter_id}-${s.section_id}-${i}`}
              className={`flex items-start gap-2 rounded-md border px-2 py-2 text-[12px] ${
                focus
                  ? 'border-[#b8955c]/45 bg-[#faf6ef]'
                  : done
                    ? 'border-[#1a1f24]/[0.05] bg-white/60 text-[#1a1f24]/50'
                    : 'border-[#1a1f24]/[0.06] bg-white/85'
              }`}
            >
              <span className="mt-0.5 font-mono text-[9px] text-[#b8955c]/90">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium leading-tight text-[#1a1f24]">{s.section_title || s.section_id}</div>
                <div className="truncate text-[10px] text-[#1a1f24]/40">{s.chapter_title}</div>
              </div>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                  done ? 'bg-emerald-50 text-emerald-800' : focus ? 'bg-amber-50 text-amber-900' : 'bg-[#1a1f24]/[0.05] text-[#1a1f24]/45'
                }`}
              >
                {done ? '已过' : focus ? '推荐' : '待学'}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const LIVE_WINDOW_TYPES = new Set(['course_digest', 'mind_map', 'extended_reading', 'code_lab', 'video_script']);

/** 对话页右侧：按小节生成资源；按类型进入可缩放弹窗 / 导图 / 答题 / 外链 / 导演板等 */
export function StudioResourcePanel({ apiBase, username, subject, chapterId, sectionId, scopeLabel }) {
  const [overview, setOverview] = useState(null);
  const [hint, setHint] = useState('');
  const [activeKey, setActiveKey] = useState(null);
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamErr, setStreamErr] = useState('');
  const [win, setWin] = useState(null);
  const abortRef = useRef(null);

  const streamDisplay = useMemo(() => decodeResourceMarkdownStream(streamText), [streamText]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${apiBase}/learning/studio/overview`);
        const j = await r.json().catch(() => ({}));
        if (!cancelled && r.ok) setOverview(j);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const resourceEntries = useMemo(() => {
    const rt = overview?.resource_types;
    if (!rt || typeof rt !== 'object') return [];
    return Object.entries(rt).map(([key, v]) => ({
      key,
      title: v?.title || key,
      chain: v?.agent_chain || '',
    }));
  }, [overview]);

  const canGen = !!(chapterId && sectionId);

  const resetStreamState = () => {
    setStreamText('');
    setStreamErr('');
    setActiveKey(null);
    setWin(null);
  };

  const startStream = async (resourceType) => {
    if (!canGen) {
      setStreamErr('请先在「章节目录」中选中小节。');
      return;
    }
    setStreamErr('');
    setStreamText('');
    setActiveKey(resourceType);
    setStreaming(true);
    if (resourceType === 'practice_pack') setWin(null);
    else if (LIVE_WINDOW_TYPES.has(resourceType)) setWin(resourceType);

    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    const ac = new AbortController();
    abortRef.current = ac;
    let ok = false;
    try {
      const r = await fetch(`${apiBase}/learning/studio/resources/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          username,
          subject,
          chapter_id: chapterId,
          section_id: sectionId,
          resource_type: resourceType,
          extra_hint: hint.trim(),
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        let msg = t;
        try {
          msg = formatApiDetail(JSON.parse(t)) || t;
        } catch {
          /* ignore */
        }
        throw new Error(msg || `HTTP ${r.status}`);
      }
      if (!r.body) throw new Error('无响应流');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setStreamText(acc);
      }
      acc += dec.decode();
      setStreamText(acc);
      ok = true;
    } catch (e) {
      if (e?.name === 'AbortError') {
        setStreamErr('已取消。');
        setWin(null);
      } else {
        setStreamErr(e?.message || '失败');
        setWin(null);
      }
    } finally {
      setStreaming(false);
      if (ok && resourceType === 'practice_pack') setWin('practice_pack');
    }
  };

  useEffect(() => {
    return () => {
      try {
        abortRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const closeModal = () => {
    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }
    resetStreamState();
  };

  const actionLabel = (key) => {
    if (key === 'practice_pack') return '生成并答题';
    if (key === 'mind_map') return '生成导图';
    return '生成';
  };

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col gap-0 overflow-hidden p-2 sm:p-3">
      <div className="shrink-0 space-y-2 border-b border-[#1a1f24]/[0.06] px-1 pb-3">
        <p className="text-[12px] leading-snug text-[#1a1f24]/48">
          当前范围：
          <span className="font-medium text-[#1a1f24]/78">{scopeLabel || '未选择'}</span>
        </p>
        <label className="pa-label block text-[10px] text-[#1a1f24]/35">额外要求（可选）</label>
        <textarea
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          rows={2}
          placeholder="如：侧重例题、考前提纲、补充难度…"
          className="studio-resource-hint w-full resize-none rounded-lg border border-[#1a1f24]/[0.1] bg-white px-3 py-2.5 text-[13px] leading-relaxed text-[#1a1f24]/85 outline-none transition-shadow placeholder:text-[#1a1f24]/28 focus:border-[#b8955c]/50 focus:shadow-[0_0_0_3px_rgba(184,149,92,0.12)]"
        />
        {!canGen && <p className="text-[11px] text-amber-800/90">请先在「章节目录」页签选择小节后再生成。</p>}
        {streamErr && !win && <p className="text-[11px] text-red-800">{streamErr}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-3 scrollbar-hide pb-4">
        <p className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#1a1f24]/38">资源类型</p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {resourceEntries.map((x) => (
            <div
              key={x.key}
              className={`rounded-xl border bg-white/95 p-3 shadow-[0_2px_12px_rgba(26,31,36,0.04)] transition-shadow ${
                activeKey === x.key ? 'border-[#b8955c]/50 ring-1 ring-[#b8955c]/20' : 'border-[#1a1f24]/[0.07]'
              }`}
            >
              <div className="text-[13px] font-semibold leading-snug text-[#1a1f24]">{x.title}</div>
              <div className="mt-1 line-clamp-1 font-mono text-[10px] text-[#1a1f24]/38">{x.chain}</div>
              <button
                type="button"
                disabled={streaming || !canGen}
                onClick={() => void startStream(x.key)}
                className="mt-2.5 w-full rounded-lg border border-[#1a1f24]/[0.1] bg-[#f6f4ef] py-2 text-[11px] font-semibold text-[#1a1f24]/78 transition-colors hover:border-[#b8955c]/45 hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                {streaming && activeKey === x.key ? '生成中…' : actionLabel(x.key)}
              </button>
            </div>
          ))}
        </div>
        {!overview?.resource_types && <p className="mt-3 text-center text-[12px] text-[#1a1f24]/40">正在加载资源类型…</p>}
      </div>

      {win === 'course_digest' && (
        <ChatDocResizableWindow
          open
          title="课程精讲文档"
          subtitle={scopeLabel || ''}
          markdown={streamDisplay}
          streaming={streaming}
          onClose={closeModal}
          onCancel={() => abortRef.current?.abort()}
        />
      )}
      {win === 'mind_map' && (
        <MermaidMindMapWindow
          open
          rawMarkdown={streamDisplay}
          streaming={streaming}
          onClose={closeModal}
          onCancel={() => abortRef.current?.abort()}
        />
      )}
      {win === 'extended_reading' && (
        <ExtendedReadingWindow
          open
          rawMarkdown={streamDisplay}
          streaming={streaming}
          onClose={closeModal}
          onCancel={() => abortRef.current?.abort()}
        />
      )}
      {win === 'code_lab' && (
        <CodeLabWorkshopWindow
          open
          rawMarkdown={streamDisplay}
          streaming={streaming}
          onClose={closeModal}
          onCancel={() => abortRef.current?.abort()}
        />
      )}
      {win === 'video_script' && <VideoScriptBoardWindow open rawMarkdown={streamDisplay} onClose={closeModal} />}
      {win === 'practice_pack' && (
        <PracticePackQuizWindow open={!!streamText} rawMarkdown={streamText} onClose={closeModal} />
      )}

      {streaming && activeKey === 'practice_pack' && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-[#1a1f24]/36 p-4 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="relative w-full max-w-[22rem] rounded-2xl border border-[#1a1f24]/[0.1] bg-gradient-to-b from-white to-[#faf9f7] px-7 py-9 shadow-[0_28px_80px_rgba(26,31,36,0.22)]">
            <div
              className="mx-auto mb-5 h-11 w-11 rounded-full border-2 border-[#1a1f24]/[0.08] border-t-[#b8955c] animate-spin"
              aria-hidden
            />
            <p className="text-center font-display text-[1.05rem] font-medium text-[#1a1f24]">正在生成题库</p>
            <p className="mt-2 text-center text-[13px] leading-relaxed text-[#1a1f24]/50">流式输出结束后将自动进入答题界面</p>
            {scopeLabel ? (
              <p className="mt-4 truncate text-center text-[11px] text-[#1a1f24]/38" title={scopeLabel}>
                {scopeLabel}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="mt-7 w-full rounded-xl border border-red-200/90 bg-red-50/95 py-2.5 text-[12px] font-semibold text-red-800 transition-colors hover:bg-red-100"
            >
              取消生成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
