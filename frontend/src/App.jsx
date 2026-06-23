import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { markdownRemarkPlugins, markdownRehypePlugins } from './markdownMathSetup';
import HeroTitle from './components/hero-motion/HeroTitle';
import ParticleField from './components/ParticleField';
import IntroLoader from './components/IntroLoader';
import DesignPreview, { AmbientField } from './components/DesignPreview';
import ClickRippleSurface from './components/ClickRippleSurface';
import PasswordVisibilityToggle from './components/PasswordVisibilityToggle';
import MindmapOutlineView from './components/MindmapOutlineView';
import { markdownToMarkmapOutline } from './utils/mindmapOutline';
import { decodeResourceMarkdownStream } from './utils/resourceStreamDecode';
import { parseStructuredVideoScript } from './utils/videoScriptParse';
import {
  StudioMentorOverviewModal,
  StudioPortraitCard,
  StudioPathPanel,
  StudioResourcePanel,
} from './components/LearningStudioBlocks';
import { API_BASE } from './apiConfig';
import 'katex/dist/katex.min.css';

const USERNAME_PATTERN = /^[\u3400-\u4DBF\u4E00-\u9FFFA-Za-z0-9_]{2,16}$/;
const sanitizeUsername = (value) =>
  String(value || '')
    .replace(/[^\u3400-\u4DBF\u4E00-\u9FFFA-Za-z0-9_]/g, '')
    .slice(0, 16);

// --- 内部组件：代码块 ---
const CodeBlock = ({ language, value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('复制失败', e);
    }
  };

  return (
    <div className="relative group my-4">
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 z-10 rounded-sm border border-[#1a1f24]/10 bg-white/90 px-2.5 py-1 text-[11px] font-medium tracking-wide text-[#1a1f24]/70 shadow-sm transition-all hover:bg-white opacity-0 group-hover:opacity-100"
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
};

// --- 数学公式轻量规范化（不再做「自动包 $」启发式，避免破坏已有 $…$、矩阵与下标等）---
const normalizeMathText = (text) => {
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
};

const ASK_USER_JSON_PREFIX = '__PA_USER_JSON__\n';
const MAX_CHAT_IMAGES = 5;
const SMALL_QUIZ_QUESTION_COUNT = 15;

const parseAskUserContent = (content) => {
  if (!content || typeof content !== 'string') return { text: '', images: [] };
  if (!content.startsWith(ASK_USER_JSON_PREFIX)) return { text: content, images: [] };
  try {
    const p = JSON.parse(content.slice(ASK_USER_JSON_PREFIX.length));
    const imgs = (p.img || [])
      .map((im) => {
        const m = im?.m || 'image/jpeg';
        const d = im?.d || '';
        if (!d) return null;
        return `data:${m};base64,${d}`;
      })
      .filter(Boolean);
    return { text: p.t || '', images: imgs };
  } catch {
    return { text: content, images: [] };
  }
};

const packUserAskForDisplay = (text, imageParts) => {
  if (!imageParts || !imageParts.length) return (text || '').trim();
  return (
    ASK_USER_JSON_PREFIX +
    JSON.stringify({
      v: 1,
      t: (text || '').trim(),
      img: imageParts.map((x) => ({ m: x.mediaType, d: x.dataB64 })),
    })
  );
};

const readImageAsBase64Part = (file) =>
  new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件'));
      return;
    }
    if (file.size > 3.5 * 1024 * 1024) {
      reject(new Error('单张图片请小于 3.5MB'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      if (i === -1) {
        reject(new Error('读取图片失败'));
        return;
      }
      resolve({ mediaType: file.type || 'image/jpeg', dataB64: s.slice(i + 1) });
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });

const UserMessageBody = ({ content }) => {
  const { text, images } = parseAskUserContent(content);
  return (
    <div className="space-y-3">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <a
              key={i}
              href={src}
              target="_blank"
              rel="noreferrer"
              className="block max-w-[min(100%,280px)] shrink-0 overflow-hidden rounded-lg border border-white/20"
            >
              <img src={src} alt="" className="max-h-52 w-auto object-contain" />
            </a>
          ))}
        </div>
      )}
      {text ? (
        <div className="prose prose-sm max-w-none prose-invert">
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={{
              code({ inline, className, children }) {
                const match = /language-(\w+)/.exec(className || '');
                return !inline && match ? (
                  <CodeBlock language={match[1]} value={String(children).replace(/\n$/, '')} />
                ) : (
                  <code className="rounded bg-white/12 px-1.5 py-0.5 font-mono text-[0.9em] text-[#e8d5a8]">{children}</code>
                );
              },
            }}
          >
            {normalizeMathText(text)}
          </ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
};

const Reveal = ({
  children,
  className = '',
  delay = 0,
  /** 看板等长列表：更短动画 + 略提前触发，滚动更跟手 */
  snappy = false,
}) => {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }

    let done = false;
    const mark = () => {
      if (done) return;
      done = true;
      setVisible(true);
    };

    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) mark();
      },
      {
        threshold: snappy ? 0.01 : 0.05,
        root: null,
        rootMargin: snappy ? '0px 0px 28% 0px' : '0px 0px 25% 0px',
      }
    );
    io.observe(el);

    const fallback = window.setTimeout(mark, snappy ? 900 : 2200);

    return () => {
      window.clearTimeout(fallback);
      io.disconnect();
    };
  }, [snappy]);

  return (
    <div
      ref={ref}
      className={`reveal-on-scroll ${snappy ? 'reveal-on-scroll--snappy' : ''} ${visible ? 'is-visible' : ''} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
};

// --- 1. 登录界面 ---
const formatApiDetail = (data) => {
  const d = data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d
      .map((x) => (typeof x === 'object' && x != null ? x.msg ?? JSON.stringify(x) : String(x)))
      .join('；');
  }
  return '';
};

const v29Subjects = [
  ['高等数学', '极限与导数', 'active', 74],
  ['线性代数', '矩阵空间', 'ready', 52],
  ['概率统计', '随机变量', 'ready', 38],
  ['机器学习', '梯度下降', 'active', 66],
  ['数据结构', '图与搜索', 'ready', 45],
  ['算法设计', '动态规划', 'next', 28],
  ['操作系统', '进程同步', 'next', 34],
  ['计算机网络', '拥塞控制', 'next', 31],
];

const v29CourseShowcase = [
  ['START HERE', '先看图像', '从一个会动的曲线想起'],
  ['LINE ROOM', '看见空间', '把矩阵想成一间房'],
  ['CHANCE MAP', '追踪可能', '用样本讲一个故事'],
  ['MODEL GARDEN', '慢慢调准', '观察模型如何靠近答案'],
  ['PATH FINDER', '找路练习', '让节点连成一条清晰路线'],
  ['IDEA SPLIT', '拆小问题', '把大题切成可走的小步'],
  ['TIME TABLE', '安排顺序', '看任务如何排队和交接'],
  ['SIGNAL FLOW', '传递消息', '理解信息怎样抵达终点'],
];

const v29MapNodes = [
  ['core', 49, 49, '当前'],
  ['a', 25, 28, '极限'],
  ['b', 67, 25, '导数'],
  ['c', 79, 54, '应用'],
  ['d', 35, 70, '错因'],
  ['e', 58, 78, '复习'],
];

const v29MapSmallNodes = [
  [18, 45],
  [30, 52],
  [43, 23],
  [53, 33],
  [63, 63],
  [73, 41],
  [84, 72],
  [22, 78],
  [46, 84],
  [72, 85],
  [13, 65],
  [90, 38],
];

const v29MapEdges = [
  [49, 49, 25, 28],
  [49, 49, 67, 25],
  [67, 25, 79, 54],
  [49, 49, 35, 70],
  [35, 70, 58, 78],
  [25, 28, 43, 23],
  [67, 25, 73, 41],
  [79, 54, 84, 72],
  [58, 78, 72, 85],
  [35, 70, 22, 78],
];

const v29PathItems = ['概念', '例题', '追问', '小测', '错因', '变式', '回顾', '总结'];

const v29ResourceModes = [
  ['course_digest', '速记卡', '把这一节收成一页清爽笔记。', 'warm'],
  ['practice_pack', '练一练', '用几道题摸清自己会到哪里。', 'violet'],
  ['extended_reading', '拓展阅读', '联网补充可信来源，再展开本节视野。', 'warm'],
  ['code_lab', '代码实操', '把方法落成可运行、可调试的小案例。', 'cool'],
  ['video_script', '讲给别人听', '整理成一段能说出口的短讲稿。', 'violet'],
];

const MATERIAL_RESOURCE_EXCLUDE = new Set(['mind_map']);

const clamp01 = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
};

const v29AbilityAxes = [
  { key: 'foundation', label: '理解', hint: '概念边界', angle: -90, base: 0.42 },
  { key: 'reasoning', label: '推理', hint: '步骤连贯', angle: -18, base: 0.36 },
  { key: 'expression', label: '表达', hint: '说清过程', angle: 54, base: 0.34 },
  { key: 'transfer', label: '迁移', hint: '换题可用', angle: 126, base: 0.3 },
  { key: 'review', label: '复盘', hint: '错因回收', angle: 198, base: 0.38 },
];

const V29PageShell = ({ children, variant = 'default' }) => (
  <section className={`dp2-stage dp2-stage-${variant}`}>
    <AmbientField dense={variant !== 'loading'} />
    <div className="dp2-page-wipe" />
    <div className="dp2-stage-inner">{children}</div>
  </section>
);

const V29Button = ({ children, quiet = false, type = 'button', ...props }) => (
  <button className={`dp2-button ${quiet ? 'is-quiet' : ''}`} type={type} {...props}>
    <span>{children}</span>
  </button>
);

const V29Field = ({ label, delay = 0, htmlFor, children }) => (
  <div className="dp2-field" style={{ animationDelay: `${delay}ms` }}>
    <label htmlFor={htmlFor}>{label}</label>
    {children}
  </div>
);

const qualitativeAbilityState = (value) => {
  const n = Number(value || 0);
  if (n >= 82) return '稳定展开';
  if (n >= 64) return '正在成形';
  if (n >= 46) return '需要练习';
  return '刚刚启动';
};

function V29RadarTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const current = payload.find((item) => item.dataKey === 'current');
  const rhythm = payload.find((item) => item.dataKey === 'rhythm');
  return (
    <div className="dp2-radar-tooltip">
      <strong>{label}</strong>
      <span>{current?.name || '当前'}：{qualitativeAbilityState(current?.value)}</span>
      <span>{rhythm?.name || '节奏'}：{qualitativeAbilityState(rhythm?.value)}</span>
    </div>
  );
}

const V29LearningMap = React.memo(function V29LearningMap({ profile = {} }) {
  const glowId = React.useId().replace(/:/g, '');
  const chartData = v29AbilityAxes.map((axis) => {
    const value = clamp01(profile[axis.key] ?? axis.base, axis.base);
    const rhythm = Math.max(0.28, axis.base + value * 0.36);
    return {
      ability: axis.label,
      hint: axis.hint,
      current: Math.round(value * 100),
      rhythm: Math.round(clamp01(rhythm) * 100),
    };
  });

  return (
    <div className="dp2-ability-map dp2-radar-map">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={chartData} margin={{ top: 10, right: 22, bottom: 8, left: 22 }}>
          <defs>
            <filter id={`multi-stroke-line-glow-${glowId}`} x="-35%" y="-35%" width="170%" height="170%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feColorMatrix
                in="blur"
                type="matrix"
                values="0 0 0 0 0.38 0 0 0 0 0.53 0 0 0 0 0.54 0 0 0 0.48 0"
                result="softGlow"
              />
              <feComposite in="SourceGraphic" in2="softGlow" operator="over" />
            </filter>
          </defs>
          <Tooltip cursor={false} content={<V29RadarTooltip />} />
          <PolarAngleAxis dataKey="ability" tickLine={false} tick={{ className: 'dp2-radar-tick' }} />
          <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
          <PolarGrid gridType="polygon" radialLines stroke="rgba(100,129,132,0.22)" />
          <Radar
            name="当前轮廓"
            dataKey="current"
            stroke="var(--dp2-radar-primary)"
            strokeWidth={1.6}
            fill="none"
            filter={`url(#multi-stroke-line-glow-${glowId})`}
            isAnimationActive={false}
          />
          <Radar
            name="复盘节奏"
            dataKey="rhythm"
            stroke="var(--dp2-radar-secondary)"
            strokeWidth={1.15}
            fill="none"
            filter={`url(#multi-stroke-line-glow-${glowId})`}
            isAnimationActive={false}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
});

const extractFencedCodeBlocks = (text) => {
  const blocks = [];
  const re = /(```|~~~)[ \t]*([^\n`]*)\n([\s\S]*?)\1/g;
  let match;
  while ((match = re.exec(text || '')) !== null) {
    const lang = (match[2] || 'text').trim().split(/\s+/)[0].toLowerCase() || 'text';
    if (lang === 'mermaid') continue;
    const code = match[3].replace(/\s+$/g, '');
    if (code.trim()) blocks.push({ lang, code });
  }
  return blocks;
};

