"""课程目录规范化、课件目录扫描、章节小节参考资料解析。"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable


def natural_sort_key(value: str | None) -> tuple[Any, ...]:
    """按 id 中的数字分段做自然序（如 math-2 < math-10、sec-2 < sec-10）。"""
    s = (value or "").strip()
    if not s:
        return ("",)
    parts = re.split(r"(\d+)", s)
    key: list[Any] = []
    for p in parts:
        if p == "":
            continue
        if p.isdigit():
            key.append(int(p))
        else:
            key.append(p.lower())
    return tuple(key) if key else ("",)


def sections_natural_order(sections: list[dict[str, str]]) -> list[dict[str, str]]:
    return sorted(sections, key=lambda sec: natural_sort_key(str(sec.get("id") or "")))

# 与 backend 同级：项目根下的「深度学习课件」
COURSEWARE_DIR_NAME = "深度学习课件"


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def deep_learning_courseware_dir() -> Path:
    return project_root() / COURSEWARE_DIR_NAME


def load_text_courseware_files() -> dict[str, str]:
    """读取「深度学习课件」下所有 .md/.txt，按文件名 stem 索引（供与小节标题模糊匹配）。"""
    root = deep_learning_courseware_dir()
    out: dict[str, str] = {}
    if not root.is_dir():
        return out
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".md", ".txt"):
            continue
        try:
            body = p.read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            continue
        if not body:
            continue
        key = p.stem.strip()
        if key:
            out[key] = body
    return out


def _match_attachment(title: str, files: dict[str, str]) -> str:
    """按小节标题与课件文件名做简单匹配，命中则附加原文（截断）。"""
    if not files or not title:
        return ""
    for stem, body in files.items():
        if not stem:
            continue
        if stem in title or title in stem:
            return body[:12000]
    return ""


def default_section_body(course_name: str, chapter_title: str, section_title: str) -> str:
    """教材小节默认讲义（结构化纲要，便于模型严格围绕本节）。未单独提供文件时使用。"""
    return (
        f"【课程】{course_name}\n"
        f"【大章】{chapter_title}\n"
        f"【小节】{section_title}\n\n"
        f"本小节的学习范围仅限上述小节标题在教材中的对应内容。请围绕定义、核心结论、典型方法、常见误区与例题类型展开讲解；"
        f"不要引入本节教材未涉及的后序章节结论作为主要依据。若需要前置概念，仅作一句话回顾并指向应复习的小节。"
    )


def normalize_subsections(
    course_name: str,
    chapter: dict[str, Any],
    courseware_files: dict[str, str] | None = None,
    attach_files_for_course_ids: Iterable[str] | None = None,
) -> list[dict[str, str]]:
    """
    将 chapters[].subsections 规范为 [{id,title,content}, ...]。
    支持元素为 str 或已是 dict。
    """
    cid = str(chapter.get("id") or "")
    raw = chapter.get("subsections") or []
    attach = courseware_files or {}
    want_files = attach_files_for_course_ids is None or cid.split("-", 1)[0] in set(attach_files_for_course_ids)

    out: list[dict[str, str]] = []
    for i, item in enumerate(raw):
        if isinstance(item, dict):
            sid = str(item.get("id") or f"{cid}-s{i + 1}")
            title = str(item.get("title") or "").strip() or f"小节{i + 1}"
            content = str(item.get("content") or "").strip()
        else:
            title = str(item).strip() or f"小节{i + 1}"
            sid = f"{cid}-s{i + 1}"
            content = ""

        if not content:
            content = default_section_body(course_name, str(chapter.get("title") or ""), title)

        extra = ""
        if want_files:
            extra = _match_attachment(title, attach)
        if extra:
            content = f"{content}\n\n--- 课件摘录（来自项目「{COURSEWARE_DIR_NAME}」目录，按文件名匹配） ---\n{extra}"

        out.append({"id": sid, "title": title, "content": content})

    return out


def serialize_subsections_for_db(sections: list[dict[str, str]]) -> str:
    return json.dumps(sections, ensure_ascii=False)


def parse_subsections_json(raw: str | None) -> list[dict[str, str]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, str]] = []
    for i, item in enumerate(data):
        if isinstance(item, dict):
            out.append(
                {
                    "id": str(item.get("id") or f"sec-{i}"),
                    "title": str(item.get("title") or f"小节{i + 1}"),
                    "content": str(item.get("content") or ""),
                }
            )
        elif isinstance(item, str):
            out.append({"id": f"sec-{i + 1}", "title": item, "content": ""})
    return out


def find_section(chapter_row_subsections_json: str, section_id: str | None) -> dict[str, str] | None:
    if not section_id:
        return None
    for sec in parse_subsections_json(chapter_row_subsections_json):
        if sec.get("id") == section_id:
            return sec
    return None


def scope_display(chapter_title: str, section_title: str | None) -> str:
    if section_title:
        return f"{chapter_title} › {section_title}"
    return chapter_title


def parse_legacy_session_chapter(value: str) -> tuple[str | None, str | None, str]:
    """
    解析会话中保存的章节字段。
    新格式: chapterId|sectionId
    旧格式: 纯标题或「大章 › 小节」
    """
    v = (value or "").strip()
    if not v:
        return None, None, ""
    if "|" in v and not v.replace("|", "").isspace():
        parts = v.split("|", 1)
        ch_id = parts[0].strip() or None
        sec_id = parts[1].strip() or None if len(parts) > 1 else None
        return ch_id, sec_id, v
    if "›" in v or ">" in v:
        sep = "›" if "›" in v else ">"
        a, b = v.split(sep, 1)
        return None, None, v.strip()
    return None, None, v
