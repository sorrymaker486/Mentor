from __future__ import annotations

import re
from typing import Any, Dict


QUESTION_COUNT = 15


def _clean_reference_text(ref_excerpt: str) -> str:
    text_value = str(ref_excerpt or "")
    marker = "课程知识库摘录"
    if marker in text_value:
        text_value = text_value.split(marker, 1)[1]
        text_value = re.sub(r"^[^\n]*\n", "", text_value, count=1)
    text_value = re.sub(r"^【(?:课程|大章|小节)】[^\n]*$", " ", text_value, flags=re.MULTILINE)
    boilerplate = (
        "本小节只围绕上面标题对应的知识范围展开",
        "讲解应覆盖定义、核心结论、典型方法、常见误区与例题类型",
        "不要把后续章节结论当作当前小节的主要依据",
        "如需前置知识，只做简短回顾并指出应复习的小节",
        "当前未指定具体小节",
    )
    for phrase in boilerplate:
        text_value = text_value.replace(phrase, " ")
    return text_value


def has_internal_scaffolding(questions: list[Dict[str, Any]]) -> bool:
    markers = (
        "【课程】",
        "【大章】",
        "【小节】",
        "课程知识库摘录",
        "本小节只围绕",
        "讲解应覆盖",
        "不要把后续章节",
        "如需前置知识",
        "来自 backend/",
    )
    for question in questions:
        values = [
            question.get("question"),
            question.get("reference_answer"),
            question.get("explanation"),
            *(question.get("options") or []),
            *(question.get("accepted_answers") or []),
        ]
        combined = "\n".join(str(value or "") for value in values)
        if any(marker in combined for marker in markers):
            return True
    return False


def normalize_questions(raw_questions: list[Any], limit: int = QUESTION_COUNT) -> list[Dict[str, Any]]:
    aliases = {
        "single": "single",
        "choice": "single",
        "单选": "single",
        "multi": "multi",
        "multiple": "multi",
        "多选": "multi",
        "true_false": "true_false",
        "boolean": "true_false",
        "judge": "true_false",
        "判断": "true_false",
        "fill_blank": "fill_blank",
        "fill": "fill_blank",
        "填空": "fill_blank",
        "short_answer": "short_answer",
        "short": "short_answer",
        "简答": "short_answer",
    }
    defaults = {"single": 4, "multi": 6, "true_false": 4, "fill_blank": 7, "short_answer": 18}
    normalized: list[Dict[str, Any]] = []
    for index, item in enumerate(raw_questions):
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or item.get("prompt") or "").strip()
        qtype = aliases.get(str(item.get("type") or "single").strip().lower(), "single")
        if not question:
            continue
        try:
            points = max(1, min(30, int(item.get("points") or defaults[qtype])))
        except Exception:
            points = defaults[qtype]
        base: Dict[str, Any] = {
            "id": str(item.get("id") or f"q{index + 1:02d}")[:64],
            "section": str(item.get("section") or "综合练习")[:80],
            "type": qtype,
            "points": points,
            "question": question[:1000],
            "explanation": str(
                item.get("explanation")
                or item.get("explain")
                or item.get("analysis")
                or "请回到本小节资料，重新核对该知识点。"
            ).strip()[:1800],
        }
        if item.get("target_concept"):
            base["target_concept"] = str(item.get("target_concept"))[:160]
        if item.get("weak_point_index") is not None:
            base["weak_point_index"] = item.get("weak_point_index")
        if qtype in ("single", "multi"):
            options = item.get("options")
            if not isinstance(options, list) or len(options) < 2:
                continue
            base["options"] = [str(value).strip()[:400] for value in options[:6]]
            if qtype == "single":
                try:
                    correct_index = int(item.get("correct_index", -1))
                except Exception:
                    correct_index = -1
                if not 0 <= correct_index < len(base["options"]):
                    continue
                base["correct_index"] = correct_index
            else:
                raw_indices = item.get("correct_indices")
                if not isinstance(raw_indices, list):
                    continue
                correct_indices: list[int] = []
                for raw_index in raw_indices:
                    try:
                        option_index = int(raw_index)
                    except Exception:
                        continue
                    if 0 <= option_index < len(base["options"]) and option_index not in correct_indices:
                        correct_indices.append(option_index)
                if not correct_indices:
                    continue
                base["correct_indices"] = sorted(correct_indices)
        elif qtype == "true_false":
            raw_bool = item.get("correct_bool", item.get("answer", item.get("correct")))
            if isinstance(raw_bool, bool):
                base["correct_bool"] = raw_bool
            elif isinstance(raw_bool, (int, float)) and raw_bool in (0, 1):
                base["correct_bool"] = bool(raw_bool)
            elif isinstance(raw_bool, str):
                raw_text = raw_bool.strip().lower()
                if raw_text in ("true", "1", "yes", "正确", "对"):
                    base["correct_bool"] = True
                elif raw_text in ("false", "0", "no", "错误", "错"):
                    base["correct_bool"] = False
                else:
                    continue
            else:
                continue
        elif qtype == "fill_blank":
            accepted = item.get("accepted_answers") or item.get("answers") or item.get("answer")
            if isinstance(accepted, str):
                accepted = [accepted]
            if not isinstance(accepted, list):
                continue
            accepted_answers = [str(value).strip()[:300] for value in accepted if str(value).strip()]
            if not accepted_answers:
                continue
            base["accepted_answers"] = accepted_answers[:8]
        else:
            reference_answer = str(
                item.get("reference_answer") or item.get("answer") or item.get("correct_answer") or ""
            ).strip()
            keywords = item.get("keywords")
            if isinstance(keywords, str):
                keywords = re.split(r"[,，、;；\s]+", keywords)
            if not isinstance(keywords, list):
                keywords = []
            keyword_list = [str(value).strip()[:80] for value in keywords if str(value).strip()]
            if not reference_answer:
                continue
            base["reference_answer"] = reference_answer[:1600]
            base["keywords"] = keyword_list[:10]
        normalized.append(base)
        if len(normalized) >= limit:
            break
    if len(normalized) < limit:
        raise ValueError(f"quiz must contain {limit} valid questions")
    return normalized


