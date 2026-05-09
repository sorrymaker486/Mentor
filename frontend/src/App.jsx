import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import HeroTitle from './components/hero-motion/HeroTitle';
import ParticleField from './components/ParticleField';
import IntroLoader from './components/IntroLoader';
import {
  StudioMentorOverviewModal,
  StudioPortraitCard,
  StudioPathPanel,
  StudioResourcePanel,
} from './components/LearningStudioBlocks';
import { API_BASE } from './apiConfig';
import 'katex/dist/katex.min.css';

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

  let t = text;

  t = t
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim()}$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m.trim()}$$`);

  t = t.replace(
    /`([^`]*?(?:\\frac|\\lim|\\sum|\\int|\\sqrt|\\to|=|\^|_)[^`]*)`/g,
    (_, m) => m
  );

  return t;
};

const ASK_USER_JSON_PREFIX = '__PA_USER_JSON__\n';
const MAX_CHAT_IMAGES = 5;

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
            remarkPlugins={[remarkMath]}
            rehypePlugins={[rehypeKatex]}
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

const LoginView = ({ onLoginSuccess }) => {
  const [authStep, setAuthStep] = useState('check');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [regEmail, setRegEmail] = useState('');
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
    const u = (params.get('username') || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
    const t = (params.get('token') || '').replace(/\s/g, '');
    if (u.length >= 3 && t.length >= 16) {
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
    if (authStep === 'check' || authStep === 'forgot') return;
    const timer = setTimeout(() => passwordRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [authStep]);

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  const handleAuthSubmit = async () => {
    const cleanUsername = username.trim();
    const cleanPassword = password.trim();
    const cleanConfirm = confirmPassword.trim();
    const cleanToken = resetToken.trim();

    const usernameRegex = /^[a-zA-Z0-9_]{3,16}$/;
    /* 注册 / 重置：仅大小写字母与数字，且须同时含大写、小写、数字；6-20 位 */
    const passwordRegisterRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9]{6,20}$/;

    if (authStep === 'check') {
      if (!cleanUsername) {
        setErrorMsg('请输入用户名');
        triggerShake();
        return;
      }
      if (!usernameRegex.test(cleanUsername)) {
        setErrorMsg('用户名需为 3-16 位字母、数字或下划线');
        triggerShake();
        return;
      }
    }

    if (authStep === 'forgot') {
      if (tokenReady) {
        setAuthStep('forgot-reset');
        setErrorMsg('');
        return;
      }
      if (!cleanUsername) {
        setErrorMsg('请输入用户名');
        triggerShake();
        return;
      }
      if (!usernameRegex.test(cleanUsername)) {
        setErrorMsg('用户名需为 3-16 位字母、数字或下划线');
        triggerShake();
        return;
      }
    }

    if (authStep === 'forgot-reset') {
      if (!cleanUsername) {
        setErrorMsg('请输入用户名');
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
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      if (authStep === 'check') {
        const response = await fetch(
          `${API_BASE}/user-exists?username=${encodeURIComponent(cleanUsername)}`
        );
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          const hint404 =
            '未找到接口（多为后端未重启或代码未加载）。请重启后端进程，并在 API 文档（/docs）中搜索 user-exists';
          setErrorMsg(
            response.status === 404 ? hint404 : formatApiDetail(data) || '无法校验用户名'
          );
          triggerShake();
          return;
        }

        if (data.exists) {
          setAuthStep('login');
        } else {
          setAuthStep('register');
        }
      } else if (authStep === 'forgot') {
        const response = await fetch(`${API_BASE}/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: cleanUsername }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = formatApiDetail(data);
          if (response.status === 429) {
            setErrorMsg(detail || '请求过于频繁，请稍后再试');
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
        setAuthStep('login');
        setPassword('');
        setConfirmPassword('');
        setResetToken('');
        setTokenReady(false);
        setResetHint('');
        setShowPassword(false);
        setShowConfirmPassword(false);
        setSuccessMsg(typeof data.message === 'string' ? data.message : '密码已重置，请使用新密码登录');
      } else {
        const url = `${API_BASE}/${authStep}`;
        const regBody =
          authStep === 'register'
            ? {
                username: cleanUsername,
                password: cleanPassword,
                ...(regEmail.trim() ? { email: regEmail.trim() } : {}),
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
      setErrorMsg('服务连接失败');
      triggerShake();
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleAuthSubmit();
  };

  return (
    <div className="pa-page relative flex h-dvh max-h-dvh flex-col overflow-hidden bg-[#f6f4ef] text-[#1a1f24] pa-grain">
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
                    {authStep === 'check'
                      ? '身份确认'
                      : authStep === 'login'
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
                    {authStep === 'check'
                      ? '你好，准备开始吧'
                      : authStep === 'login'
                        ? '欢迎回来'
                        : authStep === 'register'
                          ? '创建你的账户'
                          : authStep === 'forgot'
                            ? '找回你的访问'
                            : '设置新密码'}
                  </h1>
                  <p className="mt-4 text-sm font-light leading-relaxed text-[#1a1f24]/50 md:text-[15px] pa-motion-body">
                    {authStep === 'check'
                      ? '输入用户名，系统会自动判断你是登录还是注册。'
                      : authStep === 'login'
                        ? '请输入密码继续进入学习空间。'
                        : authStep === 'register'
                          ? '该用户名可用。新密码须为 6-20 位，仅大小写字母与数字，且同时包含大写、小写与数字。可选填邮箱以便收取重置链接。'
                          : authStep === 'forgot'
                            ? tokenReady
                              ? resetHint ||
                                '系统不会在网页上显示令牌。请查收注册邮箱（含垃圾箱），点击邮件中的链接完成重置。'
                              : '提交后，若账号已登记过邮箱，我们会向该邮箱发送一封带重置链接的邮件（链接约 20 分钟内有效）。'
                            : '粘贴邮件中的重置令牌，或通过邮件内一键链接自动填入，并设置符合规则的新密码。'}
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                  <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">Username</label>
                  <input
                      type="text"
                      readOnly={authStep === 'forgot-reset'}
                      placeholder="用户名 (3-16位字母/数字/下划线)"
                      value={username}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
                        setUsername(val);
                        if (errorMsg) setErrorMsg('');
                        if (successMsg) setSuccessMsg('');
                      }}
                      onKeyDown={handleKeyDown}
                    className="pa-motion-ui w-full border border-[#1a1f24]/[0.1] bg-[#faf9f7] px-4 py-4 text-[15px] font-medium outline-none transition-all duration-500 placeholder:text-[#1a1f24]/22 read-only:cursor-default read-only:bg-[#f0ede6]/80 focus:border-[#b8955c]/55 focus:bg-white focus:shadow-[0_0_0_1px_rgba(184,149,92,0.2)]"
                  />
                </div>

                {authStep === 'forgot' && tokenReady && (
                  <div className="space-y-2 border border-amber-200/90 bg-amber-50/90 px-4 py-3 text-sm leading-relaxed text-[#1a1f24]/80">
                    <p className="font-medium text-[#1a1f24]">下一步前请先取得令牌</p>
                    <p>
                      这里<strong>不会显示</strong>安全令牌。请到<strong>注册时填写的邮箱</strong>查收（别忘了看<strong>垃圾箱</strong>
                      与<strong>订阅邮件</strong>），点击邮件里的链接继续完成重置。
                    </p>
                    <p className="text-[12px] text-[#1a1f24]/55">
                      若迟迟收不到：确认用的是注册时登记的邮箱；在邮箱里搜索「Mentor」或「重置」；稍等几分钟再刷新。
                      若邮件里的链接打不开，请用与平时打开本页相同的网址重新进入后再试。
                    </p>
                  </div>
                )}

                {authStep === 'forgot-reset' && (
                  <div>
                    <label className="mb-2 block text-[10px] pa-label text-[#1a1f24]/35 pa-motion-body">Reset token</label>
                    <input
                      type="text"
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
                      Email（可选，用于找回密码）
                    </label>
                    <input
                      type="email"
                      autoComplete="email"
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
                        : authStep === 'check'
                          ? '继续'
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
                        setAuthStep('check');
                        setPassword('');
                        setRegEmail('');
                        setErrorMsg('');
                        setSuccessMsg('');
                        setShowPassword(false);
                      }}
                      className="w-full py-3 text-[12px] tracking-[0.18em] text-[#1a1f24]/38 transition-colors hover:text-[#1a1f24] uppercase"
                    >
                      返回重新输入用户名
                    </button>
                  )}

                  {authStep === 'register' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAuthStep('check');
                        setPassword('');
                        setRegEmail('');
                        setErrorMsg('');
                        setSuccessMsg('');
                        setShowPassword(false);
                      }}
                      className="w-full py-3 text-[12px] tracking-[0.18em] text-[#1a1f24]/38 transition-colors hover:text-[#1a1f24] uppercase"
                    >
                      返回重新输入用户名
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
    <div className="pa-page relative flex h-dvh max-h-dvh flex-col overflow-hidden bg-[#f6f4ef] text-[#1a1f24] pa-grain">
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

