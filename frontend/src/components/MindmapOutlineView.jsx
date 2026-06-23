import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import {
  flowchartOrGraphToOutlineMd,
  mermaidDefinitionToOutlineMd,
  markdownToMarkmapOutline,
} from '../utils/mindmapOutline';

const transformer = new Transformer();

const BASE_MARKMAP_OPTIONS = {
  autoFit: true,
  zoom: true,
  pan: true,
  embedGlobalCSS: true,
  initialExpandLevel: 3,
  toggleRecursively: false,
  duration: 0,
};

const DEFAULT_MARKMAP_OPTIONS = {
  ...BASE_MARKMAP_OPTIONS,
  maxWidth: 280,
  spacingHorizontal: 28,
  spacingVertical: 12,
  fitRatio: 0.88,
};

const COMPACT_MARKMAP_OPTIONS = {
  ...BASE_MARKMAP_OPTIONS,
  maxWidth: 210,
  spacingHorizontal: 20,
  spacingVertical: 9,
  fitRatio: 0.78,
};

function fitSoon(markmap) {
  if (!markmap) return;
  [0, 120, 320].forEach((delay) => {
    window.setTimeout(() => {
      try {
        markmap.fit?.();
      } catch {
        /* ignore */
      }
    }, delay);
  });
}

export default function MindmapOutlineView({ mermaidDefinition, fullMarkdown, streaming = false, compact = false }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const mmRef = useRef(null);
  const debounceRef = useRef(null);
  const [err, setErr] = useState('');

  const outlineMd = useMemo(() => {
    if (mermaidDefinition && String(mermaidDefinition).trim()) {
      const outline = mermaidDefinitionToOutlineMd(mermaidDefinition);
      if (outline) return outline;
      const flowOutline = flowchartOrGraphToOutlineMd(mermaidDefinition);
      if (flowOutline) return flowOutline;
    }
    return markdownToMarkmapOutline(fullMarkdown || '') || '';
  }, [mermaidDefinition, fullMarkdown]);

  useEffect(() => {
    if (!streaming) return;
    try {
      mmRef.current?.destroy();
    } catch {
      /* ignore */
    }
    mmRef.current = null;
    setErr('');
  }, [streaming]);

  useEffect(() => {
    if (streaming) return undefined;
    if (!outlineMd.trim() || !svgRef.current) return undefined;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    let cancelled = false;
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      (async () => {
        try {
          setErr('');
          const { root } = transformer.transform(outlineMd);
          if (cancelled || !svgRef.current) return;
          if (!mmRef.current) {
            mmRef.current = Markmap.create(
              svgRef.current,
              compact ? COMPACT_MARKMAP_OPTIONS : DEFAULT_MARKMAP_OPTIONS
            );
          }
          await mmRef.current.setData(root);
          fitSoon(mmRef.current);
        } catch (e) {
          if (!cancelled) setErr(String(e?.message || e) || '大纲解析失败');
        }
      })();
    }, 120);

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [compact, outlineMd, streaming]);

  useEffect(
    () => () => {
      try {
        mmRef.current?.destroy();
      } catch {
        /* ignore */
      }
      mmRef.current = null;
    },
    []
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!mmRef.current) return;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitSoon(mmRef.current));
    });
    observer.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  if (streaming) {
    return (
      <div className={`dp2-markmap-state ${compact ? 'is-compact' : ''}`}>
        <p className="dp2-markmap-title">生成中...</p>
        <p>正在整理当前小节的知识关系。</p>
      </div>
    );
  }

  if (!outlineMd.trim()) {
    return (
      <div className={`dp2-markmap-state ${compact ? 'is-compact' : ''}`}>
        还没有可成图的结构。生成后会显示完整知识导图。
      </div>
    );
  }

  if (err) {
    return (
      <div className={`dp2-markmap-state is-error ${compact ? 'is-compact' : ''}`}>
        {err}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={`dp2-markmap-shell ${compact ? 'is-compact' : ''}`}>
      <svg ref={svgRef} className="dp2-markmap-svg" />
      {!compact && <p className="dp2-markmap-hint">滚轮缩放，拖拽移动；点击圆点折叠节点</p>}
    </div>
  );
}
