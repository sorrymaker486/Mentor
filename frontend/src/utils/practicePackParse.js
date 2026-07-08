import { decodeResourceMarkdownStream } from './resourceStreamDecode.js';

const LETTER_INDEX_RE = /^[A-H]$/i;
const LETTER_PREFIX_RE = /^[（(【\[]?\s*([A-H])\s*[）)\]】]?\s*[.．、:：\-]\s*/i;

function firstPresent(...values) {
  return values.find((value) => value != null && String(value).trim() !== '');
}

function normalizeAnswerText(value) {
  return String(value ?? '')
    .trim()
    .replace(/^答案\s*[:：]\s*/i, '')
    .replace(/^正确答案\s*[:：]\s*/i, '')
    .replace(/^选项\s*/i, '')
    .replace(/^选\s*/i, '')
    .trim();
}

function cleanOptionText(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(LETTER_PREFIX_RE, '').trim();
}

function optionObjectText(item) {
  if (!item || typeof item !== 'object') return '';
  return firstPresent(
    item.text,
    item.value,
    item.content,
    item.option,
    item.label_text,
    item.labelText,
    item.name,
    item['文本'],
    item['内容'],
    item['选项'],
  );
}

function parsePracticeIndex(value, options = []) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeAnswerText(value);
  if (!text) return null;
  const directLetter = text.match(LETTER_INDEX_RE);
  if (directLetter) return directLetter[0].toUpperCase().charCodeAt(0) - 65;
  const namedLetter = text.match(/^([A-H])\s*选项$/i) || text.match(/^选\s*([A-H])$/i);
  if (namedLetter) return namedLetter[1].toUpperCase().charCodeAt(0) - 65;
  const prefixed = text.match(LETTER_PREFIX_RE);
  if (prefixed) return prefixed[1].toUpperCase().charCodeAt(0) - 65;
  const number = Number(text);
  if (Number.isFinite(number)) return number;
  const byText = options.findIndex((option) => {
    const normalizedOption = cleanOptionText(option);
    return normalizedOption === text || String(option).trim() === text || text.endsWith(normalizedOption);
  });
  return byText >= 0 ? byText : null;
}

function normalizePracticeIndex(value, options = []) {
  const parsed = parsePracticeIndex(value, options);
  if (parsed == null) return null;
  const number = Number(parsed);
  if (!Number.isInteger(number)) return null;
  if (options.length) {
    if (number >= 0 && number < options.length) return number;
    if (number >= 1 && number <= options.length) return number - 1;
    return null;
  }
  return number;
}