def _sentences(ref_excerpt: str, scope_label: str) -> list[str]:
    text_value = re.sub(r"```[\s\S]*?```", " ", _clean_reference_text(ref_excerpt))
    text_value = re.sub(r"[#>*_`|\[\](){}]", " ", text_value)
    chunks = re.split(r"[\r\n。！？；]+", text_value)
    result: list[str] = []
    seen: set[str] = set()
    for chunk in chunks:
        sentence = re.sub(r"\s+", " ", chunk).strip(" -:：,，")
        if len(sentence) < 12 or len(sentence) > 150:
            continue
        if not re.search(r"[\u4e00-\u9fffA-Za-z]", sentence):
            continue
        key = re.sub(r"\s+", "", sentence).lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(sentence)
        if len(result) >= 24:
            break
    if not result:
        result = [
            f"{scope_label}需要先理解核心定义，再结合条件和例子判断如何应用。",
            f"学习{scope_label}时，应区分概念本身、适用条件和实际用途。",
            f"{scope_label}中的结论需要结合当前课程资料进行解释，不能脱离上下文。",
        ]
    seed = list(result)
    while len(result) < 12:
        result.append(seed[len(result) % len(seed)])
    return result


def _keywords(ref_excerpt: str, scope_label: str, facts: list[str]) -> list[str]:
    clean_reference = _clean_reference_text(ref_excerpt)
    candidates: list[str] = []
    candidates.extend(re.findall(r"\*\*([^*\n]{2,24})\*\*", clean_reference))
    candidates.extend(
        re.findall(
            r"(?:^|[\s，。；：])([\u4e00-\u9fffA-Za-z0-9]{2,16})(?:是指|是|指|包括|表示)",
            clean_reference,
        )
    )
    candidates.extend(re.findall(r"[\u4e00-\u9fff]{2,8}", scope_label or ""))
    for sentence in facts[:8]:
        candidates.extend(re.findall(r"[\u4e00-\u9fff]{2,6}", sentence))
    stop = {
        "本节", "资料", "内容", "学习", "一个", "可以", "需要", "进行", "通过", "以及",
        "其中", "这种", "这个", "主要", "相关", "当前", "问题", "方法", "概念",
    }
    result: list[str] = []
    for candidate in candidates:
        keyword = re.sub(r"\s+", "", str(candidate)).strip("，。；：、()（）")
        if len(keyword) < 2 or keyword in stop or keyword in result:
            continue
        result.append(keyword)
        if len(result) >= 18:
            break
    return result or ["核心定义", "适用条件", "关键步骤", "实际应用"]