// --- 3. 对话界面：会话列表 + 章节目录（大章 / 小节，数据来自后端 /learning-catalog）---
const ChatView = ({ subject, username, onBack }) => {
  const welcomeMessage = { role: 'assistant', content: `你好 **${username}**！欢迎来到 **${subject}** 导师课堂。` };

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
  const [visitedSections, setVisitedSections] = useState([]);
  const [progress, setProgress] = useState({ sections: {}, chapters: {} });
  const [learnMode, setLearnMode] = useState(false);
  const [quizModal, setQuizModal] = useState(null);
  const [chapterPanelWidth] = useState(380);

  const messagesEndRef = useRef(null);
  const imageInputRef = useRef(null);
  const bufferRef = useRef('');
  const displayRef = useRef('');
  const rawRef = useRef('');
  const rafRef = useRef(null);
  const readerRef = useRef(null);

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try {
        readerRef.current?.cancel?.();
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

    try {
      const url = `${API_BASE}/history/${sessionId}`;
      const response = await fetch(url);
      const data = await response.json().catch(() => []);

      if (!response.ok) {
        throw new Error(data?.detail || '历史记录加载失败');
      }

      if (Array.isArray(data) && data.length > 0) {
        setMessages(data);
      } else {
        setMessages([welcomeMessage]);
      }
    } catch (e) {
      console.error(e);
      setMessages([welcomeMessage]);
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
    setLearnMode(false);
    setQuizModal(null);
    setProgress({ sections: {}, chapters: {} });
    setChapterRightTab('catalog');

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
  }, [username, subject]);

  useEffect(() => {
    localStorage.setItem(progressKey, JSON.stringify(visitedSections));
  }, [visitedSections, progressKey]);

  const markSectionVisited = (key) => {
    if (!key) return;
    setVisitedSections((prev) => {
      if (prev.includes(key)) return prev;
      return [...prev, key];
    });
  };

  const passedSectionCount = useMemo(() => {
    return Object.values(progress.sections || {}).filter((x) => x.small_quiz_passed).length;
  }, [progress.sections]);

  const progressPercent = totalSectionCount
    ? Math.round((passedSectionCount / totalSectionCount) * 100)
    : 0;

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
    if (!sessionScopeKey) return;

    const chapterSessions = sessions.filter((s) => s.chapter === sessionScopeKey);

    if (chapterSessions.length > 0) {
      const preferred = chapterSessions.find((s) => s.id === currentSessionId) || chapterSessions[0];
      if (preferred && preferred.id !== currentSessionId) {
        setCurrentSessionId(preferred.id);
      }
    } else {
      if (currentSessionId !== null) {
        setCurrentSessionId(null);
      }
      setMessages([welcomeMessage]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionScopeKey, sessions]);

  useEffect(() => {
    if (!currentSessionId) {
      setMessages([welcomeMessage]);
      return;
    }

    const matched = sessions.find((s) => s.id === currentSessionId);
    if (matched) {
      if (matched.chapter && catalog.length) {
        applySessionChapter(matched.chapter);
      }
      loadSessionHistory(currentSessionId);
    } else {
      setMessages([welcomeMessage]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, catalog]);

  const [quizPicks, setQuizPicks] = useState([]);

  useEffect(() => {
    if (quizModal?.questions?.length) {
      setQuizPicks(quizModal.questions.map(() => -1));
    } else {
      setQuizPicks([]);
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
      if (returnedSessionId) {
        const numericId = Number(returnedSessionId);
        if (!Number.isNaN(numericId)) setCurrentSessionId(numericId);
      }
      startRenderLoop();
      await pumpStream(r);
      finalizeAssistantStream({ stripLearnMeta: false });
      await loadSessions();
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

  const handleLearnAnswer = async (text, imageSnapshot = []) => {
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
      const meta = finalizeAssistantStream({ stripLearnMeta: true });
      if (meta?.small_quiz && Array.isArray(meta.small_quiz) && meta.small_quiz.length >= 3) {
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
      setQuizModal(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `小节测验得分：**${Math.round(j.score)}** 分（${j.correct}/${j.total} 题正确）${j.passed ? '，已通过。' : '，未达 60 分，可重新作答带学问题后再测。'}`,
        },
      ]);
      await loadLearningProgress();
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
    if (!prevText) return nextChunk;
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

  const finalizeAssistantStream = ({ stripLearnMeta = false } = {}) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (bufferRef.current.length > 0) {
      displayRef.current += bufferRef.current;
      bufferRef.current = '';
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

    const tick = () => {
      if (bufferRef.current.length > 0) {
        const sliceSize = 8;
        const piece = bufferRef.current.slice(0, sliceSize);
        bufferRef.current = bufferRef.current.slice(sliceSize);

        displayRef.current += piece;

        setMessages((prev) => {
          const updated = [...prev];
          const lastIndex = updated.length - 1;
          if (lastIndex >= 0) {
            updated[lastIndex] = {
              ...updated[lastIndex],
              content: displayRef.current,
            };
          }
          return updated;
        });
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
    if (!selectedChapterId || !selectedSectionId) return;

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
    setMessages((prev) => [...prev, { role: 'user', content: userContent }, { role: 'assistant', content: '' }]);
    setInputText('');
    setPendingImages([]);
    setIsLoading(true);

    bufferRef.current = '';
    displayRef.current = '';
    rawRef.current = '';

    try {
      const sessionPart = currentSessionId ? `&session_id=${encodeURIComponent(currentSessionId)}` : '';
      const scopePart = `&chapter_id=${encodeURIComponent(selectedChapterId)}&section_id=${encodeURIComponent(selectedSectionId)}&chapter=${encodeURIComponent(scopeLabel || '')}`;
      let response;
      if (imageSnapshot.length) {
        response = await fetch(`${API_BASE}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            subject,
            question: text,
            chapter_id: selectedChapterId,
            section_id: selectedSectionId,
            chapter: scopeLabel || '',
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
      if (returnedSessionId) {
        const numericId = Number(returnedSessionId);
        if (!Number.isNaN(numericId)) {
          setCurrentSessionId(numericId);
        }
      }

      if (!response.body) {
        throw new Error('没有可读取的响应流');
      }

      startRenderLoop();
      await pumpStream(response);
      finalizeAssistantStream({ stripLearnMeta: false });

      await loadSessions();
      markSectionVisited(sessionScopeKey);

      if (returnedSessionId) {
        await loadSessionHistory(Number(returnedSessionId));
      } else if (currentSessionId) {
        await loadSessionHistory(currentSessionId);
      }
    } catch (e) {
      console.error(e);
      setMessages((prev) => {
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        if (lastIndex >= 0 && updated[lastIndex].role === 'assistant' && !updated[lastIndex].content) {
          updated[lastIndex] = { ...updated[lastIndex], content: '抱歉，当前服务暂时不可用。' };
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

  return (
    <div className="pa-page flex h-dvh max-h-dvh min-h-0 overflow-hidden bg-[#f6f4ef] text-[#1a1f24] pa-grain">
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
        <div className="scrollbar-hide relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
          <div className="mx-auto max-w-3xl space-y-10">
            {messages.map((m, i) => (
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
                  ) : (
                    <div className="prose prose-sm max-w-none prose-neutral">
                      <ReactMarkdown
                        remarkPlugins={[remarkMath]}
                        rehypePlugins={[rehypeKatex]}
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
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="relative z-10 shrink-0 border-t border-[#1a1f24]/[0.06] bg-white/85 px-4 py-4 backdrop-blur-xl md:px-8 md:py-5">
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="text-[12px] font-medium tracking-wide text-[#1a1f24]/45">
                当前小节 · <span className="text-[#1a1f24]">{scopeLabel || '未选择'}</span>
              </div>
              <div className="h-[3px] w-44 overflow-hidden rounded-full bg-[#1a1f24]/[0.08]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#b8955c] to-[#d4bc88] transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

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
              <StudioPathPanel apiBase={API_BASE} username={username} subject={subject} />
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
                先选小节。自由提问由你发起；「AI 带学」由导师提问、你作答，完成后有小节测验；全小节通过后解锁大章测验。个性化资源在「资源生成」页签。
              </div>
            </div>
          </div>
      </aside>

      {quizModal && quizModal.questions?.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[min(90vh,640px)] w-full max-w-lg overflow-y-auto rounded-xl border border-[#1a1f24]/10 bg-[#faf9f7] p-6 shadow-2xl">
            <h3 className="font-display text-lg text-[#1a1f24]">
              {quizModal.type === 'small' ? '小节学习总结测验' : '大章学习总结测验'}
            </h3>
            <p className="mt-2 text-[12px] text-[#1a1f24]/50">
              {quizModal.type === 'small' ? '共 3 题，答对 60% 及以上为通过。' : '共 5 题，答对 60% 及以上为通过。'}
            </p>
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
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setQuizModal(null)}
                className="rounded-sm border border-[#1a1f24]/12 px-4 py-2 text-[12px] text-[#1a1f24]/70 hover:bg-white"
              >
                稍后
              </button>
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
  const [introDone, setIntroDone] = useState(false);

  return (
    <>
      {!introDone && <IntroLoader onComplete={() => setIntroDone(true)} />}
      <div className="pa-page h-dvh max-h-dvh overflow-hidden bg-[#f6f4ef] text-[#1a1f24] antialiased">
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
        <SubjectGrid
          apiBase={API_BASE}
          username={currentUser}
          onSelectSubject={(n) => {
            setSelectedSubject(n);
            setAppStep('chat');
          }}
          onLogout={() => {
            localStorage.removeItem('currentUser');
            setCurrentUser('');
            setSelectedSubject(null);
            setAppStep('login');
          }}
        />
      )}

      {appStep === 'chat' && (
        <ChatView
          subject={selectedSubject}
          username={currentUser}
          onBack={() => setAppStep('subjects')}
        />
      )}
    </div>
    </>
  );
}