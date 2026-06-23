"""课程目录规范化、课程知识库扫描、章节小节参考资料解析。"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable


COURSEWARE_DIR_NAME = "courseware"
LEGACY_COURSEWARE_DIR_NAME = "深度学习课件"
SUPPORTED_TEXT_SUFFIXES = {".md", ".txt"}


def natural_sort_key(value: str | None) -> tuple[Any, ...]:
    """按 id 中的数字分段做自然序，如 math-2 < math-10。"""
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


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def backend_root() -> Path:
    return Path(__file__).resolve().parent


def courseware_root() -> Path:
    return backend_root() / COURSEWARE_DIR_NAME


def courseware_dirs() -> list[Path]:
    """优先读取会被 Docker 复制的 backend/courseware，兼容旧的项目根目录课件。"""
    roots = [courseware_root(), project_root() / LEGACY_COURSEWARE_DIR_NAME]
    deduped: list[Path] = []
    for root in roots:
        if root not in deduped:
            deduped.append(root)
    return deduped


def deep_learning_courseware_dir() -> Path:
    """兼容旧导入名；现在返回通用课程知识库目录。"""
    return courseware_root()


def _norm_key(value: str | None) -> str:
    return re.sub(r"[\s\-_/|:：,，.。()（）【】\[\]《》<>]+", "", (value or "").lower())


def load_text_courseware_files() -> dict[str, str]:
    """读取课程知识库下所有 .md/.txt，按相对路径和 stem 建索引。"""
    out: dict[str, str] = {}
    for root in courseware_dirs():
        if not root.is_dir():
            continue
        for p in root.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in SUPPORTED_TEXT_SUFFIXES:
                continue
            try:
                body = p.read_text(encoding="utf-8", errors="ignore").strip()
            except OSError:
                continue
            if not body:
                continue
            rel_key = str(p.relative_to(root).with_suffix("")).replace("\\", "/").strip()
            stem_key = p.stem.strip()
            for key in (rel_key, stem_key, _norm_key(rel_key), _norm_key(stem_key)):
                if key:
                    out.setdefault(key, body)
    return out


def _extract_heading_block(body: str, title: str, max_chars: int = 12000) -> str:
    """从课程 md 中提取与章节/小节标题对应的标题块。"""
    target = _norm_key(title)
    if not body or not target:
        return ""

    lines = body.splitlines()
    heading_re = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
    for i, line in enumerate(lines):
        m = heading_re.match(line)
        if not m:
            continue
        heading = re.sub(r"[#`*_]+", "", m.group(2)).strip()
        heading_key = _norm_key(heading)
        if target not in heading_key and heading_key not in target:
            continue
        level = len(m.group(1))
        end = len(lines)
        for j in range(i + 1, len(lines)):
            next_match = heading_re.match(lines[j])
            if next_match and len(next_match.group(1)) <= level:
                end = j
                break
        return "\n".join(lines[i:end]).strip()[:max_chars]
    return ""


def _course_file_body(course_id: str, course_name: str, files: dict[str, str]) -> str:
    candidates = [
        course_id,
        course_name,
        f"{course_id}/{course_id}",
        f"{course_id}/index",
        f"{course_name}/{course_name}",
        f"{course_name}/index",
    ]
    for key in candidates:
        body = files.get(key) or files.get(_norm_key(key))
        if body:
            return body
    return ""


def _match_attachment(
    course_id: str,
    course_name: str,
    chapter_title: str,
    section_id: str,
    section_title: str,
    files: dict[str, str],
) -> str:
    """按 section_id、标题块、课程文件三层兜底匹配课程知识库。"""
    if not files:
        return ""

    for key in (
        section_id,
        f"{course_id}/{section_id}",
        f"{course_name}/{section_id}",
        _norm_key(section_id),
        _norm_key(f"{course_id}/{section_id}"),
    ):
        body = files.get(key)
        if body:
            return body[:12000]

    course_body = _course_file_body(course_id, course_name, files)
    for title in (section_title, chapter_title):
        block = _extract_heading_block(course_body, title)
        if block:
            return block

    for body in files.values():
        block = _extract_heading_block(body, section_title) or _extract_heading_block(body, chapter_title)
        if block:
            return block

    return course_body[:12000]


def default_section_body(course_name: str, chapter_title: str, section_title: str) -> str:
    """未提供独立 md 时的严格小节边界说明。"""
    return (
        f"【课程】{course_name}\n"
        f"【大章】{chapter_title}\n"
        f"【小节】{section_title}\n\n"
        "本小节只围绕上面标题对应的知识范围展开。讲解应覆盖定义、核心结论、典型方法、常见误区与例题类型；"
        "不要把后续章节结论当作当前小节的主要依据。如需前置知识，只做简短回顾并指出应复习的小节。"
    )


def normalize_subsections(
    course_name: str,
    chapter: dict[str, Any],
    courseware_files: dict[str, str] | None = None,
    attach_files_for_course_ids: Iterable[str] | None = None,
) -> list[dict[str, str]]:
    """
    将 chapters[].subsections 规范为 [{id,title,content}, ...]。
    支持元素为 str 或 dict。课程知识库按 course_id/section_id.md 优先匹配。
    """
    cid = str(chapter.get("id") or "")
    course_id = cid.split("-", 1)[0] if cid else ""
    raw = chapter.get("subsections") or []
    attach = courseware_files or {}
    allowed = set(attach_files_for_course_ids or [])
    want_files = attach_files_for_course_ids is None or course_id in allowed
    chapter_title = str(chapter.get("title") or "")

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
            content = default_section_body(course_name, chapter_title, title)

        extra = ""
        if want_files:
            extra = _match_attachment(course_id, course_name, chapter_title, sid, title, attach)
        if extra:
            content = (
                f"{content}\n\n"
                f"--- 课程知识库摘录（来自 backend/{COURSEWARE_DIR_NAME}，按小节 id / 标题匹配）---\n"
                f"{extra}"
            )

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


def scope_display(chapter_title: str, section_title: str | None = None) -> str:
    return f"{chapter_title} / {section_title}" if section_title else chapter_title
