import { useEffect, useRef, useState } from 'react';
import styles from './IntroLoader.module.css';

/**
 * 载入：中央小号固定百分比；全屏环境粒子 + 横贯屏幕的「粒子点阵」进度条（无实体粗条）。
 */
export default function IntroLoader({ onComplete }) {
  const [pct, setPct] = useState(0);
  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);
  const startRef = useRef(performance.now());
  const onCompleteRef = useRef(onComplete);
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const rafRef = useRef(0);
  const pctRef = useRef(0);
  onCompleteRef.current = onComplete;
  pctRef.current = pct;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let w = 0;
    let h = 0;

    const build = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      if (w < 2 || h < 2) return;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const area = w * h;
      const n = Math.min(160, Math.max(56, Math.floor(area / 12000)));
      const list = [];
      for (let i = 0; i < n; i += 1) {
        list.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.42,
          vy: (Math.random() - 0.5) * 0.34,
          r: 0.35 + Math.random() * 2.1,
          base: 0.1 + Math.random() * 0.42,
          phase: Math.random() * Math.PI * 2,
          kind: Math.random() > 0.48 ? 'gold' : 'ink',
        });
      }
      particlesRef.current = list;
    };

    const ro = new ResizeObserver(() => build());
    ro.observe(canvas);
    build();

    let t0 = performance.now();
    const paint = (t) => {
      const elapsed = (t - t0) * 0.001;
      const pLoad = Math.min(1, pctRef.current / 100);
      const edgeX = pLoad * w;

      ctx.clearRect(0, 0, w, h);

      const list = particlesRef.current;
      for (let i = 0; i < list.length; i += 1) {
        const p = list[i];
        if (!reduced) {
          p.x += p.vx * 0.9;
          p.y += p.vy * 0.9;
          if (p.x < -6) p.x = w + 6;
          if (p.x > w + 6) p.x = -6;
          if (p.y < -6) p.y = h + 6;
          if (p.y > h + 6) p.y = -6;
        }

        const nx = p.x / w;
        /* 背景粒子：略随进度提亮，主进度交给点阵条 */
        const regionBoost = 0.52 + 0.75 * Math.min(1, nx / Math.max(0.08, pLoad + 0.04));
        const distWave = Math.abs(p.x - edgeX);
        const waveBoost = 1 + Math.max(0, 1 - distWave / 95) * 0.35 * Math.sin(elapsed * 2.8 + p.phase);
        const pulse = 0.52 + 0.48 * Math.sin(elapsed * 1.35 + p.phase);
        let a = p.base * pulse * regionBoost * waveBoost;
        a = Math.min(0.95, a);

        /* 正中留给固定百分比，略压低粒子对比 */
        const cx = w * 0.5;
        const cy = h * 0.5;
        const dCenter = Math.hypot(p.x - cx, p.y - cy);
        if (dCenter < 88) {
          a *= 0.28 + 0.72 * (dCenter / 88);
        }

        const rr = p.r * (0.85 + 0.35 * Math.min(1, nx / Math.max(0.08, pLoad + 0.04)));

        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        if (p.kind === 'gold') {
          ctx.fillStyle = `rgba(210, 182, 118, ${a})`;
        } else {
          ctx.fillStyle = `rgba(26, 31, 36, ${a * 0.55})`;
        }
        ctx.fill();
      }

      /* 粒子进度条：全宽点阵，已加载段为金色亮粒，未加载为淡墨轨 */
      const barY = h * 0.5 + 36;
      const step = Math.max(3, Math.min(6, Math.floor(w / 320)));
      const pctNow = pctRef.current;
      for (let x = 0; x <= w; x += step) {
        const u = (x / w) * 100;
        const filled = u <= pctNow + 0.25;
        const atHead = Math.abs(u - pctNow) < 1.15;
        const wobble = Math.sin(elapsed * 2.5 + x * 0.06) * 1.6;
        const yy = barY + wobble;
        if (filled) {
          const tw = 0.38 + 0.42 * Math.sin(elapsed * 3.1 + x * 0.09);
          const r = atHead ? 2.15 : 1.35;
          const a = Math.min(0.92, tw + (atHead ? 0.28 : 0));
          ctx.beginPath();
          ctx.arc(x, yy, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(206, 176, 108, ${a})`;
          ctx.fill();
          if (atHead) {
            ctx.beginPath();
            ctx.arc(x, yy, r * 2.1, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(240, 214, 160, ${0.12 + 0.08 * Math.sin(elapsed * 4)})`;
            ctx.fill();
          }
        } else {
          const a = 0.06 + 0.035 * Math.sin(elapsed * 1.1 + x * 0.05);
          ctx.beginPath();
          ctx.arc(x, yy, 1.05, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(26, 31, 36, ${a})`;
          ctx.fill();
        }
      }

      rafRef.current = reduced ? 0 : requestAnimationFrame(paint);
    };

    rafRef.current = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const minHoldMs = reduced ? 400 : 1750;
    const rampMs = reduced ? 1 : 1200;
    const exitMs = reduced ? 300 : 580;

    let raf = 0;
    if (!reduced) {
      const tick = () => {
        const elapsed = performance.now() - startRef.current;
        const u = Math.min(1, elapsed / rampMs);
        const eased = 1 - (1 - u) ** 3;
        setPct(Math.min(100, Math.floor(eased * 100)));
        if (u < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } else {
      setPct(100);
    }

    let exitTimer;
    const finishTimer = setTimeout(() => {
      setPct(100);
      setExiting(true);
      exitTimer = setTimeout(() => {
        if (!doneRef.current) {
          doneRef.current = true;
          onCompleteRef.current?.();
        }
      }, exitMs);
    }, minHoldMs);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(finishTimer);
      if (exitTimer) clearTimeout(exitTimer);
    };
  }, []);

  return (
    <div
      className={`${styles.root} ${exiting ? styles.exiting : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}%`}
      aria-busy={!exiting}
      aria-label="加载进度"
    >
      <canvas ref={canvasRef} className={styles.particles} aria-hidden />
      <div className={styles.pctCenter}>{pct}%</div>
    </div>
  );
}
