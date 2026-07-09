import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { normalizeMathText } from './markdownMathNormalize.js';

test('preserves complete display and inline math regions', () => {
  const source = String.raw`判断下面哪个是函数？

$$
f(x)=\begin{cases}
x+1, & x \le 0 \\
x-1, & x > 0
\end{cases}
$$

定义域为全体实数 $\mathbb{R}$。

$y=\sqrt{x}$`;

  const output = normalizeMathText(source);

  assert.match(output, /\$\$\nf\(x\)=\\begin\{cases\}/);
  assert.match(output, /\\end\{cases\}\n\$\$/);
  assert.ok(output.includes(String.raw`$y=\sqrt{x}$`));
  assert.ok(output.includes(String.raw`$\mathbb{R}$`));

  const displayBody = output.match(/\$\$([\s\S]*?)\$\$/)?.[1] || '';
  const displayHtml = katex.renderToString(displayBody, {
    displayMode: true,
    throwOnError: false,
  });
  const sqrtHtml = katex.renderToString(String.raw`y=\sqrt{x}`, {
    throwOnError: false,
  });

  assert.doesNotMatch(displayHtml, /katex-error/);
  assert.doesNotMatch(sqrtHtml, /katex-error/);
  assert.match(sqrtHtml, /sqrt/);
});

test('still joins detached short math fragments outside delimited math', () => {
  const source = `集合\n\n$x$\n\n中的元素映射到\n\n$y$`;
  const output = normalizeMathText(source);

  assert.equal(output.replaceAll(' ', ''), '集合$x$中的元素映射到$y$');
});
