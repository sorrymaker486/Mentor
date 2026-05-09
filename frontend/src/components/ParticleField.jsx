import { useEffect, useRef } from 'react';

const LINK_DIST = 86;
const LINK_DIST_SQ = LINK_DIST * LINK_DIST;

/**
 * 高密度粒子 + 近邻连线 + 深度雾 + 水平/垂直流动线（无斜线）与横向扫描。
 * 参考 in-pro 类站点并强化动态；prefers-reduced-motion 下为静态一帧。
 */
export default function ParticleField({ className = '', areaScale = 1 }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let particles = [];
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    const makeParticles = () => {
      const area = Math.max(1, width * height);
      /* 更密：约每 4200px² 一个点，上限提高 */
      const divisor = 4200 / Math.max(0.55, Math.min(1.65, areaScale));
      const target = Math.round(Math.min(340, Math.max(90, area / divisor)));
      particles = [];
      for (let i = 0; i < target; i += 1) {
        const depth = Math.random();
        const speed = 0.35 + depth * 0.65;
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.26 * speed,
          vy: (Math.random() - 0.5) * 0.22 * speed,
          r: 0.55 + depth * 1.55,
          a: 0.28 + Math.random() * 0.55,
          z: 0.2 + depth * 0.85,
          depth,
        });
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (width < 1 || height < 1) return;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      makeParticles();
    };

    const onPointer = (e) => {
      const rect = canvas.getBoundingClientRect();
      pointer.tx = (e.clientX - rect.left) / rect.width - 0.5;
      pointer.ty = (e.clientY - rect.top) / rect.height - 0.5;
    };

    const ro = new ResizeObserver(() => {
      resize();
    });
    ro.observe(canvas);
    resize();
    window.addEventListener('pointermove', onPointer, { passive: true });

    /** 仅水平/垂直线 + 横向扫描（无斜线，减轻视觉压力） */
    const drawMotionLines = (t) => {
      const phase = t * 0.0011;

      ctx.save();
      ctx.lineCap = 'round';

      /* 水平金线：整体缓慢下移 */
      ctx.strokeStyle = 'rgba(184, 149, 92, 0.16)';
      ctx.lineWidth = 1;
      /* 间距大些，避免栅格过密引起不适 */
      const gapY = 92 + Math.sin(phase) * 14;
      const offY = (t * 0.028) % gapY;
      for (let y = -offY; y < height + gapY; y += gapY) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      /* 垂直墨线：纯竖线缓慢横移，与水平正交 */
      ctx.strokeStyle = 'rgba(26, 31, 36, 0.055)';
      ctx.lineWidth = 1;
      const gapX = 132;
      const offX = (t * 0.016) % gapX;
      for (let x = -offX; x < width + gapX; x += gapX) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      /* 横向金色扫描带 */
      const scanY = (t * 0.045) % (height + 120) - 60;
      const g = ctx.createLinearGradient(0, scanY - 28, 0, scanY + 28);
      g.addColorStop(0, 'rgba(184, 149, 92, 0)');
      g.addColorStop(0.45, 'rgba(184, 149, 92, 0.38)');
      g.addColorStop(0.55, 'rgba(212, 188, 136, 0.5)');
      g.addColorStop(1, 'rgba(184, 149, 92, 0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(0, scanY);
      ctx.lineTo(width, scanY);
      ctx.stroke();

      /* 底部缓慢正弦波曲线 */
      ctx.strokeStyle = 'rgba(184, 149, 92, 0.2)';
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      const baseY = height * 0.78;
      for (let x = 0; x <= width; x += 6) {
        const yy =
          baseY +
          Math.sin(x * 0.014 + phase * 2.4) * 22 +
          Math.sin(x * 0.006 + t * 0.0009) * 14;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();

      ctx.restore();
    };

    /** 粒子间连线：距离衰减 + 深度（粗筛 dx 降低 inner 次数） */
    const drawLinks = (driftX, driftY) => {
      const n = particles.length;
      ctx.save();
      for (let i = 0; i < n; i += 1) {
        const a = particles[i];
        const ax = a.x + driftX * a.z;
        const ay = a.y + driftY * a.z;
        for (let j = i + 1; j < n; j += 1) {
          const b = particles[j];
          const bx = b.x + driftX * b.z;
          const by = b.y + driftY * b.z;
          const dx = ax - bx;
          if (dx > LINK_DIST || dx < -LINK_DIST) continue;
          const dy = ay - by;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_DIST_SQ) continue;
          const d = Math.sqrt(d2);
          const fall = 1 - d / LINK_DIST;
          const dep = (a.depth + b.depth) * 0.5;
          const alpha = fall * (0.28 + dep * 0.62);
          ctx.strokeStyle = `rgba(200, 172, 118, ${alpha})`;
          ctx.lineWidth = 0.7 + dep * 0.65;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    const drawParticles = (driftX, driftY) => {
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        const ox = driftX * p.z;
        const oy = driftY * p.z;
        const fog = 0.32 + p.depth * 0.68;
        const alphaInk = p.a * fog * 0.72;
        const alphaGold = p.a * fog * 0.85;

        ctx.beginPath();
        ctx.arc(p.x + ox, p.y + oy, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(26, 31, 36, ${alphaInk})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(
          p.x + ox - p.r * 0.18,
          p.y + oy - p.r * 0.18,
          Math.max(0.35, p.r * 0.42),
          0,
          Math.PI * 2
        );
        ctx.fillStyle = `rgba(212, 188, 136, ${alphaGold})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p.x + ox, p.y + oy, p.r * 1.65, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(184, 149, 92, ${0.06 + p.depth * 0.12})`;
        ctx.fill();
      }
    };

    /** 径向 +纵向雾：边缘略沉、中心仍透，不盖住粒子与线条 */
    const drawFog = () => {
      const cx = width * 0.52;
      const cy = height * 0.38;
      const r = Math.max(width, height) * 0.82;

      const rg = ctx.createRadialGradient(cx, cy, Math.min(width, height) * 0.06, cx, cy, r);
      rg.addColorStop(0, 'rgba(246, 244, 239, 0)');
      rg.addColorStop(0.55, 'rgba(246, 244, 239, 0.02)');
      rg.addColorStop(0.88, 'rgba(232, 226, 214, 0.14)');
      rg.addColorStop(1, 'rgba(214, 204, 188, 0.26)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, width, height);

      const lg = ctx.createLinearGradient(0, 0, 0, height);
      lg.addColorStop(0, 'rgba(246, 244, 239, 0.1)');
      lg.addColorStop(0.28, 'rgba(246, 244, 239, 0)');
      lg.addColorStop(0.72, 'rgba(246, 244, 239, 0)');
      lg.addColorStop(1, 'rgba(228, 220, 208, 0.16)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, width, height);
    };

    const paint = (t) => {
      ctx.clearRect(0, 0, width, height);
      const driftX = pointer.x * 48;
      const driftY = pointer.y * 36;

      drawMotionLines(t);
      drawLinks(driftX, driftY);
      drawParticles(driftX, driftY);
      drawFog();
    };

    if (reduced) {
      paint(0);
      return () => {
        ro.disconnect();
        window.removeEventListener('pointermove', onPointer);
      };
    }

    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      const k = dt / 16.67;
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        p.x += p.vx * k;
        p.y += p.vy * k;
        if (p.x < -8) p.x = width + 8;
        if (p.x > width + 8) p.x = -8;
        if (p.y < -8) p.y = height + 8;
        if (p.y > height + 8) p.y = -8;
      }
      pointer.x += (pointer.tx - pointer.x) * 0.055;
      pointer.y += (pointer.ty - pointer.y) * 0.055;
      paint(now);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
    };
  }, [areaScale]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 z-[1] h-full w-full ${className}`}
      aria-hidden
    />
  );
}
