import React from 'react';
import styles from './heroMotion.module.css';

/*
  矩形就是 viewBox 的 0-100 边界，完全贴合外层 titleFrame（titleFrame 本身
  通过 display:inline-block 紧贴文字）。
  SVG 通过 overflow:visible 允许路径延伸到 viewBox 外，实现"从容器外进入/离开"。
*/

export default function StrokeLines({ tone = 'light' }) {
  return (
    <svg
      className={`${styles.strokeLayer} ${tone === 'dark' ? styles.dark : styles.light}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {/* 四条边顺序扫光一圈后消失；无静态底框，避免开场停留线条 */}
      {/* 上：(0,0) → (100,0) */}
      <line
        x1="0" y1="0" x2="100" y2="0"
        pathLength="100"
        className={styles.edgeTop}
      />
      {/* 右：(100,0) → (100,100) */}
      <line
        x1="100" y1="0" x2="100" y2="100"
        pathLength="100"
        className={styles.edgeRight}
      />
      {/* 下：(100,100) → (0,100) 与上边顺接为顺时针 */}
      <line
        x1="100" y1="100" x2="0" y2="100"
        pathLength="100"
        className={styles.edgeBottom}
      />
      {/* 左：(0,100) → (0,0) */}
      <line
        x1="0" y1="100" x2="0" y2="0"
        pathLength="100"
        className={styles.edgeLeft}
      />
    </svg>
  );
}
