import React, { useEffect, useMemo, useState } from 'react';
import GridOverlay from './GridOverlay';
import StrokeLines from './StrokeLines';
import styles from './heroMotion.module.css';
import { HERO_MOTION } from './motionConstants';

export default function HeroTitle({
  titleLines = [],
  subtitleLines = [],
  description = '',
  tone = 'light',
  className = '',
  enterDelay = 0,
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (enterDelay <= 0) {
      const id = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(() => setReady(true), enterDelay);
    return () => clearTimeout(id);
  }, [enterDelay]);

  const cssVars = useMemo(
    () => ({
      '--grid-gap': HERO_MOTION.spacing.gridGap,
      '--line-enter-offset': `${HERO_MOTION.movement.lineEnterOffsetPx}px`,
      '--line-enter-blur': `${HERO_MOTION.movement.lineEnterBlurPx}px`,
      '--line-enter-duration': `${HERO_MOTION.timing.lineEnterMs}ms`,
      '--line-enter-ease': HERO_MOTION.timing.lineEnterEase,
      '--line-stagger-ms': `${HERO_MOTION.timing.lineStaggerMs}ms`,
      '--line-breath-duration': `${HERO_MOTION.timing.lineBreathMs}ms`,
      '--stroke-draw-duration': `${HERO_MOTION.timing.strokeDrawMs}ms`,
      '--grid-pan-duration': `${HERO_MOTION.timing.gridPanMs}ms`,
      '--grid-drift-x': `${HERO_MOTION.movement.gridDriftXPx}px`,
      '--grid-drift-y': `${HERO_MOTION.movement.gridDriftYPx}px`,
      '--breath-min': HERO_MOTION.opacity.breathMin,
      '--breath-max': HERO_MOTION.opacity.breathMax,
      '--stroke-color': HERO_MOTION.colors.stroke,
      '--stroke-opacity': HERO_MOTION.opacity.stroke,
      '--grid-opacity': tone === 'dark' ? HERO_MOTION.opacity.gridDark : HERO_MOTION.opacity.gridLight,
      '--title-color': tone === 'dark' ? HERO_MOTION.colors.titleDark : HERO_MOTION.colors.titleLight,
      '--subtitle-color': tone === 'dark' ? HERO_MOTION.colors.subtitleDark : HERO_MOTION.colors.subtitleLight,
    }),
    [tone]
  );

  return (
    <div
      className={`${styles.heroTitle} ${tone === 'dark' ? styles.dark : styles.light} ${
        ready ? styles.ready : ''
      } ${className}`}
      style={cssVars}
    >
      <GridOverlay tone={tone} />

      <div className={styles.content}>
        {/* titleFrame：紧紧贴合文字本身的尺寸。SVG 矩形/扫光线的参照系就是它 */}
        <div className={styles.titleFrame}>
          <StrokeLines tone={tone} />

          <div className={styles.titleInner}>
            {titleLines.map((line, index) => (
              <p
                key={`title-${line}-${index}`}
                className={`${styles.line} ${styles.mainLine}`}
                style={{ '--line-delay': `${index * HERO_MOTION.timing.lineStaggerMs}ms` }}
              >
                {line}
              </p>
            ))}

            {subtitleLines.map((line, index) => (
              <p
                key={`subtitle-${line}-${index}`}
                className={`${styles.line} ${styles.subLine}`}
                style={{
                  '--line-delay': `${(titleLines.length + index) * HERO_MOTION.timing.lineStaggerMs}ms`,
                }}
              >
                {line}
              </p>
            ))}
          </div>
        </div>

        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
    </div>
  );
}
