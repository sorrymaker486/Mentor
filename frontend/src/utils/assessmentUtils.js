const TYPE_LABELS = {
  single: '单选题',
  multi: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
  short_answer: '简答题',
};

export const assessmentTypeLabel = (type) => TYPE_LABELS[type] || '题目';

const normalizeText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[\s，。；：、,.!?！？()（）\-_/]+/g, '');

export function emptyAssessmentAnswer(question) {
  if (question?.type === 'multi') return [];
  if (question?.type === 'fill_blank' || question?.type === 'short_answer') return '';
  if (question?.type === 'true_false') return null;
  return -1;
}

export function isAssessmentAnswered(question, answer) {
  if (question?.type === 'multi') return Array.isArray(answer) && answer.length > 0;
  if (question?.type === 'fill_blank' || question?.type === 'short_answer') {
    return String(answer ?? '').trim().length > 0;
  }
  if (question?.type === 'true_false') return typeof answer === 'boolean';
  return Number.isInteger(answer) && answer >= 0;
}

export function assessmentCorrectAnswer(question) {
  const options = question?.options || [];
  if (question?.type === 'multi') {
    return (question.correct_indices || [])
      .map((index) => `${String.fromCharCode(65 + Number(index))}. ${options[Number(index)] ?? ''}`)
      .join('；');
  }
  if (question?.type === 'true_false') return question.correct_bool ? '正确' : '错误';
  if (question?.type === 'fill_blank') return (question.accepted_answers || []).join(' / ');
  if (question?.type === 'short_answer') return question.reference_answer || '—';
  const index = Number(question?.correct_index);
  return Number.isInteger(index) && index >= 0
    ? `${String.fromCharCode(65 + index)}. ${options[index] ?? ''}`
    : '—';
}

export function assessmentUserAnswer(question, answer) {
  const options = question?.options || [];
  if (!isAssessmentAnswered(question, answer)) return '未作答';
  if (question?.type === 'multi') {
    return answer
      .map((index) => `${String.fromCharCode(65 + Number(index))}. ${options[Number(index)] ?? ''}`)
      .join('；');
  }
  if (question?.type === 'true_false') return answer ? '正确' : '错误';
  if (question?.type === 'fill_blank' || question?.type === 'short_answer') return String(answer).trim();
  const index = Number(answer);
  return `${String.fromCharCode(65 + index)}. ${options[index] ?? ''}`;
}

export function scoreAssessmentQuestion(question, answer) {
  const points = Number(question?.points) > 0 ? Number(question.points) : 1;
  if (!isAssessmentAnswered(question, answer)) {
    return { awardedPoints: 0, isCorrect: false };
  }
  if (question?.type === 'multi') {
    const expected = [...(question.correct_indices || [])].map(Number).sort((a, b) => a - b);
    const selected = Array.isArray(answer) ? [...answer].map(Number).sort((a, b) => a - b) : [];
    const correct = expected.length === selected.length && expected.every((value, index) => value === selected[index]);
    return { awardedPoints: correct ? points : 0, isCorrect: correct };
  }
  if (question?.type === 'true_false') {
    const correct = typeof answer === 'boolean' && answer === Boolean(question.correct_bool);
    return { awardedPoints: correct ? points : 0, isCorrect: correct };
  }
  if (question?.type === 'fill_blank') {
    const selected = normalizeText(answer);
    const correct = Boolean(selected) && (question.accepted_answers || []).some((item) => normalizeText(item) === selected);
    return { awardedPoints: correct ? points : 0, isCorrect: correct };
  }
  if (question?.type === 'short_answer') {
    const selected = normalizeText(answer);
    const keywords = (question.keywords || []).map(normalizeText).filter(Boolean);
    const reference = normalizeText(question.reference_answer);
    if (!selected) return { awardedPoints: 0, isCorrect: false };
    const ratio = keywords.length
      ? keywords.filter((keyword) => selected.includes(keyword)).length / keywords.length
      : reference && (selected.includes(reference) || reference.includes(selected))
        ? 1
        : 0;
    return { awardedPoints: Math.round(points * Math.min(1, ratio) * 100) / 100, isCorrect: ratio >= 0.6 };
  }
  const correct = Number(answer) === Number(question?.correct_index);
  return { awardedPoints: correct ? points : 0, isCorrect: correct };
}