def _rotate(options: list[str], correct_indices: list[int], shift: int) -> tuple[list[str], list[int]]:
    offset = shift % len(options)
    return options[offset:] + options[:offset], sorted(((index - offset) % len(options)) for index in correct_indices)


def _normalize_weak_points(weak_points: Any, scope_label: str, limit: int = 4) -> list[Dict[str, str]]:
    if not isinstance(weak_points, list):
        return []
    normalized: list[Dict[str, str]] = []
    for raw in weak_points:
        if not isinstance(raw, dict):
            continue
        concept = str(raw.get("section") or raw.get("concept") or scope_label or "当前小节").strip()
        evidence = str(raw.get("question") or raw.get("evidence") or raw.get("issue") or "").strip()
        reason = str(raw.get("reason") or raw.get("suggestion") or "").strip()
        selected = str(raw.get("selected_answer") or "").strip()
        correct = str(raw.get("correct_answer") or "").strip()
        if not concept and not evidence and not reason:
            continue
        answer_evidence = "；".join(
            part
            for part in (
                f"你的答案：{selected[:120]}" if selected else "",
                f"正确答案：{correct[:120]}" if correct else "",
            )
            if part
        )
        if answer_evidence:
            evidence = f"{evidence}；{answer_evidence}" if evidence else answer_evidence
        normalized.append(
            {
                "concept": concept[:120] or scope_label,
                "evidence": evidence[:220],
                "reason": reason[:260] or "这里容易把概念边界或适用条件混在一起。",
            }
        )
        if len(normalized) >= limit:
            break
    return normalized


def _weak_point_questions(
    weak_points: Any,
    scope_label: str,
    facts: list[str],
    unrelated: list[str],
) -> list[Dict[str, Any]]:
    weak_items = _normalize_weak_points(weak_points, scope_label)
    questions: list[Dict[str, Any]] = []
    for index, item in enumerate(weak_items):
        fact = facts[(index * 2) % len(facts)]
        concept = item["concept"]
        evidence = item["evidence"]
        reason = item["reason"]
        evidence_note = f"（表现：{evidence}）" if evidence else ""
        options, correct = _rotate(
            [
                f"先回到“{concept}”的定义、条件和例子，再解释{evidence or '这个薄弱点'}为什么会影响本节判断。",
                "直接跳过这个点，只看下一节内容。",
                unrelated[index % len(unrelated)],
                "只背一个术语，不需要说明它和本节的关系。",
            ],
            [0],
            index + 1,
        )
        questions.append(
            {
                "id": f"weak-{index + 1:02d}",
                "section": "薄弱点回看",
                "type": "single",
                "points": 5,
                "question": f"针对刚才暴露的薄弱点“{concept}”{evidence_note}，下一步最应该先确认什么？",
                "options": options,
                "correct_index": correct[0],
                "target_concept": concept,
                "weak_point_index": index + 1,
                "explanation": f"这个点需要回看：{reason}。先把定义、适用条件和例子连起来，再对照本节资料中的表述：{fact}",
            }
        )
        questions.append(
            {
                "id": f"weak-apply-{index + 1:02d}",
                "section": "薄弱点应用",
                "type": "short_answer",
                "points": 12,
                "question": (
                    f"用一句话解释“{concept}”在「{scope_label}」中的作用。"
                    + (f" 注意避开刚才的问题：{evidence}" if evidence else "")
                ),
                "reference_answer": f"{concept}需要结合本节定义、适用条件和例子来说明。{fact}",
                "keywords": [word for word in re.findall(r"[\u4e00-\u9fff]{2,6}", concept + fact)[:6]],
                "target_concept": concept,
                "weak_point_index": index + 1,
                "explanation": f"回答要同时说清概念含义、使用条件和它与本节的连接。薄弱原因：{reason}",
            }
        )
    return questions


