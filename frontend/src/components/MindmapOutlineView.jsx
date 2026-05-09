import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import {
  flowchartOrGraphToOutlineMd,
  mermaidDefinitionToOutlineMd,
  markdownToMarkmapOutline,
} from '../utils/mindmapOutline';

const transformer = new Transformer();

const MM_OPTIONS = {
  autoFit: true,
  zoom: true,
  pan: true,
  embedGlobalCSS: true,
  initialExpandLevel: 2,
  toggleRecursively: false,
  duration: 0,
  maxWidth: 260,
  spacingHorizontal: 18,
  spacingVertical: 10,
  fitRatio: 0.92,
};

/**
 * 基于 Markmap 的可折叠/缩放思维大纲（与 Mermaid mindmap 同源结构）。
 * @param {boolean} [streaming] 为 true 时不做 Markmap 重绘（流式每字更新会极卡）。
 */
export default function MindmapOutlineView({ mermaidDefinition, fullMarkdown, streaming = false }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const mmRef = useRef(null);
  const [err, setErr] = useState('');
  const debounceRef = useRef(null);

  const outlineMd = useMemo(() => {
    if (mermaidDefinition && String(mermaidDefinition).trim()) {
      const o = mermaidDefinitionToOutlineMd(mermaidDefinition);
      if (o) return o;
      const f = flowchartOrGraphToOutlineMd(mermaidDefinition);
      if (f) return f;
    }
    return markdownToMarkmapOutline(fullMarkdown || '') || '';
  }, [mermaidDefinition, fullMarkdown]);

  useEffect(() => {
    if (streaming) {
      try {
        mmRef.current?.destroy();
      } catch {
        /* ignore */
      }
      mmRef.current = null;
      setErr('');
    }
  }, [streaming]);

  useEffect(() => {
    if (streaming) return undefined;
    if (!outlineMd.trim() || !svgRef.current) return undefined;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    let cancelled = false;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      (async () => {
        try {
          setErr('');
          const { root } = transformer.transform(outlineMd);
          if (cancelled || !svgRef.current) return;
          if (!mmRef.current) {
            mmRef.current = Markmap.create(svgRef.current, MM_OPTIONS);
          }
          await mmRef.current.setData(root);
          await mmRef.current.fit();
        } catch (e) {
          if (!cancelled) setErr(String(e?.message || e) || '大纲解析失败');
        }
      })();
    }, 160);

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [outlineMd, streaming]);

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

  if (streaming) {
    return (
      <div className="flex h-full min-h-[240px] w-full flex-col items-center justify-center gap-2 px-6 text-center text-sm leading-relaxed text-[#1a1f24]/50">
        <p className="font-medium text-[#1a1f24]/65">生成中…</p>
        <p className="max-w-sm text-[12px]">
          流式阶段不刷新交互大纲（避免每字重算 Markmap 卡顿）。结束后约 0.2s 内自动渲染。
        </p>
      </div>
    );
  }

  if (!outlineMd.trim()) {
    return (
      <div className="flex h-full min-h-[240px] w-full items-center justify-center px-6 text-center text-sm leading-relaxed text-[#1a1f24]/45">
        当前内容无法生成可折叠大纲（未识别到 mindmap / flowchart，且正文中缺少可用标题）。可在「Mermaid 导图」页签查看矢量图；正文使用多级标题（##）时此处会自动汇总。
      </div>
    );
  }

  if (err) {
    return (
      <div className="flex h-full min-h-[200px] w-full items-center justify-center px-4 text-center text-xs leading-relaxed text-red-800">
        {err}
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-full min-h-[300px] w-full min-w-0 flex-1 overflow-hidden rounded-lg border border-[#1a1f24]/[0.06] bg-white"
    >
      <svg ref={svgRef} className="h-full w-full min-h-[280px] touch-manipulation" />
      <p className="pointer-events-none absolute bottom-2 left-0 right-0 text-center text-[10px] text-[#1a1f24]/35">
        点击节点圆点可折叠/展开；滚轮缩放，空白处拖拽平移
      </p>
    </div>
  );
}
