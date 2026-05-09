import React, { useEffect, useMemo, useRef } from 'react';
import styles from './heroMotion.module.css';
import { HERO_MOTION } from './motionConstants';

export default function GridOverlay({ tone = 'light' }) {
  const layerRef = useRef(null);
  const rafRef = useRef(null);
  const targetRef = useRef({ x: 0, y: 0 });
  const currentRef = useRef({ x: 0, y: 0 });

  const isMobile = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(max-width: ${HERO_MOTION.mobileBreakpointPx}px)`).matches;
  }, []);

  useEffect(() => {
    const tick = () => {
      const el = layerRef.current;
      if (!el) return;
      currentRef.current.x += (targetRef.current.x - currentRef.current.x) * 0.08;
      currentRef.current.y += (targetRef.current.y - currentRef.current.y) * 0.08;
      el.style.setProperty('--parallax-x', `${currentRef.current.x.toFixed(2)}px`);
      el.style.setProperty('--parallax-y', `${currentRef.current.y.toFixed(2)}px`);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handlePointerMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relX = (event.clientX - rect.left) / rect.width - 0.5;
    const relY = (event.clientY - rect.top) / rect.height - 0.5;
    const maxOffset = isMobile
      ? HERO_MOTION.movement.parallaxMaxMobilePx
      : HERO_MOTION.movement.parallaxMaxDesktopPx;

    targetRef.current.x = relX * 2 * maxOffset;
    targetRef.current.y = relY * 2 * maxOffset;
  };

  const handlePointerLeave = () => {
    targetRef.current.x = 0;
    targetRef.current.y = 0;
  };

  return (
    <div
      className={`${styles.gridOverlay} ${tone === 'dark' ? styles.dark : styles.light}`}
      onMouseMove={handlePointerMove}
      onMouseLeave={handlePointerLeave}
      aria-hidden
    >
      <div ref={layerRef} className={styles.gridParallaxLayer}>
        <div className={styles.gridLayer} />
      </div>
    </div>
  );
}