def build_instant_paper(
    subject: str,
    scope_label: str,
    ref_excerpt: str,
    section_summary: str = "",
    weak_points: Any = None,
) -> list[Dict[str, Any]]:
    source = "\n".join(value for value in (section_summary, ref_excerpt) if value)
    facts = _sentences(source, scope_label)
    keywords = _keywords(source, scope_label, facts)
    questions: list[Dict[str, Any]] = []
    unrelated = [
        "只需要记住界面颜色，不需要理解任何原理。",
        "所有结论在任何条件下都完全相同，不存在适用范围。",
        "该内容与本课程主题无关，也不会影响后续学习。",
        "只要背诵术语即可，不需要结合例子或条件判断。",
    ]
    questions.extend(_weak_point_questions(weak_points, scope_label, facts, unrelated))
    single_prompts = [
        f"关于「{scope_label}」，以下哪项是资料中的直接结论？",
        "复习本节时，以下哪项表述应当保留？",
        "以下哪项最符合当前小节的知识范围？",
        "结合课程资料，以下哪项说法更准确？",
        "以下哪项可以作为本节知识的正确概括？",
    ]
    multi_prompts = [
        "以下哪些表述与本节资料一致？（多选）",
        "哪些内容可以从当前小节资料中得到支持？（多选）",
        "复盘本节时，哪些结论值得保留？（多选）",
    ]

    for index in range(5):
        if len(questions) >= QUESTION_COUNT:
            break
        fact = facts[index % len(facts)]
        target_concept = keywords[index % len(keywords)]
        options, correct = _rotate(
            [fact, unrelated[index % 4], unrelated[(index + 1) % 4], unrelated[(index + 2) % 4]],
            [0],
            index,
        )
        questions.append(
            {
                "id": f"q{len(questions) + 1:02d}",
                "section": "一、概念辨析",
                "type": "single",
                "points": 4,
                "question": single_prompts[index],
                "options": options,
                "correct_index": correct[0],
                "target_concept": target_concept,
                "explanation": f"资料中的直接表述是：{fact}",
            }
        )
    for index in range(3):
        if len(questions) >= QUESTION_COUNT:
            break
        selected = [facts[(index * 2 + offset) % len(facts)] for offset in range(2)]
        target_concept = keywords[(index + 5) % len(keywords)]
        options, correct = _rotate(
            [selected[0], selected[1], unrelated[index], unrelated[index + 1]],
            [0, 1],
            index + 1,
        )
        questions.append(
            {
                "id": f"q{len(questions) + 1:02d}",
                "section": "二、重点识别",
                "type": "multi",
                "points": 6,
                "question": multi_prompts[index],
                "options": options,
                "correct_indices": correct,
                "target_concept": target_concept,
                "explanation": "正确选项都能在当前小节资料中找到依据；其余选项把结论绝对化或偏离了本节主题。",
            }
        )
    for index in range(3):
        if len(questions) >= QUESTION_COUNT:
            break
        is_true = index != 1
        fact = facts[(index + 8) % len(facts)]
        target_concept = keywords[index % len(keywords)]
        statement = fact if is_true else f"本节资料表明“{target_concept}”与当前主题完全无关。"
        questions.append(
            {
                "id": f"q{len(questions) + 1:02d}",
                "section": "三、判断理解",
                "type": "true_false",
                "points": 4,
                "question": statement,
                "correct_bool": is_true,
                "target_concept": target_concept,
                "explanation": f"对照资料可知：{fact}",
            }
        )
    for index in range(2):
        if len(questions) >= QUESTION_COUNT:
            break
        fact = facts[(index + 3) % len(facts)]
        keyword = next((word for word in keywords if word in fact), keywords[index % len(keywords)])
        blanked = fact.replace(keyword, "____", 1) if keyword in fact else "本节需要理解的关键词之一是 ____。"
        questions.append(
            {
                "id": f"q{len(questions) + 1:02d}",
                "section": "四、关键词填空",
                "type": "fill_blank",
                "points": 7,
                "question": blanked,
                "accepted_answers": [keyword],
                "target_concept": keyword,
                "explanation": f"空格处应填“{keyword}”。原句是：{fact}",
            }
        )
    for index in range(2):
        if len(questions) >= QUESTION_COUNT:
            break
        fact = facts[(index + 6) % len(facts)]
        answer_keywords = [word for word in keywords if word in fact][:4] or keywords[index * 2 : index * 2 + 3]
        target_concept = answer_keywords[0] if answer_keywords else keywords[index % len(keywords)]
        questions.append(
            {
                "id": f"q{len(questions) + 1:02d}",
                "section": "五、简答应用",
                "type": "short_answer",
                "points": 18,
                "question": f"请用自己的话说明这条知识与「{scope_label}」的关系，并给出一个简短理解：{fact}",
                "reference_answer": fact,
                "keywords": answer_keywords,
                "target_concept": target_concept,
                "explanation": f"参考回答应围绕以下资料展开：{fact}",
            }
        )
    return normalize_questions(questions)