const stripFencedCodeBlocks = (text) =>
  String(text || '')
    .replace(/(```|~~~)[ \t]*(?!mermaid\b)[^\n`]*\n[\s\S]*?\1/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function V29CodeResourceView({ markdown }) {
  const codeBlocks = useMemo(() => extractFencedCodeBlocks(markdown), [markdown]);
  const docMarkdown = useMemo(() => stripFencedCodeBlocks(markdown), [markdown]);
  const hasCode = codeBlocks.length > 0;

  return (
    <div className={`dp2-code-workbench ${hasCode ? 'has-code' : 'is-text-only'}`}>
      <div className="dp2-code-doc dp2-answer">
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
          components={{
            code({ inline, children }) {
              return inline ? <code>{children}</code> : <CodeBlock language="text" value={String(children).replace(/\n$/, '')} />;
            },
          }}
        >
          {normalizeMathText(docMarkdown || markdown)}
        </ReactMarkdown>
      </div>
      {hasCode && (
        <div className="dp2-code-stack" aria-label="代码片段">
          <span>CODE</span>
          {codeBlocks.map((block, index) => (
            <article key={`${block.lang}-${index}`} className="dp2-code-card">
              <div className="dp2-code-card-head">
                <strong>{block.lang || 'text'}</strong>
                <small>{String(index + 1).padStart(2, '0')}</small>
              </div>
              <CodeBlock language={block.lang || 'text'} value={block.code} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

const extractMarkdownLinks = (text) => {
  const links = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = re.exec(text || '')) !== null) {
    links.push({ title: match[1].trim(), url: match[2].trim() });
  }
  return links.filter((item, index, arr) => arr.findIndex((x) => x.url === item.url) === index).slice(0, 6);
};

function V29ExtendedReadingView({ markdown }) {
  const links = useMemo(() => extractMarkdownLinks(markdown), [markdown]);

  return (
    <div className="dp2-reading-workbench">
      <div className="dp2-resource-markdown dp2-answer">
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
          components={{
            code({ inline, className, children }) {
              const match = /language-(\w+)/.exec(className || '');
              return !inline && match ? (
                <CodeBlock language={match[1]} value={String(children).replace(/\n$/, '')} />
              ) : (
                <code>{children}</code>
              );
            },
          }}
        >
          {normalizeMathText(markdown)}
        </ReactMarkdown>
      </div>
      <aside className="dp2-source-rail" aria-label="拓展阅读信息来源">
        <span>来源</span>
        {links.length ? (
          links.map((link, index) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
              <b>{String(index + 1).padStart(2, '0')}</b>
              <em>{link.title}</em>
            </a>
          ))
        ) : (
          <p>生成后会在这里汇总可打开的来源。</p>
        )}
      </aside>
    </div>
  );
}

function splitV29VideoScriptToShots(markdown) {
  const t = String(markdown || '').trim();
  if (!t) return [];
  const headerParts = t.split(/\n(?=#{1,6}\s)/g).map((part) => part.trim()).filter(Boolean);
  if (headerParts.length > 1) {
    return headerParts.map((part, index) => ({
      id: index,
      shotNo: index + 1,
      title: part.split('\n')[0].replace(/^#+\s*/, '').slice(0, 72) || `镜头 ${index + 1}`,
      subtitle: '',
      markdown: part,
    }));
  }

  const shotPatterns = [
    /\n(?=\*{0,2}(?:镜号|分镜|镜头|场景|画面)(?:[：:]|＿|\s))/,
    /\n(?=【[^】]{1,48}】)/,
    /\n(?=(?:镜号|分镜|镜头|场景)\s*[：:])/,
    /\n(?=\d{1,2}[\.、]\s*(?:\*\*)?(?:镜|镜头|分镜|画面))/,
    /\n(?=第[一二三四五六七八九十百千零〇\d]+(?:镜|段|场))/,
  ];

  for (const re of shotPatterns) {
    const parts = t.split(re).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts.map((part, index) => ({
        id: index,
        shotNo: index + 1,
        title: part.split('\n')[0].replace(/^#+\s*/, '').replace(/^\*\*\s*/, '').slice(0, 72) || `镜头 ${index + 1}`,
        subtitle: '',
        markdown: part,
      }));
    }
  }

  const paras = t.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paras.length > 2) {
    return paras.map((part, index) => ({
      id: index,
      shotNo: index + 1,
      title: `段落 ${index + 1}`,
      subtitle: '',
      markdown: part,
    }));
  }

  return [{ id: 0, shotNo: 1, title: '完整讲稿', subtitle: '', markdown: t }];
}

function V29VideoScriptView({ markdown, streaming }) {
  const { meta, shots } = useMemo(() => {
    const structured = parseStructuredVideoScript(markdown || '');
    if (structured?.shots?.length) return structured;
    return { meta: null, shots: splitV29VideoScriptToShots(markdown) };
  }, [markdown]);

  return (
    <div className="dp2-video-script-workbench">
      <header className="dp2-video-script-head">
        <span>{streaming ? '脚本生成中' : '可讲述脚本'}</span>
        <p>{meta?.title || '按镜头拆开，边看边改，适合直接录制或口头复述。'}</p>
        {(meta?.chapter || meta?.totalDuration) && <small>{[meta.chapter, meta.totalDuration].filter(Boolean).join(' · ')}</small>}
      </header>
      <div className="dp2-video-shot-list">
        {shots.length ? (
          shots.map((shot, index) => (
            <article key={shot.id ?? index} className="dp2-video-shot">
              <div className="dp2-video-shot-no">
                <b>{String(shot.shotNo ?? index + 1).padStart(2, '0')}</b>
                {shot.subtitle && <small>{shot.subtitle}</small>}
              </div>
              <div className="dp2-video-shot-body dp2-answer">
                <h4>{shot.title}</h4>
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={{
                    code({ inline, className, children }) {
                      const match = /language-(\w+)/.exec(className || '');
                      return !inline && match ? (
                        <CodeBlock language={match[1]} value={String(children).replace(/\n$/, '')} />
                      ) : (
                        <code>{children}</code>
                      );
                    },
                  }}
                >
                  {normalizeMathText(shot.markdown)}
                </ReactMarkdown>
              </div>
            </article>
          ))
        ) : (
          <p>生成后会在这里按镜头展开脚本。</p>
        )}
      </div>
    </div>
  );
}

function V29InlineMindMap({ markdown, streaming, compact = false }) {
  const hasText = !!String(markdown || '').trim();
  return (
    <div className={`dp2-inline-mindmap ${compact ? 'is-compact' : ''}`}>
      {hasText || streaming ? (
        <MindmapOutlineView fullMarkdown={markdown || ''} streaming={streaming} compact={compact} />
      ) : (
        <div className={`dp2-markmap-state ${compact ? 'is-compact' : ''}`}>
          选择小节后生成知识导图。
        </div>
      )}
    </div>
  );
}

function buildSectionMindMapFallback({ subject, chapter, section, progressState }) {
  if (!chapter || !section) return '';
  const siblings = Array.isArray(chapter.sections) ? chapter.sections : [];
  const currentIndex = siblings.findIndex((s) => s.id === section.id);
  const before = siblings.slice(Math.max(0, currentIndex - 2), currentIndex).map((s) => s.title);
  const after = siblings.slice(currentIndex + 1, currentIndex + 3).map((s) => s.title);
  const state = progressState?.small_quiz_passed
    ? '已完成小测'
    : progressState?.learn_turns
      ? '正在形成理解'
      : '准备进入';

  return [
    `# ${section.title}`,
    '',
    `- 课程位置`,
    `  - ${subject || '当前课程'}`,
    `  - ${chapter.title}`,
    `- 当前任务`,
    `  - ${state}`,
    `  - 先确认定义边界`,
    `  - 再梳理方法和误区`,
    `- 前后关联`,
    ...(before.length ? before.map((title) => `  - 前置：${title}`) : ['  - 前置：回看本章核心概念']),
    `  - 当前：${section.title}`,
    ...(after.length ? after.map((title) => `  - 后续：${title}`) : ['  - 后续：进入章节小测']),
    `- 练习观察`,
    `  - 能否说清为什么`,
    `  - 能否独立做一道相邻题`,
    `  - 能否指出易错条件`,
  ].join('\n');
}

function V29LearningMapPanel({
  scopeLabel,
  abilityProfile,
  mindMapMarkdown,
  mindMapFallbackMarkdown,
  mindMapStreaming,
  mindMapErr,
  canGenerate,
  onGenerate,
}) {
  const hasGeneratedMindMap = !!String(mindMapMarkdown || '').trim();
  const displayMindMap = hasGeneratedMindMap ? mindMapMarkdown : mindMapFallbackMarkdown;
  const hasDisplayMindMap = !!String(displayMindMap || '').trim();
  const showMindMap = hasDisplayMindMap || mindMapStreaming;

  return (
    <div className={`dp2-map-workspace ${showMindMap ? 'has-mindmap' : ''}`}>
      <div className="dp2-map-toolbar">
        <span>{scopeLabel || '先选一个小节'}</span>
        <button type="button" onClick={onGenerate} disabled={!canGenerate || mindMapStreaming}>
          {mindMapStreaming ? '生成中' : hasGeneratedMindMap ? '刷新导图' : '生成导图'}
        </button>
      </div>
      <section className="dp2-map-base" aria-label="学习能力图">
        <div className="dp2-map-panel-head">
          <span>学习能力图</span>
          <small>轮廓变化</small>
        </div>
        <V29LearningMap profile={abilityProfile} />
      </section>
      <section className="dp2-map-insight" aria-label="当前小节思维导图">
        <div className="dp2-map-panel-head">
          <span>知识导图</span>
          <small>{hasGeneratedMindMap ? '生成结构' : hasDisplayMindMap ? '本地结构' : '待生成'}</small>
        </div>
        <V29InlineMindMap markdown={displayMindMap} streaming={mindMapStreaming} compact />
      </section>
      {mindMapErr && <p className="dp2-map-error">{mindMapErr}</p>}
    </div>
  );
}

function V29ResourceWorkspace({
  apiBase,
  username,
  subject,
  chapterId,
  sectionId,
  scopeLabel,
  onBack,
  onMindMapReady,
}) {
  const [overview, setOverview] = useState(null);
  const [activeKey, setActiveKey] = useState(v29ResourceModes[0][0]);
  const [resourceDrafts, setResourceDrafts] = useState({});
  const [streamingKey, setStreamingKey] = useState('');
  const abortRef = useRef(null);

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
      try {
        abortRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, [apiBase]);

  const resourceEntries = useMemo(() => {
    const apiTypes = overview?.resource_types;
    const fallback = v29ResourceModes
      .filter(([key]) => !MATERIAL_RESOURCE_EXCLUDE.has(key))
      .map(([key, title, desc, tone]) => ({ key, title, desc, tone }));
    if (!apiTypes || typeof apiTypes !== 'object') return fallback;

    const toneByKey = Object.fromEntries(v29ResourceModes.map(([key, , , tone]) => [key, tone]));
    const descByKey = Object.fromEntries(v29ResourceModes.map(([key, , desc]) => [key, desc]));
    const list = Object.entries(apiTypes)
      .filter(([key]) => !MATERIAL_RESOURCE_EXCLUDE.has(key))
      .map(([key, value]) => ({
        key,
        title: value?.title || fallback.find((x) => x.key === key)?.title || key,
        desc: descByKey[key] || '按当前小节整理一份顺手材料。',
        tone: toneByKey[key] || 'warm',
      }));

    return list.length ? list : fallback;
  }, [overview]);

  useEffect(() => {
    if (!resourceEntries.length) return;
    if (!resourceEntries.some((entry) => entry.key === activeKey)) {
      setActiveKey(resourceEntries[0].key);
    }
  }, [resourceEntries, activeKey]);

  const activeEntry = resourceEntries.find((x) => x.key === activeKey) || resourceEntries[0];
  const activeDraft = resourceDrafts[activeEntry?.key] || { text: '', err: '' };
  const streamText = activeDraft.text || '';
  const streamErr = activeDraft.err || '';
  const streaming = !!streamingKey;
  const activeStreaming = streamingKey === activeEntry?.key;
  const streamDisplay = useMemo(() => decodeResourceMarkdownStream(streamText), [streamText]);
  const canGenerate = !!(chapterId && sectionId && activeEntry?.key);

  const startResource = async (key = activeEntry?.key) => {
    const nextKey = key || activeEntry?.key;
    if (!nextKey) return;
    setActiveKey(nextKey);
    setResourceDrafts((prev) => ({ ...prev, [nextKey]: { text: '', err: '' } }));

    if (!chapterId || !sectionId) {
      setResourceDrafts((prev) => ({ ...prev, [nextKey]: { text: '', err: '先选一个小节，我才能为它准备材料。' } }));
      return;
    }

    try {
      abortRef.current?.abort();
    } catch {
      /* ignore */
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setStreamingKey(nextKey);

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
          resource_type: nextKey,
          extra_hint: '',
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

      if (!r.body) throw new Error('这次没有生成内容，请再试一次。');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setResourceDrafts((prev) => ({ ...prev, [nextKey]: { text: acc, err: '' } }));
      }

      acc += decoder.decode();
      setResourceDrafts((prev) => ({ ...prev, [nextKey]: { text: acc, err: '' } }));
      if (nextKey === 'mind_map') onMindMapReady?.(decodeResourceMarkdownStream(acc));
    } catch (e) {
      if (e?.name !== 'AbortError') {
        setResourceDrafts((prev) => ({
          ...prev,
          [nextKey]: { text: '', err: e?.message || '材料准备失败，请稍后再试。' },
        }));
      }
    } finally {
      setStreamingKey((current) => (current === nextKey ? '' : current));
    }
  };

  const clearActiveResource = () => {
    if (!activeEntry?.key) return;
    setResourceDrafts((prev) => ({ ...prev, [activeEntry.key]: { text: '', err: '' } }));
  };

  return (
    <V29PageShell variant="resources">
      <div className="dp2-resources">
        <div className="dp2-resource-toolbar">
          <button type="button" className="dp2-resource-back" onClick={onBack}>
            <span aria-hidden>←</span>
            <b>回到学习</b>
          </button>
          <section className="dp2-resource-title" aria-label="当前素材范围">
            <p>{scopeLabel ? `正在把「${scopeLabel}」整理成可带走的材料` : '先回到学习页点亮一个小节。'}</p>
          </section>
        </div>

        <div className="dp2-resource-layout">
          <aside className="dp2-resource-controls">
            <nav className="dp2-resource-modes" aria-label="学习素材类型">
              {resourceEntries.map((entry, index) => (
                <button
                  key={entry.key}
                  className={`dp2-resource-mode is-${entry.tone} ${entry.key === activeEntry?.key ? 'is-active' : ''}`}
                  type="button"
                  style={{ animationDelay: `${index * 70}ms` }}
                  aria-pressed={entry.key === activeEntry?.key}
                  onClick={() => setActiveKey(entry.key)}
                >
                  <span>{entry.title}</span>
                  <small>{entry.desc}</small>
                </button>
              ))}
            </nav>
            <div className="dp2-resource-actions dp2-actions">
              <V29Button onClick={() => void startResource()} disabled={streaming || !canGenerate}>
                {activeStreaming ? '整理中' : '开始整理'}
              </V29Button>
              <V29Button
                quiet
                onClick={clearActiveResource}
                disabled={streaming || (!streamText && !streamErr)}
              >
                清空
              </V29Button>
            </div>
          </aside>

          <section className="dp2-resource-panel">
            <div className="dp2-resource-output">
              <div className="dp2-resource-output-head">
                <div>
                  <span>{activeStreaming ? 'ARRANGING' : streamText ? 'READY' : 'PREVIEW'}</span>
                  <h3>{activeEntry?.title || '小节素材'}</h3>
                </div>
              </div>
              {streamErr ? (
                <p>{streamErr}</p>
              ) : streamText ? (
                activeEntry?.key === 'mind_map' ? (
                  <div className="dp2-resource-mindmap">
                    <V29InlineMindMap markdown={streamDisplay} streaming={streaming} />
                    <p>导图已附加到学习页左侧，学习能力图会继续保留。回到学习后可以对照当前小节查看。</p>
                  </div>
                ) : activeEntry?.key === 'extended_reading' ? (
                  <V29ExtendedReadingView markdown={streamDisplay} />
                ) : activeEntry?.key === 'code_lab' ? (
                  <V29CodeResourceView markdown={streamDisplay} />
                ) : activeEntry?.key === 'video_script' ? (
                  <V29VideoScriptView markdown={streamDisplay} streaming={activeStreaming} />
                ) : (
                  <div className="dp2-resource-markdown dp2-answer">
                    <ReactMarkdown
                      remarkPlugins={markdownRemarkPlugins}
                      rehypePlugins={markdownRehypePlugins}
                      components={{
                        code({ inline, className, children }) {
                          const match = /language-(\w+)/.exec(className || '');
                          return !inline && match ? (
                            <CodeBlock language={match[1]} value={String(children).replace(/\n$/, '')} />
                          ) : (
                            <code>{children}</code>
                          );
                        },
                      }}
                    >
                      {normalizeMathText(streamDisplay)}
                    </ReactMarkdown>
                  </div>
                )
              ) : (
                <>
                  <p>{canGenerate ? '选一种形式，我把这一节整理成更顺手的材料。' : '还没有选中小节，先回学习页点一下目录。'}</p>
                  <div className="dp2-resource-lines" aria-hidden>
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </V29PageShell>
  );
}

const LoginView = ({ onLoginSuccess }) => {
  const [authStep, setAuthStep] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [tokenReady, setTokenReady] = useState(false);
  const [resetHint, setResetHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [shake, setShake] = useState(false);

  const passwordRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('reset') !== '1') return;
    const u = sanitizeUsername(params.get('username') || '');
    const t = (params.get('token') || '').replace(/\s/g, '');
    if (u.length >= 2 && t.length >= 16) {
      setUsername(u);
      setResetToken(t);
      setAuthStep('forgot-reset');
      setTokenReady(false);
      setErrorMsg('');
      setSuccessMsg('');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash || ''}`);
    }
  }, []);

  useEffect(() => {
    setShowPassword(false);
    setShowConfirmPassword(false);
    if (authStep === 'forgot') return;
    const timer = setTimeout(() => passwordRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [authStep]);

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  const handleAuthSubmit = async () => {
    if (loading) return;
    const cleanUsername = username.trim();
    const cleanPassword = password.trim();
    const cleanConfirm = confirmPassword.trim();
    const cleanToken = resetToken.trim();
    const cleanRegEmail = regEmail.trim();
    const cleanForgotEmail = forgotEmail.trim().toLowerCase();

    /* 注册 / 重置：仅大小写字母与数字，且须同时含大写、小写、数字；6-20 位 */
    const passwordRegisterRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9]{6,20}$/;
    const emailRegex = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/;

    if (authStep === 'forgot') {
      if (tokenReady) {
        setAuthStep('forgot-reset');
        setErrorMsg('');
        return;
      }
      if (!cleanForgotEmail) {
        setErrorMsg('请输入注册邮箱');
        triggerShake();
        return;
      }
      if (!emailRegex.test(cleanForgotEmail)) {
        setErrorMsg('邮箱格式不正确');
        triggerShake();
        return;
      }
    }

    if (authStep === 'forgot-reset') {
      if (!cleanUsername) {
        setErrorMsg('请设置新昵称');
        triggerShake();
        return;
      }
      if (!USERNAME_PATTERN.test(cleanUsername)) {
        setErrorMsg('新昵称需为 2-16 位中文、英文、数字或下划线');
        triggerShake();
        return;
      }
      if (!cleanToken) {
        setErrorMsg('请输入重置令牌');
        triggerShake();
        return;
      }
      if (!cleanPassword) {
        setErrorMsg('请输入新密码');
        triggerShake();
        return;
      }
      if (!passwordRegisterRegex.test(cleanPassword)) {
        setErrorMsg('密码须为 6-20 位，只能包含大小写字母与数字，且需同时含有大写、小写与数字');
        triggerShake();
        return;
      }
      if (cleanPassword !== cleanConfirm) {
        setErrorMsg('两次输入的密码不一致');
        triggerShake();
        return;
      }
    }

    if (authStep === 'login' || authStep === 'register') {
      if (!cleanUsername) {
        setErrorMsg('请输入昵称');
        triggerShake();
        return;
      }
      if (!USERNAME_PATTERN.test(cleanUsername)) {
        setErrorMsg('昵称需为 2-16 位中文、英文、数字或下划线');
        triggerShake();
        return;
      }
      if (!cleanPassword) {
        setErrorMsg('请输入密码');
        triggerShake();
        return;
      }
      if (authStep === 'register' && !passwordRegisterRegex.test(cleanPassword)) {
        setErrorMsg('密码须为 6-20 位，只能包含大小写字母与数字，且需同时含有大写、小写与数字');
        triggerShake();
        return;
      }
      if (authStep === 'register' && !cleanConfirm) {
        setErrorMsg('请再次输入密码');
        triggerShake();
        return;
      }
      if (authStep === 'register' && cleanPassword !== cleanConfirm) {
        setErrorMsg('两次输入的密码不一致');
        triggerShake();
        return;
      }
      if (authStep === 'register' && !cleanRegEmail) {
        setErrorMsg('请填写邮箱，用于找回密码');
        triggerShake();
        return;
      }
      if (authStep === 'register' && !emailRegex.test(cleanRegEmail)) {
        setErrorMsg('邮箱格式不正确');
        triggerShake();
        return;
      }
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      if (authStep === 'forgot') {
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 45000);
        let response;
        try {
          response = await fetch(`${API_BASE}/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: cleanForgotEmail }),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(tid);
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = formatApiDetail(data);
          if (response.status === 429) {
            setErrorMsg(detail || '请求过于频繁，请稍后再试');
            triggerShake();
            return;
          }
          if (response.status === 502 || response.status === 503 || response.status === 504) {
            setErrorMsg(
              '网关或服务暂时不可用（502/503/504）。常见于托管实例休眠、重启或请求超时。请隔一分钟再试；若静态资源也同时报错，请到 Render 面板查看服务是否在线与日志。'
            );
            triggerShake();
            return;
          }
          if (response.status === 404 && detail === 'Not Found') {
            setErrorMsg(
              '未找到「找回密码」接口：后端可能未加载最新代码。请重启后端，并在 API 文档（/docs）中搜索 forgot-password 确认。'
            );
          } else {
            setErrorMsg(detail || '获取重置失败');
          }
          triggerShake();
          return;
        }
        setResetToken('');
        setResetHint(typeof data.message === 'string' ? data.message : '');
        setTokenReady(true);
      } else if (authStep === 'forgot-reset') {
        const response = await fetch(`${API_BASE}/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: cleanUsername,
            reset_token: cleanToken,
            password: cleanPassword,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = formatApiDetail(data);
          if (response.status === 404 && detail === 'Not Found') {
            setErrorMsg(
              '未找到「重置密码」接口：请重启后端，并在 API 文档（/docs）中搜索 reset-password 确认路由已加载。'
            );
          } else {
            setErrorMsg(detail || '重置失败');
          }
          triggerShake();
          return;
        }
        if (typeof data.username === 'string' && data.username) {
          setUsername(data.username);
        }
        setAuthStep('login');
        setPassword('');
        setConfirmPassword('');
        setResetToken('');
        setTokenReady(false);
        setResetHint('');
        setForgotEmail('');
        setShowPassword(false);
        setShowConfirmPassword(false);
        setSuccessMsg(typeof data.message === 'string' ? data.message : '密码已重置，请使用新昵称和新密码登录');
      } else {
        const url = `${API_BASE}/${authStep}`;
        if (authStep === 'register') {
          const checkResponse = await fetch(
            `${API_BASE}/user-exists?username=${encodeURIComponent(cleanUsername)}`
          );
          const checkData = await checkResponse.json().catch(() => ({}));
          if (!checkResponse.ok) {
            setErrorMsg(formatApiDetail(checkData) || '无法校验昵称是否可用，请稍后再试');
            triggerShake();
            return;
          }
          if (checkData.exists) {
            setErrorMsg('该昵称已被占用，请换一个');
            triggerShake();
            return;
          }
        }
        const regBody =
          authStep === 'register'
            ? {
                username: cleanUsername,
                password: cleanPassword,
                confirm_password: cleanConfirm,
                email: cleanRegEmail,
              }
            : { username: cleanUsername, password: cleanPassword };
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(regBody),
        });

        const data = await response.json().catch(() => ({}));

        if (response.ok) {
          onLoginSuccess(cleanUsername);
        } else {
          setErrorMsg(formatApiDetail(data) || '验证失败');
          triggerShake();
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        setErrorMsg('请求超时，请检查网络或稍后再试');
      } else {
        setErrorMsg('服务连接失败');
      }
      triggerShake();
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleAuthSubmit();
  };

  const authVisual = {
    login: {
      eyebrow: 'BACK',
      title: '回到你的学习场',
      body: '从上次停下的地方继续。',
      heading: '进入 Mentor',
      notes: ['保留进度', '接上对话', '继续探索'],
      primary: '登录',
      secondary: '找回密码',
    },
    register: {
      eyebrow: 'NEW',
      title: '开一条新的学习线',
      body: '留下邮箱，之后能找回账号。',
      heading: '创建账号',
      notes: ['昵称不重复', '邮箱可找回', '密码更稳妥'],
      primary: '注册',
      secondary: '返回登录',
    },
    forgot: {
      eyebrow: 'FIND',
      title: '找回你的入口',
      body: '输入注册邮箱，收一枚临时令牌。',
      heading: '找回密码',
      notes: ['只发令牌', '短时有效', '重新设置'],
      primary: tokenReady ? '继续重置' : '发送令牌',
      secondary: '返回登录',
    },
    'forgot-reset': {
      eyebrow: 'RESET',
      title: '换一个新起点',
      body: '贴上令牌，再设置新昵称和新密码。',
      heading: '重置密码',
      notes: ['令牌核对', '昵称可用', '重新进入'],
      primary: '确认重置',
      secondary: '返回找回',
    },
  }[authStep] || {};

  const goLogin = () => {
    setAuthStep('login');
    setPassword('');
    setConfirmPassword('');
    setErrorMsg('');
    setSuccessMsg('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setTokenReady(false);
    setResetToken('');
    setResetHint('');
    setForgotEmail('');
    setRegEmail('');
  };

  return (
    <V29PageShell variant="auth">
      <div className="dp2-auth">
        <aside className="dp2-auth-story">
          <div className="dp2-mini-label">{authVisual.eyebrow}</div>
          <h2>{authVisual.title}</h2>
          <p>{authVisual.body}</p>
          <div className="dp2-short-rule" />
          <div className="dp2-auth-constellation" aria-hidden>
            {(authVisual.notes || []).map((note, index) => (
              <span key={note} style={{ '--i': index }}>{note}</span>
            ))}
          </div>
        </aside>

        <section className="dp2-auth-form">
          <div className="dp2-form-heading">
            <span>ACCOUNT</span>
            <h3>{authVisual.heading}</h3>
          </div>

          <div className="dp2-form-lines">
            {authStep === 'forgot' ? (
              <V29Field label="邮箱" htmlFor="auth-forgot-email" delay={0}>
                <input
                  id="auth-forgot-email"
                  type="email"
                  autoComplete="email"
                  maxLength={255}
                  placeholder="注册邮箱"
                  value={forgotEmail}
                  onChange={(e) => {
                    setForgotEmail(e.target.value);
                    if (errorMsg) setErrorMsg('');
                    if (successMsg) setSuccessMsg('');
                  }}
                  onKeyDown={handleKeyDown}
                />
              </V29Field>
            ) : (
              <V29Field
                label={authStep === 'forgot-reset' ? '新昵称' : '昵称'}
                htmlFor="auth-username"
                delay={0}
              >
                <input
                  id="auth-username"
                  type="text"
                  autoComplete="username"
                  maxLength={16}
                  placeholder={authStep === 'forgot-reset' ? '设置新昵称' : '输入昵称'}
                  value={username}
                  onChange={(e) => {
                    setUsername(sanitizeUsername(e.target.value));
                    if (errorMsg) setErrorMsg('');
                    if (successMsg) setSuccessMsg('');
                  }}
                  onKeyDown={handleKeyDown}
                />
              </V29Field>
            )}

            {authStep === 'register' && (
              <V29Field label="邮箱" htmlFor="auth-register-email" delay={70}>
                <input
                  id="auth-register-email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={255}
                  placeholder="注册邮箱"
                  value={regEmail}
                  onChange={(e) => {
                    setRegEmail(e.target.value);
                    if (errorMsg) setErrorMsg('');
                    if (successMsg) setSuccessMsg('');
                  }}
                  onKeyDown={handleKeyDown}
                />
              </V29Field>
            )}

            {authStep === 'forgot-reset' && (
              <V29Field label="令牌" htmlFor="auth-reset-token" delay={70}>
                <input
                  id="auth-reset-token"
                  type="text"
                  maxLength={128}
                  placeholder="邮件令牌"
                  value={resetToken}
                  onChange={(e) => {
                    setResetToken(e.target.value.replace(/\s/g, ''));
                    if (errorMsg) setErrorMsg('');
                  }}
                  onKeyDown={handleKeyDown}
                />
              </V29Field>
            )}

            {(authStep === 'login' || authStep === 'register' || authStep === 'forgot-reset') && (
              <V29Field
                label={authStep === 'forgot-reset' ? '新密码' : '密码'}
                htmlFor="auth-password"
                delay={authStep === 'login' ? 70 : 140}
              >
                <div className="dp2-password-control">
                  <input
                    id="auth-password"
                    ref={passwordRef}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={authStep === 'login' ? 'current-password' : 'new-password'}
                    maxLength={authStep === 'login' ? 128 : 20}
                    placeholder={authStep === 'login' ? '输入密码' : '安全密码'}
                    value={password}
                    onChange={(e) => {
                      const val = authStep === 'login' ? e.target.value : e.target.value.replace(/[^A-Za-z0-9]/g, '');
                      setPassword(val);
                      if (errorMsg) setErrorMsg('');
                      if (successMsg) setSuccessMsg('');
                    }}
                    onKeyDown={handleKeyDown}
                  />
                  <PasswordVisibilityToggle
                    visible={showPassword}
                    onToggle={() => setShowPassword((current) => !current)}
                    label={authStep === 'forgot-reset' ? '新密码' : '密码'}
                  />
                </div>
              </V29Field>
            )}

            {(authStep === 'register' || authStep === 'forgot-reset') && (
              <V29Field label="确认密码" htmlFor="auth-confirm-password" delay={210}>
                <div className="dp2-password-control">
                  <input
                    id="auth-confirm-password"
                    type={showConfirmPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    maxLength={20}
                    placeholder={authStep === 'register' ? '再次输入密码' : '再次输入新密码'}
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value.replace(/[^A-Za-z0-9]/g, ''));
                      if (errorMsg) setErrorMsg('');
                    }}
                    onKeyDown={handleKeyDown}
                  />
                  <PasswordVisibilityToggle
                    visible={showConfirmPassword}
                    onToggle={() => setShowConfirmPassword((current) => !current)}
                    label="确认密码"
                  />
                </div>
              </V29Field>
            )}

            {tokenReady && authStep === 'forgot' && (
              <p className="text-[0.78rem] leading-6 text-[#33403f]/60">
                {resetHint || '请到注册邮箱查收令牌，然后继续设置新昵称和新密码。'}
              </p>
            )}
            {successMsg && <p className="text-[0.78rem] leading-6 text-emerald-700">{successMsg}</p>}
            {errorMsg && <p className="text-[0.78rem] leading-6 text-red-700">{errorMsg}</p>}
          </div>

          <div className="dp2-actions">
            <V29Button onClick={handleAuthSubmit}>
              {loading ? '处理中' : authVisual.primary}
            </V29Button>
            {authStep === 'login' && (
              <V29Button quiet onClick={() => {
                setAuthStep('forgot');
                setPassword('');
                setConfirmPassword('');
                setErrorMsg('');
                setSuccessMsg('');
                setTokenReady(false);
                setResetToken('');
                setResetHint('');
                setRegEmail('');
                setForgotEmail('');
                setUsername('');
              }}>
                {authVisual.secondary}
              </V29Button>
            )}
            {authStep === 'register' && <V29Button quiet onClick={goLogin}>{authVisual.secondary}</V29Button>}
            {authStep === 'forgot' && (
              <V29Button quiet onClick={() => {
                if (tokenReady) {
                  setAuthStep('forgot-reset');
                  setErrorMsg('');
                  return;
                }
                goLogin();
              }}>
                {tokenReady ? '继续重置' : authVisual.secondary}
              </V29Button>
            )}
            {authStep === 'forgot-reset' && <V29Button quiet onClick={() => setAuthStep('forgot')}>{authVisual.secondary}</V29Button>}
            {authStep === 'login' && <V29Button quiet onClick={() => setAuthStep('register')}>创建账号</V29Button>}
          </div>
        </section>
      </div>
    </V29PageShell>
  );

  return (
    <div className="pa-page dp2-live-auth relative flex h-dvh max-h-dvh flex-col overflow-hidden bg-[#f6f4ef] text-[#1a1f24] pa-grain">
      <div
        className="pa-orb pa-orb-1 -right-[12%] top-[-18%] h-[min(52vw,520px)] w-[min(52vw,520px)] bg-[radial-gradient(circle_at_center,rgba(184,149,92,0.35),transparent_68%)]"
        aria-hidden
      />
      <div
        className="pa-orb pa-orb-2 -left-[18%] bottom-[-22%] h-[min(48vw,480px)] w-[min(48vw,480px)] bg-[radial-gradient(circle_at_center,rgba(26,31,36,0.06),transparent_70%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 pa-drift-slow opacity-[0.45]"
        style={{
          background:
            'linear-gradient(105deg, transparent 0%, rgba(184,149,92,0.06) 38%, transparent 62%)',
        }}
        aria-hidden
      />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-[48%] pa-curve-field-light" aria-hidden />

      <div className="pa-scroll-rail left-4 hidden py-10 md:left-6 md:flex" aria-hidden>
        <span className="pa-scroll-label">Scroll</span>
        <div className="pa-vscan" />
      </div>

      <ParticleField />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col justify-center overflow-hidden px-6 py-8 md:px-12 md:pl-16 lg:w-[min(52%,36rem)] lg:max-w-[36rem] lg:py-6 lg:pl-20 lg:pr-8">
          <div className="min-h-0 w-full max-w-xl min-w-0">
            {/* 上方小文字：hero-stagger 只管这几行 */}
            <div className="hero-stagger">
              <p className="pa-label text-[10px] font-medium text-[#1a1f24]/40 pa-underline-draw">Mentor Academic Suite</p>
              <p className="mt-2 font-display text-sm font-medium italic text-[#1a1f24]/45 md:text-base">
                Nurturing your focus with thoughtful learning.
              </p>
              <div className="mt-4 h-px w-28 bg-gradient-to-r from-[#b8955c] to-transparent pa-line-in" />
            </div>

            <HeroTitle
              className="mt-5"
              titleLines={['Mentor']}
              subtitleLines={['为每一次深度学习，', '备好一手。']}
              enterDelay={550}
            />

            <div className="mt-6 pa-divider" aria-hidden />
          </div>
        </section>

        <section className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 py-6 md:px-8">
          <div className={`scrollbar-hide relative max-h-full w-full max-w-[440px] overflow-y-auto ${shake ? 'animate-[shake_0.45s_ease-in-out]' : ''}`}>
            <div className="group relative overflow-hidden border border-[#1a1f24]/[0.07] bg-white/90 shadow-[0_28px_90px_rgba(26,31,36,0.08)] backdrop-blur-xl">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#b8955c]/50 to-transparent" />
              {/* PA 式四角装饰线 */}
              <div className="pa-corners" aria-hidden>
                <span />
              </div>
              {/* PA 式顶部光条 */}
              <div className="pa-hline-runner absolute inset-x-0 top-0" aria-hidden />

              <div className="space-y-8 p-8 md:p-10">
                <div className="flex items-center justify-between gap-4">
                  <div className="inline-flex items-center gap-3 text-[11px] font-semibold tracking-[0.22em] text-[#1a1f24]/65 uppercase">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#b8955c]" />
                    Access
                  </div>
                  <div className="rounded-full border border-[#1a1f24]/[0.08] bg-[#f6f4ef]/90 px-3 py-1.5 text-[11px] font-medium tracking-wide text-[#1a1f24]/45">
                    {authStep === 'login'
                        ? '登录通道'
                        : authStep === 'register'
                          ? '注册通道'
                          : authStep === 'forgot'
                            ? '找回密码'
                            : '重置密码'}
                  </div>
                </div>

                <div>
                  <h1 className="font-display text-4xl leading-tight text-[#1a1f24] md:text-[2.65rem] pa-motion-display pa-serif-breathe">
                    {authStep === 'login'
                        ? '欢迎回来'
                        : authStep === 'register'
                          ? '创建你的账户'
                          : authStep === 'forgot'
                            ? '找回你的访问'
                            : '设置新密码'}
                  </h1>
                  <p className="mt-4 text-sm font-light leading-relaxed text-[#1a1f24]/50 md:text-[15px] pa-motion-body">
                    {authStep === 'login'
                        ? '请输入昵称和密码继续进入学习空间。'
                        : authStep === 'register'
                          ? '填写昵称、邮箱和密码创建账户。新密码须为 6-20 位，仅大小写字母与数字，且同时包含大写、小写与数字。'
                          : authStep === 'forgot'
                            ? tokenReady
                              ? resetHint ||
                                '系统不会在网页上显示令牌。请查收注册邮箱（含垃圾箱），复制邮件中的令牌继续完成重置。'
                              : '提交注册邮箱后，若该邮箱已绑定账号，我们会发送一枚重置令牌（约 20 分钟内有效）。'
                            : '设置新昵称，粘贴邮件中的重置令牌，并设置符合规则的新密码。'}
                  </p>
                </div>

                <div className="space-y-4">
                {authStep === 'forgot' ? (
                  <div>
                    <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">Email</label>
                    <input
                      type="email"
                      autoComplete="email"
                      maxLength={255}
                      placeholder="注册时填写的邮箱"
                      value={forgotEmail}
                      onChange={(e) => {
                        setForgotEmail(e.target.value);
                        if (errorMsg) setErrorMsg('');
                        if (successMsg) setSuccessMsg('');
                      }}
                      onKeyDown={handleKeyDown}
                      className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 text-[15px] font-medium outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">Nickname</label>
                    <input
                      type="text"
                      autoComplete="username"
                      maxLength={16}
                      placeholder={authStep === 'forgot-reset' ? '设置新昵称' : '昵称（支持中文）'}
                      value={username}
                      onChange={(e) => {
                        setUsername(sanitizeUsername(e.target.value));
                        if (errorMsg) setErrorMsg('');
                        if (successMsg) setSuccessMsg('');
                      }}
                      onKeyDown={handleKeyDown}
                      className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 text-[15px] font-medium outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                    />
                  </div>
                )}

                {authStep === 'forgot' && tokenReady && (
                  <div className="space-y-2 border border-amber-200/90 bg-amber-50/90 px-4 py-3 text-sm leading-relaxed text-[#1a1f24]/80">
                    <p className="font-medium text-[#1a1f24]">下一步前请先取得令牌</p>
                    <p>
                      这里<strong>不会显示</strong>安全令牌。请到<strong>注册时填写的邮箱</strong>查收（别忘了看<strong>垃圾箱</strong>
                      与<strong>订阅邮件</strong>），复制邮件里的令牌继续完成重置。
                    </p>
                    <p className="text-[12px] text-[#1a1f24]/55">
                      若迟迟收不到：确认用的是注册时登记的邮箱；在邮箱里搜索「Mentor」或「重置」；稍等几分钟再刷新。
                      令牌只在短时间内有效，过期后请重新获取。
                    </p>
                  </div>
                )}

                {authStep === 'forgot-reset' && (
                  <div>
                    <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">Reset token</label>
                    <input
                      type="text"
                      maxLength={128}
                      placeholder="粘贴重置令牌"
                      value={resetToken}
                      onChange={(e) => {
                        setResetToken(e.target.value.replace(/\s/g, ''));
                        if (errorMsg) setErrorMsg('');
                      }}
                      onKeyDown={handleKeyDown}
                      className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 font-mono text-[14px] outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                    />
                  </div>
                )}

                {authStep === 'register' && (
                  <div>
                    <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">
                      Email（必填，用于找回密码）
                    </label>
                    <input
                      type="email"
                      autoComplete="email"
                      required
                      maxLength={255}
                      placeholder="name@example.com"
                      value={regEmail}
                      onChange={(e) => {
                        setRegEmail(e.target.value);
                        if (errorMsg) setErrorMsg('');
                        if (successMsg) setSuccessMsg('');
                      }}
                      onKeyDown={handleKeyDown}
                      className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 text-[15px] font-medium outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                    />
                  </div>
                )}

                {(authStep === 'login' || authStep === 'register') && (
                  <div className="relative">
                    <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">Password</label>
                      <input
                        ref={passwordRef}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete={authStep === 'register' ? 'new-password' : 'current-password'}
                        maxLength={authStep === 'register' ? 20 : 128}
                        placeholder={
                          authStep === 'register'
                            ? '密码：6-20位，大小写+数字'
                            : '请输入密码'
                        }
                        value={password}
                        onChange={(e) => {
                          let val = e.target.value;
                          if (authStep === 'register') {
                            val = val.replace(/[^A-Za-z0-9]/g, '');
                          }
                          setPassword(val);
                          if (errorMsg) setErrorMsg('');
                          if (successMsg) setSuccessMsg('');
                        }}
                        onKeyDown={handleKeyDown}
                      className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 pr-14 text-[15px] font-medium outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                    />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute bottom-3.5 right-3 text-[11px] tracking-[0.18em] text-[#1a1f24]/35 transition-colors hover:text-[#1a1f24] uppercase"
                      >
                        {showPassword ? '隐藏' : '显示'}
                      </button>
                    </div>
                  )}

                {authStep === 'login' && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep('forgot');
                        setPassword('');
                        setConfirmPassword('');
                        setErrorMsg('');
                        setSuccessMsg('');
                        setShowPassword(false);
                        setTokenReady(false);
                        setResetToken('');
                        setResetHint('');
                        setRegEmail('');
                        setForgotEmail('');
                        setUsername('');
                      }}
                      className="text-[12px] tracking-[0.12em] text-[#8a6f42] transition-colors hover:text-[#1a1f24]"
                    >
                      忘记密码？
                    </button>
                  </div>
                )}

                {authStep === 'forgot-reset' && (
                  <>
                    <div className="relative">
                      <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">New password</label>
                      <input
                        ref={passwordRef}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        maxLength={20}
                        placeholder="新密码：6-20位，大小写+数字"
                        value={password}
                        onChange={(e) => {
                          const val = e.target.value.replace(/[^A-Za-z0-9]/g, '');
                          setPassword(val);
                          if (errorMsg) setErrorMsg('');
                        }}
                        onKeyDown={handleKeyDown}
                        className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 pr-14 text-[15px] font-medium outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute bottom-3.5 right-3 text-[11px] tracking-[0.18em] text-[#1a1f24]/35 transition-colors hover:text-[#1a1f24] uppercase"
                      >
                        {showPassword ? '隐藏' : '显示'}
                      </button>
                    </div>
                    <div className="relative">
                      <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">Confirm</label>
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        maxLength={20}
                        placeholder="再次输入新密码"
                        value={confirmPassword}
                        onChange={(e) => {
                          const val = e.target.value.replace(/[^A-Za-z0-9]/g, '');
                          setConfirmPassword(val);
                          if (errorMsg) setErrorMsg('');
                        }}
                        onKeyDown={handleKeyDown}
                        className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 pr-14 text-[15px] font-medium outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword((v) => !v)}
                        className="absolute bottom-3.5 right-3 text-[11px] tracking-[0.18em] text-[#1a1f24]/35 transition-colors hover:text-[#1a1f24] uppercase"
                      >
                        {showConfirmPassword ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </>
                )}

                  {successMsg && (
                    <div className="border border-emerald-200/90 bg-emerald-50/90 px-4 py-3 text-sm text-emerald-900">{successMsg}</div>
                  )}

                  {errorMsg && (
                    <div className="border border-red-200/90 bg-red-50/90 px-4 py-3 text-sm text-red-800">{errorMsg}</div>
                  )}

                  <button
                    onClick={handleAuthSubmit}
                    disabled={loading}
                    className="pa-motion-ui group relative w-full overflow-hidden border border-[#1a1f24]/[0.12] bg-[#1a1f24] py-4 text-[12px] font-semibold tracking-[0.32em] text-[#faf9f7] transition-all duration-500 hover:-translate-y-0.5 hover:shadow-[0_20px_48px_rgba(26,31,36,0.18)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:shadow-none"
                  >
                    <span className="absolute inset-0 translate-y-full bg-[#b8955c] transition-transform duration-500 group-hover:translate-y-0" />
                    <span className="relative z-10 flex items-center justify-center gap-3">
                      {loading && (
                        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white" />
                      )}
                      {loading
                        ? '处理中'
                        : authStep === 'login'
                            ? '登录'
                            : authStep === 'register'
                              ? '注册并继续'
                              : authStep === 'forgot'
                                ? tokenReady
                                  ? '继续设置新密码'
                                  : '获取重置令牌'
                                : '确认重置密码'}
                    </span>
                  </button>

                  {authStep === 'login' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep('register');
                        setPassword('');
                        setRegEmail('');
                        setForgotEmail('');
                        setErrorMsg('');
                        setSuccessMsg('');
                        setShowPassword(false);
                      }}
                      className="w-full py-3 text-[12px] tracking-[0.18em] text-[#1a1f24]/38 transition-colors hover:text-[#1a1f24] uppercase"
                    >
                      创建新账户
                    </button>
                  )}

                  {authStep === 'register' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep('login');
                        setPassword('');
                        setRegEmail('');
                        setForgotEmail('');
                        setErrorMsg('');
                        setSuccessMsg('');
                        setShowPassword(false);
                      }}
                      className="w-full py-3 text-[12px] tracking-[0.18em] text-[#1a1f24]/38 transition-colors hover:text-[#1a1f24] uppercase"
                    >
                      返回登录
                    </button>
                  )}

                  {authStep === 'forgot' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep('login');
                        setErrorMsg('');
                        setSuccessMsg('');
                        setTokenReady(false);
                        setResetToken('');
                        setResetHint('');
                        setForgotEmail('');
                      }}
                      className="w-full py-3 text-[12px] tracking-[0.18em] text-[#1a1f24]/38 transition-colors hover:text-[#1a1f24] uppercase"
                    >
                      返回登录
                    </button>
                  )}

                  {authStep === 'forgot-reset' && (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setAuthStep('forgot');
                          setPassword('');
                          setConfirmPassword('');
                          setResetToken('');
                          setTokenReady(false);
                          setResetHint('');
                          setErrorMsg('');
                          setShowPassword(false);
                          setShowConfirmPassword(false);
                        }}
                        className="w-full py-3 text-[12px] tracking-[0.18em] text-[#1a1f24]/38 transition-colors hover:text-[#1a1f24] uppercase"
                      >
                        上一步
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAuthStep('login');
                          setPassword('');
                          setConfirmPassword('');
                          setErrorMsg('');
                          setSuccessMsg('');
                          setShowPassword(false);
                          setShowConfirmPassword(false);
                          setTokenReady(false);
                          setResetToken('');
                          setResetHint('');
                          setForgotEmail('');
                        }}
                        className="w-full py-1 text-[12px] tracking-[0.18em] text-[#1a1f24]/30 transition-colors hover:text-[#1a1f24]/55 uppercase"
                      >
                        返回登录
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};


// --- 2. 科目选择 ---
const SubjectGrid = ({ onSelectSubject, onLogout, username, apiBase }) => {
  const [overviewOpen, setOverviewOpen] = useState(false);
  const subjects = [
    { id: 'math', name: '高等数学', icon: '📐', accent: 'from-[#6b7fd7] to-[#9b8fd4]' },
    { id: 'cs', name: '计算机架构', icon: '💻', accent: 'from-emerald-500 to-teal-500' },
    { id: 'nlp', name: '自然语言处理', icon: '🤖', accent: 'from-fuchsia-500 to-rose-400' },
    { id: 'os', name: '操作系统', icon: '⚙️', accent: 'from-amber-500 to-orange-500' },
    { id: 'dl', name: '深度学习', icon: '🧠', accent: 'from-sky-500 to-indigo-500' },
  ];

  return (
    <div className="pa-page dp2-live-board relative flex h-dvh max-h-dvh flex-col overflow-hidden bg-[#f6f4ef] text-[#1a1f24] pa-grain">
      <div className="pointer-events-none absolute inset-0 z-0">
        <ParticleField className="opacity-[0.26] mix-blend-multiply sm:opacity-[0.34]" areaScale={1.08} />
      </div>
      <div
        className="pa-orb pa-orb-1 pointer-events-none absolute -right-[8%] top-[-12%] z-[1] h-[min(42vw,380px)] w-[min(42vw,380px)] bg-[radial-gradient(circle_at_center,rgba(184,149,92,0.22),transparent_68%)]"
        aria-hidden
      />
      <div
        className="pa-orb pa-orb-2 pointer-events-none absolute -left-[12%] bottom-[-16%] z-[1] h-[min(38vw,340px)] w-[min(38vw,340px)] bg-[radial-gradient(circle_at_center,rgba(26,31,36,0.045),transparent_70%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-[1] pa-drift-slow opacity-[0.35]"
        style={{
          background:
            'linear-gradient(102deg, transparent 0%, rgba(184,149,92,0.055) 42%, transparent 64%)',
        }}
        aria-hidden
      />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-[min(40%,480px)] pa-curve-field-light" aria-hidden />

      <header className="relative z-20 shrink-0 border-b border-[#1a1f24]/[0.06] bg-[#f6f4ef]/88 backdrop-blur-md">
        <div className="pa-hline-runner absolute inset-x-0 bottom-0 opacity-90" aria-hidden />
        <div className="mx-auto flex max-w-5xl items-end justify-between gap-6 px-5 py-5 md:px-10 md:py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-display text-lg font-medium tracking-tight text-[#1a1f24] md:text-xl">Mentor</span>
            <span className="text-[10px] font-medium tracking-[0.32em] text-[#1a1f24]/38 uppercase">Academic Suite</span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 text-[11px] tracking-[0.18em] text-[#1a1f24]/42 sm:gap-5">
            <button
              type="button"
              onClick={() => setOverviewOpen(true)}
              className="rounded-full border border-[#1a1f24]/[0.12] bg-white/80 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#1a1f24]/55 transition-colors hover:border-[#b8955c]/45 hover:text-[#8a6f42]"
            >
              多智能体说明
            </button>
            <span className="hidden max-w-[11rem] truncate sm:inline">{username}</span>
            <button
              type="button"
              onClick={onLogout}
              className="font-semibold uppercase tracking-[0.22em] text-[#1a1f24]/38 transition-colors hover:text-red-700"
            >
              退出
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 min-h-0 flex-1 overflow-hidden">
        <div className="pa-dashboard-bg-grid opacity-80" aria-hidden />
        <div className="pa-dashboard-edge-sheen hidden opacity-90 md:block" aria-hidden />
        <div className="scrollbar-hide relative z-10 h-full min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-5 pb-24 pt-10 md:px-10 md:pt-14 lg:px-12">
            <p className="pa-label text-[10px] font-medium tracking-[0.34em] text-[#1a1f24]/38 uppercase">Curriculum</p>
            <h1 className="mt-3 font-display text-[clamp(1.65rem,4.2vw,2.65rem)] font-medium leading-[1.12] tracking-tight text-[#1a1f24] pa-motion-display">
              选择课程
            </h1>
            <div className="mt-4 h-px max-w-[9rem] bg-gradient-to-r from-[#b8955c] to-transparent pa-line-in" />
            <p className="mt-5 max-w-lg text-[15px] font-light leading-relaxed text-[#1a1f24]/52 md:text-base pa-motion-body">
              以下五个模块为对话式学习入口，点按卡片即可开始。
            </p>

            <ul className="mt-12 space-y-4 sm:mt-14 md:space-y-5">
              {subjects.map((s, idx) => (
                <Reveal key={s.id} snappy delay={idx * 18}>
                  <li>
                    <button
                      type="button"
                      onClick={() => onSelectSubject(s.name)}
                      className="group relative w-full overflow-hidden rounded-sm border border-[#1a1f24]/[0.08] bg-white/80 text-left shadow-[0_6px_22px_rgba(26,31,36,0.04)] backdrop-blur-sm transition-all duration-500 ease-out hover:-translate-y-0.5 hover:border-[#b8955c]/32 hover:shadow-[0_18px_46px_rgba(26,31,36,0.1)]"
                    >
                      <div className="pa-hline-runner absolute inset-x-0 top-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100" aria-hidden />
                      <svg className="pa-frame-svg" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden>
                        <rect x="0.5" y="0.5" width="99" height="99" pathLength="400" />
                      </svg>
                      <div className="pa-corners pa-corners-hover" aria-hidden>
                        <span />
                      </div>
                      <div className="absolute left-0 top-0 h-full w-1 bg-gradient-to-b from-[#b8955c]/0 via-[#b8955c]/45 to-[#b8955c]/0 opacity-0 transition-opacity duration-500 group-hover:opacity-100" aria-hidden />
                      <div className="relative flex items-stretch gap-0 sm:gap-1">
                        <div
                          className={`relative flex w-[4.25rem] shrink-0 items-center justify-center bg-gradient-to-br ${s.accent} opacity-[0.2] transition-all duration-500 group-hover:opacity-[0.32] sm:w-[5rem]`}
                        >
                          <div className="absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.45),transparent_50%)]" />
                          <span className="relative text-2xl transition-transform duration-500 group-hover:scale-110 sm:text-3xl">
                            {s.icon}
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-1 items-center justify-between gap-6 px-4 py-6 sm:px-6 sm:py-7">
                          <div className="min-w-0">
                            <p className="text-[10px] font-medium tracking-[0.26em] text-[#1a1f24]/34 uppercase">Module</p>
                            <h2 className="mt-1.5 font-display text-[clamp(1.1rem,2.2vw,1.45rem)] font-medium tracking-tight text-[#1a1f24] transition-colors duration-300 group-hover:text-[#1a1f24]/88 md:text-xl">
                              {s.name}
                            </h2>
                          </div>
                          <span
                            aria-hidden
                            className="shrink-0 text-lg text-[#b8955c]/70 transition-all duration-500 group-hover:translate-x-1 group-hover:text-[#b8955c] md:text-xl"
                          >
                            →
                          </span>
                        </div>
                      </div>
                    </button>
                  </li>
                </Reveal>
              ))}
            </ul>
          </div>
        </div>
      </main>

      <StudioMentorOverviewModal open={overviewOpen} onClose={() => setOverviewOpen(false)} apiBase={apiBase} />
    </div>
  );
};

const SubjectGridV29 = ({ onSelectSubject, onLogout, username, apiBase }) => {
  const [overviewOpen, setOverviewOpen] = useState(false);
  const subjects = [
    {
      id: 'math',
      name: '高等数学',
      topic: '极限 / 导数 / 积分',
      lead: 'FOUNDATION',
      desc: '用对话把抽象公式拆成可验证的推理路径。',
      state: 'active',
      status: '学习中',
      progress: 68,
    },
    {
      id: 'cs',
      name: '计算机架构',
      topic: '指令 / 存储 / 流水线',
      lead: 'SYSTEM',
      desc: '从结构关系进入性能、缓存和执行过程。',
      state: 'ready',
      status: '可进入',
      progress: 44,
    },
    {
      id: 'nlp',
      name: '自然语言处理',
      topic: '语义 / 表征 / 生成',
      lead: 'LANGUAGE',
      desc: '围绕文本理解、向量表示和模型输出构建知识网。',
      state: 'ready',
      status: '可进入',
      progress: 36,
    },
    {
      id: 'os',
      name: '操作系统',
      topic: '进程 / 内存 / 调度',
      lead: 'KERNEL',
      desc: '把并发、资源管理和系统调用串成章节路线。',
      state: 'idle',
      status: '待开启',
      progress: 22,
    },
    {
      id: 'dl',
      name: '深度学习',
      topic: '网络 / 训练 / 优化',
      lead: 'MODEL',
      desc: '从损失、梯度和泛化进入模型训练实战。',
      state: 'idle',
      status: '待开启',
      progress: 18,
    },
  ];

  return (
    <div className="pa-page dp2-live-board dp2-live-board-layout relative overflow-hidden bg-transparent text-[#1a1f24]">
      <div className="dp2-board">
        <section className="dp2-section-title">
          <div className="dp2-mini-label">MAP</div>
          <h2>学习地图</h2>
          <p>选择一条学习主线，进入对话式章节学习。课程状态会跟随你的学习记录逐步更新。</p>
          <div className="dp2-board-actions">
            <button type="button" onClick={() => setOverviewOpen(true)}>
              多智能体说明
            </button>
            <button type="button" onClick={onLogout}>
              退出
            </button>
            <span>{username}</span>
          </div>
        </section>
        <section className="dp2-subject-list" aria-label="课程选择">
          {subjects.map((s, index) => (
            <button
              key={s.id}
              className={`dp2-subject is-${s.state}`}
              type="button"
              onClick={() => onSelectSubject(s.name)}
              style={{ '--p': `${s.progress}%`, animationDelay: `${index * 55}ms` }}
            >
              <span className="dp2-course-no">{String(index + 1).padStart(2, '0')}</span>
              <span className="dp2-course-body">
                <span className="dp2-course-main">
                  <span className="dp2-course-kicker">{s.lead}</span>
                  <strong>{s.name}</strong>
                </span>
                <span className="dp2-course-subline">
                  <span className="dp2-course-topic">{s.topic}</span>
                  <span>{s.status}</span>
                  <small>{s.desc}</small>
                </span>
              </span>
              <span className="dp2-course-mark" aria-hidden>
                <span />
                <b />
              </span>
              <i className="dp2-course-line" aria-label={`${s.name} 进度`}>
                <b />
              </i>
            </button>
          ))}
        </section>
      </div>

      <StudioMentorOverviewModal open={overviewOpen} onClose={() => setOverviewOpen(false)} apiBase={apiBase} />
    </div>
  );
};

const SubjectGridExactV29 = ({ onSelectSubject, onSwitchAccount, username, apiBase = API_BASE }) => {
  const [remoteCourses, setRemoteCourses] = useState([]);
  const [courseErr, setCourseErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setCourseErr('');
        const r = await fetch(`${apiBase}/courses`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(formatApiDetail(data) || data?.detail || '课程列表暂时不可用');
        if (!cancelled) setRemoteCourses(Array.isArray(data.courses) ? data.courses : []);
      } catch (e) {
        if (!cancelled) {
          setCourseErr(e?.message || '课程列表暂时不可用');
          setRemoteCourses([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const subjects = useMemo(() => {
    const fallback = v29Subjects.map(([title, topic, state, progress], index) => ({
      id: title,
      name: title,
      lead: v29CourseShowcase[index]?.[0] || 'COURSE',
      topic: `${topic} / ${v29CourseShowcase[index]?.[1] || '学习主线'}`,
      state,
      progress,
      status: state === 'active' ? '正在学习' : state === 'ready' ? '可进入' : '待开启',
      desc: v29CourseShowcase[index]?.[2] || '从一个清晰问题开始。',
    }));
    if (!remoteCourses.length) return fallback;
    return remoteCourses.map((course, index) => {
      const base = fallback[index % fallback.length];
      const firstTopic = course.first_section_title || course.first_chapter_title || base.topic;
      return {
        id: course.id || course.name,
        name: course.name,
        lead: v29CourseShowcase[index % v29CourseShowcase.length]?.[0] || base.lead,
        topic: firstTopic,
        state: index === 0 ? 'active' : index < 3 ? 'ready' : 'next',
        progress: base.progress,
        status: index === 0 ? '正在学习' : '可进入',
        desc: course.description || base.desc,
      };
    });
  }, [remoteCourses]);

  return (
    <V29PageShell variant="board">
      <div className="dp2-board">
        <section className="dp2-section-title">
          <div className="dp2-mini-label">MAP</div>
          <h2>学习地图</h2>
          <p>选一条主线，再决定让 AI 陪你走，还是自由提问。</p>
          <div className="dp2-board-actions">
            <span>{courseErr || username || 'Learning Field'}</span>
            <button type="button" className="dp2-switch-account" onClick={onSwitchAccount}>
              切换账号
            </button>
          </div>
        </section>
        <section className="dp2-subject-list" aria-label="课程选择">
          {subjects.map((course, index) => (
            <article
              key={course.id || course.name}
              className={`dp2-subject is-${course.state}`}
              style={{ '--p': `${course.progress}%`, animationDelay: `${index * 55}ms` }}
              role="button"
              tabIndex={0}
              onClick={() => onSelectSubject(course.name, 'guided')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectSubject(course.name, 'guided');
                }
              }}
            >
              <span className="dp2-course-no">{String(index + 1).padStart(2, '0')}</span>
              <span className="dp2-course-body">
                <span className="dp2-course-main">
                  <span className="dp2-course-kicker">{course.lead}</span>
                  <strong>{course.name}</strong>
                </span>
                <span className="dp2-course-subline">
                  <span className="dp2-course-topic">{course.topic}</span>
                  <span>{course.status}</span>
                  <small>{course.desc}</small>
                </span>
              </span>
              <span className="dp2-course-mode-row" aria-label={`${course.name} 学习模式`}>
                <button
                  type="button"
                  className="dp2-course-mode is-guided"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectSubject(course.name, 'guided');
                  }}
                >
                  AI 带学
                </button>
                <button
                  type="button"
                  className="dp2-course-mode"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectSubject(course.name, 'free');
                  }}
                >
                  自由提问
                </button>
              </span>
              <span className="dp2-course-mark" aria-hidden>
                <span />
                <b />
              </span>
              <i className="dp2-course-line" aria-label={`${course.name} 进度`}>
                <b />
              </i>
            </article>
          ))}
        </section>
      </div>
    </V29PageShell>
  );
};

// --- 3. 对话界面：会话列表 + 章节目录（大章 / 小节，数据来自后端 /learning-catalog）---
const ChatView = ({ subject, username, onBack, onSwitchAccount, initialMode = 'free' }) => {
  const welcomeMessage = { role: 'assistant', content: `你好 **${username}**，我们从 **${subject}** 里挑一个点，慢慢把它讲亮。` };

  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogErr, setCatalogErr] = useState('');
  const [expandedChapters, setExpandedChapters] = useState({});
  const [selectedChapterId, setSelectedChapterId] = useState('');
  const [selectedSectionId, setSelectedSectionId] = useState('');

  const [messages, setMessages] = useState([welcomeMessage]);
  const [inputText, setInputText] = useState('');
  const [pendingImages, setPendingImages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const [sessions, setSessions] = useState([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [sessionQuery, setSessionQuery] = useState('');
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [deletingSessionId, setDeletingSessionId] = useState(null);

  const [chapterRightTab, setChapterRightTab] = useState('catalog');
  const [studioPanel, setStudioPanel] = useState('study');
  const [visitedSections, setVisitedSections] = useState([]);
  const [progress, setProgress] = useState({ sections: {}, chapters: {}, sectionRule: null });
  const [learnMode, setLearnMode] = useState(initialMode === 'guided');
  const [quizModal, setQuizModal] = useState(null);
  const [chapterPanelWidth] = useState(380);
  const [mindMapMarkdown, setMindMapMarkdown] = useState('');
  const [mindMapStreaming, setMindMapStreaming] = useState(false);
  const [mindMapErr, setMindMapErr] = useState('');

  const messagesEndRef = useRef(null);
  const dialogueScrollRef = useRef(null);
  const legacyMessagesScrollRef = useRef(null);
  const outputStartScrollFrameRef = useRef(null);
  const imageInputRef = useRef(null);
  const bufferRef = useRef('');
  const displayRef = useRef('');
  const rawRef = useRef('');
  const rafRef = useRef(null);
  const readerRef = useRef(null);
  const quizStripRef = useRef(null);
  const mindMapAbortRef = useRef(null);
  const guidedAutoStartedRef = useRef(false);
  /** 刚流式输出完的会话 id：在此 id 的历史尚未可查时不要用「空历史 → 欢迎页」覆盖界面 */
  const preferUiOverHistoryUntilRef = useRef(null);

  const progressKey = `section_progress_${username}_${subject}`;

  const totalSectionCount = useMemo(
    () => catalog.reduce((n, ch) => n + (ch.sections?.length || 0), 0),
    [catalog]
  );

  const scopeLabel = useMemo(() => {
    const ch = catalog.find((c) => c.id === selectedChapterId);
    const sec = ch?.sections?.find((s) => s.id === selectedSectionId);
    if (ch && sec) return `${ch.title} › ${sec.title}`;
    if (ch) return ch.title;
    return '';
  }, [catalog, selectedChapterId, selectedSectionId]);

  const sessionScopeKey = useMemo(() => {
    if (selectedChapterId && selectedSectionId) return `${selectedChapterId}|${selectedSectionId}`;
    return '';
  }, [selectedChapterId, selectedSectionId]);

  const getMessagesScroller = () => dialogueScrollRef.current || legacyMessagesScrollRef.current;

  const scrollMessagesToBottom = (behavior = 'smooth') => {
    const el = getMessagesScroller();
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const scrollMessagesOnOutputStart = () => {
    if (outputStartScrollFrameRef.current) cancelAnimationFrame(outputStartScrollFrameRef.current);
    outputStartScrollFrameRef.current = requestAnimationFrame(() => {
      outputStartScrollFrameRef.current = requestAnimationFrame(() => {
        scrollMessagesToBottom('auto');
        outputStartScrollFrameRef.current = null;
      });
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (outputStartScrollFrameRef.current) cancelAnimationFrame(outputStartScrollFrameRef.current);
      try {
        readerRef.current?.cancel?.();
      } catch {}
      try {
        mindMapAbortRef.current?.abort?.();
      } catch {}
    };
  }, []);

  const deleteSession = async (sessionId) => {
    if (!username || deletingSessionId != null) return;
    if (!window.confirm('确定删除该会话及其全部消息？此操作不可恢复。')) return;
    setDeletingSessionId(sessionId);
    try {
      const url = `${API_BASE}/chat-sessions/${encodeURIComponent(sessionId)}?username=${encodeURIComponent(username)}`;
      const r = await fetch(url, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '删除失败');
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
        setLearnMode(false);
        setQuizModal(null);
        setMessages([welcomeMessage]);
        setInputText('');
      }
      await loadSessions();
    } catch (e) {
      console.error(e);
      setSessionError(`删除失败：${e?.message || '未知错误'}`);
    } finally {
      setDeletingSessionId(null);
    }
  };

  const loadSessions = async () => {
    if (!username || !subject) return;

    setSessionLoading(true);
    setSessionError('');

    try {
      const url = `${API_BASE}/sessions/${encodeURIComponent(username)}/${encodeURIComponent(subject)}`;
      const response = await fetch(url);
      const data = await response.json().catch(() => []);

      if (!response.ok) {
        throw new Error(data?.detail || '会话列表加载失败');
      }

      const list = Array.isArray(data) ? data : [];
      setSessions(list);

      if (list.length === 0) {
        setCurrentSessionId(null);
        setMessages([welcomeMessage]);
        return;
      }
    } catch (e) {
      console.error(e);
      setSessionError('会话列表加载失败');
      setSessions([]);
    } finally {
      setSessionLoading(false);
    }
  };

  const loadLearningProgress = async () => {
    if (!username || !subject) return;
    try {
      const r = await fetch(
        `${API_BASE}/learning/progress?username=${encodeURIComponent(username)}&subject=${encodeURIComponent(subject)}`
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return;
      setProgress({
        sections: d.sections || {},
        chapters: d.chapters || {},
        sectionRule: d.section_completion_rule || null,
      });
    } catch {
      /* ignore */
    }
  };

  const loadSessionHistory = async (sessionId) => {
    if (!sessionId) {
      setMessages([welcomeMessage]);
      return;
    }

    const streamUiGuard =
      preferUiOverHistoryUntilRef.current != null &&
      Number(sessionId) === Number(preferUiOverHistoryUntilRef.current);

    try {
      let data = [];
      for (let attempt = 0; attempt < 15; attempt++) {
        const url = `${API_BASE}/history/${sessionId}`;
        const response = await fetch(url);
        const parsed = await response.json().catch(() => []);

        if (!response.ok) {
          throw new Error(parsed?.detail || '历史记录加载失败');
        }

        data = Array.isArray(parsed) ? parsed : [];
        if (data.length > 0) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      if (data.length > 0) {
        setMessages(data);
        preferUiOverHistoryUntilRef.current = null;
      } else if (!streamUiGuard) {
        setMessages([welcomeMessage]);
      }
    } catch (e) {
      console.error(e);
      if (!streamUiGuard) {
        setMessages([welcomeMessage]);
      }
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem(progressKey);
    const parsed = saved ? JSON.parse(saved) : [];
    const safeList = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    setVisitedSections(safeList);

    setCurrentSessionId(null);
    setInputText('');
    setPendingImages([]);
    setMessages([welcomeMessage]);
    setSessions([]);
    setSessionQuery('');
    setCatalog([]);
    setCatalogErr('');
    setCatalogLoading(true);
    setSelectedChapterId('');
    setSelectedSectionId('');
    setExpandedChapters({});
    setLearnMode(initialMode === 'guided');
    setQuizModal(null);
    setProgress({ sections: {}, chapters: {}, sectionRule: null });
    setMindMapMarkdown('');
    setMindMapStreaming(false);
    setMindMapErr('');
    setChapterRightTab('catalog');
    setStudioPanel('study');
    guidedAutoStartedRef.current = false;
    preferUiOverHistoryUntilRef.current = null;

    loadSessions();
    loadLearningProgress();

    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/learning-catalog?subject=${encodeURIComponent(subject)}`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(data?.detail || '章节目录加载失败，请先在后端执行 /seed');
        }
        const chs = Array.isArray(data.chapters) ? data.chapters : [];
        if (cancelled) return;
        setCatalog(chs);
        const ch0 = chs[0];
        const s0 = ch0?.sections?.[0];
        if (ch0 && s0) {
          setSelectedChapterId(ch0.id);
          setSelectedSectionId(s0.id);
          setExpandedChapters({ [ch0.id]: true });
        }
        if (!cancelled) await loadLearningProgress();
      } catch (e) {
        if (!cancelled) {
          setCatalogErr(e?.message || '章节目录加载失败');
          setCatalog([]);
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, subject, initialMode]);

  useEffect(() => {
    localStorage.setItem(progressKey, JSON.stringify(visitedSections));
  }, [visitedSections, progressKey]);

  const passedSectionCount = useMemo(() => {
    return Object.values(progress.sections || {}).filter((x) => x.small_quiz_passed).length;
  }, [progress.sections]);

  const progressPercent = totalSectionCount
    ? Math.round((passedSectionCount / totalSectionCount) * 100)
    : 0;

  const progressSignal = useMemo(() => {
    const sections = Object.entries(progress.sections || {})
      .map(([key, value]) => [
        key,
        value?.mastery,
        value?.learn_turns,
        value?.phase,
        value?.small_quiz_score,
        value?.small_quiz_passed,
        value?.updated_at,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const chapters = Object.entries(progress.chapters || {})
      .map(([key, value]) => [
        key,
        value?.sections_quiz_passed,
        value?.chapter_quiz_passed,
        value?.chapter_quiz_score,
        value?.updated_at,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify({ sections, chapters });
  }, [progress.sections, progress.chapters]);

  const currentSectionProgress = sessionScopeKey ? progress.sections?.[sessionScopeKey] : null;
  const currentMasteryPercent = Math.round(Math.max(0, Math.min(1, Number(currentSectionProgress?.mastery || 0))) * 100);
  const sectionRule = progress.sectionRule || {};
  const sectionMasteryTarget = Math.round(Number(sectionRule.mastery_threshold ?? 0.72) * 100);
  const sectionForceTurns = Number(sectionRule.force_quiz_turns ?? 6);
  const canPrepareSmallQuiz = !!selectedChapterId && !!selectedSectionId && !currentSectionProgress?.small_quiz_passed;
  const selectedChapter = useMemo(
    () => catalog.find((chapter) => chapter.id === selectedChapterId) || null,
    [catalog, selectedChapterId]
  );
  const selectedSection = useMemo(
    () => selectedChapter?.sections?.find((section) => section.id === selectedSectionId) || null,
    [selectedChapter, selectedSectionId]
  );
  const abilityProfile = useMemo(() => {
    const sections = Object.values(progress.sections || {});
    const activeCount = sections.filter((x) => x?.learn_turns || x?.small_quiz_passed).length;
    const passedRatio = totalSectionCount ? passedSectionCount / totalSectionCount : 0;
    const activeRatio = totalSectionCount ? activeCount / totalSectionCount : 0;
    const mastery = clamp01(currentSectionProgress?.mastery, 0.28);
    const turnRatio = clamp01(Number(currentSectionProgress?.learn_turns || 0) / Math.max(1, sectionForceTurns), 0.2);
    const quizSignal = currentSectionProgress?.small_quiz_passed
      ? 0.88
      : currentSectionProgress?.quiz_pending
        ? 0.62
        : 0.34;
    return {
      foundation: Math.max(0.3, mastery * 0.82 + activeRatio * 0.18),
      reasoning: Math.max(0.28, mastery * 0.55 + turnRatio * 0.3 + passedRatio * 0.15),
      expression: Math.max(0.26, turnRatio * 0.56 + mastery * 0.26 + activeRatio * 0.18),
      transfer: Math.max(0.24, passedRatio * 0.58 + quizSignal * 0.24 + mastery * 0.18),
      review: Math.max(0.3, quizSignal * 0.46 + turnRatio * 0.3 + passedRatio * 0.24),
    };
  }, [currentSectionProgress, passedSectionCount, progress.sections, sectionForceTurns, totalSectionCount]);
  const mindMapFallbackMarkdown = useMemo(
    () =>
      buildSectionMindMapFallback({
        subject,
        chapter: selectedChapter,
        section: selectedSection,
        progressState: currentSectionProgress,
      }),
    [subject, selectedChapter, selectedSection, currentSectionProgress]
  );

  useEffect(() => {
    try {
      mindMapAbortRef.current?.abort?.();
    } catch {
      /* ignore */
    }
    setMindMapMarkdown('');
    setMindMapErr('');
    setMindMapStreaming(false);
  }, [sessionScopeKey]);

  const generateMindMap = async () => {
    if (!selectedChapterId || !selectedSectionId) {
      setMindMapErr('先在右侧目录点亮一个小节，再生成它的知识图。');
      return;
    }
    try {
      mindMapAbortRef.current?.abort?.();
    } catch {
      /* ignore */
    }

    const ac = new AbortController();
    mindMapAbortRef.current = ac;
    setMindMapErr('');
    setMindMapMarkdown('');
    setMindMapStreaming(true);

    try {
      const r = await fetch(`${API_BASE}/learning/studio/resources/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          username,
          subject,
          chapter_id: selectedChapterId,
          section_id: selectedSectionId,
          resource_type: 'mind_map',
          extra_hint: '请严格输出一个 Mermaid mindmap 代码块，根节点是当前小节标题；节点短、层级清楚，只保留核心定义、方法、误区和练习观察。',
        }),
      });

      if (!r.ok) {
        const t = await r.text().catch(() => '');
        let detail = t;
        try {
          const j = JSON.parse(t);
          detail = formatApiDetail(j) || t;
        } catch {
          /* ignore */
        }
        throw new Error(detail || `HTTP ${r.status}`);
      }
      if (!r.body) throw new Error('没有收到导图内容。');

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
      }
      acc += decoder.decode();
      const decoded = decodeResourceMarkdownStream(acc);
      setMindMapMarkdown(markdownToMarkmapOutline(decoded) ? decoded : mindMapFallbackMarkdown);
    } catch (e) {
      if (e?.name !== 'AbortError') {
        setMindMapErr(e?.message || '导图生成失败，请稍后再试。');
      }
    } finally {
      setMindMapStreaming(false);
    }
  };

  const applySessionChapter = (raw) => {
    if (!raw || !catalog.length) return;
    const pipe = raw.indexOf('|');
    if (pipe !== -1) {
      const cid = raw.slice(0, pipe);
      const sid = raw.slice(pipe + 1);
      const ch = catalog.find((c) => c.id === cid);
      if (ch) {
        setSelectedChapterId(ch.id);
        setExpandedChapters((e) => ({ ...e, [ch.id]: true }));
      }
      if (sid) setSelectedSectionId(sid);
      return;
    }
    const ch = catalog.find((c) => c.title === raw);
    if (ch) {
      setSelectedChapterId(ch.id);
      setSelectedSectionId(ch.sections?.[0]?.id || '');
      setExpandedChapters((e) => ({ ...e, [ch.id]: true }));
    }
  };

  useEffect(() => {
    if (!learnMode || !sessionScopeKey) return;

    /** 带学首轮请求进行中：勿清空消息、勿自动切到旧会话（否则会 loadHistory 覆盖流式界面）。 */
    if (learnMode && isLoading) return;

    const chapterSessions = sessions.filter((s) => s.chapter === sessionScopeKey);

    if (chapterSessions.length > 0) {
      const preferred =
        chapterSessions.find((s) => Number(s.id) === Number(currentSessionId)) || chapterSessions[0];
      if (preferred && Number(preferred.id) !== Number(currentSessionId)) {
        setCurrentSessionId(preferred.id);
      }
    } else {
      /** AI 带学模式下可能短暂尚无会话记录；勿重置为欢迎页以免打断输出 */
      if (learnMode) return;
      if (currentSessionId !== null) {
        setCurrentSessionId(null);
      }
      setMessages([welcomeMessage]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionScopeKey, sessions, learnMode, isLoading]);

  useEffect(() => {
    if (!currentSessionId) {
      if (!learnMode) {
        setMessages([welcomeMessage]);
      }
      return;
    }

    if (learnMode && isLoading) return;

    const matched = sessions.find((s) => Number(s.id) === Number(currentSessionId));
    if (matched) {
      if (matched.chapter && catalog.length) {
        applySessionChapter(matched.chapter);
      }
      loadSessionHistory(currentSessionId);
    }
    /* 若列表尚未含当前 id（例如刚创建带学会话），勿清空消息，避免打断流式输出 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, catalog, learnMode, isLoading]);

  const [quizPicks, setQuizPicks] = useState([]);
  const [quizIndex, setQuizIndex] = useState(0);

  useEffect(() => {
    if (quizModal?.questions?.length) {
      setQuizPicks(quizModal.questions.map(() => -1));
      setQuizIndex(0);
    } else {
      setQuizPicks([]);
      setQuizIndex(0);
    }
  }, [quizModal]);

  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const t = `${s.title || ''} ${s.preview || ''} ${s.chapter || ''}`.toLowerCase();
      return t.includes(q);
    });
  }, [sessions, sessionQuery]);

  const startLearn = async () => {
    if (!selectedChapterId || !selectedSectionId || isLoading) return;
    scrollMessagesOnOutputStart();
    setIsLoading(true);
    setLearnMode(true);
    setMessages([{ role: 'assistant', content: '' }]);
    bufferRef.current = '';
    displayRef.current = '';
    rawRef.current = '';
    try {
      const r = await fetch(`${API_BASE}/learning/start-section`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          subject,
          chapter_id: selectedChapterId,
          section_id: selectedSectionId,
        }),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        let detail = errText;
        try {
          const j = JSON.parse(errText);
          detail = formatApiDetail(j) || errText;
        } catch {
          /* ignore */
        }
        throw new Error(detail || `HTTP ${r.status}`);
      }
      const returnedSessionId = r.headers.get('X-Session-Id');
      startRenderLoop();
      await pumpStream(r);
      await finalizeAssistantStream({ stripLearnMeta: false });
      const rs = returnedSessionId ? Number(returnedSessionId) : NaN;
      preferUiOverHistoryUntilRef.current = Number.isNaN(rs) ? null : rs;
      await loadSessions();
      if (returnedSessionId) {
        const numericId = Number(returnedSessionId);
        if (!Number.isNaN(numericId)) setCurrentSessionId(numericId);
      }
      await loadLearningProgress();
    } catch (e) {
      console.error(e);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      bufferRef.current = '';
      displayRef.current = '';
      rawRef.current = '';
      preferUiOverHistoryUntilRef.current = null;
      setLearnMode(false);
      setCurrentSessionId(null);
      setMessages([
        welcomeMessage,
        { role: 'assistant', content: `无法开始带学：${e?.message || '未知错误'}` },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (initialMode !== 'guided') return;
    if (guidedAutoStartedRef.current || catalogLoading || isLoading) return;
    if (!selectedChapterId || !selectedSectionId) return;
    guidedAutoStartedRef.current = true;
    void startLearn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode, selectedChapterId, selectedSectionId, catalogLoading, isLoading]);

  const startRemedialLearn = async (quizResult) => {
    if (!selectedChapterId || !selectedSectionId) return;
    scrollMessagesOnOutputStart();
    const note = quizResult?.remedial_prompt || '小节测验未达标，请继续针对薄弱点带学。';
    setIsLoading(true);
    setLearnMode(true);
    setMessages([{ role: 'assistant', content: '' }]);
    bufferRef.current = '';
    displayRef.current = '';
    rawRef.current = '';
    try {
      const r = await fetch(`${API_BASE}/learning/start-section`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          subject,
          chapter_id: selectedChapterId,
          section_id: selectedSectionId,
          reset_progress: false,
          opening_note: note,
        }),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        let detail = errText;
        try {
          const j = JSON.parse(errText);
          detail = formatApiDetail(j) || errText;
        } catch {
          /* ignore */
        }
        throw new Error(detail || `HTTP ${r.status}`);
      }
      const returnedSessionId = r.headers.get('X-Session-Id');
      startRenderLoop();
      await pumpStream(r);
      await finalizeAssistantStream({ stripLearnMeta: false });
      const rs = returnedSessionId ? Number(returnedSessionId) : NaN;
      preferUiOverHistoryUntilRef.current = Number.isNaN(rs) ? null : rs;
      await loadSessions();
      if (returnedSessionId) {
        const numericId = Number(returnedSessionId);
        if (!Number.isNaN(numericId)) setCurrentSessionId(numericId);
      }
      await loadLearningProgress();
    } catch (e) {
      console.error(e);
      setMessages((prev) => [
        ...prev.filter((m) => m.content),
        { role: 'assistant', content: `未达标补救带学启动失败：${e?.message || '未知错误'}` },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLearnAnswer = async (text, imageSnapshot = []) => {
    scrollMessagesOnOutputStart();
    setIsLoading(true);
    setInputText('');
    try {
      if (!currentSessionId) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: '请先点击「开始 AI 带学」以创建带学会话。' },
        ]);
        return;
      }
      const userContent = packUserAskForDisplay(text, imageSnapshot);
      setMessages((prev) => [...prev, { role: 'user', content: userContent }, { role: 'assistant', content: '' }]);
      bufferRef.current = '';
      displayRef.current = '';
      rawRef.current = '';

      const r = await fetch(`${API_BASE}/learning/answer-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          subject,
          chapter_id: selectedChapterId,
          section_id: selectedSectionId,
          session_id: currentSessionId,
          answer: text,
          images: imageSnapshot.map((x) => ({ media_type: x.mediaType, data_b64: x.dataB64 })),
        }),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        let detail = errText;
        try {
          const j = JSON.parse(errText);
          detail = formatApiDetail(j) || errText;
        } catch {
          /* ignore */
        }
        throw new Error(detail || `HTTP ${r.status}`);
      }

      startRenderLoop();
      await pumpStream(r);
      const meta = await finalizeAssistantStream({ stripLearnMeta: true });
      const sid = Number(currentSessionId);
      preferUiOverHistoryUntilRef.current = Number.isNaN(sid) ? null : sid;
      if (meta?.small_quiz && Array.isArray(meta.small_quiz) && meta.small_quiz.length >= SMALL_QUIZ_QUESTION_COUNT) {
        setQuizModal({ type: 'small', questions: meta.small_quiz });
      }
      await loadLearningProgress();
      await loadSessions();
    } catch (e) {
      console.error(e);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      bufferRef.current = '';
      displayRef.current = '';
      rawRef.current = '';
      preferUiOverHistoryUntilRef.current = null;
      setMessages((prev) => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        if (lastIndex >= 0 && updated[lastIndex].role === 'assistant') {
          updated[lastIndex] = {
            ...updated[lastIndex],
            content: `抱歉：${e?.message || '服务不可用'}`,
          };
          return updated;
        }
        return [...prev, { role: 'assistant', content: `抱歉：${e?.message || '服务不可用'}` }];
      });
    } finally {
      setIsLoading(false);
    }
  };

  const prepareSmallQuiz = async () => {
    if (!selectedChapterId || !selectedSectionId || isLoading) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${API_BASE}/learning/quiz/small/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          subject,
          chapter_id: selectedChapterId,
          section_id: selectedSectionId,
          mode: currentSectionProgress?.quiz_pending ? 'resume' : 'direct',
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '小节测验生成失败');
      if (j.already_passed) {
        setMessages((prev) => [...prev, { role: 'assistant', content: '当前小节测验已经通过，可以继续学习后续小节。' }]);
        await loadLearningProgress();
        return;
      }
      setQuizModal({ type: 'small', questions: j.questions || [] });
      await loadLearningProgress();
    } catch (e) {
      console.error(e);
      setMessages((prev) => [...prev, { role: 'assistant', content: `小节测验生成失败：${e?.message || ''}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const submitSmallQuiz = async (answers) => {
    if (!selectedChapterId || !selectedSectionId) return;
    setIsLoading(true);
    try {
      const r = await fetch(`${API_BASE}/learning/quiz/small/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          subject,
          chapter_id: selectedChapterId,
          section_id: selectedSectionId,
          answers,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '提交失败');
      setQuizModal((prev) => (prev ? { ...prev, result: j } : prev));
      await loadLearningProgress();
      if (!j.passed) {
        await startRemedialLearn(j);
      }
    } catch (e) {
      console.error(e);
      setMessages((prev) => [...prev, { role: 'assistant', content: `测验提交失败：${e?.message || ''}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const prepareChapterQuiz = async (chapterId) => {
    setIsLoading(true);
    try {
      const r = await fetch(`${API_BASE}/learning/chapter-quiz/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, subject, chapter_id: chapterId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '大章测验生成失败');
      setQuizModal({ type: 'chapter', chapterId, questions: j.questions || [] });
    } catch (e) {
      console.error(e);
      setMessages((prev) => [...prev, { role: 'assistant', content: `大章测验：${e?.message || ''}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const submitChapterQuiz = async (chapterId, answers) => {
    setIsLoading(true);
    try {
      const r = await fetch(`${API_BASE}/learning/chapter-quiz/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, subject, chapter_id: chapterId, answers }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(formatApiDetail(j) || '提交失败');
      setQuizModal(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `大章测验得分：**${Math.round(j.score)}** 分（${j.correct}/${j.total}）${j.passed ? '，已通过。' : '，未达 60 分可再次生成测验。'}`,
        },
      ]);
      await loadLearningProgress();
    } catch (e) {
      console.error(e);
      setMessages((prev) => [...prev, { role: 'assistant', content: `大章测验提交失败：${e?.message || ''}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const dedupeOverlap = (prevText, nextChunk) => {
    if (!nextChunk) return '';
    if (!prevText) return nextChunk;
    if (nextChunk.startsWith(prevText)) return nextChunk.slice(prevText.length);

    const restartWindow = 48;
    if (
      prevText.length >= restartWindow &&
      nextChunk.length >= restartWindow &&
      nextChunk.slice(0, restartWindow) === prevText.slice(0, restartWindow)
    ) {
      let i = restartWindow;
      const limit = Math.min(prevText.length, nextChunk.length);
      while (i < limit && prevText[i] === nextChunk[i]) i += 1;
      return nextChunk.slice(i);
    }

    const maxOverlap = Math.min(prevText.length, nextChunk.length);
    for (let i = maxOverlap; i > 0; i--) {
      if (prevText.endsWith(nextChunk.slice(0, i))) {
        return nextChunk.slice(i);
      }
    }

    return nextChunk;
  };

  const LEARN_META_BEGIN = '[[META]]';
  const LEARN_META_END = '[[/META]]';

  const stripLearnMetaTail = (raw) => {
    if (!raw || typeof raw !== 'string') return { display: '', meta: null };
    const end = raw.lastIndexOf(LEARN_META_END);
    if (end === -1) return { display: raw, meta: null };
    const start = raw.lastIndexOf(LEARN_META_BEGIN, end);
    if (start === -1) return { display: raw.slice(0, end).trimEnd(), meta: null };
    const display = raw.slice(0, start).trimEnd();
    const jsonStr = raw.slice(start + LEARN_META_BEGIN.length, end).trim();
    try {
      const meta = JSON.parse(jsonStr);
      return { display, meta };
    } catch {
      return { display, meta: null };
    }
  };

  /** 打字机：每条助手消息最小间隔（毫秒），即使网络一次性返回整段也能逐字显现 */
  const TYPING_MIN_INTERVAL_MS = 8;

  const popFirstGrapheme = (s) => {
    if (!s) return { grapheme: '', rest: '' };
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      for (const data of seg.segment(s)) {
        return {
          grapheme: data.segment,
          rest: s.slice(data.index + data.segment.length),
        };
      }
      return { grapheme: '', rest: s };
    } catch {
      const arr = Array.from(s);
      const grapheme = arr[0] ?? '';
      return { grapheme, rest: arr.slice(1).join('') };
    }
  };

  const pumpStream = async (response) => {
    if (!response.body) throw new Error('没有可读取的响应流');
    const reader = response.body.getReader();
    readerRef.current = reader;
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const safeChunk = dedupeOverlap(rawRef.current, chunk);
      rawRef.current += safeChunk;
      bufferRef.current += safeChunk;
    }

    const tail = decoder.decode();
    if (tail) {
      const safeTail = dedupeOverlap(rawRef.current, tail);
      rawRef.current += safeTail;
      bufferRef.current += safeTail;
    }
  };

  const finalizeAssistantStream = async ({ stripLearnMeta = false } = {}) => {
    await new Promise((resolve) => {
      const waitEmpty = () => {
        if (bufferRef.current.length > 0) {
          requestAnimationFrame(waitEmpty);
        } else {
          resolve(undefined);
        }
      };
      waitEmpty();
    });

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    let meta = null;
    let content = displayRef.current;
    if (stripLearnMeta) {
      const parsed = stripLearnMetaTail(rawRef.current);
      content = parsed.display;
      meta = parsed.meta;
      displayRef.current = content;
    }
    setMessages((prev) => {
      const updated = [...prev];
      const lastIndex = updated.length - 1;
      if (lastIndex >= 0 && updated[lastIndex].role === 'assistant') {
        updated[lastIndex] = { ...updated[lastIndex], content };
      }
      return updated;
    });
    return meta;
  };

  const startRenderLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    let lastEmit = 0;

    const tick = (now = performance.now()) => {
      if (bufferRef.current.length > 0 && now - lastEmit >= TYPING_MIN_INTERVAL_MS) {
        lastEmit = now;
        const { grapheme, rest } = popFirstGrapheme(bufferRef.current);
        bufferRef.current = rest;
        if (grapheme) {
          displayRef.current += grapheme;
          setMessages((prev) => {
            const updated = [...prev];
            const lastIndex = updated.length - 1;
            if (lastIndex >= 0 && updated[lastIndex].role === 'assistant') {
              updated[lastIndex] = {
                ...updated[lastIndex],
                content: displayRef.current,
              };
            }
            return updated;
          });
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  };

  const removePendingImage = (id) => {
    setPendingImages((prev) => prev.filter((x) => x.id !== id));
  };

  const onImageFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    for (const file of files) {
      try {
        const part = await readImageAsBase64Part(file);
        setPendingImages((prev) => {
          if (prev.length >= MAX_CHAT_IMAGES) return prev;
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const previewUrl = `data:${part.mediaType};base64,${part.dataB64}`;
          return [...prev, { id, previewUrl, mediaType: part.mediaType, dataB64: part.dataB64 }];
        });
      } catch (err) {
        console.error(err);
        window.alert(err?.message || '添加图片失败');
        break;
      }
    }
  };

  const handleSend = async (customMsg) => {
    const text = (customMsg || inputText).trim();
    if (isLoading) return;
    if (learnMode && (!selectedChapterId || !selectedSectionId)) return;

    if (learnMode) {
      if (!text.trim() && !pendingImages.length) return;
      const snap = [...pendingImages];
      setPendingImages([]);
      setInputText('');
      await handleLearnAnswer(text, snap);
      return;
    }

    if (!text && !pendingImages.length) return;

    const imageSnapshot = [...pendingImages];
    const userContent = packUserAskForDisplay(text, imageSnapshot);
    scrollMessagesOnOutputStart();
    setMessages((prev) => [...prev, { role: 'user', content: userContent }, { role: 'assistant', content: '' }]);
    setInputText('');
    setPendingImages([]);
    setIsLoading(true);

    bufferRef.current = '';
    displayRef.current = '';
    rawRef.current = '';

    try {
      const sessionPart = currentSessionId ? `&session_id=${encodeURIComponent(currentSessionId)}` : '';
      const scopePart = '';
      let response;
      if (imageSnapshot.length) {
        response = await fetch(`${API_BASE}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            subject,
            question: text,
            session_id: currentSessionId || undefined,
            images: imageSnapshot.map((x) => ({ media_type: x.mediaType, data_b64: x.dataB64 })),
          }),
        });
      } else {
        const url = `${API_BASE}/ask?question=${encodeURIComponent(text)}&username=${encodeURIComponent(username)}&subject=${encodeURIComponent(subject)}${scopePart}${sessionPart}`;
        response = await fetch(url);
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let msg = errText || `HTTP ${response.status}`;
        try {
          const j = JSON.parse(errText);
          msg = formatApiDetail(j) || msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }

      const returnedSessionId = response.headers.get('X-Session-Id');

      if (!response.body) {
        throw new Error('没有可读取的响应流');
      }

      startRenderLoop();
      await pumpStream(response);
      await finalizeAssistantStream({ stripLearnMeta: false });

      if (returnedSessionId) {
        const n = Number(returnedSessionId);
        preferUiOverHistoryUntilRef.current = Number.isNaN(n) ? null : n;
      } else if (currentSessionId != null) {
        const n = Number(currentSessionId);
        preferUiOverHistoryUntilRef.current = Number.isNaN(n) ? null : n;
      } else {
        preferUiOverHistoryUntilRef.current = null;
      }

      await loadSessions();

      if (returnedSessionId) {
        const numericId = Number(returnedSessionId);
        if (!Number.isNaN(numericId)) setCurrentSessionId(numericId);
      } else if (currentSessionId) {
        await loadSessionHistory(currentSessionId);
      }
    } catch (e) {
      console.error(e);
      preferUiOverHistoryUntilRef.current = null;
      const hint =
        e instanceof Error && e.message?.trim()
          ? `抱歉，对话暂时失败：${e.message.trim()}`
          : '抱歉，当前服务暂时不可用。';
      setMessages((prev) => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        if (lastIndex >= 0 && updated[lastIndex].role === 'assistant' && !updated[lastIndex].content) {
          updated[lastIndex] = { ...updated[lastIndex], content: hint };
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const previewText = (text) => {
    if (!text) return '';
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 48 ? `${oneLine.slice(0, 48)}...` : oneLine;
  };

  const sessionDate = (value) => {
    if (!value) return '';
    try {
      return new Date(value).toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return '';
    }
  };

  const quizResult = quizModal?.result || null;
  const quizQuestions = quizModal?.questions || [];
  const currentQuizQuestion = quizQuestions[quizIndex] || quizQuestions[0] || null;
  const isLastQuizQuestion = quizIndex >= quizQuestions.length - 1;
  const allQuizAnswered = quizQuestions.length > 0 && quizPicks.length === quizQuestions.length && quizPicks.every((p) => p >= 0);

  useEffect(() => {
    if (!quizModal || quizResult || quizQuestions.length === 0) return;
    const strip = quizStripRef.current;
    const target = strip?.querySelector(`[data-quiz-index="${quizIndex}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [quizIndex, quizModal, quizQuestions.length, quizResult]);

  const handleQuizWheel = (event) => {
    if (quizQuestions.length <= 1) return;
    event.stopPropagation();
    const direction = event.deltaY > 0 ? 1 : -1;
    setQuizIndex((index) => Math.max(0, Math.min(quizQuestions.length - 1, index + direction)));
  };

  const v29PathChapters =
    catalog.length > 0
      ? catalog.map((chapter) => ({
          key: chapter.id,
          title: chapter.title,
          desc: chapter.desc,
          chapter,
          sections: (chapter.sections || []).map((section) => ({
            key: `${chapter.id}|${section.id}`,
            title: section.title,
            chapter,
            section,
          })),
        }))
      : [
          {
            key: 'fallback',
            title: '学习路线',
            desc: '路线准备好后，会按主线和小步展开。',
            fallback: true,
            sections: v29PathItems.map((item, index) => ({ key: item, title: item, fallbackIndex: index })),
          },
        ];

  if (studioPanel === 'resources') {
    return (
      <V29ResourceWorkspace
        apiBase={API_BASE}
        username={username}
        subject={subject}
        chapterId={selectedChapterId}
        sectionId={selectedSectionId}
        scopeLabel={scopeLabel}
        onBack={() => setStudioPanel('study')}
        onMindMapReady={(markdown) => {
          setMindMapErr('');
          setMindMapMarkdown(markdown || '');
        }}
      />
    );
  }

  return (
    <V29PageShell variant="studio">
      <div className="dp2-studio">
        <aside className="dp2-portrait">
          <div className="dp2-mini-label">TRACE</div>
          <h2>学习能力图</h2>
          <p>用图形观察理解、推理和复盘的变化。</p>
          <V29LearningMapPanel
            scopeLabel={scopeLabel}
            abilityProfile={abilityProfile}
            mindMapMarkdown={mindMapMarkdown}
            mindMapFallbackMarkdown={mindMapFallbackMarkdown}
            mindMapStreaming={mindMapStreaming}
            mindMapErr={mindMapErr}
            canGenerate={!!selectedChapterId && !!selectedSectionId}
            onGenerate={() => void generateMindMap()}
          />
        </aside>

        <main className="dp2-chat">
          <div className="dp2-study-context">
            <span>{subject || 'MENTOR'}</span>
            <strong>{scopeLabel || '先选一个小节，让学习有落点'}</strong>
          </div>

          <div
            className="dp2-dialogue"
            ref={dialogueScrollRef}
          >
            {messages.map((m, i) => {
              const isUser = m.role === 'user';
              const assistantTyping =
                m.role === 'assistant' &&
                isLoading &&
                i === messages.length - 1 &&
                !(typeof m.content === 'string' && m.content.trim());

              return (
                <article key={`${m.role}-${i}`} className={`dp2-bubble ${isUser ? 'is-user' : ''}`}>
                  <span>{isUser ? '我' : '陪你看'}</span>
                  {isUser ? (
                    <UserMessageBody content={m.content} />
                  ) : assistantTyping ? (
                    <div>正在整理重点...</div>
                  ) : (
                    <div className="dp2-answer">
                      <ReactMarkdown
                        remarkPlugins={markdownRemarkPlugins}
                        rehypePlugins={markdownRehypePlugins}
                        components={{
                          code({ inline, className, children }) {
                            const match = /language-(\w+)/.exec(className || '');
                            return !inline && match ? (
                              <CodeBlock language={match[1]} value={String(children).replace(/\n$/, '')} />
                            ) : (
                              <code>{children}</code>
                            );
                          },
                        }}
                      >
                        {normalizeMathText(m.content)}
                      </ReactMarkdown>
                    </div>
                  )}
                </article>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className="dp2-compose">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
              placeholder={learnMode ? `写下你的想法：${scopeLabel || ''}` : '从一句话开始问'}
              aria-label="写下你的问题"
            />
            <V29Button onClick={() => handleSend()} disabled={isLoading}>发送</V29Button>
          </div>
        </main>

        <aside className="dp2-study-rail">
          <section className="dp2-plan">
            <div className="dp2-mini-label">NOW</div>
            <h3>这一刻看什么</h3>
            <p>
              {learnMode
                ? scopeLabel
                  ? `正在看：${scopeLabel}`
                  : '先挑一个小节，我把它拆成几步。'
                : '自由问：想到哪里，就从哪里开口。'}
            </p>
            <ol>
              <li>先抓住最亮的点</li>
              <li>再换个画面理解</li>
              <li>最后用小练习确认</li>
            </ol>
          </section>

          <div className="dp2-rail-actions">
            <V29Button quiet onClick={() => void prepareSmallQuiz()} disabled={isLoading || !canPrepareSmallQuiz}>
              试一试
            </V29Button>
            <V29Button quiet onClick={() => setStudioPanel('resources')}>
              学习素材
            </V29Button>
            <V29Button quiet onClick={onBack}>回到地图</V29Button>
            <V29Button quiet onClick={onSwitchAccount}>换账号</V29Button>
          </div>

          <section className="dp2-path">
            <div className="dp2-mini-label">目录</div>
            {catalogLoading && <div className="dp2-path-item"><span /><strong>铺开路线</strong><small>准备中</small></div>}
            {!catalogLoading && catalogErr && <div className="dp2-path-item"><span /><strong>路线没铺好</strong><small>{catalogErr}</small></div>}
            {!catalogLoading &&
              !catalogErr &&
              v29PathChapters.map((chapter, chapterIndex) => {
                const open = chapter.fallback || expandedChapters[chapter.key] || chapter.sections.some((item) => item.chapter?.id === selectedChapterId);
                const passedCount = chapter.sections.filter((item) => progress.sections?.[item.key]?.small_quiz_passed).length;
                return (
                  <div className={`dp2-path-chapter ${open ? 'is-open' : ''}`} key={chapter.key} style={{ animationDelay: `${chapterIndex * 90}ms` }}>
                    <button
                      type="button"
                      className="dp2-path-chapter-head"
                      onClick={() => {
                        if (chapter.fallback) return;
                        setExpandedChapters((prev) => ({ ...prev, [chapter.key]: !open }));
                      }}
                    >
                      <span />
                      <strong>{chapter.title}</strong>
                      <small>{chapter.sections.length ? `${passedCount}/${chapter.sections.length}` : '准备中'}</small>
                    </button>
                    {open && (
                      <div className="dp2-path-section-list">
                        {chapter.sections.map((item, index) => {
                          const active = item.chapter?.id === selectedChapterId && item.section?.id === selectedSectionId;
                          const status =
                            item.fallbackIndex != null
                              ? item.fallbackIndex < 2
                                ? '已点亮'
                                : item.fallbackIndex === 2
                                  ? '正在看'
                                  : '待点亮'
                              : progress.sections?.[item.key]?.small_quiz_passed
                                ? '已点亮'
                                : active
                                  ? '正在看'
                                  : '待点亮';
                          return (
                            <button
                              key={item.key}
                              type="button"
                              className={`dp2-path-item ${active ? 'is-active' : ''}`}
                              style={{ animationDelay: `${index * 55}ms` }}
                              onClick={() => {
                                if (!item.chapter || !item.section) return;
                                setLearnMode(false);
                                setSelectedChapterId(item.chapter.id);
                                setSelectedSectionId(item.section.id);
                                setExpandedChapters((prev) => ({ ...prev, [item.chapter.id]: true }));
                                const matched = sessions.filter((s) => s.chapter === item.key);
                                setCurrentSessionId(matched[0]?.id ?? null);
                              }}
                            >
                              <span />
                              <strong>{item.title}</strong>
                              <small>{status}</small>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
          </section>
        </aside>
      </div>

      {quizModal && quizQuestions.length > 0 && (
        <div className="dp2-functional-modal" role="dialog" aria-modal="true">
          {!quizResult ? (
            <div className="dp2-quiz">
              <section className="dp2-section-title">
                <div className="dp2-mini-label">CHECK</div>
                <h2>{quizModal.type === 'small' ? '小节练习' : '整章回看'}</h2>
                <p>做完就看回放：哪里亮了，哪里还要补。右侧题号可以跳转。</p>
              </section>
              <section className="dp2-quiz-board">
                <article className="dp2-quiz-focus">
                  <span>{`第 ${quizIndex + 1} 题 / 共 ${quizQuestions.length} 题`}</span>
                  <h3>{currentQuizQuestion?.question}</h3>
                  <div className="dp2-options">
                    {(currentQuizQuestion?.options || []).map((option, index) => (
                      <button
                        key={option}
                        type="button"
                        className={quizPicks[quizIndex] === index ? 'is-selected' : ''}
                        onClick={() =>
                          setQuizPicks((prev) => {
                            const next = [...prev];
                            next[quizIndex] = index;
                            return next;
                          })
                        }
                      >
                        <span>{String.fromCharCode(65 + index)}</span>
                        {option}
                      </button>
                    ))}
                  </div>
                  <footer className="dp2-quiz-actions">
                    <V29Button quiet onClick={() => setQuizIndex((n) => Math.max(0, n - 1))} disabled={quizIndex === 0}>
                      上一题
                    </V29Button>
                    {!isLastQuizQuestion ? (
                      <V29Button onClick={() => setQuizIndex((n) => Math.min(quizQuestions.length - 1, n + 1))}>
                        下一题
                      </V29Button>
                    ) : (
                      <V29Button
                        disabled={isLoading || !allQuizAnswered}
                        onClick={() => {
                          if (quizModal.type === 'small') submitSmallQuiz(quizPicks);
                          else submitChapterQuiz(quizModal.chapterId, quizPicks);
                        }}
                      >
                        看结果
                      </V29Button>
                    )}
                  </footer>
                </article>
                <div className="dp2-quiz-strip" ref={quizStripRef} onWheel={handleQuizWheel} aria-label="题目导航">
                  {quizQuestions.map((q, index) => {
                    const distance = Math.abs(index - quizIndex);
                    return (
                      <button
                        key={index}
                        type="button"
                        data-quiz-index={index}
                        className={`${quizPicks[index] >= 0 ? 'is-done' : ''} ${index === quizIndex ? 'is-now' : ''} ${distance === 1 ? 'is-near' : ''}`}
                        onClick={() => setQuizIndex(index)}
                      >
                        <i />
                        <b>{String(index + 1).padStart(2, '0')}</b>
                        <span>{q.question}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : (
            <div className="dp2-result">
              <section className="dp2-result-hero">
                <div className="dp2-mini-label">REVIEW</div>
                <h2>回看结果</h2>
                <p>{quizResult.passed ? '这一轮已经过关，可以继续往前。' : '还差一点，我会带你把薄弱处补上。'}</p>
                <div className="dp2-result-orbit" aria-hidden>
                  <span>{quizResult.passed ? '已掌握' : '需巩固'}</span>
                </div>
              </section>
              <section className="dp2-result-board">
                <div className="dp2-result-track" aria-hidden>
                  <i className="is-ok" />
                  <i className="is-warn" />
                  <i className="is-miss" />
                </div>
                <div className="dp2-result-list">
                  {(quizResult.items || []).slice(0, 3).map((item, index) => (
                    <article key={index} className={`dp2-result-card ${item.is_correct ? 'is-ok' : 'is-miss'}`}>
                      <span>{item.is_correct ? '点亮' : '补光'}</span>
                      <p>{item.explanation || item.question}</p>
                    </article>
                  ))}
                </div>
                <aside className="dp2-ai-queue">
                  <span>NEXT</span>
                  <h3>下一步怎么补</h3>
                  <ol>
                    <li>先回看最容易卡住的地方</li>
                    <li>再做一题相近的小练习</li>
                    <li>最后重新试一轮回看</li>
                  </ol>
                  <div className="dp2-actions">
                    <V29Button onClick={() => setQuizModal(null)}>继续往前</V29Button>
                  </div>
                </aside>
              </section>
            </div>
          )}
        </div>
      )}
    </V29PageShell>
  );

  return (
    <div className="pa-page dp2-live-studio flex h-dvh max-h-dvh min-h-0 overflow-hidden bg-[#f6f4ef] text-[#1a1f24] pa-grain">
      <aside className="relative flex h-full min-h-0 w-72 flex-shrink-0 flex-col border-r border-[#1a1f24]/[0.08] bg-[#ebe8e0] sm:w-80">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(184,149,92,0.14),transparent_52%)]"
          aria-hidden
        />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[#1a1f24]/[0.06] bg-[#ebe8e0]/95 px-3 py-2.5 sm:px-4">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex min-h-[2.25rem] w-full items-center justify-center gap-2 rounded-md border border-[#1a1f24]/[0.08] bg-white/70 px-3 py-2 text-[11px] font-semibold tracking-[0.18em] text-[#1a1f24]/55 transition-colors hover:border-[#b8955c]/40 hover:text-[#1a1f24] sm:justify-start sm:px-3.5 uppercase"
            >
              ← 返回看板
            </button>
          </div>

          <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-3 py-3 scrollbar-hide sm:px-4 sm:py-4">
            <div className="space-y-4">
              <div className="relative border border-[#1a1f24]/[0.08] bg-white/70 p-5 shadow-sm">
                <div className="pa-corners" aria-hidden>
                  <span />
                </div>
                <div className="pa-label text-[10px] text-[#1a1f24]/38">Session</div>
                <h3 className="mt-2 font-display text-2xl text-[#1a1f24] pa-motion-display">{subject}</h3>
                <p className="mt-2 text-[12px] tracking-wide text-[#1a1f24]/45">{username}</p>
                <div className="mt-4 pa-divider" aria-hidden />
              </div>

              <StudioPortraitCard
                apiBase={API_BASE}
                username={username}
                subject={subject}
                sessionId={currentSessionId}
                progressSignal={progressSignal}
              />

              <button
                type="button"
                onClick={() => {
                  setCurrentSessionId(null);
                  setLearnMode(false);
                  setQuizModal(null);
                  setPendingImages([]);
                  const ch0 = catalog[0];
                  const s0 = ch0?.sections?.[0];
                  if (ch0 && s0) {
                    setSelectedChapterId(ch0.id);
                    setSelectedSectionId(s0.id);
                    setExpandedChapters({ [ch0.id]: true });
                  }
                  setMessages([welcomeMessage]);
                  setInputText('');
                }}
                className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#1a1f24] py-3.5 text-[11px] font-semibold tracking-[0.22em] text-[#faf9f7] transition-all duration-500 hover:-translate-y-0.5 hover:bg-[#242b32] hover:shadow-[0_14px_32px_rgba(26,31,36,0.15)] active:translate-y-0"
              >
                新建对话
              </button>

              <div className="relative">
                <input
                  value={sessionQuery}
                  onChange={(e) => setSessionQuery(e.target.value)}
                  placeholder="搜索会话"
                  className="w-full border border-[#1a1f24]/[0.1] bg-white/80 py-3.5 pl-11 pr-4 text-sm text-[#1a1f24] outline-none transition-all placeholder:text-[#1a1f24]/30 focus:border-[#b8955c]/55 focus:shadow-[0_0_0_1px_rgba(184,149,92,0.18)]"
                />
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[11px] text-[#1a1f24]/35">⌕</span>
              </div>

              <div className="space-y-2 pt-1">
          {sessionLoading && (
            <div className="border border-[#1a1f24]/[0.08] bg-white/60 p-4 text-sm text-[#1a1f24]/50">正在加载会话列表...</div>
          )}

          {!sessionLoading && sessionError && (
            <div className="border border-red-200 bg-red-50/90 p-4 text-sm text-red-800">{sessionError}</div>
          )}

          {!sessionLoading && !sessionError && filteredSessions.length === 0 && (
            <div className="border border-[#1a1f24]/[0.08] bg-white/60 p-4 text-sm text-[#1a1f24]/45">暂无会话。</div>
          )}

          {!sessionLoading &&
            !sessionError &&
            filteredSessions.map((item) => {
              const active = currentSessionId === item.id;
              const busy = deletingSessionId === item.id;

              return (
                <div
                  key={item.id}
                  className={`flex w-full min-w-0 items-stretch border-l-2 border-y border-r transition-all duration-500 ${
                    active
                      ? 'border-y-[#1a1f24]/[0.06] border-r-[#1a1f24]/[0.06] border-l-[#b8955c] bg-white shadow-[0_8px_28px_rgba(26,31,36,0.06)]'
                      : 'border-l-transparent border-y-transparent border-r-transparent bg-transparent hover:bg-white/70'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (item.chapter) applySessionChapter(item.chapter);
                      setCurrentSessionId(item.id);
                      setLearnMode(item.session_kind === 'learn');
                    }}
                    className="min-w-0 flex-1 px-4 py-3.5 text-left"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] font-semibold tracking-[0.2em] text-[#1a1f24]/38 uppercase">{item.subject}</div>
                      <div className="text-[10px] text-[#1a1f24]/35">{sessionDate(item.updated_at)}</div>
                    </div>

                    <div className="mt-2 truncate text-[13px] font-medium leading-6 text-[#1a1f24]">
                      {previewText(item.title || '新会话')}
                    </div>

                    <div className="mt-1 truncate text-[11px] leading-5 text-[#1a1f24]/45">
                      {previewText((item.chapter || '').includes('|') ? (item.chapter || '').replace('|', ' · ') : item.chapter || '')}
                    </div>

                    {item.preview && (
                      <div className="mt-1 truncate text-[11px] leading-5 text-[#1a1f24]/38">{previewText(item.preview)}</div>
                    )}
                  </button>
                  <button
                    type="button"
                    title="删除此会话"
                    disabled={busy || deletingSessionId != null}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSession(item.id);
                    }}
                    className="shrink-0 border-l border-[#1a1f24]/[0.06] px-2.5 text-[11px] font-medium text-[#1a1f24]/35 transition-colors hover:bg-red-50/90 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? '…' : '删除'}
                  </button>
                </div>
              );
            })}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#faf9f7]">
        <div
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(246,244,239,0.75),transparent_32%)]"
          aria-hidden
        />
        {/* 顶部水平跑马光条 */}
        <div className="pa-hline-runner absolute inset-x-0 top-0 z-10" aria-hidden />
        {/* 左侧垂直 Scroll 扫描线（极细金线） */}
        <div className="pa-vscan absolute bottom-6 left-3 top-6 z-10 hidden md:block" aria-hidden />
        <div
          className="scrollbar-hide relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6"
          ref={legacyMessagesScrollRef}
        >
          <div className="mx-auto max-w-3xl space-y-10">
            {messages.map((m, i) => {
              const assistantTyping =
                m.role === 'assistant' &&
                isLoading &&
                i === messages.length - 1 &&
                !(typeof m.content === 'string' && m.content.trim());
              return (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`chat-prose max-w-[92%] border px-6 py-5 shadow-[0_16px_44px_rgba(26,31,36,0.05)] transition-all duration-700 ease-out ${
                      m.role === 'user'
                        ? 'rounded-2xl rounded-br-sm border-[#1a1f24]/[0.1] bg-[#1a1f24] text-[#faf9f7]'
                        : 'rounded-2xl rounded-tl-sm border-[#1a1f24]/[0.06] bg-white text-[#1a1f24]'
                    }`}
                  >
                    {m.role === 'user' ? (
                      <UserMessageBody content={m.content} />
                    ) : assistantTyping ? (
                      <div
                        className="flex min-h-[1.5rem] items-center gap-2.5 text-[13px] text-[#1a1f24]/50"
                        aria-live="polite"
                        aria-busy="true"
                      >
                        <span className="inline-flex items-center gap-1" aria-hidden>
                          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#b8955c]/80 [animation-duration:1.1s]" />
                          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#b8955c]/65 [animation-duration:1.1s] [animation-delay:0.2s]" />
                          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#b8955c]/50 [animation-duration:1.1s] [animation-delay:0.4s]" />
                        </span>
                        <span className="font-medium tracking-wide">正在输入中…</span>
                      </div>
                    ) : (
                      <div className="dp2-answer prose prose-sm max-w-none prose-neutral">
                        <ReactMarkdown
                          remarkPlugins={markdownRemarkPlugins}
                          rehypePlugins={markdownRehypePlugins}
                          components={{
                            code({ inline, className, children }) {
                              const match = /language-(\w+)/.exec(className || '');
                              return !inline && match ? (
                                <CodeBlock language={match[1]} value={String(children).replace(/\n$/, '')} />
                              ) : (
                                <code className="rounded bg-[#1a1f24]/[0.06] px-1.5 py-0.5 font-mono text-[0.9em] text-red-800">
                                  {children}
                                </code>
                              );
                            },
                          }}
                        >
                          {normalizeMathText(m.content)}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="relative z-10 shrink-0 border-t border-[#1a1f24]/[0.06] bg-white/85 px-4 py-4 backdrop-blur-xl md:px-8 md:py-5">
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="text-[12px] font-medium tracking-wide text-[#1a1f24]/45">
                当前小节 · <span className="text-[#1a1f24]">{scopeLabel || '未选择'}</span>
                {selectedSectionId && (
                  <span className="ml-2 text-[#1a1f24]/35">
                    掌握 {currentMasteryPercent}% · {currentSectionProgress?.learn_turns || 0}/{sectionForceTurns} 轮
                  </span>
                )}
              </div>
              <div className="h-[3px] w-44 overflow-hidden rounded-full bg-[#1a1f24]/[0.08]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#b8955c] to-[#d4bc88] transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-[#1a1f24]/38">
              小节结束规则：掌握度达到 {sectionMasteryTarget}% 或完成 {sectionForceTurns} 轮带学后出现小节测验；也可以直接进入小节测验跳过带学。全章小节测验通过后，章节测试会自动出现。
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-[10px] font-semibold tracking-wider ${
                  learnMode ? 'bg-amber-100 text-amber-900' : 'bg-[#1a1f24]/[0.06] text-[#1a1f24]/55'
                }`}
              >
                {learnMode ? 'AI 带学中' : '自由提问'}
              </span>
              {!learnMode ? (
                <button
                  type="button"
                  onClick={() => startLearn()}
                  disabled={isLoading || !selectedChapterId || !selectedSectionId}
                  className="rounded-sm border border-[#b8955c]/50 bg-[#faf6ef] px-3 py-1.5 text-[11px] font-semibold text-[#5c4a28] transition-colors hover:bg-[#f3ead8] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  开始 AI 带学
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setLearnMode(false)}
                  className="rounded-sm border border-[#1a1f24]/15 bg-white px-3 py-1.5 text-[11px] font-semibold text-[#1a1f24]/70 hover:bg-[#f6f4ef]"
                >
                  结束带学
                </button>
              )}
              <button
                type="button"
                onClick={() => void prepareSmallQuiz()}
                disabled={isLoading || !canPrepareSmallQuiz}
                className="rounded-sm border border-[#1a1f24]/15 bg-white px-3 py-1.5 text-[11px] font-semibold text-[#1a1f24]/68 transition-colors hover:border-[#b8955c]/45 hover:bg-[#faf6ef] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {currentSectionProgress?.quiz_pending ? '继续小节测验' : currentSectionProgress?.small_quiz_passed ? '小节已通过' : '直接小节测验'}
              </button>
            </div>

            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 rounded-lg border border-[#1a1f24]/[0.08] bg-[#f6f4ef]/70 p-3">
                {pendingImages.map((p) => (
                  <div key={p.id} className="group relative shrink-0">
                    <img
                      src={p.previewUrl}
                      alt=""
                      className="h-16 w-16 rounded-md border border-[#1a1f24]/[0.08] object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(p.id)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-[#1a1f24]/15 bg-white text-[11px] font-bold text-[#1a1f24]/70 shadow-sm hover:bg-red-50 hover:text-red-700"
                      aria-label="移除图片"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => void onImageFilesSelected(e)}
            />

            <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch sm:gap-4">
              <button
                type="button"
                title="添加图片"
                disabled={isLoading || pendingImages.length >= MAX_CHAT_IMAGES}
                onClick={() => imageInputRef.current?.click()}
                className="pa-motion-ui flex min-h-[52px] shrink-0 items-center justify-center border border-[#1a1f24]/[0.12] bg-white px-4 text-[12px] font-semibold text-[#1a1f24]/70 transition-all hover:border-[#b8955c]/45 hover:text-[#1a1f24] disabled:cursor-not-allowed disabled:opacity-40"
              >
                图片
              </button>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSend();
                }}
                placeholder={
                  learnMode
                    ? `回答导师在当前小节「${scopeLabel || ''}」中的提问…`
                    : `向导师提问（可附图，带学/自由模式均可），当前限定在「${scopeLabel || '请先选择左侧小节'}」…`
                }
                className="pa-motion-ui min-h-[52px] flex-1 border border-[#1a1f24]/[0.1] bg-[#f6f4ef]/90 px-5 py-4 text-[15px] outline-none transition-all placeholder:text-[#1a1f24]/22 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.15)]"
              />
              <button
                type="button"
                onClick={() => handleSend()}
                disabled={isLoading}
                className="pa-motion-ui min-h-[52px] border border-[#1a1f24]/[0.12] bg-[#1a1f24] px-10 text-[11px] font-semibold tracking-[0.28em] text-[#faf9f7] transition-all duration-500 hover:-translate-y-0.5 hover:bg-[#242b32] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 uppercase"
              >
                发送
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-[#1a1f24]/38">
              最多 {MAX_CHAT_IMAGES} 张图片，单张建议小于 3.5MB；仅支持 JPEG / PNG / WebP / GIF。自由提问与 AI 带学均可附图。
            </p>
          </div>
        </div>
      </main>

      <aside
        className="relative h-full min-h-0 flex-shrink-0 overflow-hidden border-l border-[#1a1f24]/[0.08] bg-[#ebe8e0] text-[#1a1f24]"
        style={{ width: `${chapterPanelWidth}px` }}
      >
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_100%_100%,rgba(184,149,92,0.12),transparent_55%)]"
          aria-hidden
        />

        <div className="relative z-10 flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-[#1a1f24]/[0.06] p-3 sm:p-4">
              <div className="pa-label text-[10px] text-[#1a1f24]/38">Curriculum</div>
              <div className="mt-2 font-display text-2xl text-[#1a1f24] pa-motion-display">学习侧栏</div>

              <div className="relative mt-5 border border-[#1a1f24]/[0.08] bg-white/70 p-4 shadow-sm">
                <div className="pa-corners" aria-hidden>
                  <span />
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-[#1a1f24]/45">学习进度</span>
                  <span className="font-semibold text-[#8a6f42]">{progressPercent}%</span>
                </div>
                <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-[#1a1f24]/[0.08]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#b8955c] to-[#e8d5a8] transition-all duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="mt-3 text-[11px] text-[#1a1f24]/42">
                  小节测验通过 {passedSectionCount} / {totalSectionCount || '—'}
                </div>
              </div>

              <div className="mt-4 flex rounded-md border border-[#1a1f24]/[0.08] bg-[#f6f4ef]/90 p-0.5">
                {[
                  { id: 'catalog', label: '章节目录' },
                  { id: 'path', label: '学习路径' },
                  { id: 'resources', label: '资源生成' },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setChapterRightTab(t.id)}
                    className={`min-w-0 flex-1 rounded-sm px-1.5 py-2 text-[10px] font-semibold leading-tight transition-all sm:px-2 sm:text-[11px] ${
                      chapterRightTab === t.id ? 'bg-[#1a1f24] text-[#faf9f7] shadow-sm' : 'text-[#1a1f24]/55 hover:bg-white/90'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {chapterRightTab === 'catalog' && (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 scrollbar-hide sm:p-3">
              {catalogLoading && (
                <div className="border border-[#1a1f24]/[0.08] bg-white/60 p-4 text-sm text-[#1a1f24]/50">正在加载目录…</div>
              )}
              {!catalogLoading && catalogErr && (
                <div className="border border-amber-200 bg-amber-50/90 p-4 text-sm text-amber-900">{catalogErr}</div>
              )}
              {!catalogLoading &&
                !catalogErr &&
                catalog.map((chapter) => {
                  const open = !!expandedChapters[chapter.id];
                  const sections = chapter.sections || [];
                  const chapterDone =
                    sections.length > 0 &&
                    sections.every((s) => progress.sections?.[`${chapter.id}|${s.id}`]?.small_quiz_passed);

                  return (
                    <div
                      key={chapter.id}
                      className="border-l-2 border-y border-r border-y-[#1a1f24]/[0.06] border-r-[#1a1f24]/[0.06] border-l-transparent bg-transparent"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedChapters((e) => ({
                            ...e,
                            [chapter.id]: !open,
                          }))
                        }
                        className="flex w-full items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-white/70"
                      >
                        <div>
                          <div className="text-[10px] font-semibold tracking-[0.2em] text-[#1a1f24]/38 uppercase">
                            {chapterDone ? '本章小节已学' : '大章'}
                          </div>
                          <div className="mt-2 text-[13px] font-medium leading-6 text-[#1a1f24]">{chapter.title}</div>
                          <div className="mt-2 text-[11px] leading-5 text-[#1a1f24]/45">{chapter.desc}</div>
                        </div>
                        <span className="mt-1 shrink-0 text-[11px] text-[#1a1f24]/35">{open ? '▾' : '▸'}</span>
                      </button>
                      {open && (
                        <div className="space-y-1 border-t border-[#1a1f24]/[0.06] bg-white/40 px-2 py-2">
                          {sections.map((sec) => {
                            const sk = `${chapter.id}|${sec.id}`;
                            const active = selectedChapterId === chapter.id && selectedSectionId === sec.id;
                            const st = progress.sections?.[sk];
                            const dotClass = st?.small_quiz_passed
                              ? 'bg-emerald-600/85'
                              : (st?.learn_turns || 0) > 0
                                ? 'bg-amber-500/90'
                                : 'bg-[#1a1f24]/18';
                            const masteryPct = Math.round(Math.max(0, Math.min(1, Number(st?.mastery || 0))) * 100);
                            const sectionStatusLabel = st?.small_quiz_passed
                              ? '已通过'
                              : st?.quiz_pending
                                ? '待测验'
                                : (st?.learn_turns || 0) > 0
                                  ? `${masteryPct}%`
                                  : '未开始';
                            const sectionStatusClass = st?.small_quiz_passed
                              ? 'bg-emerald-50 text-emerald-800'
                              : st?.quiz_pending
                                ? 'bg-amber-50 text-amber-900'
                                : 'bg-[#1a1f24]/[0.05] text-[#1a1f24]/45';
                            return (
                              <button
                                key={sec.id}
                                type="button"
                                onClick={() => {
                                  setLearnMode(false);
                                  setSelectedChapterId(chapter.id);
                                  setSelectedSectionId(sec.id);
                                  const matched = sessions.filter((s) => s.chapter === sk);
                                  setCurrentSessionId(matched[0]?.id ?? null);
                                }}
                                className={`flex w-full items-center justify-between gap-2 rounded-sm px-3 py-2.5 text-left text-[12px] transition-all ${
                                  active
                                    ? 'bg-white font-medium text-[#1a1f24] shadow-[0_4px_14px_rgba(26,31,36,0.06)] ring-1 ring-[#b8955c]/35'
                                    : 'text-[#1a1f24]/78 hover:bg-white/80'
                                }`}
                              >
                                <span className="min-w-0 flex-1 leading-snug">{sec.title}</span>
                                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${sectionStatusClass}`}>
                                  {sectionStatusLabel}
                                </span>
                                <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} title={st?.small_quiz_passed ? '小节测验已通过' : '未完成小节测验'} />
                              </button>
                            );
                          })}
                          {(() => {
                            const cp = progress.chapters?.[chapter.id];
                            if (!cp?.chapter_quiz_ready || cp.chapter_quiz_passed) return null;
                            return (
                              <button
                                type="button"
                                onClick={() => prepareChapterQuiz(chapter.id)}
                                disabled={isLoading}
                                className="mt-2 w-full rounded-sm border border-[#b8955c]/50 bg-[#faf6ef] py-2 text-[11px] font-semibold text-[#5c4a28] transition-colors hover:bg-[#f3ead8] disabled:opacity-40"
                              >
                                大章总结测验（全小节通过后）
                              </button>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
            )}

            {chapterRightTab === 'path' && (
              <StudioPathPanel apiBase={API_BASE} username={username} subject={subject} progressSignal={progressSignal} />
            )}

            {chapterRightTab === 'resources' && (
              <StudioResourcePanel
                apiBase={API_BASE}
                username={username}
                subject={subject}
                chapterId={selectedChapterId}
                sectionId={selectedSectionId}
                scopeLabel={scopeLabel}
              />
            )}

            <div className="shrink-0 border-t border-[#1a1f24]/[0.06] p-2 sm:p-3">
              <div className="border border-[#1a1f24]/[0.08] bg-white/70 p-3 text-[11px] leading-relaxed text-[#1a1f24]/50 sm:text-[12px]">
                先选小节。达到掌握度目标或完成带学轮次后会出现小节测验；也可直接小节测验跳过带学。全章小节通过后解锁大章测验。个性化资源在「资源生成」页签。
              </div>
            </div>
          </div>
      </aside>

      {quizModal && quizModal.questions?.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[min(90vh,720px)] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#1a1f24]/10 bg-[#faf9f7] p-6 shadow-2xl">
            <h3 className="font-display text-lg text-[#1a1f24]">
              {quizResult ? '测验结果与解析' : quizModal.type === 'small' ? '小节学习总结测验' : '大章学习总结测验'}
            </h3>
            <p className="mt-2 text-[12px] text-[#1a1f24]/50">
              {quizResult
                ? `得分 ${Math.round(quizResult.score)} 分，${quizResult.correct}/${quizResult.total} 题正确。${quizResult.passed ? '已通过。' : '未达标，已自动接入 AI 继续学习。'}`
                : quizModal.type === 'small'
                  ? `共 ${SMALL_QUIZ_QUESTION_COUNT} 题，答对 60% 及以上为通过。`
                  : '共 5 题，答对 60% 及以上为通过。'}
            </p>
            {quizResult ? (
              <div className="mt-5 space-y-4">
                {!quizResult.passed && (
                  <div className="rounded-md border border-amber-200 bg-amber-50/90 p-3 text-[12px] leading-relaxed text-amber-900">
                    未达标后已自动创建补救带学会话。关闭此窗口后，继续跟随 AI 补薄弱点。
                  </div>
                )}
                {(quizResult.items || []).map((item, qi) => {
                  const selected = Number(item.selected_index);
                  const correct = Number(item.correct_index);
                  const selectedText = selected >= 0 ? `${String.fromCharCode(65 + selected)}. ${item.options?.[selected] || ''}` : '未作答';
                  const correctText = correct >= 0 ? `${String.fromCharCode(65 + correct)}. ${item.options?.[correct] || ''}` : '—';
                  return (
                    <div key={item.index ?? qi} className="rounded-md border border-[#1a1f24]/[0.08] bg-white/75 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-[13px] font-medium leading-relaxed text-[#1a1f24]">
                          {qi + 1}. {item.question}
                        </div>
                        <span
                          className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${
                            item.is_correct ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
                          }`}
                        >
                          {item.is_correct ? '正确' : '需复习'}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2 text-[12px] text-[#1a1f24]/60 sm:grid-cols-2">
                        <div>你的答案：<span className="text-[#1a1f24]">{selectedText}</span></div>
                        <div>正确答案：<span className="text-[#1a1f24]">{correctText}</span></div>
                      </div>
                      <p className="mt-2 text-[12px] leading-relaxed text-[#1a1f24]/58">
                        解析：{item.explanation || '请回到本小节资料，重新核对该知识点。'}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-5 space-y-5">
                {quizModal.questions.map((q, qi) => (
                  <div key={qi} className="border-b border-[#1a1f24]/[0.06] pb-4 last:border-0">
                    <div className="text-[13px] font-medium leading-relaxed text-[#1a1f24]">
                      {qi + 1}. {q.question}
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {(q.options || []).map((opt, oi) => (
                        <label
                          key={oi}
                          className="flex cursor-pointer items-start gap-2 rounded-sm border border-transparent px-2 py-1.5 text-[12px] hover:bg-white"
                        >
                          <input
                            type="radio"
                            className="mt-0.5"
                            name={`quiz-q-${qi}`}
                            checked={quizPicks[qi] === oi}
                            onChange={() =>
                              setQuizPicks((prev) => {
                                const next = [...prev];
                                next[qi] = oi;
                                return next;
                              })
                            }
                          />
                          <span>{opt}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setQuizModal(null)}
                className="rounded-sm border border-[#1a1f24]/12 px-4 py-2 text-[12px] text-[#1a1f24]/70 hover:bg-white"
              >
                {quizResult ? '关闭' : '稍后'}
              </button>
              {!quizResult && (
                <button
                  type="button"
                  disabled={isLoading || quizPicks.some((p) => p < 0)}
                  onClick={() => {
                    if (quizModal.type === 'small') {
                      submitSmallQuiz(quizPicks);
                    } else {
                      submitChapterQuiz(quizModal.chapterId, quizPicks);
                    }
                  }}
                  className="rounded-sm bg-[#1a1f24] px-4 py-2 text-[12px] font-semibold text-[#faf9f7] disabled:opacity-40"
                >
                  提交答案
                </button>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default function App() {
  const [currentUser, setCurrentUser] = useState(localStorage.getItem('currentUser') || '');
  const [appStep, setAppStep] = useState(localStorage.getItem('currentUser') ? 'subjects' : 'login');
  const [selectedSubject, setSelectedSubject] = useState(null);
  const [selectedStudyMode, setSelectedStudyMode] = useState('free');
  const [introDone, setIntroDone] = useState(false);
  const isDesignPreview =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === 'design';

  const handleSwitchAccount = () => {
    localStorage.removeItem('currentUser');
    setCurrentUser('');
    setSelectedSubject(null);
    setSelectedStudyMode('free');
    setAppStep('login');
  };

  if (isDesignPreview) {
    return <DesignPreview />;
  }

  return (
    <ClickRippleSurface className="dp2-root">
      {!introDone && <IntroLoader onComplete={() => setIntroDone(true)} />}
      <header className="dp2-header dp2-header-compact">
        <button
          type="button"
          className="dp2-brand"
          onClick={() => {
            if (currentUser) setAppStep('subjects');
          }}
        >
          <strong>Mentor</strong>
          <span>{currentUser ? currentUser : 'Learning Field'}</span>
        </button>
      </header>
      <main className="dp2-main" key={appStep}>
      {appStep === 'login' && (
        <LoginView
          onLoginSuccess={(name) => {
            localStorage.setItem('currentUser', name);
            setCurrentUser(name);
            setAppStep('subjects');
          }}
        />
      )}

      {appStep === 'subjects' && (
        <SubjectGridExactV29
          apiBase={API_BASE}
          username={currentUser}
          onSelectSubject={(n, mode = 'free') => {
            setSelectedSubject(n);
            setSelectedStudyMode(mode === 'guided' ? 'guided' : 'free');
            setAppStep('chat');
          }}
          onSwitchAccount={handleSwitchAccount}
        />
      )}

      {appStep === 'chat' && (
        <ChatView
          subject={selectedSubject}
          username={currentUser}
          initialMode={selectedStudyMode}
          onBack={() => setAppStep('subjects')}
          onSwitchAccount={handleSwitchAccount}
        />
      )}
    </main>
    </ClickRippleSurface>
  );
}