function normalizePracticeIndexArray(value, options = []) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          const text = normalizeAnswerText(value);
          if (/^[A-H]{2,}$/i.test(text)) return text.split('');
          return text.split(/[,\s，、;；]+/).filter(Boolean);
        })()
      : value == null
        ? []
        : [value];
  const numericValues = values
    .map((item) => {
      const parsed = Number(normalizeAnswerText(item));
      return Number.isInteger(parsed) ? parsed : null;
    })
    .filter((item) => item != null);
  if (
    options.length &&
    numericValues.length === values.length &&
    numericValues.every((number) => number >= 1 && number <= options.length) &&
    numericValues.some((number) => number === options.length)
  ) {
    return [...new Set(numericValues.map((number) => number - 1))].sort((a, b) => a - b);
  }
  const numbers = values.map((item) => normalizePracticeIndex(item, options)).filter((item) => item != null);
  return [...new Set(numbers.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function parsePracticeBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (/^(true|1|yes|y|正确|对|是)$/i.test(text)) return true;
  if (/^(false|0|no|n|错误|错|否)$/i.test(text)) return false;
  return null;
}

function normalizePracticeOptions(rawOptions) {
  if (Array.isArray(rawOptions)) {
    return rawOptions
      .map((item) => (item && typeof item === 'object' ? optionObjectText(item) : item))
      .map(cleanOptionText)
      .filter(Boolean);
  }
  if (rawOptions && typeof rawOptions === 'object') {
    return Object.entries(rawOptions)
      .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
      .map(([, value]) => (value && typeof value === 'object' ? optionObjectText(value) : value))
      .map(cleanOptionText)
      .filter(Boolean);
  }
  return [];
}

function normalizePracticeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const question = String(
    firstPresent(
      raw.question,
      raw.prompt,
      raw.Question,
      raw.stem,
      raw.question_text,
      raw.questionText,
      raw.content,
      raw['题目'],
      raw['题干'],
      raw['问题'],
      raw.title,
    ) ?? '',
  ).trim();
  const options = normalizePracticeOptions(
    firstPresent(raw.options, raw.Options, raw['选项'], raw.choices, raw.Choices, raw.answers_options, raw.answerOptions),
  );
  const rawType = String(raw.type ?? raw.Type ?? raw['题型'] ?? '').toLowerCase();
  const answerSource = firstPresent(
    raw.correct_answer,
    raw.correctAnswer,
    raw.correct,
    raw.answer,
    raw.Answer,
    raw.answer_key,
    raw.answerKey,
    raw.right_answer,
    raw.rightAnswer,
    raw['答案'],
    raw['正确答案'],
    raw['参考答案'],
  );
  const type = /multi|multiple|多选|复选/.test(rawType)
    ? 'multi'
    : /true_false|boolean|judge|判断/.test(rawType)
      ? 'true_false'
      : /fill_blank|fill|填空/.test(rawType)
        ? 'fill_blank'
        : /short_answer|short|简答/.test(rawType)
          ? 'short_answer'
          : 'single';
  let correctIndex =
    raw.correct_index ??
    raw.correctIndex ??
    raw.correct_option ??
    raw.correctOption ??
    raw.answer_index ??
    raw.answerIndex ??
    raw.answer_option ??
    raw.answerOption ??
    raw['正确选项'] ??
    raw['正确答案序号'] ??
    raw['正确选项序号'] ??
    answerSource;
  let correctIndices =
    raw.correct_indices ??
    raw.correctIndices ??
    raw.correct_options ??
    raw.correctOptions ??
    raw.answer_indices ??
    raw.answerIndices ??
    raw.answer_options ??
    raw.answerOptions ??
    raw.answer_keys ??
    raw.answerKeys ??
    raw.answers ??
    raw.correct_answers ??
    raw['答案序号组'] ??
    raw['正确选项组'] ??
    raw['正确答案序号组'] ??
    raw['正确选项序号组'];

  correctIndices = normalizePracticeIndexArray(correctIndices, options);
  if (type === 'single' && correctIndex == null && correctIndices.length === 1) {
    correctIndex = correctIndices[0];
  }
  correctIndex = normalizePracticeIndex(correctIndex, options);
  if (type === 'multi' && correctIndices.length === 0 && correctIndex != null) {
    correctIndices = [correctIndex];
  }
  const acceptedRaw =
    raw.accepted_answers ??
    raw.acceptedAnswers ??
    raw.blank_answers ??
    raw.blankAnswers ??
    raw.answers ??
    raw['可接受答案'] ??
    (type === 'fill_blank' ? answerSource : null);
  const acceptedAnswers = Array.isArray(acceptedRaw)
    ? acceptedRaw.map((item) => String(item ?? '').trim()).filter(Boolean)
    : acceptedRaw == null
      ? []
      : [String(acceptedRaw).trim()].filter(Boolean);
  const keywordRaw = raw.keywords ?? raw['关键词'];
  const keywords = Array.isArray(keywordRaw)
    ? keywordRaw.map((item) => String(item ?? '').trim()).filter(Boolean)
    : typeof keywordRaw === 'string'
      ? keywordRaw.split(/[,，、;；\s]+/).filter(Boolean)
      : [];
  const correctBool = parsePracticeBool(raw.correct_bool ?? raw.correctBool ?? answerSource);
  const referenceAnswer = String(
    firstPresent(raw.reference_answer, raw.referenceAnswer, raw.model_answer, raw.modelAnswer, answerSource) ?? ''
  ).trim();
  if (!question) return null;
  if ((type === 'single' || type === 'multi') && options.length < 2) return null;
  if (type === 'single' && correctIndex == null) return null;
  if (type === 'multi' && correctIndices.length === 0) return null;
  if (type === 'true_false' && correctBool == null) return null;
  if (type === 'fill_blank' && acceptedAnswers.length === 0) return null;
  if (type === 'short_answer' && !referenceAnswer) return null;

  return {
    ...raw,
    id: String(raw.id ?? `q-${question.slice(0, 12)}`),
    section: String(raw.section ?? '综合练习'),
    points: Number(raw.points) > 0 ? Number(raw.points) : 1,
    question,
    options,
    type,
    correct_index: correctIndex,
    correct_indices: correctIndices,
    correct_bool: correctBool,
    accepted_answers: acceptedAnswers,
    reference_answer: referenceAnswer,
    keywords,
    explain: raw.explain ?? raw.Explain ?? raw.explanation ?? raw.analysis ?? raw['解析'] ?? raw['解析说明'] ?? raw['说明'],
  };
}

function unwrapPracticePayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const keys = ['questions', 'items', 'data', 'practice_pack', 'practicePack', 'quiz', 'exercises'];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = unwrapPracticePayload(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function stripPracticeWrapper(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .trim()
    .replace(/^`{1,3}\s*(?:json|javascript|js)?\s*/i, '')
    .replace(/^\s*(?:json|javascript|js)\s*(?=[[{])/i, '')
    .replace(/`{1,3}\s*$/i, '')
    .trim();
}

function escapeControlCharactersInsideStrings(value) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const character of String(value || '')) {
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (character === '\n') output += '\\n';
    else if (character === '\r') output += '\\r';
    else if (character === '\t') output += '\\t';
    else if (character.charCodeAt(0) < 32) output += ' ';
    else output += character;
  }
  return output;
}

function repairPracticeJson(value) {
  return escapeControlCharactersInsideStrings(stripPracticeWrapper(value))
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .trim();
}

function balancedJsonSegments(value, open, close) {
  const text = String(value || '');
  const segments = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === close && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        segments.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return segments;
}

function parsePracticePayload(candidate) {
  const attempts = [stripPracticeWrapper(candidate), repairPracticeJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (typeof parsed === 'string') {
        const nested = parsePracticePayload(parsed);
        if (nested?.length) return nested;
      }
      const normalized = unwrapPracticePayload(parsed).map(normalizePracticeItem).filter(Boolean);
      if (normalized.length) return normalized;
    } catch {
      // Try the repaired or object-by-object fallbacks below.
    }
  }
  return null;
}

function parsePracticeObjectsIndividually(value) {
  const items = balancedJsonSegments(value, '{', '}')
    .map((segment) => {
      try {
        return normalizePracticeItem(JSON.parse(repairPracticeJson(segment)));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return items.length ? items : null;
}

export function extractPracticeQuestions(text) {
  const decoded = decodeResourceMarkdownStream(text || '');
  const sources = [...new Set([decoded, text].map((value) => String(value || '').trim()).filter(Boolean))];
  const candidates = [];
  const pushCandidate = (value) => {
    const candidate = String(value || '').trim();
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  for (const source of sources) {
    pushCandidate(source);
    for (const match of source.matchAll(/`{1,3}(?:json|javascript|js)?\s*([\s\S]*?)`{1,3}/gi)) {
      pushCandidate(match[1]);
    }
    balancedJsonSegments(source, '[', ']').forEach(pushCandidate);
    balancedJsonSegments(source, '{', '}').forEach(pushCandidate);
  }

  for (const candidate of candidates) {
    const parsed = parsePracticePayload(candidate);
    if (parsed?.length) return parsed;
  }
  for (const source of sources) {
    const parsed = parsePracticeObjectsIndividually(source);
    if (parsed?.length) return parsed;
  }
  return null;
}
