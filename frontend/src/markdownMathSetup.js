import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/**
 * remark-math + rehype-katex（关闭 KaTeX strict）。
 * 课件/模型常在 $...$ 里混写中文说明，strict 会刷屏 unicodeTextInMathMode 警告。
 */
export const markdownRemarkPlugins = [remarkMath];
export const markdownRehypePlugins = [[rehypeKatex, { strict: false }]];