export function buildAssessmentResults(questions, answers) {
  const items = questions.map((question, index) => {
    const score = scoreAssessmentQuestion(question, answers[index]);
    return {
      index,
      id: question.id || `q${index + 1}`,
      section: question.section || '综合练习',
      type: question.type || 'single',
      target_concept: question.target_concept || '',
      points: Number(question.points) || 1,
      awarded_points: score.awardedPoints,
      question: question.question,
      options: question.options || [],
      selected_answer: assessmentUserAnswer(question, answers[index]),
      correct_answer: assessmentCorrectAnswer(question),
      is_correct: score.isCorrect,
      explanation: question.explain || question.explanation || '请回到当前小节核对这个知识点。',
    };
  });
  const correct = items.filter((item) => item.is_correct).length;
  const totalPoints = items.reduce((sum, item) => sum + item.points, 0);
  const earnedPoints = items.reduce((sum, item) => sum + item.awarded_points, 0);
  return {
    items,
    correct,
    incorrect: items.length - correct,
    total: items.length,
    earned_points: earnedPoints,
    total_points: totalPoints,
    score: totalPoints ? (earnedPoints / totalPoints) * 100 : 0,
    passed: totalPoints ? earnedPoints / totalPoints >= 0.6 : false,
  };
}

export function assessmentWeakPointsFromResult(result, { scopeLabel = '', fallbackSection = '' } = {}) {
  const items = Array.isArray(result?.items) ? result.items : [];
  return items
    .filter((item) => !item?.is_correct)
    .slice(0, 5)
    .map((item, index) => {
      const selected = String(item.selected_answer || '').trim();
      const correct = String(item.correct_answer || '').trim();
      const explanation = String(item.explanation || '').trim();
      const reasonParts = [
        selected ? `你的答案：${selected}` : '',
        correct ? `正确答案：${correct}` : '',
        explanation ? `解析：${explanation}` : '',
      ].filter(Boolean);
      return {
        index: Number(item.index ?? index) + 1,
        section: item.target_concept || fallbackSection || scopeLabel || item.section || '',
        type: item.type || 'practice',
        question: item.question || '',
        reason: reasonParts.join('；') || explanation || '这道题需要回到当前小节重新核对。',
        selected_answer: selected,
        correct_answer: correct,
        target_concept: item.target_concept || '',
      };
    });
}

function safeFilename(value) {
  return String(value || '测评解析')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function assessmentMarkdownDownload({ title, result, questions = [], answers = [] }) {
  const items = result?.items?.length
    ? result.items
    : buildAssessmentResults(questions, answers).items;
  const summary = result || buildAssessmentResults(questions, answers);
  const lines = [
    `# ${title || '测评题目与详细解析'}`,
    '',
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    `- 得分：${Math.round(Number(summary.score) || 0)} 分`,
    `- 正确：${summary.correct ?? 0} 题`,
    `- 错误：${summary.incorrect ?? Math.max(0, (summary.total ?? items.length) - (summary.correct ?? 0))} 题`,
    '',
  ];
  items.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.question}`, '');
    lines.push(`- 题型：${assessmentTypeLabel(item.type)}`);
    lines.push(`- 分值：${item.awarded_points ?? 0} / ${item.points ?? 1}`);
    if (item.options?.length) {
      lines.push('- 选项：');
      item.options.forEach((option, optionIndex) => {
        lines.push(`  - ${String.fromCharCode(65 + optionIndex)}. ${option}`);
      });
    }
    lines.push(`- 你的答案：${item.selected_answer || '未作答'}`);
    lines.push(`- 正确答案：${item.correct_answer || '—'}`);
    lines.push(`- 结果：${item.is_correct ? '正确' : '错误或需补充'}`);
    lines.push('', `### 解析`, '', item.explanation || '暂无解析。', '');
  });
  const content = lines.join('\n');
  return {
    href: `data:text/markdown;charset=utf-8,%EF%BB%BF${encodeURIComponent(content)}`,
    filename: `${safeFilename(title)}.md`,
  };
}

export function downloadAssessmentMarkdown(options) {
  const download = assessmentMarkdownDownload(options);
  const anchor = document.createElement('a');
  anchor.href = download.href;
  anchor.download = download.filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