def public_questions(questions: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    private_keys = {
        "correct_index",
        "correct_indices",
        "correct_bool",
        "accepted_answers",
        "reference_answer",
        "keywords",
        "explanation",
    }
    return [{key: value for key, value in question.items() if key not in private_keys} for question in questions]


def _answer_text(value: Any) -> str:
    return re.sub(r"[\s，。；：、,.!?！？()（）\-_/]+", "", str(value or "")).lower()


def answer_summary(question: Dict[str, Any], answer: Any, *, correct: bool = False) -> str:
    qtype = str(question.get("type") or "single")
    options = [str(value) for value in (question.get("options") or [])]
    if qtype == "single":
        raw_index = question.get("correct_index") if correct else answer
        try:
            index = int(raw_index)
        except Exception:
            return "未作答" if not correct else "—"
        return f"{chr(65 + index)}. {options[index]}" if 0 <= index < len(options) else "—"
    if qtype == "multi":
        raw_indices = question.get("correct_indices") if correct else answer
        if not isinstance(raw_indices, list) or not raw_indices:
            return "未作答" if not correct else "—"
        labels = []
        for raw_index in raw_indices:
            try:
                index = int(raw_index)
            except Exception:
                continue
            if 0 <= index < len(options):
                labels.append(f"{chr(65 + index)}. {options[index]}")
        return "；".join(labels) if labels else ("未作答" if not correct else "—")
    if qtype == "true_false":
        value = question.get("correct_bool") if correct else answer
        if value is None:
            return "未作答"
        if isinstance(value, str):
            value = value.strip().lower() in ("true", "1", "yes", "正确", "对")
        return "正确" if bool(value) else "错误"
    if qtype == "fill_blank":
        return (
            " / ".join(str(value) for value in (question.get("accepted_answers") or []))
            if correct
            else str(answer or "").strip() or "未作答"
        )
    return (
        str(question.get("reference_answer") or "").strip() or "—"
        if correct
        else str(answer or "").strip() or "未作答"
    )


def score_answer(question: Dict[str, Any], answer: Any) -> tuple[float, bool]:
    qtype = str(question.get("type") or "single")
    points = float(question.get("points") or 1)
    if qtype == "single":
        try:
            ok = int(answer) == int(question.get("correct_index"))
        except Exception:
            ok = False
        return (points if ok else 0.0, ok)
    if qtype == "multi":
        expected = {int(value) for value in (question.get("correct_indices") or [])}
        if not isinstance(answer, list):
            return 0.0, False
        try:
            selected = {int(value) for value in answer}
        except Exception:
            return 0.0, False
        ok = selected == expected
        return (points if ok else 0.0, ok)
    if qtype == "true_false":
        value = answer
        if isinstance(value, str):
            raw_value = value.strip().lower()
            if raw_value in ("true", "1", "yes", "正确", "对"):
                value = True
            elif raw_value in ("false", "0", "no", "错误", "错"):
                value = False
            else:
                return 0.0, False
        elif not isinstance(value, bool):
            return 0.0, False
        ok = answer is not None and bool(value) == bool(question.get("correct_bool"))
        return (points if ok else 0.0, ok)
    if qtype == "fill_blank":
        selected = _answer_text(answer)
        accepted = [_answer_text(value) for value in (question.get("accepted_answers") or [])]
        ok = bool(selected) and any(selected == value for value in accepted if value)
        return (points if ok else 0.0, ok)
    selected = _answer_text(answer)
    keywords = [_answer_text(value) for value in (question.get("keywords") or [])]
    keywords = [value for value in keywords if value]
    reference = _answer_text(question.get("reference_answer"))
    if not selected:
        return 0.0, False
    if keywords:
        ratio = sum(1 for keyword in keywords if keyword in selected) / len(keywords)
    else:
        ratio = 1.0 if reference and (reference in selected or selected in reference) else 0.0
    return round(points * min(1.0, ratio), 2), ratio >= 0.6
