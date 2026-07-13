from __future__ import annotations

import logging
import os
import re
import json
import base64
import hashlib
import secrets
import smtplib
import socket
import ssl
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import parseaddr
from time import time
from typing import List, cast, Optional, Any, Dict
from pathlib import Path
from urllib.parse import urlencode
import urllib.error
import urllib.request

from dotenv import load_dotenv

from course_runtime import (
    deep_learning_courseware_dir,
    find_section,
    load_text_courseware_files,
    natural_sort_key,
    normalize_subsections,
    parse_subsections_json,
    scope_display,
    sections_natural_order,
    serialize_subsections_for_db,
)
from agents_workspace import (
    AGENT_MANIFEST,
    PORTRAIT_DIMENSION_KEYS,
    RESOURCE_TYPES,
    default_portrait,
)
from dl_book_data import DL_COURSE
from quiz_runtime import (
    answer_summary as quiz_answer_summary,
    build_instant_paper,
    has_internal_scaffolding as quiz_has_internal_scaffolding,
    normalize_questions as normalize_mixed_quiz_questions,
    public_questions as public_quiz_questions,
    score_answer as score_quiz_answer,
)
from safety import (
    ANTI_HALLUCINATION_SYSTEM_SUFFIX,
    assert_user_content_safe,
    sanitize_user_plaintext,
    safety_headers,
)
from fastapi import FastAPI, HTTPException, Depends, Query, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam
from passlib.context import CryptContext
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import create_engine, ForeignKey, DateTime, String, inspect, text, Text, UniqueConstraint, Float, Integer, Boolean, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import (
    sessionmaker,
    Session,
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
)

# 始终从 backend 目录加载 .env（避免从仓库根目录启动时读不到配置）
load_dotenv(Path(__file__).resolve().parent / ".env")


def static_site_dir() -> Optional[Path]:
    """生产环境指向 Vite 构建产物目录（内含 index.html 与 assets/）。"""
    raw = os.getenv("STATIC_ROOT", "").strip()
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw).resolve())
    elif os.getenv("RENDER", "").strip().lower() in ("true", "1", "yes"):
        # Dockerfile 将构建产物放在 /app/static；遗漏 STATIC_ROOT 时仍可加载前端
        candidates.append(Path("/app/static").resolve())
    for p in candidates:
        if p.is_dir() and (p / "index.html").is_file():
            return p
    return None


def strip_api_prefix_enabled() -> bool:
    """浏览器请求 /api/... 时剥离前缀，与同域部署的前端默认 API_BASE=/api 对齐。"""
    v = os.getenv("STRIP_API_PREFIX", "").strip().lower()
    if v in ("0", "false", "no"):
        return False
    if v in ("1", "true", "yes"):
        return True
    return static_site_dir() is not None


class StripApiPrefixMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if strip_api_prefix_enabled():
            path = request.scope.get("path") or ""
            if path.startswith("/api"):
                tail = path[4:]
                rest = tail.lstrip("/")
                new_path = f"/{rest}" if rest else "/"
                request.scope["path"] = new_path
                request.scope["raw_path"] = new_path.encode("utf-8")
        return await call_next(request)


def stream_response_headers(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """流式 text/plain 响应：降低反向代理整包缓冲，便于浏览器逐块读取与前端打字效果。"""
    h = dict(extra or {})
    h["Cache-Control"] = "no-cache, no-transform"
    h["X-Accel-Buffering"] = "no"
    return h


# ----------------------------
# 数据库配置
# ----------------------------
def _normalize_database_url(url: str) -> str:
    """统一 Postgres 连接串：兼容 Render 的 postgres://，并默认使用 psycopg v3 驱动。"""
    u = url.strip()
    if u.startswith("postgres://"):
        u = "postgresql://" + u[len("postgres://") :]
    if u.startswith("postgresql://"):
        return "postgresql+psycopg://" + u[len("postgresql://") :]
    return u


# 默认 SQLite 写在 backend 工作目录。
# 线上托管 Postgres：DATABASE_URL=postgresql://...（Neon/Supabase/Render Postgres 控制台复制）
# SQLite 持久盘：DATABASE_URL=sqlite:////var/data/users.db
_raw_db_url = os.getenv("DATABASE_URL", "").strip()
SQLALCHEMY_DATABASE_URL = (
    _normalize_database_url(_raw_db_url) if _raw_db_url else "sqlite:///./users.db"
)
_engine_kwargs: Dict[str, Any] = {}
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    _engine_kwargs["pool_pre_ping"] = True
engine = create_engine(SQLALCHEMY_DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class Base(DeclarativeBase):
    pass

# --- 数据库模型 ---
class CourseDB(Base):
    __tablename__ = "courses"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text)
    learning_goals: Mapped[str] = mapped_column(Text)
    chapters = relationship("ChapterDB", back_populates="course", cascade="all, delete-orphan")

class ChapterDB(Base):
    __tablename__ = "chapters"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    title: Mapped[str] = mapped_column(String(128))
    desc: Mapped[str] = mapped_column(Text)
    subsections: Mapped[str] = mapped_column(Text)
    keywords: Mapped[str] = mapped_column(Text)
    course = relationship("CourseDB", back_populates="chapters")

class UserDB(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password: Mapped[str] = mapped_column(String(255))
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    sessions = relationship("ChatSessionDB", back_populates="user", cascade="all, delete-orphan")

class ChatSessionDB(Base):
    __tablename__ = "chat_sessions"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    subject: Mapped[str] = mapped_column(String(64), index=True)
    chapter: Mapped[str] = mapped_column(String(512), index=True, default="", server_default="")
    title: Mapped[str] = mapped_column(String(128), default="新会话", index=True)
    session_kind: Mapped[str] = mapped_column(String(16), default="chat", server_default="chat")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    user = relationship("UserDB", back_populates="sessions")
    messages = relationship("ChatHistoryDB", back_populates="session", cascade="all, delete-orphan")


class SectionLearningProgressDB(Base):
    """小节维度：AI 带学轮次、掌握度、小节测验与大章衔接。"""

    __tablename__ = "section_learning_progress"
    __table_args__ = (UniqueConstraint("user_id", "subject", "chapter_id", "section_id", name="uq_user_subject_section"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    subject: Mapped[str] = mapped_column(String(64), index=True)
    chapter_id: Mapped[str] = mapped_column(String(64), index=True)
    section_id: Mapped[str] = mapped_column(String(64), index=True)
    mastery: Mapped[float] = mapped_column(Float, default=0.0)
    learn_turns: Mapped[int] = mapped_column(Integer, default=0)
    phase: Mapped[str] = mapped_column(String(24), default="idle")  # idle questioning quiz_pending done
    pending_quiz_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    weak_points_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    section_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    small_quiz_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    small_quiz_passed: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ChapterLearningProgressDB(Base):
    """大章维度：全小节测验通过后的大章总结测验。"""

    __tablename__ = "chapter_learning_progress"
    __table_args__ = (UniqueConstraint("user_id", "subject", "chapter_id", name="uq_user_subject_chapter"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    subject: Mapped[str] = mapped_column(String(64), index=True)
    chapter_id: Mapped[str] = mapped_column(String(64), index=True)
    pending_quiz_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    chapter_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    chapter_quiz_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    chapter_quiz_passed: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class ChatHistoryDB(Base):
    __tablename__ = "chat_history"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("chat_sessions.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    session = relationship("ChatSessionDB", back_populates="messages")


class UserLearningStudioDB(Base):
    """赛题 A3：学习画像、路径规划、资源生成归档（JSON）。"""

    __tablename__ = "user_learning_studio"
    __table_args__ = (UniqueConstraint("user_id", "subject", name="uq_uls_user_subject"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    subject: Mapped[str] = mapped_column(String(64), index=True)
    portrait_json: Mapped[str] = mapped_column(Text, default="{}")
    learning_path_json: Mapped[str] = mapped_column(Text, default="[]")
    resource_events_json: Mapped[str] = mapped_column(Text, default="[]")
    resource_artifacts_json: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PasswordResetTokenDB(Base):
    """一次性密码重置令牌（仅存 SHA256；明文仅通过邮件或本机控制台交付）。"""
    __tablename__ = "password_reset_tokens"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


# --- 初始化与工具 ---
def ensure_schema():
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "section_learning_progress" in table_names:
        progress_cols = {c["name"] for c in inspector.get_columns("section_learning_progress")}
        if "weak_points_json" not in progress_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE section_learning_progress ADD COLUMN weak_points_json TEXT"))
    if "user_learning_studio" in table_names:
        studio_cols = {c["name"] for c in inspector.get_columns("user_learning_studio")}
        if "resource_events_json" not in studio_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE user_learning_studio ADD COLUMN resource_events_json TEXT DEFAULT '[]'"))
        if "resource_artifacts_json" not in studio_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE user_learning_studio ADD COLUMN resource_artifacts_json TEXT DEFAULT '[]'"))
    # 以下 ALTER 仅针对旧版 SQLite 库；Postgres 由 create_all 一次性建全表
    if engine.dialect.name != "sqlite":
        return
    inspector = inspect(engine)
    if "chat_sessions" in inspector.get_table_names():
        existing_cols = {c["name"] for c in inspector.get_columns("chat_sessions")}
        with engine.begin() as conn:
            for col in ["chapter", "subject", "title"]:
                if col not in existing_cols:
                    conn.execute(text(f"ALTER TABLE chat_sessions ADD COLUMN {col} VARCHAR(128) DEFAULT ''"))
            if "session_kind" not in existing_cols:
                try:
                    conn.execute(text("ALTER TABLE chat_sessions ADD COLUMN session_kind VARCHAR(16) DEFAULT 'chat'"))
                except Exception:
                    pass
    if "users" in inspector.get_table_names():
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        if "email" not in user_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR(255)"))

ensure_schema()


# --- 认证接口限流（防刷接口 / 枚举 / 暴力尝试）---
_AUTH_ATTEMPTS: defaultdict[str, list[float]] = defaultdict(list)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    if request.client:
        return request.client.host or "unknown"
    return "unknown"


def _enforce_auth_rate_limit(
    request: Request,
    action: str,
    *,
    max_attempts: int,
    window_sec: int,
) -> None:
    ip = _client_ip(request)
    now = time()
    key = f"{action}:{ip}"
    arr = _AUTH_ATTEMPTS[key]
    arr[:] = [t for t in arr if now - t < window_sec]
    if len(arr) >= max_attempts:
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    arr.append(now)


def _enforce_register_rate_limit(request: Request) -> None:
    _enforce_auth_rate_limit(request, "register", max_attempts=6, window_sec=60 * 60)


def _enforce_login_rate_limit(request: Request) -> None:
    _enforce_auth_rate_limit(request, "login", max_attempts=20, window_sec=15 * 60)


def _enforce_forgot_rate_limit(request: Request) -> None:
    _enforce_auth_rate_limit(request, "forgot", max_attempts=8, window_sec=15 * 60)


def _enforce_reset_rate_limit(request: Request) -> None:
    _enforce_auth_rate_limit(request, "reset", max_attempts=12, window_sec=15 * 60)


def _public_app_url() -> str:
    explicit = os.getenv("PUBLIC_APP_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    railway_domain = os.getenv("RAILWAY_PUBLIC_DOMAIN", "").strip()
    if railway_domain:
        if railway_domain.startswith(("http://", "https://")):
            return railway_domain.rstrip("/")
        return f"https://{railway_domain.rstrip('/')}"
    return "http://127.0.0.1:5173"


def _magic_reset_url(username: str, token: str) -> str:
    q = urlencode({"reset": "1", "username": username, "token": token})
    return f"{_public_app_url()}/?{q}"


def _password_reset_token_content(token: str) -> tuple[str, str]:
    plain = (
        "您好，\n\n"
        "您正在重置 Mentor 账户密码。请在网站的重置密码页面输入下面的令牌"
        "（20 分钟内有效，仅可使用一次）：\n\n"
        f"{token}\n\n"
        "请勿转发本邮件或把令牌提供给他人。\n\n"
        "若不是你本人操作，请忽略本邮件。\n"
    )
    html = (
        "<p>您好，</p>"
        "<p>您正在重置 Mentor 账户密码。请在网站的重置密码页面输入下面的令牌"
        "（20 分钟内有效，仅可使用一次）：</p>"
        f'<p style="font-family:monospace;font-size:18px;letter-spacing:0.04em;">{token}</p>'
        "<p>请勿转发本邮件或把令牌提供给他人。</p>"
        "<p>若不是你本人操作，请忽略本邮件。</p>"
    )
    return plain, html


def _smtp_configured() -> bool:
    return bool(os.getenv("PASSWORD_RESET_SMTP_HOST", "").strip())


def _strip_env_secret(val: str) -> str:
    """去掉复制粘贴夹带的 BOM、首尾空白与成对引号。"""
    s = (val or "").strip().strip("\ufeff")
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1].strip()
    return s


def _gmail_env(name: str) -> str:
    return _strip_env_secret(os.getenv(f"PASSWORD_RESET_GMAIL_{name}", "")) or _strip_env_secret(
        os.getenv(f"GMAIL_{name}", "")
    )


def _gmail_configured() -> bool:
    return bool(_gmail_env("CLIENT_ID") and _gmail_env("CLIENT_SECRET") and _gmail_env("REFRESH_TOKEN"))


def _gmail_from_header() -> str:
    return _gmail_env("FROM")


def _gmail_error_hint(detail: str) -> str:
    """Return an actionable, secret-free hint for common Google OAuth/Gmail errors."""
    lowered = (detail or "").lower()
    if "invalid_grant" in lowered:
        return (
            "刷新令牌已过期、被撤销或与当前 OAuth 客户端不匹配。若 OAuth 同意屏幕仍为 Testing，"
            "Gmail 权限的 refresh token 通常 7 天后失效；请先切换为 In production，再重新运行 "
            "gmail_oauth_setup.py，并替换 Railway 的 PASSWORD_RESET_GMAIL_REFRESH_TOKEN。"
        )
    if "invalid_client" in lowered or "unauthorized_client" in lowered:
        return (
            "OAuth 客户端校验失败。请确认 Railway 中的 CLIENT_ID 与 CLIENT_SECRET 来自同一个"
            "桌面应用客户端；若密钥曾公开，请先在 Google Cloud 轮换密钥。"
        )
    if "insufficient" in lowered or "permission" in lowered or "forbidden" in lowered:
        return (
            "当前授权缺少 Gmail 发送权限。请确认已启用 Gmail API，并重新授权 "
            "https://www.googleapis.com/auth/gmail.send。"
        )
    if "from" in lowered and ("invalid" in lowered or "not owned" in lowered or "alias" in lowered):
        return (
            "发件人不是当前 Gmail 账号或已验证别名。请将 PASSWORD_RESET_GMAIL_FROM 设置为"
            "生成 refresh token 时登录的 Gmail 地址。"
        )
    return "请核对 Gmail API、OAuth 客户端、刷新令牌和发件地址配置。"


def _gmail_access_token() -> str:
    data = urlencode(
        {
            "client_id": _gmail_env("CLIENT_ID"),
            "client_secret": _gmail_env("CLIENT_SECRET"),
            "refresh_token": _gmail_env("REFRESH_TOKEN"),
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    token = str(payload.get("access_token") or "")
    if not token:
        raise RuntimeError("Google OAuth token response did not include access_token")
    return token


def _send_password_reset_gmail(to_addr: str, username: str, token: str) -> bool:
    """Send password-reset email through the Gmail API over HTTPS."""
    if not _gmail_configured():
        return False
    from_addr = _gmail_from_header()
    if not from_addr:
        print("[PASSWORD_RESET] Gmail API: PASSWORD_RESET_GMAIL_FROM or GMAIL_FROM is missing.")
        return False

    plain, html = _password_reset_token_content(token)

    msg = EmailMessage()
    msg["Subject"] = "【Mentor】密码重置令牌"
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Reply-To"] = from_addr
    msg.set_content(plain)
    msg.add_alternative(html, subtype="html")

    try:
        access_token = _gmail_access_token()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        print(
            f"[PASSWORD_RESET] Gmail OAuth token refresh HTTP {exc.code}: {detail}\n"
            f"  [PASSWORD_RESET] Gmail OAuth 排障：{_gmail_error_hint(detail)}"
        )
        return False
    except Exception as exc:
        print(f"[PASSWORD_RESET] Gmail OAuth token refresh failed: {exc}")
        return False

    try:
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        req = urllib.request.Request(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            data=json.dumps({"raw": raw}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
        print(
            f"[PASSWORD_RESET] Gmail API accepted reset email: id={payload.get('id')!r}, "
            f"recipient={to_addr!r}, sender={from_addr!r}."
        )
        return True
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        print(
            f"[PASSWORD_RESET] Gmail API HTTP {exc.code}: {detail}\n"
            f"  [PASSWORD_RESET] Gmail API 排障：{_gmail_error_hint(detail)}"
        )
        return False
    except Exception as exc:
        print(f"[PASSWORD_RESET] Gmail API request failed: {exc}")
        return False


def _sendgrid_api_key() -> str:
    return _strip_env_secret(os.getenv("PASSWORD_RESET_SENDGRID_API_KEY", "")) or _strip_env_secret(
        os.getenv("SENDGRID_API_KEY", "")
    )


def _sendgrid_from_header() -> str:
    return _strip_env_secret(os.getenv("PASSWORD_RESET_SENDGRID_FROM", "")) or _strip_env_secret(
        os.getenv("SENDGRID_FROM", "")
    )


def _sendgrid_configured() -> bool:
    return bool(_sendgrid_api_key())


def _sendgrid_data_residency() -> str:
    return (
        _strip_env_secret(os.getenv("PASSWORD_RESET_SENDGRID_DATA_RESIDENCY", ""))
        or _strip_env_secret(os.getenv("SENDGRID_DATA_RESIDENCY", ""))
    ).lower()


def _send_password_reset_sendgrid(to_addr: str, username: str, token: str) -> bool:
    """Send password-reset email via Twilio SendGrid HTTPS API."""
    api_key = _sendgrid_api_key()
    from_addr = _sendgrid_from_header()
    if not api_key:
        return False
    if not from_addr:
        print(
            "[PASSWORD_RESET] SendGrid: API key is configured, "
            "but PASSWORD_RESET_SENDGRID_FROM or SENDGRID_FROM is missing."
        )
        return False

    from_name, from_email = parseaddr(from_addr)
    if not from_email:
        print(f"[PASSWORD_RESET] SendGrid: invalid sender address {from_addr!r}.")
        return False

    plain, html = _password_reset_token_content(token)

    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Email, Mail
    except ImportError:
        print("[PASSWORD_RESET] SendGrid package is not installed. Add sendgrid to requirements.txt.")
        return False

    try:
        from_email_obj = Email(from_email, from_name or None)
        message = Mail(
            from_email=from_email_obj,
            to_emails=to_addr,
            subject="【Mentor】密码重置令牌",
            plain_text_content=plain,
            html_content=html,
        )
        sg = SendGridAPIClient(api_key)
        if _sendgrid_data_residency() == "eu":
            set_region = getattr(sg, "set_sendgrid_data_residency", None)
            if callable(set_region):
                set_region("eu")
        response = sg.send(message)
        status = int(getattr(response, "status_code", 0) or 0)
        if 200 <= status < 300:
            print(
                f"[PASSWORD_RESET] SendGrid accepted reset email: status={status}, "
                f"recipient={to_addr!r}, sender={from_addr!r}."
            )
            return True
        body = getattr(response, "body", b"")
        if isinstance(body, bytes):
            body = body.decode("utf-8", errors="replace")
        print(f"[PASSWORD_RESET] SendGrid HTTP {status}: {str(body)[:800]}")
        return False
    except Exception as exc:
        detail = getattr(exc, "body", None) or getattr(exc, "message", None) or str(exc)
        print(f"[PASSWORD_RESET] SendGrid request failed: {detail}")
        return False


def _resend_api_key() -> str:
    """兼容 Render 上误用 Resend 文档里的变量名 RESEND_API_KEY。"""
    pr = _strip_env_secret(os.getenv("PASSWORD_RESET_RESEND_API_KEY", ""))
    rr = _strip_env_secret(os.getenv("RESEND_API_KEY", ""))
    return pr or rr


def _resend_env_diag_line() -> str:
    """401 排障用：不打印密钥，只描述长度、前缀与变量冲突。"""
    pr = _strip_env_secret(os.getenv("PASSWORD_RESET_RESEND_API_KEY", ""))
    rr = _strip_env_secret(os.getenv("RESEND_API_KEY", ""))
    bits = []
    if pr:
        bits.append(
            f"PASSWORD_RESET_RESEND_API_KEY 已设置(len={len(pr)},re_前缀={'是' if pr.startswith('re_') else '否'})"
        )
    else:
        bits.append("PASSWORD_RESET_RESEND_API_KEY 未设置")
    if rr:
        bits.append(f"RESEND_API_KEY 已设置(len={len(rr)},re_前缀={'是' if rr.startswith('re_') else '否'})")
    else:
        bits.append("RESEND_API_KEY 未设置")
    if pr and rr and pr != rr:
        bits.append("警告：两变量均非空且不一致，代码优先使用 PASSWORD_RESET_RESEND_API_KEY（请删错的那份或改成一致）")
    use = "PASSWORD_RESET_RESEND_API_KEY" if pr else ("RESEND_API_KEY" if rr else "（无）")
    bits.append(f"实际选用：{use}")
    return " ".join(bits)


def _resend_from_header() -> str:
    raw = _strip_env_secret(os.getenv("PASSWORD_RESET_RESEND_FROM", "")) or _strip_env_secret(
        os.getenv("RESEND_FROM", "")
    )
    return raw


def _resend_configured() -> bool:
    return bool(_resend_api_key())


def _send_password_reset_resend(to_addr: str, username: str, token: str) -> bool:
    """经 Resend HTTPS API 发信（适合 Render 等屏蔽出站 SMTP 的环境）。"""
    api_key = _resend_api_key()
    from_addr = _resend_from_header()
    if not api_key:
        return False
    if not from_addr:
        print(
            "[PASSWORD_RESET] Resend：已配置 API Key，"
            "但未设置 PASSWORD_RESET_RESEND_FROM 或 RESEND_FROM（须在 Resend 控制台验证过的发件地址）。"
        )
        return False
    plain, html = _password_reset_token_content(token)
    send_params = {
        "from": from_addr,
        "to": [to_addr],
        "subject": "【Mentor】密码重置令牌",
        "text": plain,
        "html": html,
    }

    use_sdk = os.getenv("PASSWORD_RESET_RESEND_USE_SDK", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    if use_sdk:
        try:
            import resend
            from resend.exceptions import ResendError
        except ImportError:
            pass
        else:
            try:
                resend.api_key = api_key
                out = resend.Emails.send(send_params)
                eid = getattr(out, "id", None)
                print(
                    f"[PASSWORD_RESET] Resend SDK 已受理投递：id={eid!r}，收件人={to_addr!r}，发件人={from_addr!r}。"
                    "若收件箱未见到，请到 Resend 控制台查看投递记录与退信原因。"
                )
                return True
            except ResendError as exc:
                code_s = str(exc.code)
                print(
                    f"[PASSWORD_RESET] Resend SDK HTTP {exc.code}: {exc.message} ({exc.error_type})\n"
                    "  请到 https://resend.com/docs 核对 API Key、发件域名验证与收件人限制。"
                )
                if code_s == "401":
                    print(f"  [PASSWORD_RESET] Resend 401 排障：{_resend_env_diag_line()}")
                return False
            except Exception as exc:
                print(f"[PASSWORD_RESET] Resend SDK 异常，回退 urllib：{exc}")

    payload = json.dumps(send_params, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Resend 经 Cloudflare：无 User-Agent 会返回 403 error code 1010
            "User-Agent": "Mentor-Academic-Suite/1.0 (+https://resend.com/docs)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=22) as resp:
            _ = resp.read()
            if 200 <= int(resp.status) < 300:
                print(
                    f"[PASSWORD_RESET] Resend 已受理投递：收件人={to_addr!r}，发件人={from_addr!r}。"
                    "若收件箱未见到，请到 Resend 控制台查看投递记录与退信原因。"
                )
                return True
            print(f"[PASSWORD_RESET] Resend 意外状态码: {resp.status}")
            return False
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        print(
            f"[PASSWORD_RESET] Resend HTTP {exc.code}: {detail}\n"
            "  请到 https://resend.com/docs 核对 API Key、发件域名验证与收件人限制。"
        )
        if exc.code == 401:
            print(f"  [PASSWORD_RESET] Resend 401 排障：{_resend_env_diag_line()}")
        return False
    except Exception as exc:
        print(f"[PASSWORD_RESET] Resend 请求失败: {exc}")
        return False


def _smtp_prefer_ipv4() -> bool:
    return os.getenv("PASSWORD_RESET_SMTP_PREFER_IPV4", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )


def _smtp_tcp_socket(host: str, port: int, timeout: float) -> socket.socket:
    """
    默认优先 IPv4 再 IPv6。容器常见仅有 IPv4 出口时，纯 IPv6 目标会报 [Errno 101] Network is unreachable。
    关闭：PASSWORD_RESET_SMTP_PREFER_IPV4=0（使用系统默认解析顺序）。
    """
    if not _smtp_prefer_ipv4():
        return socket.create_connection((host, port), timeout)

    last_err: OSError | None = None
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            for res in socket.getaddrinfo(host, port, family, socket.SOCK_STREAM):
                af, socktype, proto, _, sa = res
                s = socket.socket(af, socktype, proto)
                s.settimeout(timeout)
                try:
                    s.connect(sa)
                    return s
                except OSError as e:
                    last_err = e
                    s.close()
        except socket.gaierror:
            continue
    if last_err:
        raise last_err
    raise OSError(f"无法解析或连接 SMTP 主机 {host!r}:{port}")


class _SMTPPreferIPv4(smtplib.SMTP):
    """与 smtplib.SMTP 相同，但建连时优先 IPv4。"""

    def _get_socket(self, host, port, timeout):
        return _smtp_tcp_socket(host, port, timeout)


class _SMTPSSLPreferIPv4(smtplib.SMTP_SSL):
    def _get_socket(self, host, port, timeout):
        plain = _smtp_tcp_socket(host, port, timeout)
        return self.context.wrap_socket(plain, server_hostname=host)


def _send_password_reset_email(to_addr: str, username: str, token: str) -> bool:
    """使用环境变量中的 SMTP 发送重置令牌；失败返回 False（由调用方改打控制台）。"""
    host = os.getenv("PASSWORD_RESET_SMTP_HOST", "").strip()
    if not host:
        return False
    port = int(os.getenv("PASSWORD_RESET_SMTP_PORT", "587"))
    user = os.getenv("PASSWORD_RESET_SMTP_USER", "").strip()
    password = os.getenv("PASSWORD_RESET_SMTP_PASSWORD", "")
    sender = (os.getenv("PASSWORD_RESET_SMTP_FROM") or user or "").strip()
    if not sender:
        print("[PASSWORD_RESET] 未设置 PASSWORD_RESET_SMTP_FROM 且 SMTP_USER 非邮箱，无法发信；请设置发件人地址（建议与 SMTP 登录账号一致）。")
        return False
    use_tls = os.getenv("PASSWORD_RESET_SMTP_USE_TLS", "1").strip().lower() not in ("0", "false", "no")
    plain, html = _password_reset_token_content(token)
    msg = EmailMessage()
    msg["Subject"] = "【Mentor】密码重置令牌"
    msg["From"] = sender
    msg["To"] = to_addr
    msg["Reply-To"] = sender
    msg.set_content(plain)
    msg.add_alternative(html, subtype="html")

    ctx = ssl.create_default_context()
    try:
        # 较短超时：避免托管平台网关先于 SMTP 断开导致 502；真实发信在 BackgroundTasks 中执行
        smtp_timeout = min(18, int(os.getenv("PASSWORD_RESET_SMTP_TIMEOUT_SEC", "14")))
        if port == 465:
            with _SMTPSSLPreferIPv4(host, port, timeout=smtp_timeout, context=ctx) as smtp:
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with _SMTPPreferIPv4(host, port, timeout=smtp_timeout) as smtp:
                smtp.ehlo()
                if use_tls and port not in (25,):
                    try:
                        smtp.starttls(context=ctx)
                        smtp.ehlo()
                    except smtplib.SMTPNotSupportedError:
                        pass
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
        print(
            f"[PASSWORD_RESET] 已向收件箱投递重置邮件：收件人={to_addr}，发件人={sender}，"
            f"smtp://{host}:{port}。若网页收件箱没有，请搜主题「Mentor」或查垃圾箱。"
        )
        return True
    except smtplib.SMTPAuthenticationError as exc:
        print(
            f"[PASSWORD_RESET] SMTP 登录被拒: {exc}\n"
            "  QQ 邮箱若出现 535：到邮箱网页版 → 设置 → 账户 → 开启「POP3/SMTP服务」→ 按提示生成「授权码」，"
            "将授权码填入 .env 的 PASSWORD_RESET_SMTP_PASSWORD（不是 QQ 登录密码）。"
            "若刚改过授权码或多次失败，请稍后再试或重新生成授权码。"
            "说明: https://help.mail.qq.com/detail/108/1023"
        )
        return False
    except Exception as exc:
        errno = getattr(exc, "errno", None)
        extra = ""
        if errno == 101 or (isinstance(exc, OSError) and exc.errno == 101):
            extra = (
                "\n  [Errno 101] 多为网络不可达：① 托管平台禁止出站 SMTP（Render 等或对 25/465/587 有限制），"
                "可改用 HTTPS 邮件 API（Resend / SendGrid 等）；② 容器仅有 IPv4，已默认优先 IPv4 建连，"
                "仍失败请查看 Render 出站策略或联系平台支持。"
            )
        print(
            f"[PASSWORD_RESET] SMTP 发送失败: {exc}\n"
            "  常见原因：端口与加密方式不匹配（587+STARTTLS / 465+SSL）、须使用「授权码」而非登录密码、"
            "发件人 PASSWORD_RESET_SMTP_FROM 与 SMTP 登录邮箱不一致被拒。"
            f"{extra}"
        )
        return False


def _deliver_password_reset_notification(username: str, token: str, user_email: str) -> None:
    """
    在 HTTP 响应返回后执行：优先 Gmail API（HTTPS），然后 SendGrid/Resend（HTTPS），否则 SMTP，否则控制台打印令牌。
    """
    mailed = False
    addr = (user_email or "").strip()
    mail_skip_reason = ""
    if not addr:
        mail_skip_reason = (
            "该账号在数据库中未绑定邮箱（users.email 为空）。"
            "旧账号需补邮箱后才能收信：在 backend 目录执行 "
            "`python set_user_email.py 你的用户名 你的邮箱`，或重新注册并填写邮箱。"
        )
    elif _gmail_configured():
        mailed = _send_password_reset_gmail(addr, username, token)
        if not mailed:
            if _sendgrid_configured():
                print("[PASSWORD_RESET] Gmail API failed; falling back to SendGrid.")
                mailed = _send_password_reset_sendgrid(addr, username, token)
            if not mailed and _resend_configured():
                print("[PASSWORD_RESET] Gmail API failed; falling back to Resend.")
                mailed = _send_password_reset_resend(addr, username, token)
            if not mailed and _smtp_configured():
                print("[PASSWORD_RESET] Gmail API failed; falling back to SMTP.")
                mailed = _send_password_reset_email(addr, username, token)
            if not mailed:
                mail_skip_reason = (
                    "Gmail API 发送未成功。请查看 [PASSWORD_RESET] Gmail API 开头的日志；"
                    "确认 PASSWORD_RESET_GMAIL_CLIENT_ID、PASSWORD_RESET_GMAIL_CLIENT_SECRET、"
                    "PASSWORD_RESET_GMAIL_REFRESH_TOKEN 与 PASSWORD_RESET_GMAIL_FROM 已正确配置。"
                    "若日志包含 invalid_grant，请先把 Google OAuth 同意屏幕切换为 In production，"
                    "再重新生成 refresh token 并更新 Railway。"
                    "如果已配置 SendGrid、Resend 或 SMTP，也请查看对应 [PASSWORD_RESET] 报错。"
                )
    elif _sendgrid_configured():
        mailed = _send_password_reset_sendgrid(addr, username, token)
        if not mailed:
            if _resend_configured():
                print("[PASSWORD_RESET] SendGrid failed; falling back to Resend.")
                mailed = _send_password_reset_resend(addr, username, token)
            if not mailed and _smtp_configured():
                print("[PASSWORD_RESET] SendGrid failed; falling back to SMTP.")
                mailed = _send_password_reset_email(addr, username, token)
            if not mailed:
                mail_skip_reason = (
                    "SendGrid API 发送未成功。请查看 [PASSWORD_RESET] SendGrid 开头的日志；"
                    "确认 PASSWORD_RESET_SENDGRID_API_KEY 有 Mail Send 权限，"
                    "且 PASSWORD_RESET_SENDGRID_FROM 已完成 Single Sender Verification。"
                    "如果已配置 Resend 或 SMTP，也请查看对应 [PASSWORD_RESET] 报错。"
                )
    elif _resend_configured():
        mailed = _send_password_reset_resend(addr, username, token)
        if not mailed:
            if _smtp_configured():
                print("[PASSWORD_RESET] Resend failed; falling back to SMTP.")
                mailed = _send_password_reset_email(addr, username, token)
            if not mailed:
                mail_skip_reason = (
                    "Resend API 发送未成功。请向上滚动日志查看 [PASSWORD_RESET] Resend 开头的报错；"
                    "并确认 PASSWORD_RESET_RESEND_FROM 已在 Resend 验证、收件邮箱未被沙箱策略拦截。"
                    "如果已配置 SMTP，也请查看 [PASSWORD_RESET] SMTP 报错。"
                )
    elif not _smtp_configured():
        mail_skip_reason = (
            "后端未配置邮件投递：请优先设置 PASSWORD_RESET_GMAIL_CLIENT_ID、"
            "PASSWORD_RESET_GMAIL_CLIENT_SECRET、PASSWORD_RESET_GMAIL_REFRESH_TOKEN 与 PASSWORD_RESET_GMAIL_FROM；"
            "也可设置 PASSWORD_RESET_SENDGRID_API_KEY / SENDGRID_API_KEY 与对应 FROM；"
            "也可设置 PASSWORD_RESET_RESEND_API_KEY / RESEND_API_KEY 与对应 FROM；"
            "或配置 PASSWORD_RESET_SMTP_*（部分云平台禁止出站 SMTP）。"
        )
    else:
        mailed = _send_password_reset_email(addr, username, token)
        if not mailed:
            mail_skip_reason = (
                "已尝试 SMTP 但发送未成功。Railway/Render 等环境常限制 SMTP 出站，请改用 SendGrid HTTPS API："
                "设置 PASSWORD_RESET_SENDGRID_API_KEY（或 SENDGRID_API_KEY）与 PASSWORD_RESET_SENDGRID_FROM（或 SENDGRID_FROM）。"
                "亦可向上滚动终端查找 [PASSWORD_RESET] SMTP 报错详情。"
            )

    if not mailed:
        _log_reset_to_console(username, token, mail_skip_reason)
    else:
        print(
            f"[PASSWORD_RESET] 找回密码流程：已向用户登记邮箱发送重置信 username={username!r} "
            f"recipient={addr!r}（请在该邮箱查收，不是别的 QQ 号）"
        )


def _log_reset_to_console(username: str, token: str, mail_skip_reason: str = "") -> None:
    """令牌不出现在 HTTP 响应中；仅在未发邮件时打印，便于本机自助重置。"""
    why = (
        f"\n【未发邮件原因】\n{mail_skip_reason.strip()}\n"
        if mail_skip_reason.strip()
        else ""
    )
    print(
        "\n========== PASSWORD RESET（请勿截图外传）==========\n"
        f"{why}"
        f"用户名: {username}\n"
        f"令牌: {token}\n"
        "====================================================\n"
    )

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ====================== 完整知识库数据（来自执行摘要报告第1节） ======================
COURSES_DATA = [
  {
    "id": "math",
    "name": "高等数学",
    "source": "同济大学数学系，《高等数学》（第七版·上册，高等教育出版社）",
    "description": "涵盖同济《高等数学》第七版上册与下册：一元微积分、微分方程、向量与空间解析几何、多元微积分、曲线曲面积分与无穷级数等。",
    "learning_goals": [
      "理解极限、连续、导数、微分、不定积分、定积分等基本概念及运算性质[1]",
      "掌握导数的计算方法和微分中值定理，利用导数分析函数单调性、凹凸性及极值问题",
      "熟练应用不定积分的换元法、分部法和定积分的牛顿-莱布尼茨公式",
      "能用定积分计算平面图形面积和旋转体体积，解决简单的几何和物理问题[2]",
      "培养抽象思维、严密推理和数学表达能力，掌握使用数学软件进行计算的基本技能"
    ],
    "chapters": [
      {
        "id": "math-1",
        "title": "第一章 函数与极限",
        "desc": "同济《高等数学》第七版上册：映射与函数、数列极限与函数极限、无穷小与无穷大、函数的连续性与间断点。",
        "subsections": ["映射与函数", "数列的极限", "函数的极限", "无穷小与无穷大", "极限运算法则", "极限存在准则", "无穷小的比较", "函数的连续性与间断点", "连续函数的运算与初等函数的连续性", "闭区间上连续函数的性质"],
        "keywords": ["函数", "极限", "无穷小", "无穷大", "连续", "间断"]
      },
      {
        "id": "math-2",
        "title": "第二章 导数与微分",
        "desc": "导数概念与几何意义、求导法则、高阶导数、隐函数与参数方程的导数、函数的微分。",
        "subsections": ["导数概念", "函数的求导法则", "高阶导数", "隐函数及由参数方程所确定的函数的导数", "函数的微分"],
        "keywords": ["导数", "微分", "求导法则", "隐函数", "变化率"]
      },
      {
        "id": "math-3",
        "title": "第三章 微分中值定理与导数的应用",
        "desc": "罗尔、拉格朗日与柯西中值定理，洛必达法则，泰勒公式，利用导数研究单调性、凹凸性、极值与曲率。",
        "subsections": ["微分中值定理", "洛必达法则", "泰勒公式", "函数的单调性与曲线的凹凸性", "函数的极值与最大值最小值", "函数图形的描绘", "曲率", "方程的近似解"],
        "keywords": ["中值定理", "洛必达", "泰勒公式", "单调性", "极值", "凹凸性"]
      },
      {
        "id": "math-4",
        "title": "第四章 不定积分",
        "desc": "原函数与不定积分、基本积分表、换元积分法、分部积分法、有理函数的积分。",
        "subsections": ["不定积分的概念与性质", "换元积分法", "分部积分法", "有理函数的积分", "积分表的使用"],
        "keywords": ["不定积分", "原函数", "换元法", "分部法", "有理函数"]
      },
      {
        "id": "math-5",
        "title": "第五章 定积分",
        "desc": "定积分概念与性质、微积分基本公式、定积分的换元法与分部积分法、反常积分。",
        "subsections": ["定积分的概念与性质", "微积分基本公式", "定积分的换元法和分部积分法", "反常积分"],
        "keywords": ["定积分", "牛顿-莱布尼茨公式", "反常积分", "换元法", "分部法"]
      },
      {
        "id": "math-6",
        "title": "第六章 定积分的应用",
        "desc": "定积分的元素法，在几何（面积、体积、弧长）与部分物理问题中的应用。",
        "subsections": ["定积分的元素法", "定积分在几何学上的应用", "定积分在物理学上的应用"],
        "keywords": ["面积", "体积", "弧长", "元素法", "物理应用"]
      },
      {
        "id": "math-7",
        "title": "第七章 微分方程",
        "desc": "微分方程基本概念、可分离变量、齐次方程、一阶线性、可降阶、高阶常系数线性、欧拉方程与常系数线性方程组。",
        "subsections": ["微分方程的基本概念", "可分离变量的微分方程", "齐次方程", "一阶线性微分方程", "全微分方程", "可降阶的高阶微分方程", "高阶线性微分方程", "常系数齐次线性微分方程", "常系数非齐次线性微分方程", "欧拉方程", "常系数线性微分方程组解法举例"],
        "keywords": ["微分方程", "通解", "特解", "特征方程", "欧拉方程"]
      },
      {
        "id": "math-8",
        "title": "第八章 向量代数与空间解析几何",
        "desc": "向量坐标、曲面与空间曲线、平面与直线方程、位置关系与夹角。",
        "subsections": ["向量及其线性运算", "点的坐标与向量的坐标", "向量的数量积向量积混合积", "曲面方程与空间曲线方程", "平面及其方程", "空间直线及其方程", "空间直线与平面的夹角与位置关系"],
        "keywords": ["向量", "平面", "直线", "曲面", "夹角"]
      },
      {
        "id": "math-9",
        "title": "第九章 多元函数微分法及其应用",
        "desc": "多元函数极限与连续、偏导全微分、链式法则、方向导数与梯度、极值与最值。",
        "subsections": ["多元函数的基本概念", "偏导数", "全微分", "多元复合函数的求导法则", "隐函数的求导公式", "多元函数微分学的几何应用", "方向导数与梯度", "多元函数的极值及其求法"],
        "keywords": ["偏导数", "全微分", "梯度", "极值", "拉格朗日乘数法"]
      },
      {
        "id": "math-10",
        "title": "第十章 重积分",
        "desc": "二重与三重积分的定义、计算与坐标变换，重积分应用。",
        "subsections": ["二重积分的概念与性质", "二重积分的计算法", "三重积分", "重积分的应用"],
        "keywords": ["二重积分", "三重积分", "极坐标", "柱面坐标", "球面坐标"]
      },
      {
        "id": "math-11",
        "title": "第十一章 曲线积分与曲面积分",
        "desc": "对弧长与坐标的曲线积分、格林公式、曲面积分、高斯公式与斯托克斯公式。",
        "subsections": ["对弧长的曲线积分", "对坐标的曲线积分", "格林公式及其应用", "对面积的曲面积分", "对坐标的曲面积分", "高斯公式通量与散度", "斯托克斯公式环量与旋度"],
        "keywords": ["曲线积分", "曲面积分", "格林公式", "高斯公式", "斯托克斯公式"]
      },
      {
        "id": "math-12",
        "title": "第十二章 无穷级数",
        "desc": "常数项级数审敛、幂级数、函数项级数与傅里叶级数。",
        "subsections": ["常数项级数的概念和性质", "常数项级数的审敛法", "幂级数", "函数展开成幂级数", "函数的幂级数展开式的应用", "函数项级数的一致收敛性及其基本性质", "傅里叶级数", "一般周期函数的傅里叶级数"],
        "keywords": ["级数", "收敛", "幂级数", "傅里叶级数", "泰勒级数"]
      }
    ]
  },
  {
    "id": "cs",
    "name": "计算机架构",
    "source": "张晨曦等，《计算机体系结构》（第2版，高等教育出版社）",
    "description": "系统介绍计算机体系结构基本概念，包括指令系统、算术逻辑、处理器结构（流水线、超标量、乱序执行）、存储层次（缓存、主存、虚拟存储）和并行体系结构等[9][8]。",
    "learning_goals": [
      "了解计算机系统的层次结构，掌握指令集与数据表示方法（如补码、浮点数）[9]",
      "掌握单周期与流水线CPU设计，理解流水线并行性、冒险与冲突解决；了解超标量与乱序执行技术",
      "理解存储层次结构（Cache、主存、虚拟存储）及其工作原理",
      "认识多核处理器和GPU加速器架构的基本原理",
      "掌握计算机系统性能评估的基本指标与基准测试方法"
    ],
    "chapters": [
      {
        "id": "cs-1",
        "title": "第一章 计算机系统结构的基本概念",
        "desc": "计算机系统结构定义、计算机系统设计的定量原理（Amdahl定律等）、计算机系统结构的发展。",
        "subsections": ["计算机系统结构的基本概念", "计算机系统的设计技术", "计算机系统的性能评测", "计算机系统结构的发展"],
        "keywords": ["系统结构", "Amdahl定律", "CPU时间", "MIPS", "性能评测"]
      },
      {
        "id": "cs-2",
        "title": "第二章 计算机指令集结构",
        "desc": "指令集结构的分类、寻址方式、指令格式、CISC与RISC、MIPS指令集结构简介。",
        "subsections": ["指令集结构的分类", "寻址技术", "指令集结构的功能设计", "操作数的类型和大小", "指令集格式的设计", "DLX指令集结构", "MIPS指令集结构"],
        "keywords": ["指令集", "寻址方式", "CISC", "RISC", "MIPS"]
      },
      {
        "id": "cs-3",
        "title": "第三章 流水线和向量处理技术",
        "desc": "先行控制技术、流水线工作原理、流水线中的相关与冲突、流水线的调度与性能分析、向量处理机。",
        "subsections": ["先行控制技术", "流水线技术", "指令调度", "流水线性能分析", "向量处理机"],
        "keywords": ["流水线", "数据相关", "控制相关", "结构相关", "向量处理"]
      },
      {
        "id": "cs-4",
        "title": "第四章 指令级并行",
        "desc": "指令级并行概念、超标量处理机、超长指令字处理机、多指令发射与乱序执行、分支预测。",
        "subsections": ["指令级并行", "超标量处理机", "超长指令字处理机", "多指令发射技术", "乱序执行技术", "分支预测技术"],
        "keywords": ["指令级并行", "超标量", "VLIW", "乱序执行", "分支预测"]
      },
      {
        "id": "cs-5",
        "title": "第五章 存储层次结构",
        "desc": "存储器的层次结构、Cache基本知识、降低Cache失效率与失效开销的方法、主存与虚拟存储器。",
        "subsections": ["存储器的层次结构", "Cache基本知识", "降低Cache失效率的方法", "减少Cache失效开销的方法", "减少命中时间的方法", "主存与虚拟存储器"],
        "keywords": ["Cache", "失效率", "虚拟存储", "TLB", "存储层次"]
      },
      {
        "id": "cs-6",
        "title": "第六章 输入输出系统",
        "desc": "输入输出系统的基本概念、总线、通道处理机、RAID、磁盘存储设备及其性能。",
        "subsections": ["输入输出系统的基本概念", "总线", "通道处理机", "RAID", "磁盘存储设备及其性能"],
        "keywords": ["总线", "通道", "DMA", "RAID", "磁盘"]
      },
      {
        "id": "cs-7",
        "title": "第七章 阵列处理机与 SIMD 计算机",
        "desc": "阵列处理的基本原理、SIMD 互联网络、并行存储器无冲突访问。",
        "subsections": ["阵列处理的基本原理", "SIMD 计算机的基本结构", "SIMD 计算机的实例", "SIMD 计算机的应用", "并行存储器无冲突访问", "脉动阵列机基本原理"],
        "keywords": ["SIMD", "阵列", "互联网络", "脉动阵列"]
      },
      {
        "id": "cs-8",
        "title": "第八章 多处理机与多计算机",
        "desc": "集中式与分布式共享存储、通信延迟与可扩展性。",
        "subsections": ["多处理机系统概述", "多处理机系统的结构", "多处理机系统的存储器组织", "多处理机系统的通信技术", "多处理机系统的同步机制", "多处理机系统的机间互连形式", "并行程序设计"],
        "keywords": ["多处理机", "共享存储", "互连", "同步"]
      },
      {
        "id": "cs-9",
        "title": "第九章 机群系统",
        "desc": "机群结构、关键技术、典型系统。",
        "subsections": ["机群的基本结构", "机群的关键技术", "机群的分类", "典型的机群系统"],
        "keywords": ["机群", "Beowulf", "关键服务"]
      },
      {
        "id": "cs-10",
        "title": "第十章 领域专用体系结构",
        "desc": "面向特定应用领域的体系结构加速。",
        "subsections": ["领域专用计算需求", "张量处理单元", "神经网络加速器", "图形处理器体系结构要点"],
        "keywords": ["TPU", "NPU", "GPU", "加速器"]
      },
      {
        "id": "cs-11",
        "title": "第十一章 容错与可靠性设计",
        "desc": "故障分类、冗余与可用性。",
        "subsections": ["故障与容错基本概念", "硬件冗余技术", "时间冗余与信息冗余", "可用性与 RAS 设计要点"],
        "keywords": ["容错", "冗余", "RAS"]
      },
      {
        "id": "cs-12",
        "title": "第十二章 体系结构评价与展望",
        "desc": "性能评价方法、能效与新兴趋势。",
        "subsections": ["性能评测与基准程序", "功耗与能效", "领域专用与异构计算趋势"],
        "keywords": ["基准", "能效", "异构计算"]
      }
    ]
  },
  {
    "id": "nlp",
    "name": "自然语言处理",
    "source": "宗成庆，《统计自然语言处理》（第2版，清华大学出版社）",
    "description": "系统介绍统计自然语言处理的基本问题与方法，覆盖宗成庆《统计自然语言处理》第二版全书主线章节（绪论至神经机器翻译等）。",
    "learning_goals": [
      "理解NLP的基本概念、流程和常见任务[13]",
      "掌握统计与神经语言模型，熟悉词向量生成及预训练模型（如Word2Vec、BERT）",
      "了解深度学习基础（前馈网络、CNN、RNN、Transformer）及其在NLP中的应用",
      "能够处理常见NLP任务：文本分类、序列标注（分词、词性标注、实体识别）等",
      "理解机器翻译与对话系统的基本原理，了解预训练语言模型在下游任务中的迁移应用"
    ],
    "chapters": [
      {
        "id": "nlp-1",
        "title": "第一章 绪论",
        "desc": "自然语言处理的概念、研究内容、发展历程、现状与难点。",
        "subsections": ["自然语言处理的概念", "自然语言处理的研究内容", "自然语言处理的发展历程", "自然语言处理的现状", "自然语言处理的难点"],
        "keywords": ["NLP", "研究内容", "发展历程", "难点"]
      },
      {
        "id": "nlp-2",
        "title": "第二章 预备知识",
        "desc": "概率论基础、信息论基础、语言学基本概念。",
        "subsections": ["概率论基础", "信息论基础", "语言学基础"],
        "keywords": ["概率", "熵", "互信息", "语言学"]
      },
      {
        "id": "nlp-3",
        "title": "第三章 形式语言与自动机及其应用",
        "desc": "形式文法、有限自动机、下推自动机、句法分析与词法分析中的应用。",
        "subsections": ["形式语言", "形式文法", "有限自动机", "下推自动机", "句法分析的相关理论"],
        "keywords": ["形式语言", "自动机", "文法", "句法分析"]
      },
      {
        "id": "nlp-4",
        "title": "第四章 语料库与语言知识库",
        "desc": "语料库类型与建设、语料库加工、语言知识库、词语知识库。",
        "subsections": ["语料库的类型", "语料库建设的基本问题", "语料库的加工和使用", "语言知识库", "词语知识库"],
        "keywords": ["语料库", "标注", "知识库", "WordNet"]
      },
      {
        "id": "nlp-5",
        "title": "第五章 词法分析与词性标注",
        "desc": "汉语分词、未登录词处理、基于统计与序列标注的词性标注。",
        "subsections": ["汉语分词中的基本问题", "汉语分词方法", "未登录词的处理", "词性标注"],
        "keywords": ["分词", "未登录词", "词性标注", "HMM", "CRF"]
      },
      {
        "id": "nlp-6",
        "title": "第六章 命名实体识别",
        "desc": "命名实体类型、基于规则与统计的识别方法、评价与系统实现。",
        "subsections": ["命名实体识别的类型", "命名实体识别的方法", "命名实体识别的评价方法"],
        "keywords": ["命名实体", "NER", "评价指标", "序列标注"]
      },
      {
        "id": "nlp-7",
        "title": "第七章 理论：词法分析、句法分析与语义分析",
        "desc": "词法分析、句法分析与语义分析相关理论与模型。",
        "subsections": ["词法分析与句法分析", "语义分析", "基于概率的句法分析模型", "基于数据的句法分析模型"],
        "keywords": ["句法", "语义", "概率句法"]
      },
      {
        "id": "nlp-8",
        "title": "第八章 词义消歧",
        "desc": "词义消歧问题、有监督与无监督方法。",
        "subsections": ["词义消歧问题", "有监督的词义消歧方法", "无监督的词义消歧方法"],
        "keywords": ["词义消歧", "有监督", "无监督"]
      },
      {
        "id": "nlp-9",
        "title": "第九章 句法分析",
        "desc": "句法分析概述、短语结构分析、依存分析。",
        "subsections": ["句法分析概述", "短语结构句法分析", "依存句法分析"],
        "keywords": ["句法分析", "依存", "短语结构"]
      },
      {
        "id": "nlp-10",
        "title": "第十章 统计翻译模型",
        "desc": "基于词的翻译模型、基于短语的翻译模型。",
        "subsections": ["基于词的翻译模型", "基于短语的翻译模型"],
        "keywords": ["IBM模型", "短语对齐", "翻译模型"]
      },
      {
        "id": "nlp-11",
        "title": "第十一章 基于短语的统计机器翻译",
        "desc": "基于短语的翻译模型、解码、评价。",
        "subsections": ["基于短语的翻译模型", "基于短语解码", "基于短语的翻译模型评价"],
        "keywords": ["短语解码", "BLEU", "翻译评价"]
      },
      {
        "id": "nlp-12",
        "title": "第十二章 神经机器翻译",
        "desc": "神经机器翻译、序列到序列与注意力。",
        "subsections": ["神经机器翻译", "基于循环神经网络的翻译模型", "基于自注意力的翻译模型"],
        "keywords": ["NMT", "Seq2Seq", "Attention", "Transformer"]
      }
    ]
  },
  {
    "id": "os",
    "name": "操作系统",
    "source": "汤子瀛等，《计算机操作系统》（第4版，西安电子科技大学出版社）",
    "description": "介绍操作系统的基本原理，覆盖汤子瀛等《计算机操作系统》第四版全书主要章：进程与调度、存储与虚拟存储、I/O、文件、磁盘、接口、多处理机、多媒体与安全等。",
    "learning_goals": [
      "理解操作系统的功能和结构，掌握OS作为资源管理和控制平台的作用",
      "掌握进程和线程的概念、状态转换、调度算法，以及上下文切换的原理",
      "熟悉处理机调度算法与死锁的预防、避免、检测与解除",
      "掌握存储器管理（分页、分段）与虚拟存储、页面置换算法",
      "了解输入输出系统的结构、中断与设备分配、磁盘存储器管理"
    ],
    "chapters": [
      {
        "id": "os-1",
        "title": "第一章 操作系统引论",
        "desc": "操作系统的目标和作用、发展过程、基本特性、主要功能、OS结构设计。",
        "subsections": ["操作系统的目标和作用", "操作系统的发展过程", "操作系统的基本特性", "操作系统的主要功能", "OS结构设计"],
        "keywords": ["操作系统", "批处理", "分时", "实时", "微内核"]
      },
      {
        "id": "os-2",
        "title": "第二章 进程的描述与控制",
        "desc": "进程与程序、进程控制块、进程状态与控制、进程通信、线程。",
        "subsections": ["前趋图和程序执行", "进程的描述", "进程控制", "进程通信", "线程"],
        "keywords": ["进程", "PCB", "进程状态", "进程通信", "线程"]
      },
      {
        "id": "os-3",
        "title": "第三章 处理机调度与死锁",
        "desc": "处理机调度的层次与算法、实时调度、死锁的预防避免检测与解除。",
        "subsections": ["处理机调度的层次", "调度队列模型", "调度算法", "实时调度", "产生死锁的原因和必要条件", "预防死锁的方法", "避免死锁的方法", "死锁的检测与解除"],
        "keywords": ["调度", "FCFS", "SJF", "优先级", "死锁", "银行家算法"]
      },
      {
        "id": "os-4",
        "title": "第四章 存储器管理",
        "desc": "连续分配、分页与分段、段页式存储管理、地址变换与内存保护。",
        "subsections": ["存储器的层次结构", "程序的装入和链接", "连续分配存储管理方式", "对换与覆盖技术", "分页存储管理方式", "分段存储管理方式"],
        "keywords": ["连续分配", "分页", "分段", "页表", "地址变换"]
      },
      {
        "id": "os-5",
        "title": "第五章 虚拟存储器",
        "desc": "虚拟存储基本概念、请求分页/分段、页面置换算法、抖动与工作集。",
        "subsections": ["虚拟存储器概述", "请求分页存储管理方式", "页面置换算法", "请求分段存储管理方式"],
        "keywords": ["虚拟存储", "请求分页", "页面置换", "抖动", "工作集"]
      },
      {
        "id": "os-6",
        "title": "第六章 输入输出系统",
        "desc": "I/O系统功能与模型、中断与驱动程序、设备分配、缓冲与磁盘存储器管理。",
        "subsections": ["I/O系统的功能、模型和接口", "中断和驱动程序", "与设备无关的I/O软件", "用户层的I/O软件", "磁盘存储器的管理"],
        "keywords": ["I/O", "中断", "设备驱动", "缓冲", "磁盘调度"]
      },
      {
        "id": "os-7",
        "title": "第七章 文件管理",
        "desc": "文件和文件系统、目录、共享与保护、数据一致性。",
        "subsections": ["文件和文件系统", "文件的逻辑结构", "外存分配方式", "目录管理", "文件存储空间的管理", "文件共享与文件保护", "数据一致性控制"],
        "keywords": ["文件", "目录", "FCB", "索引节点", "共享"]
      },
      {
        "id": "os-8",
        "title": "第八章 磁盘存储器的管理",
        "desc": "磁盘驱动调度、RAID、提高 I/O 速度的措施。",
        "subsections": ["外存的组织方式", "文件的组织方式", "提高磁盘 I/O 速度的若干措施", "数据交付", "提高磁盘可靠性的技术"],
        "keywords": ["磁盘", "调度", "RAID", "缓冲"]
      },
      {
        "id": "os-9",
        "title": "第九章 操作系统接口",
        "desc": "联机命令接口、系统调用、图形用户接口。",
        "subsections": ["联机命令接口", "Shell 命令语言", "系统调用", "图形用户接口元素", "图形结构的终端服务"],
        "keywords": ["系统调用", "API", "Shell", "GUI"]
      },
      {
        "id": "os-10",
        "title": "第十章 多处理机操作系统",
        "desc": "多处理机系统结构、进程同步与调度。",
        "subsections": ["多处理机系统的基本概念", "多处理机系统的结构", "多处理机操作系统的特征及分类", "进程同步", "多处理机系统的进程调度"],
        "keywords": ["多处理机", "SMP", "调度", "同步"]
      },
      {
        "id": "os-11",
        "title": "第十一章 多媒体操作系统",
        "desc": "多媒体文件、接纳控制与实时调度。",
        "subsections": ["多媒体系统简介", "多媒体文件中的各种媒体", "多媒体文件管理", "多媒体设备驱动程序", "接纳控制与实时调度", "多媒体磁盘调度"],
        "keywords": ["多媒体", "实时", "接纳控制"]
      },
      {
        "id": "os-12",
        "title": "第十二章 保护和安全",
        "desc": "访问矩阵、加密与认证、防火墙。",
        "subsections": ["安全环境", "数据加密技术", "用户验证", "访问控制技术", "可信任系统", "防火墙技术"],
        "keywords": ["安全", "加密", "认证", "访问控制", "防火墙"]
      }
    ]
  },
  DL_COURSE,
]

# ====================== 种子导入函数 ======================
def seed_courses(db: Session):
    """导入/更新课程知识库：每门课含全书大章 + 小节正文纲要；深度学习可叠加「深度学习课件」目录中的 md/txt。"""
    ware = load_text_courseware_files()
    total_chapters = 0
    total_sections = 0

    for course_data in COURSES_DATA:
        learning_goals_str = json.dumps(course_data.get("learning_goals", []), ensure_ascii=False)

        course = db.query(CourseDB).filter_by(id=course_data["id"]).first()

        if course:
            course.name = course_data["name"]
            course.source = course_data["source"]
            course.description = course_data["description"]
            course.learning_goals = learning_goals_str
            for ch in list(course.chapters):
                db.delete(ch)
        else:
            course = CourseDB(
                id=course_data["id"],
                name=course_data["name"],
                source=course_data["source"],
                description=course_data["description"],
                learning_goals=learning_goals_str,
            )
            db.add(course)

        db.commit()
        db.refresh(course)

        for chap in course_data["chapters"]:
            sections = normalize_subsections(
                course_data["name"],
                chap,
                ware,
                attach_files_for_course_ids=None,
            )
            total_chapters += 1
            total_sections += len(sections)
            chapter = ChapterDB(
                id=chap["id"],
                course_id=course.id,
                title=chap["title"],
                desc=chap["desc"],
                subsections=serialize_subsections_for_db(sections),
                keywords=json.dumps(chap.get("keywords", []), ensure_ascii=False),
            )
            db.add(chapter)

        db.commit()

    print(
        f"[OK] 课程数据导入完成：{len(COURSES_DATA)} 门课程，{total_chapters} 个大章，{total_sections} 个小节；"
        f"深度学习课件目录：{deep_learning_courseware_dir()}（当前扫描到 {len(ware)} 个文本文件）"
    )


def course_seed_refresh_reason(db: Session) -> str:
    expected_ids = {str(c["id"]) for c in COURSES_DATA}
    existing_ids = {row[0] for row in db.query(CourseDB.id).all()}
    if not existing_ids:
        return "empty-course-table"
    missing_ids = sorted(expected_ids - existing_ids)
    if missing_ids:
        return f"missing-courses:{','.join(missing_ids)}"

    ware = load_text_courseware_files()
    if not ware:
        return ""

    section_total = 0
    attached_total = 0
    for (subsections_json,) in db.query(ChapterDB.subsections).all():
        for sec in parse_subsections_json(subsections_json):
            body = str(sec.get("content") or "")
            section_total += 1
            if "课程知识库摘录" in body:
                attached_total += 1
    if section_total > 0 and attached_total == 0:
        return "courseware-files-present-but-db-not-attached"
    return ""


def resolve_course(db: Session, subject: str, *, auto_seed: bool = False) -> CourseDB | None:
    value = (subject or "").strip()
    if not value:
        return None

    def lookup() -> CourseDB | None:
        course = db.query(CourseDB).filter(CourseDB.name == value).first()
        if course:
            return course
        course = db.query(CourseDB).filter(CourseDB.id == value).first()
        if course:
            return course
        return db.query(CourseDB).filter(func.lower(CourseDB.id) == value.lower()).first()

    course = lookup()
    if course or not auto_seed:
        return course
    seed_courses(db)
    return lookup()


def _chapter_row(db: Session, course_id: str, chapter_id: str) -> ChapterDB | None:
    if not chapter_id:
        return None
    return (
        db.query(ChapterDB)
        .filter(ChapterDB.id == chapter_id, ChapterDB.course_id == course_id)
        .first()
    )


def _build_learning_reference(
    ch_row: ChapterDB | None, section_id: str | None
) -> tuple[str, str]:
    """(人类可读范围, 参考资料正文)"""
    if not ch_row:
        return "（未匹配到教材章节）", ""

    sid = (section_id or "").strip()
    if sid:
        sec = find_section(ch_row.subsections, sid)
        if sec:
            body = (sec.get("content") or "").strip()
            label = scope_display(ch_row.title, sec.get("title"))
            return label, body[:12000]

    desc = (ch_row.desc or "").strip()
    secs = sections_natural_order(parse_subsections_json(ch_row.subsections))
    outline = "；".join(s.get("title", "") for s in secs[:24])
    label = ch_row.title
    body = (
        f"{desc}\n\n【本章各小节目录】{outline}\n\n"
        "当前未指定具体小节：请仅做本章范围内的总览式回答，不要深入依赖后章结论；并建议学习者点击左侧具体小节以启用严格小节资料。"
    )
    return label, body[:12000]


_llm_client: Optional[OpenAI] = None


def _get_llm_client() -> OpenAI:
    """仅从环境变量读取密钥，不在仓库中写死默认密钥。支持 API_KEY 或 OPENAI_API_KEY。"""
    global _llm_client
    if _llm_client is None:
        key = (os.getenv("API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
        base = (os.getenv("BASE_URL") or "https://api.openai.com/v1").strip()
        if not key:
            raise HTTPException(
                status_code=503,
                detail=(
                    "未配置大模型密钥：请在 backend/.env 设置 API_KEY，或设置环境变量 OPENAI_API_KEY。"
                    "示例见 backend/.env.example。"
                ),
            )
        _llm_client = OpenAI(api_key=key, base_url=base)
    return _llm_client


def _learn_chat_complete(messages: List[dict[str, str]], temperature: float = 0.35) -> str:
    resp = _get_llm_client().chat.completions.create(
        model=os.getenv("MODEL_NAME", "gpt-4o-mini"),
        messages=cast(List[ChatCompletionMessageParam], messages),
        temperature=temperature,
    )
    msg = resp.choices[0].message
    return (msg.content or "").strip()


LEARN_META_BEGIN = "[[META]]"
LEARN_META_END = "[[/META]]"
SECTION_QUIZ_MASTERY_THRESHOLD = 0.72
SECTION_FORCE_QUIZ_TURNS = 6
SMALL_QUIZ_QUESTION_COUNT = 15
SMALL_QUIZ_JSON_MAX_CHARS = 80000
QUIZ_PASSING_SCORE = 60.0


def _strip_learn_meta_trailer(text: str) -> str:
    i = text.rfind(LEARN_META_BEGIN)
    if i == -1:
        return text.strip()
    return text[:i].strip()


def _learn_opening_system(subject: str, scope_label: str, ref_excerpt: str) -> str:
    return (
        f"你是「{subject}」学习伙伴，当前小节：{scope_label}。\n"
        "请用清爽、有重点的 Markdown 组织第一轮内容。不要堆专业术语；必须出现术语时，立刻用一句人话解释。\n"
        "固定结构如下，标题必须保留；第一行必须是 `## 先抓重点`，不要在标题前写“好的/我们来看/下面是”等开场句：\n"
        "## 先抓重点\n用 2-4 条短句说清这节最重要的东西，每条只讲一个意思。\n"
        "## 换个说法\n用生活化比喻或画面感解释核心想法，不要写成教材摘要。\n"
        "## 小例子\n给一个小例子、反例或一步步的小推演，让学习者看见它怎么用。\n"
        "## 你来试试\n给 1 个轻量问题或小练习，引导学习者继续回答。\n"
        "排版要求：段落不要过长；不要把单个字母、公式符号单独拆成一行；列表最多 5 条；重点词可以加粗，但不要满屏加粗。\n"
        "数学公式请用 LaTeX：行内 `$...$`，独立公式 `$$...$$`；代码用 Markdown 围栏代码块（带语言标签）。\n"
        "严格只依据【资料】，不要编造资料中不存在的定理编号；不要输出与教学无关的寒暄套话。\n"
        f"【资料】\n{ref_excerpt[:11000]}\n\n"
        "重要：正文中**禁止**出现子串 [[META]]、[[/META]]（系统预留）。"
        + ANTI_HALLUCINATION_SYSTEM_SUFFIX
    )


def _learn_teaching_system(subject: str, scope_label: str, ref_excerpt: str) -> str:
    return (
        f"你是「{subject}」学习伙伴，当前小节：{scope_label}。\n"
        "请用清爽、有重点的 Markdown 组织本轮讲解，并自然接住学习者上一句回答。不要堆专业术语；必须出现术语时，立刻用一句人话解释。\n"
        "固定结构如下，标题必须保留；第一行必须是 `## 先接住你的想法`，不要在标题前写“好的/我们来看/下面是”等开场句：\n"
        "## 先接住你的想法\n先用 1-2 句话点评学习者刚才的回答：哪里对、哪里需要轻轻修正。\n"
        "## 先抓重点\n用 2-4 条短句讲清本轮最重要的东西，每条只讲一个意思。\n"
        "## 小例子\n给一个小例子、反例或一步步的小推演，让学习者看见它怎么用。\n"
        "## 你来试试\n给 1 个轻量问题或小练习，引导学习者继续回答。\n"
        "排版要求：段落不要过长；不要把单个字母、公式符号单独拆成一行；列表最多 5 条；重点词可以加粗，但不要满屏加粗。\n"
        "若学员回答明显偏离本节，先温和纠偏再回到本节主线。\n"
        "公式：行内 `$...$`，独立 `$$...$$`；代码用 ```语言 围栏；可用少量 Unicode 符号（如 ⇒、∴）辅助表达。\n"
        "严格只依据【资料】；不要编造资料中不存在的结论。\n"
        f"【资料】\n{ref_excerpt[:10000]}\n\n"
        "重要：正文中**禁止**出现子串 [[META]]、[[/META]]。"
        + ANTI_HALLUCINATION_SYSTEM_SUFFIX
    )


def _learn_extract_meta_json(
    teaching_md: str, user_answer: str, scope_label: str, learn_turns_after: int
) -> Dict[str, Any]:
    """在流式教学正文结束后，单独抽取进度与测验结构（非流式）。"""
    excerpt = (teaching_md or "")[:9000]
    sys_e = (
        "你是教学评估模块。根据【教员本轮 Markdown 讲解全文】与【学员最新作答】输出**仅一个 JSON 对象**（不要用 markdown 围栏）。\n"
        "字段：\n"
        '{"evaluation":"对学员本轮表现的简短评价",'
        '"mastery_total":0到1的小数,'
        '"section_complete":true或false,'
        '"section_summary":"本节300字内总结，section_complete为true时必填",'
        '"small_quiz":[{"question":"题干","options":["A","B","C","D"],"correct_index":0,"explanation":"解析"},...]}\n'
        f"规则：small_quiz 要么为 null，要么长度**恰好为{SMALL_QUIZ_QUESTION_COUNT}**；correct_index 为0-3；每题必须给出 explanation；\n"
        f"若本轮讲解已覆盖本节核心且互动充分、或 mastery_total>={SECTION_QUIZ_MASTERY_THRESHOLD:.2f}、或 learn_turns_after>={SECTION_FORCE_QUIZ_TURNS}，"
        "则 section_complete=true 且必须给出 small_quiz；否则 section_complete=false 且 small_quiz 为 null。\n"
        f"当前已累计带学轮次（含本轮）为：{learn_turns_after}。"
    )
    user_e = (
        f"【学习范围】{scope_label}\n【学员最新作答】\n{user_answer[:4000]}\n\n【教员本轮讲解】\n{excerpt}"
    )
    sys_e += (
        "\nAlso include weak_points as an array. Each item must contain section, question, and reason. "
        "Only add weak_points when the learner shows misunderstanding, missing conditions, weak transfer, or incomplete expression; otherwise return an empty array."
    )
    raw = _learn_chat_complete(
        [{"role": "system", "content": sys_e}, {"role": "user", "content": user_e}],
        temperature=0.1,
    )
    return _parse_json_object_from_llm(raw)


def _ask_extract_learning_signal(answer_md: str, user_question: str, scope_label: str) -> Dict[str, Any]:
    """Extract a light learning signal from free-form Q&A without turning it into guided mode."""
    sys_p = (
        "你是学习状态观察模块。根据【用户问题】和【回答】输出**仅一个 JSON 对象**，不要 markdown。\n"
        "字段："
        '{"weak_points":[{"section":"小节或概念","question":"暴露的疑问","reason":"为什么需要回补"}],'
        '"summary":"60字内学习观察","needs_practice":true或false}\n'
        "只在用户明确表现出混淆、误解、缺少条件、迁移困难、反复分不清概念时写 weak_points；"
        "普通求解释但没有薄弱迹象时 weak_points 返回空数组。最多 3 个弱点。"
    )
    user_p = (
        f"【学习范围】{scope_label}\n"
        f"【用户问题】\n{(user_question or '')[:3000]}\n\n"
        f"【回答】\n{(answer_md or '')[:7000]}"
    )
    raw = _learn_chat_complete(
        [{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
        temperature=0.1,
    )
    data = _parse_json_object_from_llm(raw)
    weak_points = data.get("weak_points") if isinstance(data, dict) else []
    if not isinstance(weak_points, list):
        weak_points = []
    data["weak_points"] = weak_points[:3]
    data["summary"] = str(data.get("summary") or "")[:300]
    data["needs_practice"] = bool(data.get("needs_practice") or weak_points)
    return data


def _parse_json_object_from_llm(raw: str) -> Dict[str, Any]:
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```\s*$", "", s).strip()
    i = s.find("{")
    j = s.rfind("}")
    if i == -1 or j == -1 or j <= i:
        raise ValueError("no json object in model output")
    return json.loads(s[i : j + 1])


def _parse_json_array_from_llm(raw: str) -> list[Any]:
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```\s*$", "", s).strip()
    i = s.find("[")
    j = s.rfind("]")
    if i == -1 or j == -1 or j <= i:
        raise ValueError("no json array in model output")
    val = json.loads(s[i : j + 1])
    if not isinstance(val, list):
        raise ValueError("top-level json is not array")
    return val


def _normalize_small_quiz_questions(raw_questions: list[Any]) -> list[Dict[str, Any]]:
    return normalize_mixed_quiz_questions(raw_questions, limit=SMALL_QUIZ_QUESTION_COUNT)


def _generate_small_quiz_for_section(
    subject: str,
    scope_label: str,
    ref_excerpt: str,
    section_summary: str = "",
    weak_points: Optional[list[Dict[str, Any]]] = None,
) -> list[Dict[str, Any]]:
    return build_instant_paper(subject, scope_label, ref_excerpt, section_summary, weak_points=weak_points)

def _get_or_create_section_progress(
    db: Session, user_id: int, subject: str, chapter_id: str, section_id: str
) -> SectionLearningProgressDB:
    row = (
        db.query(SectionLearningProgressDB)
        .filter(
            SectionLearningProgressDB.user_id == user_id,
            SectionLearningProgressDB.subject == subject,
            SectionLearningProgressDB.chapter_id == chapter_id,
            SectionLearningProgressDB.section_id == section_id,
        )
        .first()
    )
    if row:
        return row
    row = SectionLearningProgressDB(
        user_id=user_id,
        subject=subject,
        chapter_id=chapter_id,
        section_id=section_id,
        mastery=0.0,
        learn_turns=0,
        phase="idle",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _get_or_create_chapter_progress(
    db: Session, user_id: int, subject: str, chapter_id: str
) -> ChapterLearningProgressDB:
    row = (
        db.query(ChapterLearningProgressDB)
        .filter(
            ChapterLearningProgressDB.user_id == user_id,
            ChapterLearningProgressDB.subject == subject,
            ChapterLearningProgressDB.chapter_id == chapter_id,
        )
        .first()
    )
    if row:
        return row
    row = ChapterLearningProgressDB(user_id=user_id, subject=subject, chapter_id=chapter_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _all_sections_quiz_passed(db: Session, user_id: int, subject: str, chapter_id: str) -> bool:
    ch = db.query(ChapterDB).filter(ChapterDB.id == chapter_id).first()
    if not ch:
        return False
    secs = sections_natural_order(parse_subsections_json(ch.subsections))
    if not secs:
        return False
    for sec in secs:
        sid = str(sec.get("id") or "")
        if not sid:
            continue
        pr = (
            db.query(SectionLearningProgressDB)
            .filter(
                SectionLearningProgressDB.user_id == user_id,
                SectionLearningProgressDB.subject == subject,
                SectionLearningProgressDB.chapter_id == chapter_id,
                SectionLearningProgressDB.section_id == sid,
            )
            .first()
        )
        if not _section_effectively_passed(pr):
            return False
    return True


# ====================== FastAPI 实例 ======================
@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    """每次进程启动（含 --reload 子进程）再跑一次建表，并在控制台标明关键路由已注册。"""
    ensure_schema()
    db = SessionLocal()
    try:
        refresh_reason = course_seed_refresh_reason(db)
        if refresh_reason:
            seed_courses(db)
            print(f"[mentor-backend] courseware refreshed: {refresh_reason}")
    finally:
        db.close()
    print(
        "[mentor-backend] 已就绪: POST /forgot-password, POST /reset-password "
        "（若前端仍 404，请确认浏览器请求的是本机 8001 且仅保留一个后端进程）"
    )
    yield


app = FastAPI(lifespan=_app_lifespan)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_headers=["*"],
    allow_methods=["*"],
    expose_headers=["X-Session-Id"],
)
app.add_middleware(StripApiPrefixMiddleware)


@app.get("/")
async def api_root():
    """静态站点模式下返回前端首页；否则返回 JSON 服务说明。"""
    sd = static_site_dir()
    if sd is not None:
        index = sd / "index.html"
        if index.is_file():
            return FileResponse(index)
    return {
        "service": "mentor-backend",
        "version": 1,
        "docs": "/docs",
        "user_check": "/user-exists?username=你的用户名",
        "password_reset": {
            "forgot_password": "POST /forgot-password（提交邮箱；响应不含令牌；邮件或本机终端）",
            "reset_password": "POST /reset-password",
            "env": "PUBLIC_APP_URL, PASSWORD_RESET_SMTP_HOST, PASSWORD_RESET_SMTP_PORT, PASSWORD_RESET_SMTP_USER, PASSWORD_RESET_SMTP_PASSWORD, PASSWORD_RESET_SMTP_FROM",
        },
    }


USERNAME_MIN_LENGTH = 2
USERNAME_MAX_LENGTH = 16
USERNAME_PATTERN = r"^[A-Za-z0-9_㐀-䶿一-鿿]+$"


class UserLogin(BaseModel):
    username: str = Field(
        ...,
        min_length=USERNAME_MIN_LENGTH,
        max_length=USERNAME_MAX_LENGTH,
        pattern=USERNAME_PATTERN,
    )
    password: str = Field(..., min_length=1, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def trim_username(cls, v: str) -> str:
        return str(v).strip()


def assert_password_strength(v: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9]+", v):
        raise ValueError("密码仅可包含大小写字母与数字")
    if not re.search(r"[a-z]", v):
        raise ValueError("密码须包含至少一个小写字母")
    if not re.search(r"[A-Z]", v):
        raise ValueError("密码须包含至少一个大写字母")
    if not re.search(r"\d", v):
        raise ValueError("密码须包含至少一个数字")
    return v


_EMAIL_RE = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")


class UserRegister(BaseModel):
    username: str = Field(
        ...,
        min_length=USERNAME_MIN_LENGTH,
        max_length=USERNAME_MAX_LENGTH,
        pattern=USERNAME_PATTERN,
    )
    password: str = Field(..., min_length=6, max_length=20)
    confirm_password: str = Field(..., min_length=6, max_length=20)
    email: str = Field(..., min_length=5, max_length=255)

    @field_validator("username", mode="before")
    @classmethod
    def trim_username(cls, v: str) -> str:
        return str(v).strip()

    @field_validator("email")
    @classmethod
    def required_email(cls, v: str) -> str:
        s = str(v).strip().lower()
        if not _EMAIL_RE.fullmatch(s):
            raise ValueError("邮箱格式不正确")
        return s

    @field_validator("password", "confirm_password")
    @classmethod
    def password_policy(cls, v: str) -> str:
        return assert_password_strength(v)

    @model_validator(mode="after")
    def matching_passwords(self):
        if self.password != self.confirm_password:
            raise ValueError("两次输入的密码不一致")
        return self


class ForgotPasswordBody(BaseModel):
    email: str = Field(..., min_length=5, max_length=255)

    @field_validator("email")
    @classmethod
    def valid_email(cls, v: str) -> str:
        s = str(v).strip().lower()
        if not _EMAIL_RE.fullmatch(s):
            raise ValueError("邮箱格式不正确")
        return s


class ResetPasswordBody(BaseModel):
    username: str = Field(
        ...,
        min_length=USERNAME_MIN_LENGTH,
        max_length=USERNAME_MAX_LENGTH,
        pattern=USERNAME_PATTERN,
    )
    reset_token: str = Field(..., min_length=16, max_length=128)
    password: str = Field(..., min_length=6, max_length=20)

    @field_validator("username", mode="before")
    @classmethod
    def trim_username(cls, v: str) -> str:
        return str(v).strip()

    @field_validator("password")
    @classmethod
    def password_policy(cls, v: str) -> str:
        return assert_password_strength(v)


class LearningStartBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    reset_progress: bool = True
    opening_note: str = Field(default="", max_length=4000)


class AskImagePart(BaseModel):
    media_type: str = Field(default="image/jpeg", max_length=64)
    data_b64: str = Field(..., min_length=8, max_length=14_000_000)

    @field_validator("media_type")
    @classmethod
    def _media_type_ok(cls, v: str) -> str:
        x = (v or "image/jpeg").strip().lower()
        allowed = ("image/jpeg", "image/png", "image/webp", "image/gif")
        if x not in allowed:
            raise ValueError(f"仅支持: {', '.join(allowed)}")
        return x


class AskPostBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    question: str = Field(default="", max_length=8000)
    chapter: Optional[str] = None
    chapter_id: Optional[str] = None
    section_id: Optional[str] = None
    session_id: Optional[int] = None
    images: List[AskImagePart] = Field(default_factory=list, max_length=5)


class LearningAnswerBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    session_id: int = Field(..., ge=1)
    answer: str = Field(default="", max_length=8000)
    images: List[AskImagePart] = Field(default_factory=list, max_length=5)


class StudioPortraitRefreshBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    session_id: Optional[int] = None


class StudioResourceStreamBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    resource_type: str = Field(..., min_length=3, max_length=40)
    extra_hint: str = Field(default="", max_length=2000)


class StudioPracticeResultBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    score: float = Field(default=0)
    weak_points: List[Dict[str, Any]] = Field(default_factory=list, max_length=12)


class SmallQuizSubmitBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    answers: List[Any] = Field(..., min_length=1, max_length=30)
    session_id: Optional[int] = None


class SmallQuizPrepareBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    mode: str = Field(default="direct", max_length=24)


class ChapterQuizPrepareBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)


class ChapterQuizSubmitBody(BaseModel):
    username: str = Field(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN)
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    answers: List[Any] = Field(..., min_length=1, max_length=24)
    session_id: Optional[int] = None


def clean_model_math_artifacts(text: str) -> str:
    if not text:
        return text
    for _ in range(3):
        new_text = re.sub(
            r"(\\frac\{[^{}\n]+\}\{[^{}\n]+\}|\\sqrt\{[^{}\n]+\}|\\(?:lim|sum|int)[^$\n]{0,80})\$\1",
            r"$\1$",
            text,
        )
        new_text = re.sub(r"(\\frac\{[^{}\n]+\})\$\1", r"\1", new_text)
        if new_text == text:
            break
        text = new_text
    return text


def collapse_repetition(text: str) -> str:
    if not text:
        return text
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"([，。！？；、,.!?])\1+", r"\1", text)
    for _ in range(3):
        new_text = re.sub(r"(.{2,30}?)(?:\1)+", r"\1", text)
        if new_text == text:
            break
        text = new_text
    return clean_model_math_artifacts(text).strip()

ANSWER_START_HEADINGS = ("## 先抓重点", "## 先接住你的想法")


def strip_intro_before_answer_heading(text: str, *, wait_for_heading: bool = False) -> str:
    """Keep fixed-format learning answers starting at their first required heading."""
    if not text:
        return text
    positions = [text.find(h) for h in ANSWER_START_HEADINGS if text.find(h) >= 0]
    if positions:
        return text[min(positions):].lstrip()
    return "" if wait_for_heading else text


def safe_stream_delta(prev_clean: str, new_clean: str) -> str:
    if not prev_clean:
        return new_clean
    if new_clean.startswith(prev_clean):
        return new_clean[len(prev_clean):]
    max_overlap = min(len(prev_clean), len(new_clean))
    for i in range(max_overlap, 0, -1):
        if prev_clean[-i:] == new_clean[:i]:
            return new_clean[i:]
    # Streaming cannot retract text already sent to the browser. If cleanup changed
    # earlier content, sending the full cleaned string again duplicates the answer.
    if len(new_clean) <= len(prev_clean):
        return ""
    return new_clean[len(prev_clean):]

def make_session_title(text: str) -> str:
    title = text.strip().replace("\n", " ")
    return (title[:24] + "...") if len(title) > 24 else (title or "新会话")

def session_to_dict(session: ChatSessionDB, last_message: str = ""):
    return {
        "id": session.id,
        "title": session.title,
        "subject": session.subject,
        "chapter": session.chapter,
        "session_kind": getattr(session, "session_kind", None) or "chat",
        "updated_at": session.updated_at.isoformat() if session.updated_at else None,
        "preview": last_message,
    }


def _append_quiz_history_snapshot(
    db: Session,
    *,
    user_id: int,
    subject: str,
    session_id: Optional[int],
    quiz_title: str,
    scope_label: str,
    score: float,
    correct: int,
    total: int,
    passed: bool,
    weak_points: list[Dict[str, Any]],
) -> None:
    if not session_id:
        return
    try:
        session = (
            db.query(ChatSessionDB)
            .filter(
                ChatSessionDB.id == session_id,
                ChatSessionDB.user_id == user_id,
                ChatSessionDB.subject == subject,
            )
            .first()
        )
        if not session:
            return

        status = "已通过" if passed else "需要巩固"
        lines = [
            f"## {quiz_title}",
            "",
            f"- 范围：{scope_label or subject}",
            f"- 结果：{round(float(score or 0))} 分，答对 {correct}/{total}，{status}。",
        ]
        if weak_points:
            lines.append("- 需要回看：")
            for item in weak_points[:3]:
                section = str(item.get("section") or "本题").strip()
                question = str(item.get("question") or "").strip()
                reason = str(item.get("reason") or "").strip()
                detail = question or reason or "错因待复盘"
                lines.append(f"  - {section}：{detail[:120]}")
        else:
            lines.append("- 下一步：可以进入下一小节，或生成一份拓展练习保持手感。")

        db.add(ChatHistoryDB(session_id=session.id, role="assistant", content="\n".join(lines)[:5000]))
        session.updated_at = datetime.utcnow()
        db.add(session)
        db.commit()
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        print(f"[QUIZ_HISTORY] save failed: {exc}", flush=True)


# ====================== /seed 接口（支持 GET 和 POST） ======================
@app.get("/seed")
@app.post("/seed")
async def seed_database(db: Session = Depends(get_db)):
    """访问一次即可导入/更新所有课程知识库"""
    seed_courses(db)
    return {
        "status": "success",
        "message": "课程知识库已成功导入/更新",
        "total_courses": len(COURSES_DATA)
    }

# ====================== 原有所有路由（完全未改动） ======================
@app.get("/user-exists")
async def user_exists(
    username: str = Query(..., min_length=1, max_length=64),
    db: Session = Depends(get_db),
):
    """供前端判断：用户名已存在则走登录，否则走注册（Query 形式，避免路径 404 歧义）。"""
    clean_username = username.strip()
    row = db.query(UserDB).filter(func.lower(UserDB.username) == clean_username.lower()).first()
    return {"exists": row is not None}


@app.get("/check-user/{username}")
async def check_user_path(username: str, db: Session = Depends(get_db)):
    """兼容旧前端路径：与 /user-exists 相同语义。"""
    clean_username = username.strip()
    row = db.query(UserDB).filter(func.lower(UserDB.username) == clean_username.lower()).first()
    return {"exists": row is not None}


@app.post("/register")
async def register(user: UserRegister, request: Request, db: Session = Depends(get_db)):
    _enforce_register_rate_limit(request)
    clean_username = user.username.strip()
    if db.query(UserDB).filter(func.lower(UserDB.username) == clean_username.lower()).first():
        raise HTTPException(status_code=400, detail="用户名已被占用")
    clean_email = user.email.strip().lower()
    if db.query(UserDB).filter(func.lower(UserDB.email) == clean_email).first():
        raise HTTPException(status_code=400, detail="该邮箱已被其他账号绑定")
    log = logging.getLogger("uvicorn.error")
    try:
        hashed = pwd_context.hash(user.password)
    except Exception as exc:
        log.exception("POST /register password hash failed (check bcrypt/passlib versions): %s", exc)
        raise HTTPException(
            status_code=500,
            detail="注册失败：服务端密码组件异常，请联系管理员或稍后重试",
        ) from exc
    try:
        db.add(
            UserDB(
                username=clean_username,
                password=hashed,
                email=clean_email,
            )
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="用户名已被占用")
    except Exception as exc:
        db.rollback()
        log.exception("POST /register failed: %s", exc)
        raise HTTPException(status_code=500, detail="注册失败，请稍后重试") from exc
    return {"message": "注册成功"}

@app.post("/login")
async def login(user: UserLogin, request: Request, db: Session = Depends(get_db)):
    _enforce_login_rate_limit(request)
    clean_username = user.username.strip()
    db_user = db.query(UserDB).filter(func.lower(UserDB.username) == clean_username.lower()).first()
    if not db_user or not pwd_context.verify(user.password, str(db_user.password)):
        raise HTTPException(status_code=400, detail="用户名或密码错误")
    return {"message": "登录成功", "username": db_user.username}


FORGOT_PASSWORD_PUBLIC_MESSAGE = {
    "message": (
        "若该邮箱已绑定账号，我们已受理密码重置请求。"
        "请查收该邮箱（含垃圾箱、订阅邮件）中的重置令牌。"
        "若迟迟收不到，可在邮箱内搜索「Mentor」或「重置」，或稍后再试。"
    ),
    "expires_in_minutes": 20,
}


@app.post("/forgot-password")
async def forgot_password(
    body: ForgotPasswordBody,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    签发短时重置令牌：绝不把明文令牌放进 HTTP 响应。
    - 按邮箱查找账号并发送纯令牌邮件，不发送一键链接。
    - 否则：仅写入数据库哈希，并在**运行后端的本机终端**打印令牌。
    - 邮箱不存在时返回与成功相同的 JSON，降低账号枚举风险。
    """
    _enforce_forgot_rate_limit(request)
    user = db.query(UserDB).filter(func.lower(UserDB.email) == body.email).first()
    if not user:
        return FORGOT_PASSWORD_PUBLIC_MESSAGE

    db.query(PasswordResetTokenDB).filter(PasswordResetTokenDB.user_id == user.id).delete()
    token = secrets.token_urlsafe(24)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    expires_at = datetime.utcnow() + timedelta(minutes=20)
    db.add(PasswordResetTokenDB(user_id=user.id, token_hash=token_hash, expires_at=expires_at))
    db.commit()

    snap_username = user.username
    snap_email = user.email or ""
    background_tasks.add_task(_deliver_password_reset_notification, snap_username, token, snap_email)

    return FORGOT_PASSWORD_PUBLIC_MESSAGE


@app.post("/reset-password")
async def reset_password(body: ResetPasswordBody, request: Request, db: Session = Depends(get_db)):
    _enforce_reset_rate_limit(request)
    raw = body.reset_token.strip()
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    row = (
        db.query(PasswordResetTokenDB)
        .filter(PasswordResetTokenDB.token_hash == token_hash)
        .first()
    )
    if not row:
        raise HTTPException(status_code=400, detail="令牌无效")
    if row.expires_at < datetime.utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="令牌已过期，请重新获取")
    user = db.query(UserDB).filter(UserDB.id == row.user_id).first()
    if not user:
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="令牌无效")
    new_username = body.username.strip()
    if new_username.lower() != user.username.lower():
        exists = (
            db.query(UserDB)
            .filter(func.lower(UserDB.username) == new_username.lower(), UserDB.id != user.id)
            .first()
        )
        if exists:
            raise HTTPException(status_code=400, detail="该昵称已被占用，请换一个")
    user.username = new_username
    user.password = pwd_context.hash(body.password)
    db.query(PasswordResetTokenDB).filter(PasswordResetTokenDB.user_id == user.id).delete()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="该昵称已被占用，请换一个")
    return {"message": "密码已重置，请使用新昵称和新密码登录", "username": user.username}


@app.get("/courses/{course_id}")
async def get_course_detail(course_id: str, db: Session = Depends(get_db)):
    course = db.query(CourseDB).filter(CourseDB.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_out = []
    for c in sorted(course.chapters, key=lambda x: natural_sort_key(x.id)):
        secs = sections_natural_order(parse_subsections_json(c.subsections))
        ch_out.append(
            {
                "id": c.id,
                "title": c.title,
                "desc": c.desc,
                "sections": [{"id": s["id"], "title": s["title"]} for s in secs],
            }
        )
    return {
        "name": course.name,
        "description": course.description,
        "learning_goals": json.loads(course.learning_goals),
        "chapters": ch_out,
    }


def _get_or_create_studio_row(db: Session, user_id: int, subject: str) -> UserLearningStudioDB:
    row = (
        db.query(UserLearningStudioDB)
        .filter(UserLearningStudioDB.user_id == user_id, UserLearningStudioDB.subject == subject)
        .first()
    )
    if row:
        return row
    row = UserLearningStudioDB(
        user_id=user_id,
        subject=subject,
        portrait_json=json.dumps(default_portrait(), ensure_ascii=False),
        learning_path_json="[]",
        resource_events_json="[]",
        resource_artifacts_json="[]",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _studio_collect_recent_messages(
    db: Session, user_id: int, subject: str, session_id: Optional[int]
) -> list[dict[str, str]]:
    sess = None
    if session_id:
        sess = (
            db.query(ChatSessionDB)
            .filter(ChatSessionDB.id == session_id, ChatSessionDB.user_id == user_id)
            .first()
        )
    if not sess:
        sess = (
            db.query(ChatSessionDB)
            .filter(ChatSessionDB.user_id == user_id, ChatSessionDB.subject == subject)
            .order_by(ChatSessionDB.updated_at.desc())
            .first()
        )
    if not sess:
        return []
    hist = (
        db.query(ChatHistoryDB)
        .filter(ChatHistoryDB.session_id == sess.id)
        .order_by(ChatHistoryDB.id.desc())
        .limit(36)
        .all()
    )
    out: list[dict[str, str]] = []
    for h in reversed(hist):
        c = (h.content or "")[:2400]
        if c.startswith(ASK_USER_JSON_PREFIX):
            c = "[图文/附图消息，已省略二进制]"
        out.append({"role": h.role, "content": c})
    return out


def _heuristic_merge_mastery_into_portrait(
    db: Session, user_id: int, subject: str, portrait: Dict[str, Any]
) -> None:
    if not isinstance(portrait.get("dimensions"), dict):
        portrait["dimensions"] = {}
    for key in PORTRAIT_DIMENSION_KEYS:
        portrait["dimensions"].setdefault(key, {"score": 0.5, "note": "证据仍在积累"})

    rows = (
        db.query(SectionLearningProgressDB)
        .filter(
            SectionLearningProgressDB.user_id == user_id,
            SectionLearningProgressDB.subject == subject,
        )
        .all()
    )
    studio_row = (
        db.query(UserLearningStudioDB)
        .filter(UserLearningStudioDB.user_id == user_id, UserLearningStudioDB.subject == subject)
        .first()
    )
    resource_events = _load_resource_events(studio_row, limit=60)
    if not rows and not resource_events:
        return

    event_stats = _resource_event_stats(resource_events)
    event_counts: Dict[str, int] = event_stats.get("counts") or {}
    resource_total = sum(int(event_counts.get(key, 0) or 0) for key in RESOURCE_TYPES.keys())
    practice_signal_count = sum(
        int(event_counts.get(key, 0) or 0)
        for key in ("practice_result", "small_quiz_result", "chapter_quiz_result")
    )
    avg_mastery = sum(float(r.mastery or 0) for r in rows) / max(len(rows), 1) if rows else 0.5
    passed = sum(1 for r in rows if r.small_quiz_passed)
    quiz_pending = sum(1 for r in rows if r.phase == "quiz_pending")
    active = sum(1 for r in rows if int(r.learn_turns or 0) > 0 or float(r.mastery or 0) > 0)
    passed_ratio = passed / max(len(rows), 1)
    turn_avg = sum(int(r.learn_turns or 0) for r in rows) / max(active, 1)
    weak_section_count = 0
    weak_item_count = 0
    for r in rows:
        try:
            weak_items = json.loads(r.weak_points_json or "[]")
        except Exception:
            weak_items = []
        if isinstance(weak_items, list) and weak_items:
            weak_section_count += 1
            weak_item_count += len([x for x in weak_items if isinstance(x, dict)])
    weak_rate = min(1.0, weak_section_count / max(len(rows), 1))
    weak_load = min(1.0, weak_item_count / max(len(rows) * 3, 1))

    def blend_dimension(key: str, score: float, note: str, weight: float = 0.68) -> None:
        current = portrait["dimensions"].get(key) or {"score": 0.5, "note": ""}
        base = max(0.0, min(1.0, float(current.get("score") or 0.5)))
        merged_score = (base * (1.0 - weight)) + (max(0.0, min(1.0, score)) * weight)
        portrait["dimensions"][key] = {
            "score": max(0.0, min(1.0, merged_score)),
            "note": note[:120],
        }

    blend_dimension(
        "知识基础",
        max(0.0, avg_mastery - weak_load * 0.12),
        f"随小节掌握度和薄弱点同步；已记录 {weak_item_count} 个待巩固点。",
    )
    blend_dimension(
        "学习目标对齐度",
        max(avg_mastery, passed_ratio),
        f"已通过 {passed} 个小节测验，{quiz_pending} 个小节待测。",
        weight=0.58,
    )
    if weak_item_count:
        blend_dimension(
            "易错点偏好",
            min(1.0, 0.42 + weak_rate * 0.34 + weak_load * 0.18),
            f"薄弱点集中在 {weak_section_count} 个小节，后续题目会优先覆盖。",
            weight=0.62,
        )
    pace_score = min(1.0, 0.42 + passed_ratio * 0.45 + min(turn_avg, SECTION_FORCE_QUIZ_TURNS) / SECTION_FORCE_QUIZ_TURNS * 0.13)
    blend_dimension("学习节奏", pace_score, f"平均带学 {turn_avg:.1f} 轮；通过测验后节奏评分会继续上升。", weight=0.52)

    if resource_events:
        focus_terms = event_stats.get("focus_terms") or []
        focus_note = f"；最近聚焦：{'、'.join(focus_terms[:3])}" if focus_terms else ""
        blend_dimension(
            "认知风格",
            min(1.0, 0.44 + min(resource_total, 8) * 0.045 + min(practice_signal_count, 5) * 0.055),
            f"已使用 {resource_total} 份学习素材、{practice_signal_count} 次练习反馈{focus_note}。",
            weight=0.42,
        )
        transfer_score = min(
            1.0,
            0.42
            + min(int(event_counts.get("extended_reading", 0) or 0), 3) * 0.11
            + min(int(event_counts.get("code_lab", 0) or 0), 3) * 0.08
            + min(int(event_counts.get("video_script", 0) or 0), 2) * 0.06,
        )
        blend_dimension(
            "兴趣与拓展倾向",
            transfer_score,
            f"拓展阅读 {event_counts.get('extended_reading', 0)} 次，代码实操 {event_counts.get('code_lab', 0)} 次，表达脚本 {event_counts.get('video_script', 0)} 次。",
            weight=0.44,
        )
        if practice_signal_count:
            blend_dimension(
                "学习节奏",
                min(1.0, pace_score + min(practice_signal_count, 5) * 0.035),
                f"学习、练习和素材反馈已形成闭环；累计 {practice_signal_count} 次评测反馈。",
                weight=0.36,
            )


def _studio_llm_portrait(
    db: Session, user_id: int, subject: str, session_id: Optional[int]
) -> Dict[str, Any]:
    msgs = _studio_collect_recent_messages(db, user_id, subject, session_id)
    if not msgs:
        p = default_portrait()
        p["summary"] = "暂无近期对话，已展示默认六维画像。"
        _heuristic_merge_mastery_into_portrait(db, user_id, subject, p)
        return p
    dim_list = "、".join(PORTRAIT_DIMENSION_KEYS)
    sys_p = (
        "你是学习画像智能体。根据下列对话摘录，输出**仅一个 JSON**（不要用 markdown 代码围栏）。\n"
        f"必须包含键 dimensions（对象）与 summary（字符串）。dimensions 中**恰好**包含这六个键：{dim_list}。\n"
        '每个维度值为 {"score":0到1的小数,"note":"30字内中文"}。\n'
        "证据不足时 score 取 0.45~0.55 并在 note 说明不确定性；不得编造具体成绩或隐私。"
    )
    user_blob = "\n".join(f"{m['role']}: {m['content']}" for m in msgs[-28:])
    try:
        raw = _learn_chat_complete(
            [{"role": "system", "content": sys_p}, {"role": "user", "content": user_blob}],
            temperature=0.2,
        )
        data = _parse_json_object_from_llm(raw)
        merged = default_portrait()
        dims = data.get("dimensions") or {}
        if isinstance(dims, dict):
            for k in PORTRAIT_DIMENSION_KEYS:
                cell = dims.get(k)
                if isinstance(cell, dict):
                    merged["dimensions"][k] = {
                        "score": max(0.0, min(1.0, float(cell.get("score") or 0.5))),
                        "note": str(cell.get("note") or "")[:120],
                    }
        merged["summary"] = str(data.get("summary") or "")[:600] or merged["summary"]
        merged["version"] = 2
        _heuristic_merge_mastery_into_portrait(db, user_id, subject, merged)
        return merged
    except Exception:
        p = default_portrait()
        p["summary"] = "画像模型暂不可用，已回退默认并结合掌握度启发式。"
        _heuristic_merge_mastery_into_portrait(db, user_id, subject, p)
        return p


def _load_resource_events(row: Optional[UserLearningStudioDB], limit: int = 24) -> list[Dict[str, Any]]:
    if not row or not row.resource_events_json:
        return []
    try:
        data = json.loads(row.resource_events_json or "[]")
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)][: max(0, limit)]


def _load_resource_artifacts(row: Optional[UserLearningStudioDB], limit: int = 80) -> list[Dict[str, Any]]:
    if not row or not getattr(row, "resource_artifacts_json", None):
        return []
    try:
        data = json.loads(row.resource_artifacts_json or "[]")
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)][: max(0, limit)]


def _save_resource_artifact(
    db: Session,
    *,
    user_id: int,
    subject: str,
    chapter_id: str,
    section_id: str,
    resource_type: str,
    scope_label: str,
    content: str,
    source_count: int = 0,
) -> None:
    text_content = str(content or "").strip()
    if not text_content:
        return
    row = _get_or_create_studio_row(db, user_id, subject)
    artifacts = _load_resource_artifacts(row, limit=80)
    now = datetime.utcnow().isoformat()
    payload = {
        "resource_type": resource_type,
        "chapter_id": chapter_id,
        "section_id": section_id,
        "scope_label": scope_label,
        "content": text_content[:28000],
        "summary": text_content[:320],
        "source_count": int(source_count or 0),
        "updated_at": now,
    }

    filtered: list[Dict[str, Any]] = []
    replaced = False
    for item in artifacts:
        same_slot = (
            item.get("chapter_id") == chapter_id
            and item.get("section_id") == section_id
            and item.get("resource_type") == resource_type
        )
        if same_slot and not replaced:
            filtered.append(payload)
            replaced = True
        elif not same_slot:
            filtered.append(item)
    if not replaced:
        filtered.insert(0, payload)
    row.resource_artifacts_json = json.dumps(filtered[:60], ensure_ascii=False)[:240000]
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.commit()


def _resource_event_stats(events: list[Dict[str, Any]]) -> Dict[str, Any]:
    counts: Dict[str, int] = defaultdict(int)
    generated_types: set[str] = set()
    source_count = 0
    latest_result_score: Optional[float] = None
    latest_practice_score: Optional[float] = None
    focus_terms: list[str] = []

    for event in events:
        resource_type = str(event.get("resource_type") or "").strip()
        if not resource_type:
            continue
        counts[resource_type] += 1
        if resource_type in RESOURCE_TYPES:
            generated_types.add(resource_type)
        try:
            source_count += int(event.get("source_count") or 0)
        except Exception:
            pass

        summary = str(event.get("summary") or "")
        match = re.search(r"score=([0-9]+(?:\.[0-9]+)?)", summary)
        if match:
            try:
                score = float(match.group(1))
                latest_result_score = score
                if resource_type == "practice_result":
                    latest_practice_score = score
            except Exception:
                pass

        for key in ("focus_nodes", "focus_terms"):
            values = event.get(key)
            if isinstance(values, list):
                for value in values:
                    text_value = str(value or "").strip()
                    if 2 <= len(text_value) <= 48 and text_value not in focus_terms:
                        focus_terms.append(text_value)
                        if len(focus_terms) >= 8:
                            break
            if len(focus_terms) >= 8:
                break

    return {
        "counts": dict(counts),
        "generated_types": generated_types,
        "source_count": source_count,
        "latest_result_score": latest_result_score,
        "latest_practice_score": latest_practice_score,
        "focus_terms": focus_terms[:8],
    }


def _is_technical_subject(subject: str) -> bool:
    s = str(subject or "").lower()
    return bool(
        s in ("cs", "nlp", "dl", "os")
        or "计算" in subject
        or "代码" in subject
        or "程序" in subject
        or "机器学习" in subject
        or "自然语言" in subject
        or "操作系统" in subject
    )


def _choose_resource_recommendation(
    *,
    subject: str,
    weak_points: list[Dict[str, Any]],
    score: Optional[float],
    phase: str = "",
    mastery: float = 0.0,
    events: list[Dict[str, Any]],
) -> Dict[str, str]:
    stats = _resource_event_stats(events)
    generated = stats["generated_types"]
    counts = stats["counts"]
    latest_practice_score = stats.get("latest_practice_score")
    failed_recent_practice = latest_practice_score is not None and latest_practice_score < QUIZ_PASSING_SCORE
    failed_section_quiz = score is not None and score < QUIZ_PASSING_SCORE

    def pack(resource_type: str, reason: str) -> Dict[str, str]:
        return {"type": resource_type, "reason": reason}

    if weak_points:
        if "course_digest" not in generated or failed_recent_practice:
            return pack("course_digest", "先把薄弱点背后的概念边界重新讲清。")
        if not counts.get("practice_pack") or not counts.get("practice_result"):
            return pack("practice_pack", "围绕已暴露的薄弱点做一次针对检测。")
        if "extended_reading" not in generated:
            return pack("extended_reading", "换一个来源解释同一个卡点。")
        return pack("practice_pack", "继续用变式题确认薄弱点是否真正补上。")

    if phase == "quiz_pending":
        return pack("practice_pack", "当前已经适合进入检测。")
    if failed_section_quiz:
        if "course_digest" not in generated:
            return pack("course_digest", "测验未达标，先回看精讲再练。")
        return pack("practice_pack", "用针对练习复测未达标部分。")
    if "course_digest" not in generated:
        return pack("course_digest", "先生成一页精讲，建立本节主线。")
    if _is_technical_subject(subject) and "code_lab" not in generated and mastery >= 0.35:
        return pack("code_lab", "把概念落到可运行的小实验里。")
    if "extended_reading" not in generated and mastery >= 0.42:
        return pack("extended_reading", "补一个可信来源，扩大理解角度。")
    if not counts.get("practice_result"):
        return pack("practice_pack", "用练习确认是否可以前进。")
    if "video_script" not in generated and mastery >= 0.55:
        return pack("video_script", "把本节讲给别人听，检验表达是否完整。")
    return pack("practice_pack", "继续用小练习保持手感。")


def _extract_resource_focus_terms(markdown: str, fallback_label: str = "", limit: int = 8) -> list[str]:
    text = str(markdown or "")
    candidates: list[str] = []
    if fallback_label:
        candidates.append(fallback_label)
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("```") or line.lower() in {"mermaid", "mindmap"}:
            continue
        quoted = re.search(r'\["([^"]{2,48})"\]', line)
        if quoted:
            candidates.append(quoted.group(1))
            continue
        node = re.search(r"\(\(([^()]{2,48})\)\)", line)
        if node:
            candidates.append(node.group(1))
            continue
        cleaned = re.sub(r"^[\s#*\-+>0-9.]+", "", line)
        if re.match(r"^[a-zA-Z][\w-]{0,24}\s*(?:[\[{(])", cleaned):
            cleaned = re.sub(r"^[a-zA-Z0-9_-]+\s*", "", cleaned)
        cleaned = re.sub(r"[\[\]{}()]+", "", cleaned).strip()
        if 2 <= len(cleaned) <= 32 and not cleaned.lower().startswith(("flowchart", "graph ")):
            candidates.append(cleaned)
    out: list[str] = []
    for item in candidates:
        value = re.sub(r"\s+", " ", str(item or "")).strip()
        if value and value not in out:
            out.append(value)
        if len(out) >= limit:
            break
    return out


def _append_resource_event(db: Session, user_id: int, subject: str, event: Dict[str, Any]) -> None:
    row = _get_or_create_studio_row(db, user_id, subject)
    events = _load_resource_events(row, limit=60)
    payload = dict(event or {})
    payload["created_at"] = datetime.utcnow().isoformat()
    row.resource_events_json = json.dumps([payload] + events, ensure_ascii=False)[:48000]
    row.updated_at = datetime.utcnow()
    try:
        course = resolve_course(db, subject)
        if course:
            row.learning_path_json = json.dumps(
                _studio_build_learning_path(db, user_id, subject, course),
                ensure_ascii=False,
            )[:48000]
    except Exception as exc:
        print(f"[STUDIO_PATH] snapshot sync failed: {exc}", flush=True)
    db.add(row)
    db.commit()


def _load_weak_points(prog: Optional[SectionLearningProgressDB], limit: int = 6) -> list[Dict[str, Any]]:
    if not prog or not prog.weak_points_json:
        return []
    try:
        data = json.loads(prog.weak_points_json)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)][: max(0, limit)]


def _section_effectively_passed(prog: Optional[SectionLearningProgressDB]) -> bool:
    return bool(prog and prog.small_quiz_passed and not _load_weak_points(prog, limit=1))


def _merge_weak_points(
    prog: SectionLearningProgressDB,
    new_points: list[Dict[str, Any]],
    *,
    limit: int = 24,
) -> list[Dict[str, Any]]:
    now = datetime.utcnow().isoformat()
    merged: list[Dict[str, Any]] = []
    seen: set[str] = set()
    for raw in new_points + _load_weak_points(prog, limit=limit):
        if not isinstance(raw, dict):
            continue
        question = str(raw.get("question") or raw.get("evidence") or "").strip()
        reason = str(raw.get("reason") or raw.get("suggestion") or "").strip()
        section = str(raw.get("section") or raw.get("concept") or "").strip()
        selected_answer = str(raw.get("selected_answer") or "").strip()
        correct_answer = str(raw.get("correct_answer") or "").strip()
        if not question and not reason and not section:
            continue
        key = f"{section}|{question[:120]}|{reason[:120]}"
        if key in seen:
            continue
        seen.add(key)
        merged.append(
            {
                "index": raw.get("index"),
                "section": section,
                "type": str(raw.get("type") or "practice"),
                "question": question,
                "reason": reason,
                "selected_answer": selected_answer,
                "correct_answer": correct_answer,
                "seen_at": raw.get("seen_at") or now,
            }
        )
        if len(merged) >= limit:
            break
    return merged


def _normalize_weak_points_payload(
    raw_points: Any,
    scope_label: str,
    *,
    source_type: str,
    limit: int = 6,
) -> list[Dict[str, Any]]:
    if not isinstance(raw_points, list):
        return []
    normalized: list[Dict[str, Any]] = []
    for index, raw in enumerate(raw_points[:limit]):
        if not isinstance(raw, dict):
            continue
        section = sanitize_user_plaintext(
            str(raw.get("section") or raw.get("concept") or scope_label or "当前小节"),
            max_len=160,
        )
        question = sanitize_user_plaintext(
            str(raw.get("question") or raw.get("evidence") or raw.get("checkpoint") or raw.get("issue") or ""),
            max_len=520,
        )
        reason = sanitize_user_plaintext(
            str(raw.get("reason") or raw.get("suggestion") or raw.get("next_action") or ""),
            max_len=820,
        )
        if not question and not reason:
            continue
        normalized.append(
            {
                "index": raw.get("index") or index + 1,
                "section": section,
                "type": source_type,
                "question": question or section,
                "reason": reason or "这一轮表现说明这里还需要再确认一次。",
            }
        )
    return normalized


def _section_adaptive_context(prog: Optional[SectionLearningProgressDB]) -> str:
    if not prog:
        return "new_section: start from core concepts, then verify with a short task."
    parts: list[str] = []
    weak_points = _load_weak_points(prog, limit=4)
    if weak_points:
        focus = " / ".join(str(x.get("section") or x.get("question") or "weak point")[:80] for x in weak_points)
        parts.append(f"known_weak_points: {focus}")
        details: list[str] = []
        for idx, item in enumerate(weak_points[:3], start=1):
            title = str(item.get("section") or item.get("question") or "weak point").strip()
            question = str(item.get("question") or "").strip()
            reason = str(item.get("reason") or "").strip()
            selected = str(item.get("selected_answer") or "").strip()
            correct = str(item.get("correct_answer") or "").strip()
            detail_parts = [f"{idx}. {title[:80]}"]
            if question and question != title:
                detail_parts.append(f"question={question[:140]}")
            if selected:
                detail_parts.append(f"learner_answer={selected[:120]}")
            if correct:
                detail_parts.append(f"correct_answer={correct[:120]}")
            if reason:
                detail_parts.append(f"reason={reason[:180]}")
            details.append("; ".join(detail_parts))
        if details:
            parts.append("weak_point_details:\n" + "\n".join(details))
    if prog.small_quiz_score is not None and not prog.small_quiz_passed:
        parts.append("recent_quiz_failed: repair concept boundaries before moving on.")
    if prog.phase == "quiz_pending" or prog.pending_quiz_json:
        parts.append("quiz_pending: the next task should connect learning to assessment.")
    if int(prog.learn_turns or 0) > 0:
        parts.append("dialogue_seen: connect the next explanation to recent answers.")
    if float(prog.mastery or 0) < 0.45:
        parts.append("low_mastery: begin with foundation checks.")
    return "\n".join(parts) or "steady_progress: continue with concept contrast, example, and recall."


def _course_section_steps(course: CourseDB) -> list[Dict[str, Any]]:
    steps: list[Dict[str, Any]] = []
    for ch in sorted(course.chapters, key=lambda x: natural_sort_key(x.id)):
        for sec in sections_natural_order(parse_subsections_json(ch.subsections)):
            sid = str(sec.get("id") or "")
            if not sid:
                continue
            steps.append(
                {
                    "key": f"{ch.id}|{sid}",
                    "chapter_id": ch.id,
                    "chapter_title": ch.title,
                    "section_id": sid,
                    "section_title": str(sec.get("title") or sid),
                }
            )
    return steps


def _studio_build_learning_path(db: Session, user_id: int, subject: str, course: CourseDB) -> Dict[str, Any]:
    studio_row = _get_or_create_studio_row(db, user_id, subject)
    resource_events = _load_resource_events(studio_row, limit=40)
    events_by_key: Dict[str, list[Dict[str, Any]]] = defaultdict(list)
    for event in resource_events:
        key = f"{event.get('chapter_id') or ''}|{event.get('section_id') or ''}"
        events_by_key[key].append(event)

    steps: list[Dict[str, Any]] = []
    for ch in sorted(course.chapters, key=lambda x: natural_sort_key(x.id)):
        secs = sections_natural_order(parse_subsections_json(ch.subsections))
        for sec in secs:
            sid = str(sec.get("id") or "")
            if not sid:
                continue
            pr = (
                db.query(SectionLearningProgressDB)
                .filter(
                    SectionLearningProgressDB.user_id == user_id,
                    SectionLearningProgressDB.subject == subject,
                    SectionLearningProgressDB.chapter_id == ch.id,
                    SectionLearningProgressDB.section_id == sid,
                )
                .first()
            )
            key = f"{ch.id}|{sid}"
            weak_points = _load_weak_points(pr, limit=3) if pr else []
            done = _section_effectively_passed(pr)
            events = events_by_key.get(key, [])
            event_stats = _resource_event_stats(events)
            mastery = float(pr.mastery or 0) if pr else 0.0
            score = float(pr.small_quiz_score) if pr and pr.small_quiz_score is not None else None
            priority = 0.0 if done else max(0.0, 0.82 - mastery)
            evidence: list[str] = []
            if weak_points:
                priority += 0.86
                evidence.append("存在需要回看的薄弱点")
            if pr and pr.phase == "quiz_pending":
                priority += 0.2
                evidence.append("小节测验待完成")
            if score is not None and score < QUIZ_PASSING_SCORE:
                priority += 0.28
                evidence.append("最近测验未达标")
            latest_practice_score = event_stats.get("latest_practice_score")
            if latest_practice_score is not None and latest_practice_score < QUIZ_PASSING_SCORE:
                priority += 0.22
                evidence.append("资源练习反馈未达标")
            if events:
                priority -= min(0.16, len(events) * 0.04)
                generated_types = sorted(event_stats.get("generated_types") or [])
                evidence.append(f"已有 {len(events)} 条学习反馈" + (f"：{', '.join(generated_types[:3])}" if generated_types else ""))
            if pr and int(pr.learn_turns or 0) > 0:
                evidence.append(f"已对话 {int(pr.learn_turns or 0)} 轮")
            recommendation = _choose_resource_recommendation(
                subject=subject,
                weak_points=weak_points,
                score=score,
                phase=pr.phase if pr else "",
                mastery=mastery,
                events=events,
            )
            steps.append(
                {
                    "chapter_id": ch.id,
                    "chapter_title": ch.title,
                    "section_id": sid,
                    "section_title": sec.get("title"),
                    "status": "done" if done else "pending",
                    "priority": round(max(0.0, priority), 3),
                    "weak_points": weak_points,
                    "resource_count": len(events),
                    "recommended_resource": recommendation["type"],
                    "recommended_reason": recommendation["reason"],
                    "resource_types": sorted(event_stats.get("generated_types") or []),
                    "evidence": evidence[:4],
                }
            )
    focus_idx = None
    pending = [(i, s) for i, s in enumerate(steps) if s["status"] == "pending"]
    if pending:
        focus_idx = max(pending, key=lambda item: float(item[1].get("priority") or 0))[0]
    return {
        "steps": steps,
        "focus_index": focus_idx,
        "hint": "按顺序完成「待学」小节；每节前可在资源工坊生成预习材料，再进行 AI 带学。",
    }


def _learning_control_state(
    db: Session,
    user_id: int,
    subject: str,
    course: CourseDB,
    current_chapter_id: Optional[str] = None,
    current_section_id: Optional[str] = None,
) -> Dict[str, Any]:
    steps = _course_section_steps(course)
    rows = (
        db.query(SectionLearningProgressDB)
        .filter(SectionLearningProgressDB.user_id == user_id, SectionLearningProgressDB.subject == subject)
        .all()
    )
    progress_by_key = {f"{r.chapter_id}|{r.section_id}": r for r in rows}
    studio_row = (
        db.query(UserLearningStudioDB)
        .filter(UserLearningStudioDB.user_id == user_id, UserLearningStudioDB.subject == subject)
        .first()
    )
    resource_events = _load_resource_events(studio_row, limit=40)
    resource_by_key: Dict[str, list[Dict[str, Any]]] = defaultdict(list)
    for event in resource_events:
        key = f"{event.get('chapter_id') or ''}|{event.get('section_id') or ''}"
        resource_by_key[key].append(event)

    current_key = f"{current_chapter_id}|{current_section_id}" if current_chapter_id and current_section_id else ""
    current_index = next((i for i, s in enumerate(steps) if s["key"] == current_key), None)
    if current_index is None:
        current_index = next(
            (i for i, s in enumerate(steps) if not _section_effectively_passed(progress_by_key.get(s["key"]))),
            0 if steps else None,
        )
    current = steps[current_index] if current_index is not None and steps else None
    current_progress = progress_by_key.get(current["key"]) if current else None
    current_weak_points = _load_weak_points(current_progress, limit=3) if current_progress else []
    next_step = None
    if current_index is not None:
        for step in steps[current_index + 1 :]:
            pr = progress_by_key.get(step["key"])
            if not _section_effectively_passed(pr):
                next_step = step
                break

    if not current:
        action, headline, cue = "idle", "先选择一门课", "我会把下一步拆成可以执行的小动作。"
    elif current_progress and current_weak_points:
        first_weak = current_weak_points[0]
        weak_label = first_weak.get("section") or first_weak.get("question") or "刚才卡住的点"
        action, headline, cue = "repair_weak", "先补一个薄弱点", f"优先回看：{str(weak_label)[:80]}，再用针对练习确认。"
    elif current_progress and current_progress.small_quiz_passed:
        action = "next_section" if next_step else "chapter_review"
        headline = "这一节已经通过"
        cue = f"下一步看：{next_step['section_title']}" if next_step else "可以进入本章回看，或换一章继续。"
    elif current_progress and current_progress.phase == "quiz_pending" and current_progress.pending_quiz_json:
        action, headline, cue = "take_quiz", "现在适合做小测", "先完成小节练习，结果会反向更新画像、弱点和后续资源。"
    elif current_progress and (
        current_progress.phase == "quiz_ready"
        or float(current_progress.mastery or 0) >= SECTION_QUIZ_MASTERY_THRESHOLD
        or int(current_progress.learn_turns or 0) >= SECTION_FORCE_QUIZ_TURNS
    ):
        action, headline, cue = "prepare_quiz", "可以做小测", "用小节测验确认掌握度；结果会决定继续前进还是回补弱点。"
    elif current_progress and int(current_progress.learn_turns or 0) > 0:
        action, headline, cue = "continue_dialogue", "继续把概念讲透", "我会根据刚才的回答判断是否进入检测。"
    else:
        action, headline, cue = "start_guided", "从这一节开始", "先让 AI 带学抓主线，再用练习确认是否真正理解。"

    weak_focus: list[Dict[str, Any]] = []
    for step in steps:
        pr = progress_by_key.get(step["key"])
        weak_points = _load_weak_points(pr, limit=3) if pr else []
        if _section_effectively_passed(pr):
            continue
        mastery = float(pr.mastery or 0) if pr else 0.0
        score = float(pr.small_quiz_score) if pr and pr.small_quiz_score is not None else None
        resource_count = len(resource_by_key.get(step["key"], []))
        priority = max(0.0, 0.72 - mastery)
        reason = "还没有开始"
        if weak_points:
            priority += 0.86 + min(0.18, len(weak_points) * 0.06)
            reason = "有薄弱点"
        if pr and pr.phase == "quiz_pending":
            priority += 0.24
            reason = "等待小测"
        if score is not None and score < QUIZ_PASSING_SCORE:
            priority += 0.36
            reason = "测验未达标"
        if resource_count:
            priority -= min(0.16, resource_count * 0.04)
        recommendation = _choose_resource_recommendation(
            subject=subject,
            weak_points=weak_points,
            score=score,
            phase=pr.phase if pr else "",
            mastery=mastery,
            events=resource_by_key.get(step["key"], []),
        )
        weak_focus.append(
            {
                "key": step["key"],
                "chapter_id": step["chapter_id"],
                "section_id": step["section_id"],
                "title": step["section_title"],
                "reason": reason,
                "weak_points": weak_points,
                "resource_count": resource_count,
                "priority": round(priority, 3),
                "recommended_resource": recommendation["type"],
                "recommended_reason": recommendation["reason"],
            }
        )
    weak_focus = sorted(weak_focus, key=lambda x: x["priority"], reverse=True)[:4]

    current_events = resource_by_key.get(current["key"], []) if current else []
    current_score = float(current_progress.small_quiz_score) if current_progress and current_progress.small_quiz_score is not None else None
    current_recommendation = _choose_resource_recommendation(
        subject=subject,
        weak_points=current_weak_points,
        score=current_score,
        phase=current_progress.phase if current_progress else "",
        mastery=float(current_progress.mastery or 0) if current_progress else 0.0,
        events=current_events,
    )
    label_map = {
        "course_digest": "回看精讲" if action == "repair_weak" else "先看精讲",
        "practice_pack": "针对练习",
        "extended_reading": "换源解释" if action == "repair_weak" else "补充阅读",
        "code_lab": "代码实操",
        "video_script": "讲给别人听",
    }
    fallback_reasons = {
        "course_digest": "把概念边界重新压清楚",
        "practice_pack": "用练习确认是否真的理解",
        "extended_reading": "换一个可信来源补理解",
        "code_lab": "把概念变成可运行例子",
        "video_script": "用表达反推理解是否完整",
    }
    ordered_types = [
        current_recommendation["type"],
        "course_digest",
        "practice_pack",
        "extended_reading",
        "code_lab",
        "video_script",
    ]
    if not _is_technical_subject(subject):
        ordered_types = [x for x in ordered_types if x != "code_lab"]
    resource_actions = []
    seen_action_types: set[str] = set()
    for resource_type in ordered_types:
        if not resource_type or resource_type in seen_action_types or resource_type not in RESOURCE_TYPES:
            continue
        seen_action_types.add(resource_type)
        resource_actions.append(
            {
                "type": resource_type,
                "label": label_map.get(resource_type, RESOURCE_TYPES[resource_type]["title"]),
                "reason": current_recommendation["reason"] if resource_type == current_recommendation["type"] else fallback_reasons.get(resource_type, "补一个匹配当前状态的资源"),
            }
        )
        if len(resource_actions) >= 4:
            break

    primary_resource = resource_actions[0] if resource_actions else None
    current_learning_goal = {
        "action": action,
        "headline": headline,
        "cue": cue,
        "chapter_id": current.get("chapter_id") if current else None,
        "section_id": current.get("section_id") if current else None,
        "title": current.get("section_title") if current else None,
        "next_key": next_step.get("key") if next_step else None,
        "weak_target": weak_focus[0] if weak_focus else None,
        "recommended_resource": primary_resource.get("type") if primary_resource else None,
        "recommended_reason": primary_resource.get("reason") if primary_resource else None,
    }

    return {
        "current": current,
        "next": next_step,
        "action": action,
        "headline": headline,
        "cue": cue,
        "current_learning_goal": current_learning_goal,
        "weak_focus": weak_focus,
        "resource_actions": resource_actions[:4],
        "resource_evidence": resource_by_key.get(current["key"], [])[:6] if current else [],
        "adaptive_context": _section_adaptive_context(current_progress),
        "updated_at": datetime.utcnow().isoformat(),
    }


@app.get("/learning/studio/overview")
def learning_studio_overview():
    return {
        "agents": AGENT_MANIFEST,
        "resource_types": {k: {"title": v["title"], "agent_chain": v["agent_chain"]} for k, v in RESOURCE_TYPES.items()},
        "safety": {
            "policy": "mentor-v1",
            "layers": ["输入敏感/注入过滤", "提示词防幻觉与课程边界", "参考资料强约束", "可选输出复核"],
        },
    }


@app.get("/learning/studio/portrait")
def learning_studio_portrait_get(
    username: str = Query(..., min_length=1),
    subject: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
):
    u = db.query(UserDB).filter(UserDB.username == username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    row = _get_or_create_studio_row(db, u.id, subject)
    try:
        data = json.loads(row.portrait_json or "{}")
    except json.JSONDecodeError:
        data = default_portrait()
    if not isinstance(data, dict):
        data = default_portrait()
    _heuristic_merge_mastery_into_portrait(db, u.id, subject, data)
    return {
        "portrait": data,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "synced_at": datetime.utcnow().isoformat(),
        "progress_synced": True,
    }


@app.post("/learning/studio/portrait/refresh")
def learning_studio_portrait_refresh(body: StudioPortraitRefreshBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    portrait = _studio_llm_portrait(db, u.id, body.subject, body.session_id)
    row = _get_or_create_studio_row(db, u.id, body.subject)
    row.portrait_json = json.dumps(portrait, ensure_ascii=False)[:48000]
    row.updated_at = datetime.utcnow()
    db.commit()
    return {"portrait": portrait}


@app.get("/learning/studio/path")
def learning_studio_path_get(
    username: str = Query(..., min_length=1),
    subject: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
):
    u = db.query(UserDB).filter(UserDB.username == username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    path = _studio_build_learning_path(db, u.id, subject, course)
    return {"path": path}


@app.post("/learning/studio/path/rebuild")
def learning_studio_path_rebuild(body: StudioPortraitRefreshBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    path = _studio_build_learning_path(db, u.id, body.subject, course)
    row = _get_or_create_studio_row(db, u.id, body.subject)
    row.learning_path_json = json.dumps(path, ensure_ascii=False)[:48000]
    row.updated_at = datetime.utcnow()
    db.commit()
    return {"path": path}


def _safe_search_json(url: str, headers: Optional[Dict[str, str]] = None) -> Any:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=8) as resp:
        raw = resp.read(800000)
    return json.loads(raw.decode("utf-8", errors="ignore"))


def _resource_search_sources(query: str, limit: int = 4) -> List[Dict[str, str]]:
    q = sanitize_user_plaintext(query, max_len=180).strip()
    if not q:
        return []
    results: list[Dict[str, str]] = []
    seen: set[str] = set()

    def push(title: str, url: str, snippet: str = "") -> None:
        if not url or url in seen or not url.startswith(("http://", "https://")):
            return
        seen.add(url)
        results.append({"title": title or url, "url": url, "snippet": snippet or ""})

    brave_key = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
    if brave_key:
        try:
            url = "https://api.search.brave.com/res/v1/web/search?" + urlencode({"q": q, "count": limit})
            data = _safe_search_json(
                url,
                headers={
                    "Accept": "application/json",
                    "X-Subscription-Token": brave_key,
                    "User-Agent": "mentor-learning-resource/1.0",
                },
            )
            for item in (((data or {}).get("web") or {}).get("results") or []):
                push(item.get("title") or "", item.get("url") or "", item.get("description") or "")
                if len(results) >= limit:
                    return results
        except Exception as exc:
            print(f"[RESOURCE_SEARCH] Brave search failed: {exc}", flush=True)

    try:
        url = "https://zh.wikipedia.org/w/api.php?" + urlencode(
            {"action": "opensearch", "search": q, "limit": min(max(limit, 1), 5), "namespace": 0, "format": "json"}
        )
        data = _safe_search_json(url, headers={"User-Agent": "mentor-learning-resource/1.0"})
        titles = data[1] if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list) else []
        descs = data[2] if isinstance(data, list) and len(data) > 2 and isinstance(data[2], list) else []
        urls = data[3] if isinstance(data, list) and len(data) > 3 and isinstance(data[3], list) else []
        for i, href in enumerate(urls):
            push(titles[i] if i < len(titles) else href, href, descs[i] if i < len(descs) else "")
            if len(results) >= limit:
                break
    except Exception as exc:
        print(f"[RESOURCE_SEARCH] Wikipedia fallback failed: {exc}", flush=True)
    return results[:limit]


def _resource_quality_contract(resource_type: str) -> str:
    common = (
        "\n\n【输出质量要求】\n"
        "- 只输出最终内容，不写寒暄。\n"
        "- 首次出现术语时，用一句人话解释。\n"
        "- 不要把单个字母、变量、公式符号拆成独立一行。\n"
        "- 如果 Learning control 里有 known_weak_points，必须优先围绕薄弱点设计内容。\n"
    )
    contracts = {
        "course_digest": "【格式】# 本节先抓住什么\n## 一句话主线\n## 概念边界\n## 方法怎么用\n## 例题拆解\n## 容易卡住的地方\n## 现在该做什么",
        "extended_reading": "【格式】# 拓展阅读\n## 信息来源\n## 可以继续看的方向\n## 来源怎么用。信息来源只允许使用【联网检索结果】里的 URL；没有来源必须明确说明。",
        "code_lab": "【格式】# 代码实操\n## 任务目标\n## 最小环境\n## 输入输出\n## 实现思路\n## 完整代码\n## 运行方式\n## 常见错误。必须包含 fenced code block。",
        "video_script": "【格式】# 微课脚本\n## 开场\n## 分镜脚本\n至少 5 个 `### 镜头 N：短标题`，每个镜头含画面/板书要点、口播稿、时长建议。\n## 收束复盘",
        "mind_map": "【格式】优先输出一个 fenced mermaid 代码块，只允许一个根节点。",
    }
    return common + "\n" + contracts.get(resource_type, "")


def _resource_context_brief(
    *,
    subject: str,
    scope_label: str,
    hint: str,
    adaptive_context: str,
    source_count: int = 0,
) -> str:
    lines = [f"course={subject}", f"scope={scope_label}", f"source_count={source_count}"]
    if adaptive_context.strip():
        lines.append("adaptive_context:")
        lines.append(adaptive_context.strip())
    if hint.strip():
        lines.append("user_extra_hint:")
        lines.append(hint.strip()[:1200])
    return "\n".join(lines)


def _weak_points_from_resource_hint(hint: str, scope_label: str, limit: int = 3) -> list[Dict[str, Any]]:
    points: list[Dict[str, Any]] = []
    for raw_line in str(hint or "").splitlines():
        line = raw_line.strip()
        if not line.lower().startswith(("wrong_answer_focus:", "weak_focus:")):
            continue
        body = line.split(":", 1)[1].strip()
        for part in re.split(r"\s*/\s*", body):
            item = part.strip(" -;；")
            if not item:
                continue
            section, question = scope_label, item
            if ":" in item:
                maybe_section, maybe_question = item.split(":", 1)
                if maybe_section.strip():
                    section = maybe_section.strip()
                if maybe_question.strip():
                    question = maybe_question.strip()
            points.append(
                {
                    "index": len(points) + 1,
                    "section": sanitize_user_plaintext(section, max_len=160),
                    "type": "resource_hint",
                    "question": sanitize_user_plaintext(question, max_len=520),
                    "reason": "当前规划或答题回看把这里标记为优先薄弱点。",
                }
            )
            if len(points) >= limit:
                return points
    return points


@app.post("/learning/studio/resources/stream")
def learning_studio_resource_stream(body: StudioResourceStreamBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    uid = u.id
    if body.resource_type not in RESOURCE_TYPES:
        raise HTTPException(status_code=400, detail=f"未知资源类型，可选：{', '.join(RESOURCE_TYPES.keys())}")
    assert_user_content_safe(body.extra_hint)
    hint = sanitize_user_plaintext(body.extra_hint, max_len=2000)
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="章节不存在")
    sec = find_section(ch_row.subsections, body.section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="小节不存在")
    scope_label, ref = _build_learning_reference(ch_row, body.section_id)
    spec = RESOURCE_TYPES[body.resource_type]
    prog = (
        db.query(SectionLearningProgressDB)
        .filter(
            SectionLearningProgressDB.user_id == u.id,
            SectionLearningProgressDB.subject == body.subject,
            SectionLearningProgressDB.chapter_id == body.chapter_id,
            SectionLearningProgressDB.section_id == body.section_id,
        )
        .first()
    )
    adaptive_context = _section_adaptive_context(prog)
    hinted_weak_points = _weak_points_from_resource_hint(hint, scope_label)

    if body.resource_type == "practice_pack":
        weak_points = _load_weak_points(prog, limit=6) if prog else []
        if not weak_points:
            weak_points = hinted_weak_points
        focus_hint = "\n\n".join(part for part in (prog.section_summary if prog else "", hint, adaptive_context) if part)
        paper = build_instant_paper(body.subject, scope_label, ref or "", focus_hint, weak_points=weak_points)
        _append_resource_event(
            db,
            uid,
            body.subject,
            {
                "resource_type": body.resource_type,
                "chapter_id": body.chapter_id,
                "section_id": body.section_id,
                "scope_label": scope_label,
                "focus": focus_hint,
                "focus_terms": [
                    str(x.get("section") or x.get("question") or "").strip()
                    for x in weak_points[:8]
                    if isinstance(x, dict) and str(x.get("section") or x.get("question") or "").strip()
                ],
                "summary": f"practice_pack questions={len(paper) if isinstance(paper, list) else 0} weak_points={len(weak_points)}",
            },
        )
        _save_resource_artifact(
            db,
            user_id=uid,
            subject=body.subject,
            chapter_id=body.chapter_id,
            section_id=body.section_id,
            resource_type=body.resource_type,
            scope_label=scope_label,
            content=json.dumps(paper, ensure_ascii=False),
            source_count=0,
        )
        headers = safety_headers(spec["agent_chain"])
        headers["X-Resource-Type"] = body.resource_type
        return StreamingResponse(iter([json.dumps(paper, ensure_ascii=False)]), media_type="application/json", headers=stream_response_headers(headers))

    search_block = ""
    source_count = 0
    if body.resource_type == "extended_reading":
        search_sources = _resource_search_sources(f"{course.name} {scope_label}")
        source_count = len(search_sources)
        if search_sources:
            search_block = "\n\n【联网检索结果】\n" + "\n".join(
                f"- [{item['title']}]({item['url']}) —— {item.get('snippet') or '与当前小节相关的可核验来源'}"
                for item in search_sources
            )
        else:
            search_block = "\n\n【联网检索结果】\n（空）本次未取得可核验联网来源；不得编造 URL、DOI 或来源。"

    resource_context = _resource_context_brief(
        subject=body.subject,
        scope_label=scope_label,
        hint=hint,
        adaptive_context=adaptive_context,
        source_count=source_count,
    )
    sys_m = (
        spec["instruction"]
        + _resource_quality_contract(body.resource_type)
        + f"\n\n【当前范围】{scope_label}\n【资料】\n"
        + (ref or "")[:11000]
        + f"\n\n[Learning control]\n{adaptive_context}\n"
        + f"\n\n[Resource context]\n{resource_context}\n"
        + search_block
        + ANTI_HALLUCINATION_SYSTEM_SUFFIX
    )
    user_lines = [
        f"课程：{body.subject}；大章/小节：{scope_label}。",
        "请严格只输出本任务要求的格式，不输出与任务无关的寒暄。",
        "表达要少术语、重点清楚、有画面感；必须出现术语时，立刻用一句人话解释。",
        "排版要规整：标题短、段落短、列表不超过 5 条；不要把单个字母或公式符号单独拆成一行。",
    ]
    if hint:
        user_lines.append(f"额外要求：\n{hint}")
    messages: List[Any] = [{"role": "system", "content": sys_m}, {"role": "user", "content": "\n".join(user_lines)}]
    try:
        response = _get_llm_client().chat.completions.create(
            model=os.getenv("MODEL_NAME", "gpt-4o-mini"),
            messages=cast(List[ChatCompletionMessageParam], messages),
            stream=True,
            temperature=0.35,
        )

        def generate_chunks():
            raw_answer, clean_answer = "", ""
            try:
                for chunk in response:
                    if chunk.choices and chunk.choices[0].delta.content:
                        delta = chunk.choices[0].delta.content
                        raw_answer += delta
                        new_clean = collapse_repetition(raw_answer)
                        emit = safe_stream_delta(clean_answer, new_clean)
                        if emit:
                            yield emit
                        clean_answer = new_clean
                final_text = clean_answer or collapse_repetition(raw_answer)
                if final_text.strip():
                    try:
                        with SessionLocal() as event_db:
                            _append_resource_event(
                                event_db,
                                uid,
                                body.subject,
                                {
                                    "resource_type": body.resource_type,
                                    "chapter_id": body.chapter_id,
                                    "section_id": body.section_id,
                                    "scope_label": scope_label,
                                    "focus": resource_context,
                                    "focus_terms": _extract_resource_focus_terms(final_text, scope_label),
                                    "summary": final_text.strip()[:900],
                                    "source_count": source_count,
                                },
                            )
                            _save_resource_artifact(
                                event_db,
                                user_id=uid,
                                subject=body.subject,
                                chapter_id=body.chapter_id,
                                section_id=body.section_id,
                                resource_type=body.resource_type,
                                scope_label=scope_label,
                                content=final_text,
                                source_count=source_count,
                            )
                    except Exception as event_exc:
                        print(f"[RESOURCE_EVENT] save failed: {event_exc}", flush=True)
            finally:
                close_stream = getattr(response, "close", None)
                if callable(close_stream):
                    try:
                        close_stream()
                    except Exception:
                        pass

        hdr = safety_headers(spec["agent_chain"])
        hdr["X-Resource-Type"] = body.resource_type
        return StreamingResponse(generate_chunks(), media_type="text/plain", headers=stream_response_headers(hdr))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"资源生成失败: {exc}") from exc


@app.get("/learning/studio/resources")
def learning_studio_resources_get(
    username: str = Query(..., min_length=USERNAME_MIN_LENGTH, max_length=USERNAME_MAX_LENGTH, pattern=USERNAME_PATTERN),
    subject: str = Query(..., min_length=1, max_length=64),
    chapter_id: str = Query(..., min_length=1, max_length=64),
    section_id: str = Query(..., min_length=1, max_length=64),
    db: Session = Depends(get_db),
):
    u = db.query(UserDB).filter(UserDB.username == username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="章节不存在")
    sec = find_section(ch_row.subsections, section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="小节不存在")
    row = (
        db.query(UserLearningStudioDB)
        .filter(UserLearningStudioDB.user_id == u.id, UserLearningStudioDB.subject == subject)
        .first()
    )
    artifacts = _load_resource_artifacts(row, limit=80)
    by_type: Dict[str, Dict[str, Any]] = {}
    for item in artifacts:
        if item.get("chapter_id") != chapter_id or item.get("section_id") != section_id:
            continue
        resource_type = str(item.get("resource_type") or "").strip()
        if resource_type not in RESOURCE_TYPES or resource_type in by_type:
            continue
        by_type[resource_type] = {
            "resource_type": resource_type,
            "title": RESOURCE_TYPES[resource_type].get("title") or resource_type,
            "scope_label": item.get("scope_label") or scope_display(ch_row.title, sec.get("title")),
            "content": item.get("content") or "",
            "summary": item.get("summary") or "",
            "source_count": item.get("source_count") or 0,
            "updated_at": item.get("updated_at") or "",
        }
    return {
        "subject": subject,
        "chapter_id": chapter_id,
        "section_id": section_id,
        "scope_label": scope_display(ch_row.title, sec.get("title")),
        "resources": by_type,
    }


@app.post("/learning/studio/practice-result")
def learning_studio_practice_result(body: StudioPracticeResultBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="章节不存在")
    sec = find_section(ch_row.subsections, body.section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="小节不存在")
    scope_label = scope_display(ch_row.title, sec.get("title"))
    prog = _get_or_create_section_progress(db, u.id, body.subject, body.chapter_id, body.section_id)

    weak_points: list[Dict[str, Any]] = []
    for i, raw in enumerate(body.weak_points[:8]):
        if not isinstance(raw, dict):
            continue
        question = sanitize_user_plaintext(str(raw.get("question") or ""), max_len=500)
        reason = sanitize_user_plaintext(str(raw.get("reason") or ""), max_len=800)
        if not question and not reason:
            continue
        selected_answer = sanitize_user_plaintext(str(raw.get("selected_answer") or ""), max_len=500)
        correct_answer = sanitize_user_plaintext(str(raw.get("correct_answer") or ""), max_len=500)
        weak_points.append(
            {
                "index": raw.get("index") or i + 1,
                "section": sanitize_user_plaintext(str(raw.get("section") or scope_label), max_len=160),
                "type": sanitize_user_plaintext(str(raw.get("type") or "practice"), max_len=40),
                "question": question,
                "reason": reason,
                "selected_answer": selected_answer,
                "correct_answer": correct_answer,
            }
        )

    score_ratio = max(0.0, min(1.0, float(body.score or 0) / 100.0))
    if weak_points:
        prog.weak_points_json = json.dumps(_merge_weak_points(prog, weak_points), ensure_ascii=False)[:12000]
        prog.pending_quiz_json = None
        if prog.phase == "quiz_pending":
            prog.phase = "questioning"
        existing_summary = (prog.section_summary or "").strip()
        practice_note = "\n".join(
            f"- Q{x['index']} {x['section']}: {x['question']} -> {x['reason']}"
            + (f" | 你的答案: {x['selected_answer']}" if x.get("selected_answer") else "")
            + (f" | 正确答案: {x['correct_answer']}" if x.get("correct_answer") else "")
            for x in weak_points
        )
        prog.section_summary = (existing_summary + "\n\n[resource_practice]\n" + practice_note).strip()[-8000:]
        prog.mastery = max(float(prog.mastery or 0), min(0.74, score_ratio))
    else:
        if float(body.score or 0) >= QUIZ_PASSING_SCORE:
            if float(body.score or 0) >= 85:
                prog.weak_points_json = None
            if not prog.small_quiz_passed:
                prog.phase = "quiz_ready"
        prog.mastery = max(float(prog.mastery or 0), min(0.82, score_ratio))
    prog.updated_at = datetime.utcnow()
    _append_resource_event(
        db,
        u.id,
        body.subject,
        {
            "resource_type": "practice_result",
            "chapter_id": body.chapter_id,
            "section_id": body.section_id,
            "scope_label": scope_label,
            "focus": "\n".join(x.get("question") or x.get("reason") or "" for x in weak_points[:5]),
            "summary": f"practice_result score={round(float(body.score or 0), 1)} weak_points={len(weak_points)}",
        },
    )
    db.commit()
    return {
        "weak_points": weak_points,
        "control": _learning_control_state(db, u.id, body.subject, course, body.chapter_id, body.section_id),
    }


@app.get("/courses")
def list_courses(request: Request, db: Session = Depends(get_db)):
    # BrowserRouter uses /courses as a page URL while the API uses the same
    # path behind /api. A document navigation asks for HTML; API fetches do not.
    if "text/html" in request.headers.get("accept", "").lower():
        sd = static_site_dir()
        if sd is not None:
            index = sd / "index.html"
            if index.is_file():
                return FileResponse(index, headers={"Cache-Control": "no-cache"})

    courses = sorted(db.query(CourseDB).all(), key=lambda x: natural_sort_key(x.id))
    result = []
    for course in courses:
        chapters = sorted(course.chapters, key=lambda x: natural_sort_key(x.id))
        first_chapter = chapters[0] if chapters else None
        first_sections = sections_natural_order(parse_subsections_json(first_chapter.subsections)) if first_chapter else []
        section_count = sum(len(parse_subsections_json(ch.subsections)) for ch in chapters)
        try:
            goals = json.loads(course.learning_goals or "[]")
        except json.JSONDecodeError:
            goals = []
        result.append(
            {
                "id": course.id,
                "name": course.name,
                "source": course.source,
                "description": course.description,
                "learning_goals": goals if isinstance(goals, list) else [],
                "chapter_count": len(chapters),
                "section_count": section_count,
                "first_chapter_title": first_chapter.title if first_chapter else "",
                "first_section_title": first_sections[0]["title"] if first_sections else "",
            }
        )
    return {"courses": result, "courseware_dir": str(deep_learning_courseware_dir())}


@app.get("/learning-catalog")
def learning_catalog(subject: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    """前端章节目录：大章 + 小节 id/title（不含正文，避免响应过大）。"""
    course = resolve_course(db, subject, auto_seed=True)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在，请先访问 /seed 导入数据")
    chapters = []
    for ch in sorted(course.chapters, key=lambda x: natural_sort_key(x.id)):
        secs = sections_natural_order(parse_subsections_json(ch.subsections))
        chapters.append(
            {
                "id": ch.id,
                "title": ch.title,
                "desc": ch.desc,
                "sections": [{"id": s["id"], "title": s["title"]} for s in secs],
            }
        )
    return {
        "subject": course.name,
        "course_id": course.id,
        "courseware_dir": str(deep_learning_courseware_dir()),
        "chapters": chapters,
    }

@app.get("/sessions/{username}/{subject}")
async def get_sessions(username: str, subject: str, db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == username).first()
    if not db_user:
        raise HTTPException(
            status_code=404,
            detail="用户不存在：请在本网站重新注册并登录。公网实例数据库若未挂载持久盘，服务重启后账号会丢失，需重新注册。",
        )
    sessions = db.query(ChatSessionDB).filter(
        ChatSessionDB.user_id == db_user.id,
        ChatSessionDB.subject == subject
    ).order_by(ChatSessionDB.updated_at.desc()).all()
    result = []
    for s in sessions:
        last = db.query(ChatHistoryDB).filter(
            ChatHistoryDB.session_id == s.id
        ).order_by(ChatHistoryDB.id.desc()).first()
        result.append(session_to_dict(s, last.content if last else ""))
    return result

@app.get("/history/{session_id}")
async def get_history(session_id: int, db: Session = Depends(get_db)):
    history = db.query(ChatHistoryDB).filter(
        ChatHistoryDB.session_id == session_id
    ).order_by(ChatHistoryDB.id.asc()).all()
    return [{"role": h.role, "content": h.content} for h in history]


@app.delete("/chat-sessions/{session_id}")
def delete_chat_session(
    session_id: int,
    username: str = Query(
        ...,
        min_length=USERNAME_MIN_LENGTH,
        max_length=USERNAME_MAX_LENGTH,
        pattern=USERNAME_PATTERN,
    ),
    db: Session = Depends(get_db),
):
    """删除指定会话及其全部聊天记录（须为会话所属用户）。"""
    u = db.query(UserDB).filter(UserDB.username == username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    sess = (
        db.query(ChatSessionDB)
        .filter(ChatSessionDB.id == session_id, ChatSessionDB.user_id == u.id)
        .first()
    )
    if not sess:
        raise HTTPException(status_code=404, detail="会话不存在或无权删除")
    db.delete(sess)
    db.commit()
    return {"message": "已删除", "session_id": session_id}


@app.post("/learning/start-section")
def learning_start_section(body: LearningStartBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="大章不存在")
    sec = find_section(ch_row.subsections, body.section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="小节不存在")
    scope_label, ref = _build_learning_reference(ch_row, body.section_id)
    prog = _get_or_create_section_progress(db, u.id, body.subject, body.chapter_id, body.section_id)
    if body.reset_progress:
        prog.mastery = 0.0
        prog.learn_turns = 0
        prog.pending_quiz_json = None
        prog.section_summary = None
        prog.small_quiz_score = None
        prog.small_quiz_passed = False
        cprog = (
            db.query(ChapterLearningProgressDB)
            .filter(
                ChapterLearningProgressDB.user_id == u.id,
                ChapterLearningProgressDB.subject == body.subject,
                ChapterLearningProgressDB.chapter_id == body.chapter_id,
            )
            .first()
        )
        if cprog:
            cprog.chapter_quiz_score = None
            cprog.chapter_quiz_passed = False
            cprog.pending_quiz_json = None
            cprog.updated_at = datetime.utcnow()
            db.add(cprog)
    prog.phase = "questioning"
    prog.updated_at = datetime.utcnow()

    sk = f"{body.chapter_id}|{body.section_id}"
    session_title_prefix = "[带学]" if body.reset_progress else "[巩固]"
    sess = ChatSessionDB(
        user_id=u.id,
        subject=body.subject,
        chapter=sk[:512],
        title=f"{session_title_prefix}{(sec.get('title') or '小节')[:100]}",
        session_kind="learn",
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)
    session_id = sess.id
    uid = u.id
    subject = body.subject
    chapter_id = body.chapter_id
    section_id = body.section_id

    sys_prompt = _learn_opening_system(body.subject, scope_label, ref)
    opening_note = body.opening_note.strip()
    opening_user_content = (
        "学员刚完成本小节测验但未达标。请根据下面的错题摘要继续进行针对性补救讲解，"
        "先指出薄弱点，再用本小节资料重讲关键概念，最后给 1-2 个巩固练习。\n\n"
        f"{opening_note}"
        if not body.reset_progress and opening_note
        else "请开始本小节的带学讲解（Markdown）。"
    )
    messages: List[dict[str, str]] = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": opening_user_content},
    ]

    def generate_chunks():
        try:
            response = _get_llm_client().chat.completions.create(
                model=os.getenv("MODEL_NAME", "gpt-4o-mini"),
                messages=cast(List[ChatCompletionMessageParam], messages),
                stream=True,
                temperature=0.42,
            )
        except Exception as exc:
            yield f"【AI 不可用：{exc}】"
            return

        raw_answer, clean_answer = "", ""
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                delta = chunk.choices[0].delta.content
                raw_answer += delta
                new_clean = strip_intro_before_answer_heading(
                    collapse_repetition(raw_answer),
                    wait_for_heading=True,
                )
                emit = safe_stream_delta(clean_answer, new_clean)
                if emit:
                    yield emit
                clean_answer = new_clean

        if not clean_answer:
            clean_answer = strip_intro_before_answer_heading(
                collapse_repetition(raw_answer),
                wait_for_heading=False,
            )
        assistant_plain = _strip_learn_meta_trailer(clean_answer).strip()
        if not assistant_plain:
            assistant_plain = "（本节讲解暂时为空，请稍后重试。）"
        meta_out: Dict[str, Any] = {
            "mastery_total": 0.0,
            "learn_turns": 0,
            "quiz_pending": False,
            "small_quiz": None,
            "control": None,
            "weak_points": [],
        }
        with SessionLocal() as save_db:
            save_db.add(ChatHistoryDB(session_id=session_id, role="assistant", content=assistant_plain))
            s_row = save_db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
            if s_row:
                s_row.updated_at = datetime.utcnow()
            prog2 = _get_or_create_section_progress(save_db, uid, subject, chapter_id, section_id)
            prog2.phase = "questioning"
            prog2.updated_at = datetime.utcnow()
            save_db.commit()
            local_course = resolve_course(save_db, subject)
            if local_course:
                meta_out = {
                    "mastery_total": float(prog2.mastery or 0),
                    "learn_turns": int(prog2.learn_turns or 0),
                    "quiz_pending": False,
                    "small_quiz": None,
                    "control": _learning_control_state(save_db, uid, subject, local_course, chapter_id, section_id),
                    "weak_points": _load_weak_points(prog2, limit=5),
                }
        yield LEARN_META_BEGIN + json.dumps(meta_out, ensure_ascii=False) + LEARN_META_END

    return StreamingResponse(
        generate_chunks(),
        media_type="text/plain",
        headers=stream_response_headers({"X-Session-Id": str(session_id)}),
    )


@app.post("/learning/answer-turn")
def learning_answer_turn(body: LearningAnswerBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    sess = (
        db.query(ChatSessionDB)
        .filter(ChatSessionDB.id == body.session_id, ChatSessionDB.user_id == u.id)
        .first()
    )
    if not sess:
        raise HTTPException(status_code=404, detail="会话不存在")
    if (getattr(sess, "session_kind", None) or "chat") != "learn":
        raise HTTPException(status_code=400, detail="不是 AI 带学会话")
    expected_scope_key = f"{body.chapter_id}|{body.section_id}"
    if (sess.chapter or "").strip() != expected_scope_key:
        raise HTTPException(status_code=409, detail="当前带学会话不属于所选小节，请重新开始本小节带学")

    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    scope_label, ref = _build_learning_reference(ch_row, body.section_id)

    imgs = normalize_ask_image_payload(body.images)
    answer_plain = (body.answer or "").strip()
    assert_user_content_safe(answer_plain)
    if not answer_plain and not imgs:
        raise HTTPException(status_code=400, detail="请填写文字或上传至少一张图片")
    try:
        user_stored = encode_user_message_for_db(
            answer_plain or ("请结合附图作答与点评。" if imgs else ""),
            imgs,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    db.add(ChatHistoryDB(session_id=sess.id, role="user", content=user_stored))
    sess.updated_at = datetime.utcnow()
    db.commit()

    hist = (
        db.query(ChatHistoryDB)
        .filter(ChatHistoryDB.session_id == sess.id)
        .order_by(ChatHistoryDB.id.asc())
        .limit(48)
        .all()
    )

    sys_prompt = _learn_teaching_system(body.subject, scope_label, ref)
    if _hist_has_user_images(hist):
        sys_prompt += (
            "\n\n对话中可能含学员上传的**图片**：请结合图片与【资料】进行点评、纠错与引导；"
            "若图片与当前小节无关或不清晰，请如实说明。"
        )
    api_messages: List[Any] = [{"role": "system", "content": sys_prompt}]
    for h in hist[-28:]:
        api_messages.append(history_content_to_chat_message(h.role, h.content))

    session_id = sess.id
    uid = u.id
    subject = body.subject
    chapter_id = body.chapter_id
    section_id = body.section_id
    answer_text = answer_plain or ("（学员本轮上传了附图，无额外文字说明。）" if imgs else answer_plain)

    def generate_chunks():
        try:
            response = _get_llm_client().chat.completions.create(
                model=os.getenv("MODEL_NAME", "gpt-4o-mini"),
                messages=cast(List[ChatCompletionMessageParam], api_messages),
                stream=True,
                temperature=0.38,
            )
        except Exception as exc:
            yield f"【导师响应暂时不可用：{exc}】"
            return

        raw_answer, clean_answer = "", ""
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                delta = chunk.choices[0].delta.content
                raw_answer += delta
                new_clean = strip_intro_before_answer_heading(
                    collapse_repetition(raw_answer),
                    wait_for_heading=True,
                )
                emit = safe_stream_delta(clean_answer, new_clean)
                if emit:
                    yield emit
                clean_answer = new_clean

        if not clean_answer:
            clean_answer = strip_intro_before_answer_heading(
                collapse_repetition(raw_answer),
                wait_for_heading=False,
            )
        teaching_md = _strip_learn_meta_trailer(clean_answer).strip()
        if not teaching_md:
            teaching_md = "已收到你的回答。我们结合资料再梳理一下要点。"

        quiz_ready = False
        quiz_payload: list[Any] | None = None
        meta_out: Dict[str, Any] = {
            "mastery_total": 0.0,
            "learn_turns": 0,
            "quiz_pending": False,
            "small_quiz": None,
            "control": None,
            "weak_points": [],
        }
        assistant_stored = teaching_md

        try:
            with SessionLocal() as work_db:
                u2 = work_db.query(UserDB).filter(UserDB.id == uid).first()
                if not u2:
                    raise RuntimeError("user missing")
                prog = _get_or_create_section_progress(
                    work_db, u2.id, subject, chapter_id, section_id
                )
                learn_turns_after = int(prog.learn_turns or 0) + 1

                try:
                    data = _learn_extract_meta_json(
                        teaching_md, answer_text, scope_label, learn_turns_after
                    )
                except Exception:
                    data = {
                        "evaluation": "",
                        "mastery_total": 0.0,
                        "section_complete": False,
                        "section_summary": "",
                        "small_quiz": None,
                        "weak_points": [],
                    }

                mastery_new = float(data.get("mastery_total") or 0)
                mastery_new = max(0.0, min(1.0, mastery_new))
                want_complete = bool(data.get("section_complete"))
                small_quiz = data.get("small_quiz")
                summary = str(data.get("section_summary") or "").strip()
                dialogue_weak_points = _normalize_weak_points_payload(
                    data.get("weak_points"),
                    scope_label,
                    source_type="dialogue",
                    limit=3,
                )
                weak_note = "\n".join(
                    f"- {x['section']}: {x['question']} -> {x['reason']}"
                    for x in dialogue_weak_points
                )

                prog.learn_turns = learn_turns_after
                prog.mastery = max(float(prog.mastery or 0), mastery_new)
                prog.updated_at = datetime.utcnow()
                if dialogue_weak_points:
                    prog.weak_points_json = json.dumps(
                        _merge_weak_points(prog, dialogue_weak_points),
                        ensure_ascii=False,
                    )[:12000]
                    prog.pending_quiz_json = None
                    if prog.phase == "quiz_pending":
                        prog.phase = "questioning"

                if mastery_new >= SECTION_QUIZ_MASTERY_THRESHOLD or learn_turns_after >= SECTION_FORCE_QUIZ_TURNS:
                    want_complete = True

                assistant_msg = teaching_md

                quiz_questions: list[Dict[str, Any]] | None = None
                if want_complete and isinstance(small_quiz, list):
                    try:
                        quiz_questions = _normalize_small_quiz_questions(small_quiz)
                    except Exception:
                        quiz_questions = None
                if want_complete and quiz_questions is None:
                    try:
                        quiz_questions = _generate_small_quiz_for_section(
                            subject,
                            scope_label,
                            ref,
                            summary,
                            weak_points=_load_weak_points(prog, limit=6),
                        )
                    except Exception:
                        quiz_questions = None

                if want_complete and quiz_questions:
                    prog.phase = "quiz_pending"
                    summary_parts = [summary[:7000]] if summary else []
                    if weak_note:
                        summary_parts.append("[dialogue_weak_points]\n" + weak_note)
                    prog.section_summary = "\n\n".join(summary_parts).strip()[-8000:] or None
                    prog.pending_quiz_json = json.dumps(quiz_questions, ensure_ascii=False)[:SMALL_QUIZ_JSON_MAX_CHARS]
                    quiz_ready = True
                    if prog.section_summary:
                        assistant_msg += f"\n\n**学习小结**\n{prog.section_summary}"
                    assistant_msg += "\n\n本节对话已完成。请完成 **小节测验**（在测验窗口中作答）。"
                elif want_complete:
                    prog.phase = "questioning"
                    if weak_note:
                        existing_summary = (prog.section_summary or "").strip()
                        prog.section_summary = (existing_summary + "\n\n[dialogue_weak_points]\n" + weak_note).strip()[-8000:]
                    assistant_msg += (
                        "\n\n（测验未生成完整，我们再巩固一问。）\n请用一句话概括本节最核心的定义。"
                    )
                else:
                    prog.phase = "questioning"
                    if weak_note:
                        existing_summary = (prog.section_summary or "").strip()
                        prog.section_summary = (existing_summary + "\n\n[dialogue_weak_points]\n" + weak_note).strip()[-8000:]

                work_db.add(
                    ChatHistoryDB(session_id=session_id, role="assistant", content=assistant_msg)
                )
                s_row = work_db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
                if s_row:
                    s_row.updated_at = datetime.utcnow()
                work_db.commit()

                if prog.pending_quiz_json:
                    try:
                        quiz_payload = public_quiz_questions(
                            _normalize_small_quiz_questions(json.loads(prog.pending_quiz_json))
                        )
                    except Exception:
                        quiz_payload = None

                meta_out = {
                    "mastery_total": float(prog.mastery or 0),
                    "learn_turns": int(prog.learn_turns or 0),
                    "quiz_pending": quiz_ready,
                    "small_quiz": quiz_payload,
                    "control": _learning_control_state(work_db, u2.id, subject, course, chapter_id, section_id),
                    "weak_points": _load_weak_points(prog, limit=5),
                }
                assistant_stored = assistant_msg
        except Exception:
            with SessionLocal() as work_db:
                prog = _get_or_create_section_progress(
                    work_db, uid, subject, chapter_id, section_id
                )
                prog.learn_turns = int(prog.learn_turns or 0) + 1
                prog.phase = "questioning"
                prog.updated_at = datetime.utcnow()
                fallback = teaching_md + "\n\n（进度保存时出现异常，请继续学习或重试。）"
                work_db.add(
                    ChatHistoryDB(session_id=session_id, role="assistant", content=fallback)
                )
                s_row = work_db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
                if s_row:
                    s_row.updated_at = datetime.utcnow()
                work_db.commit()
                meta_out = {
                    "mastery_total": float(prog.mastery or 0),
                    "learn_turns": int(prog.learn_turns or 0),
                    "quiz_pending": False,
                    "small_quiz": None,
                    "control": _learning_control_state(work_db, uid, subject, course, chapter_id, section_id),
                    "weak_points": _load_weak_points(prog, limit=5),
                }
                assistant_stored = fallback

        if assistant_stored.startswith(teaching_md):
            extra_stream = assistant_stored[len(teaching_md) :]
            if extra_stream:
                yield extra_stream

        yield LEARN_META_BEGIN + json.dumps(meta_out, ensure_ascii=False) + LEARN_META_END

    return StreamingResponse(
        generate_chunks(),
        media_type="text/plain",
        headers=stream_response_headers({"X-Session-Id": str(session_id)}),
    )


@app.get("/learning/progress")
def learning_progress(
    username: str = Query(..., min_length=1),
    subject: str = Query(..., min_length=1),
    chapter_id: Optional[str] = Query(None, min_length=1, max_length=64),
    section_id: Optional[str] = Query(None, min_length=1, max_length=64),
    db: Session = Depends(get_db),
):
    u = db.query(UserDB).filter(UserDB.username == username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")

    rows = (
        db.query(SectionLearningProgressDB)
        .filter(SectionLearningProgressDB.user_id == u.id, SectionLearningProgressDB.subject == subject)
        .all()
    )
    section_map: Dict[str, Any] = {}
    for r in rows:
        k = f"{r.chapter_id}|{r.section_id}"
        weak_points = _load_weak_points(r, limit=5)
        effectively_passed = bool(r.small_quiz_passed and not weak_points)
        section_map[k] = {
            "mastery": r.mastery,
            "learn_turns": r.learn_turns,
            "phase": r.phase,
            "quiz_pending": r.phase == "quiz_pending" and bool(r.pending_quiz_json),
            "ready_for_quiz": bool(r.pending_quiz_json)
            or float(r.mastery or 0) >= SECTION_QUIZ_MASTERY_THRESHOLD
            or int(r.learn_turns or 0) >= SECTION_FORCE_QUIZ_TURNS,
            "small_quiz_passed": r.small_quiz_passed,
            "effectively_passed": effectively_passed,
            "needs_review": bool(weak_points),
            "small_quiz_score": r.small_quiz_score,
            "weak_points": weak_points,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }

    chapter_progress_rows = (
        db.query(ChapterLearningProgressDB)
        .filter(
            ChapterLearningProgressDB.user_id == u.id,
            ChapterLearningProgressDB.subject == subject,
        )
        .all()
    )
    chapter_progress_map = {row.chapter_id: row for row in chapter_progress_rows}

    chapters_out: Dict[str, Any] = {}
    for ch in sorted(course.chapters, key=lambda x: natural_sort_key(x.id)):
        secs = sections_natural_order(parse_subsections_json(ch.subsections))
        total = len(secs)
        passed = 0
        for sec in secs:
            sid = str(sec.get("id") or "")
            if not sid:
                continue
            st = section_map.get(f"{ch.id}|{sid}")
            if st and st.get("effectively_passed"):
                passed += 1
        cq = chapter_progress_map.get(ch.id)
        chapters_out[ch.id] = {
            "sections_total": total,
            "sections_quiz_passed": passed,
            "chapter_quiz_ready": total > 0 and passed >= total,
            "chapter_quiz_passed": bool(cq.chapter_quiz_passed) if cq else False,
            "chapter_quiz_score": cq.chapter_quiz_score if cq else None,
            "updated_at": cq.updated_at.isoformat() if cq and cq.updated_at else None,
        }
    return {
        "subject": subject,
        "sections": section_map,
        "chapters": chapters_out,
        "control": _learning_control_state(db, u.id, subject, course, chapter_id, section_id),
        "section_completion_rule": {
            "mastery_threshold": SECTION_QUIZ_MASTERY_THRESHOLD,
            "force_quiz_turns": SECTION_FORCE_QUIZ_TURNS,
        },
    }


@app.post("/learning/quiz/small/prepare")
def learning_small_quiz_prepare(body: SmallQuizPrepareBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="大章不存在")
    sec = find_section(ch_row.subsections, body.section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="小节不存在")

    prog = _get_or_create_section_progress(db, u.id, body.subject, body.chapter_id, body.section_id)
    if _section_effectively_passed(prog):
        return {"questions": [], "already_passed": True}
    if prog.pending_quiz_json and prog.phase == "quiz_pending":
        try:
            questions = _normalize_small_quiz_questions(json.loads(prog.pending_quiz_json))
            if quiz_has_internal_scaffolding(questions):
                raise ValueError("stale quiz contains internal scaffolding")
            weak_points = _load_weak_points(prog, limit=6)
            if weak_points and not any(q.get("weak_point_index") for q in questions):
                raise ValueError("stale quiz does not include current weak points")
            return {"questions": public_quiz_questions(questions), "cached": True, "already_passed": False}
        except Exception:
            prog.pending_quiz_json = None

    scope_label, ref = _build_learning_reference(ch_row, body.section_id)
    try:
        questions = _generate_small_quiz_for_section(
            body.subject,
            scope_label,
            ref,
            prog.section_summary or "",
            weak_points=_load_weak_points(prog, limit=6),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"小节测验生成失败: {exc}") from exc

    prog.phase = "quiz_pending"
    prog.pending_quiz_json = json.dumps(questions, ensure_ascii=False)[:SMALL_QUIZ_JSON_MAX_CHARS]
    if not prog.section_summary:
        prog.section_summary = f"直接进入小节测验：{scope_label}"
    prog.updated_at = datetime.utcnow()
    db.commit()
    return {"questions": public_quiz_questions(_normalize_small_quiz_questions(questions)), "already_passed": False, "cached": False}


@app.post("/learning/quiz/small/submit")
def learning_small_quiz_submit(body: SmallQuizSubmitBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="章节不存在")
    sec = find_section(ch_row.subsections, body.section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="小节不存在")

    prog = _get_or_create_section_progress(db, u.id, body.subject, body.chapter_id, body.section_id)
    if not prog.pending_quiz_json or prog.phase != "quiz_pending":
        raise HTTPException(status_code=400, detail="当前没有待提交的小节测验")
    try:
        qs = json.loads(prog.pending_quiz_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="测验数据损坏")
    if not isinstance(qs, list) or len(qs) < SMALL_QUIZ_QUESTION_COUNT:
        raise HTTPException(status_code=500, detail="测验题目不完整")

    quiz_questions = _normalize_small_quiz_questions(qs)
    correct = 0
    earned_points = 0.0
    total_points = 0.0
    results: list[Dict[str, Any]] = []
    for i, qi in enumerate(quiz_questions):
        answer = body.answers[i] if i < len(body.answers) else None
        awarded_points, ok = score_quiz_answer(qi, answer)
        points = float(qi.get("points") or 1)
        earned_points += awarded_points
        total_points += points
        if ok:
            correct += 1
        results.append(
            {
                "index": i,
                "id": qi.get("id") or f"q{i + 1:02d}",
                "section": qi.get("section") or "综合练习",
                "type": qi.get("type") or "single",
                "target_concept": qi.get("target_concept") or "",
                "points": points,
                "awarded_points": awarded_points,
                "question": str(qi.get("question") or ""),
                "options": [str(x) for x in (qi.get("options") or [])],
                "selected_answer": quiz_answer_summary(qi, answer),
                "correct_answer": quiz_answer_summary(qi, None, correct=True),
                "is_correct": ok,
                "explanation": str(qi.get("explanation") or "请回到本小节资料，重新核对该知识点。"),
            }
        )

    total = len(quiz_questions)
    incorrect = total - correct
    score = (earned_points / max(total_points, 1.0)) * 100.0
    passed = score >= QUIZ_PASSING_SCORE
    prog.small_quiz_score = score
    prog.small_quiz_passed = passed
    prog.mastery = max(float(prog.mastery or 0), score / 100.0)
    weak_items = [x for x in results if not x.get("is_correct")][:5]
    weak_points = [
        {
            "index": int(x.get("index", 0)) + 1,
            "section": x.get("target_concept") or x.get("section") or "综合练习",
            "type": x.get("type") or "single",
            "question": x.get("question") or "",
            "reason": x.get("explanation") or "",
        }
        for x in weak_items
    ]

    if passed:
        prog.pending_quiz_json = None
        prog.phase = "done"
        prog.weak_points_json = None
    else:
        prog.phase = "quiz_pending"
        if weak_points:
            prog.weak_points_json = json.dumps(_merge_weak_points(prog, weak_points), ensure_ascii=False)[:12000]
            focus_note = "\n".join(
                f"- Q{x['index']} {x['section']}: {x['question']} -> {x['reason']}"
                for x in weak_points
            )
            existing_summary = (prog.section_summary or "").strip()
            prog.section_summary = (existing_summary + "\n\n[weak_points]\n" + focus_note).strip()[-8000:]
    prog.updated_at = datetime.utcnow()
    db.commit()
    try:
        scope_label = scope_display(ch_row.title, sec.get("title"))
        _append_resource_event(
            db,
            u.id,
            body.subject,
            {
                "resource_type": "small_quiz_result",
                "chapter_id": body.chapter_id,
                "section_id": body.section_id,
                "scope_label": scope_label,
                "focus": "\n".join(x.get("question") or x.get("reason") or "" for x in weak_points[:5]),
                "summary": f"small_quiz score={round(float(score or 0), 1)} weak_points={len(weak_points)} passed={passed}",
            },
        )
    except Exception as event_exc:
        print(f"[SMALL_QUIZ_EVENT] save failed: {event_exc}", flush=True)

    _append_quiz_history_snapshot(
        db,
        user_id=u.id,
        subject=body.subject,
        session_id=body.session_id,
        quiz_title="小节测验结果",
        scope_label=scope_display(ch_row.title, sec.get("title")),
        score=score,
        correct=correct,
        total=total,
        passed=passed,
        weak_points=weak_points,
    )

    remedial_prompt = (
        f"我刚完成「{body.chapter_id} / {body.section_id}」小节测验，得分 {round(score)} 分，未达标。"
        "请根据这些错题继续带我学习，先补核心概念，再给我练习：\n"
        + "\n".join(
            f"{x['index'] + 1}. {x['question']}；正确答案：{x['correct_answer']}；解析：{x['explanation']}"
            for x in weak_items
        )
    )
    return {
        "score": score,
        "passed": passed,
        "correct": correct,
        "incorrect": incorrect,
        "total": total,
        "earned_points": earned_points,
        "total_points": total_points,
        "passing_score": QUIZ_PASSING_SCORE,
        "items": results,
        "weak_points": weak_points,
        "control": _learning_control_state(db, u.id, body.subject, course, body.chapter_id, body.section_id),
        "remedial_prompt": "" if passed else remedial_prompt[:4000],
    }


def _chapter_quiz_context(
    db: Session,
    user_id: int,
    subject: str,
    ch_row: ChapterDB,
) -> tuple[list[Dict[str, Any]], str, str, list[Dict[str, Any]]]:
    sections = sections_natural_order(parse_subsections_json(ch_row.subsections))
    material_parts: list[str] = []
    summary_parts: list[str] = []
    weak_points: list[Dict[str, Any]] = []
    for sec in sections:
        sid = str(sec.get("id") or "")
        title = str(sec.get("title") or sid)
        if not sid:
            continue
        scope_label, ref = _build_learning_reference(ch_row, sid)
        if ref:
            material_parts.append(f"【{title}】\n{ref[:3600]}")
        pr = (
            db.query(SectionLearningProgressDB)
            .filter(
                SectionLearningProgressDB.user_id == user_id,
                SectionLearningProgressDB.subject == subject,
                SectionLearningProgressDB.chapter_id == ch_row.id,
                SectionLearningProgressDB.section_id == sid,
            )
            .first()
        )
        if pr and pr.section_summary:
            summary_parts.append(f"【{title}】\n{pr.section_summary[:1800]}")
        for raw in _load_weak_points(pr, limit=4) if pr else []:
            point = dict(raw)
            point["section_id"] = sid
            point["section"] = str(point.get("section") or title)
            weak_points.append(point)
            if len(weak_points) >= 10:
                break
    if not summary_parts:
        summary_parts.append(ch_row.desc or ch_row.title)
    return (
        sections,
        "\n\n".join(material_parts)[:18000] or (ch_row.desc or ""),
        "\n\n".join(summary_parts)[:10000],
        weak_points[:10],
    )


def _section_id_for_chapter_quiz_item(sections: list[Dict[str, Any]], item: Dict[str, Any], fallback_index: int) -> str:
    if not sections:
        return ""
    haystack = " ".join(
        str(item.get(key) or "")
        for key in ("section", "target_concept", "question", "explanation")
    ).lower()
    for sec in sections:
        sid = str(sec.get("id") or "")
        title = str(sec.get("title") or "")
        if (sid and sid.lower() in haystack) or (title and title.lower() in haystack):
            return sid
    return str(sections[fallback_index % len(sections)].get("id") or "")


def _section_title_by_id(sections: list[Dict[str, Any]], section_id: str) -> str:
    for sec in sections:
        if str(sec.get("id") or "") == str(section_id):
            return str(sec.get("title") or section_id)
    return section_id


@app.post("/learning/chapter-quiz/prepare")
def learning_chapter_quiz_prepare(body: ChapterQuizPrepareBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    if not _all_sections_quiz_passed(db, u.id, body.subject, body.chapter_id):
        raise HTTPException(status_code=400, detail="需先完成本大章下所有小节测验")
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="大章不存在")

    _sections, material, summary, weak_points = _chapter_quiz_context(db, u.id, body.subject, ch_row)
    scope_label = f"{ch_row.title} 综合测验"
    try:
        questions = build_instant_paper(
            body.subject,
            scope_label,
            material,
            summary,
            weak_points=weak_points,
        )
        questions = _normalize_small_quiz_questions(questions)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"大章测验生成失败: {exc}") from exc

    cprog = _get_or_create_chapter_progress(db, u.id, body.subject, body.chapter_id)
    cprog.pending_quiz_json = json.dumps(questions, ensure_ascii=False)[:36000]
    cprog.updated_at = datetime.utcnow()
    db.commit()
    return {
        "questions": public_quiz_questions(questions),
        "already_passed": bool(cprog.chapter_quiz_passed),
        "total": len(questions),
    }


@app.post("/learning/chapter-quiz/submit")
def learning_chapter_quiz_submit(body: ChapterQuizSubmitBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = resolve_course(db, body.subject)
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="大章不存在")
    sections, _material, _summary, _existing_weak = _chapter_quiz_context(db, u.id, body.subject, ch_row)
    cprog = _get_or_create_chapter_progress(db, u.id, body.subject, body.chapter_id)
    if not cprog.pending_quiz_json:
        raise HTTPException(status_code=400, detail="请先调用 /learning/chapter-quiz/prepare 生成大章测验")
    try:
        qs = json.loads(cprog.pending_quiz_json)
        quiz_questions = normalize_mixed_quiz_questions(qs, limit=SMALL_QUIZ_QUESTION_COUNT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"大章测验数据损坏，请重新生成: {exc}") from exc

    correct = 0
    earned_points = 0.0
    total_points = 0.0
    results: list[Dict[str, Any]] = []
    for i, qi in enumerate(quiz_questions):
        answer = body.answers[i] if i < len(body.answers) else None
        awarded_points, ok = score_quiz_answer(qi, answer)
        points = float(qi.get("points") or 1)
        earned_points += awarded_points
        total_points += points
        if ok:
            correct += 1
        results.append(
            {
                "index": i,
                "id": qi.get("id") or f"q{i + 1:02d}",
                "section": qi.get("section") or "综合练习",
                "type": qi.get("type") or "single",
                "target_concept": qi.get("target_concept") or "",
                "points": points,
                "awarded_points": awarded_points,
                "question": str(qi.get("question") or ""),
                "options": [str(x) for x in (qi.get("options") or [])],
                "selected_answer": quiz_answer_summary(qi, answer),
                "correct_answer": quiz_answer_summary(qi, None, correct=True),
                "is_correct": ok,
                "explanation": str(qi.get("explanation") or "请回到本章资料，重新核对该知识点。"),
            }
        )

    total = len(quiz_questions)
    score = (earned_points / max(total_points, 1.0)) * 100.0
    passed = score >= QUIZ_PASSING_SCORE
    incorrect = total - correct
    cprog.chapter_quiz_score = score
    cprog.chapter_quiz_passed = passed
    cprog.chapter_summary = (
        f"大章测验得分 {round(score, 1)}；正确 {correct}/{total}；"
        f"{'已通过' if passed else '未达标，需要回到薄弱小节补强'}。"
    )
    if passed:
        cprog.pending_quiz_json = None
    cprog.updated_at = datetime.utcnow()

    weak_points: list[Dict[str, Any]] = []
    focus_section_id = ""
    for item in [x for x in results if not x.get("is_correct")][:8]:
        section_id = _section_id_for_chapter_quiz_item(sections, item, int(item.get("index") or 0))
        section_title = _section_title_by_id(sections, section_id)
        if not focus_section_id:
            focus_section_id = section_id
        point = {
            "index": int(item.get("index", 0)) + 1,
            "section": item.get("target_concept") or section_title or item.get("section") or "本章综合",
            "type": item.get("type") or "chapter_quiz",
            "question": item.get("question") or "",
            "reason": item.get("explanation") or "",
        }
        weak_points.append(point)
        if section_id:
            pr = _get_or_create_section_progress(db, u.id, body.subject, body.chapter_id, section_id)
            pr.weak_points_json = json.dumps(_merge_weak_points(pr, [point]), ensure_ascii=False)[:12000]
            pr.phase = "questioning"
            pr.updated_at = datetime.utcnow()
            existing_summary = (pr.section_summary or "").strip()
            chapter_note = f"- Q{point['index']} {point['section']}: {point['question']} -> {point['reason']}"
            pr.section_summary = (existing_summary + "\n\n[chapter_quiz_weak_point]\n" + chapter_note).strip()[-8000:]
            db.add(pr)

    _append_resource_event(
        db,
        u.id,
        body.subject,
        {
            "resource_type": "chapter_quiz_result",
            "chapter_id": body.chapter_id,
            "section_id": focus_section_id,
            "scope_label": ch_row.title,
            "focus": "\n".join(x.get("question") or x.get("reason") or "" for x in weak_points[:5]),
            "summary": f"chapter_quiz score={round(score, 1)} weak_points={len(weak_points)}",
        },
    )
    db.add(cprog)
    db.commit()
    _append_quiz_history_snapshot(
        db,
        user_id=u.id,
        subject=body.subject,
        session_id=body.session_id,
        quiz_title="章节测验结果",
        scope_label=ch_row.title,
        score=score,
        correct=correct,
        total=total,
        passed=passed,
        weak_points=weak_points,
    )
    return {
        "score": score,
        "passed": passed,
        "correct": correct,
        "incorrect": incorrect,
        "total": total,
        "earned_points": earned_points,
        "total_points": total_points,
        "passing_score": QUIZ_PASSING_SCORE,
        "items": results,
        "weak_points": weak_points,
        "control": _learning_control_state(db, u.id, body.subject, course, body.chapter_id, focus_section_id or None),
    }


ASK_USER_JSON_PREFIX = "__PA_USER_JSON__\n"
ASK_MAX_IMAGE_BYTES = 4 * 1024 * 1024
ASK_MAX_IMAGES = 5
ASK_MAX_USER_PAYLOAD_BYTES = 15 * 1024 * 1024


def encode_user_message_for_db(text: str, images: list[dict[str, str]]) -> str:
    """无图时存纯文本；有图时存 JSON（含 base64），供历史回放与多模态 API。"""
    if not images:
        return text
    t = (text or "").strip()
    payload = {"v": 1, "t": t, "img": images}
    blob = ASK_USER_JSON_PREFIX + json.dumps(payload, ensure_ascii=False)
    if len(blob.encode("utf-8")) > ASK_MAX_USER_PAYLOAD_BYTES:
        raise ValueError("图文总大小超过限制，请减少图片数量或压缩后重试")
    return blob


def history_content_to_chat_message(role: str, content: str) -> dict[str, Any]:
    if role == "assistant":
        return {"role": "assistant", "content": content}
    if not content.startswith(ASK_USER_JSON_PREFIX):
        return {"role": "user", "content": content}
    raw = content[len(ASK_USER_JSON_PREFIX) :].strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"role": "user", "content": content}
    parts: list[dict[str, Any]] = []
    t = str(payload.get("t") or "").strip()
    if t:
        parts.append({"type": "text", "text": t})
    for im in payload.get("img") or []:
        if not isinstance(im, dict):
            continue
        mt = str(im.get("m") or "image/jpeg").strip().lower()
        d = str(im.get("d") or "").strip()
        if not d or not mt.startswith("image/"):
            continue
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mt};base64,{d}"}})
    if not parts:
        return {"role": "user", "content": "(消息解析失败，请重新发送)"}
    return {"role": "user", "content": parts}


def normalize_ask_image_payload(parts: List[AskImagePart]) -> list[dict[str, str]]:
    """校验并规范化 AskImagePart 列表，供 /ask 与带学 answer-turn 共用。"""
    if not parts:
        return []
    imgs: list[dict[str, str]] = []
    total_decoded = 0
    for p in parts[:ASK_MAX_IMAGES]:
        b64 = re.sub(r"\s+", "", p.data_b64 or "")
        try:
            raw = base64.b64decode(b64, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="图片 Base64 无效") from exc
        if len(raw) > ASK_MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="单张图片不可超过 4MB")
        total_decoded += len(raw)
        imgs.append({"m": p.media_type, "d": b64})
    if total_decoded > 12 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="多图总大小不可超过约 12MB")
    return imgs


def _hist_has_user_images(hist_rows: list[ChatHistoryDB]) -> bool:
    for h in hist_rows:
        if h.role == "user" and (h.content or "").startswith(ASK_USER_JSON_PREFIX):
            return True
    return False


def _execute_ask_stream(
    db: Session,
    *,
    db_user: UserDB,
    subject: str,
    question_text: str,
    images: list[dict[str, str]],
    chapter: Optional[str],
    chapter_id: Optional[str],
    section_id: Optional[str],
    session_id: Optional[int],
) -> StreamingResponse:
    course = resolve_course(db, subject)
    cid = (chapter_id or "").strip()
    sid = (section_id or "").strip()
    session = None
    if session_id:
        session = db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
        if session and (
            session.user_id != db_user.id or (getattr(session, "session_kind", None) or "chat") != "chat"
        ):
            session = None

    legacy = (chapter or "").strip()
    if session and not cid and not sid and not legacy and session.chapter:
        legacy = str(session.chapter or "").strip()
    if not cid and legacy and "|" in legacy:
        p1, p2 = legacy.split("|", 1)
        cid = p1.strip()
        sid = p2.strip()

    ch_row: ChapterDB | None = None
    if course and cid:
        ch_row = _chapter_row(db, course.id, cid)
    elif course and legacy and "›" in legacy and "|" not in legacy:
        main_part, sub_part = [x.strip() for x in legacy.split("›", 1)]
        for c in course.chapters:
            if c.title == main_part or main_part in c.title or c.title in main_part:
                ch_row = c
                cid = c.id
                for s in parse_subsections_json(c.subsections):
                    if s.get("title") == sub_part:
                        sid = str(s.get("id") or "")
                break
    elif course and legacy and "|" not in legacy:
        for c in course.chapters:
            if c.title == legacy:
                ch_row = c
                cid = c.id
                break

    scope_label, ref_block = _build_learning_reference(ch_row, sid or None)
    if not ref_block.strip() and course and ch_row:
        scope_label, ref_block = _build_learning_reference(ch_row, None)

    session_key = f"{cid}|{sid}" if (cid and sid) else legacy
    if not session_key and ch_row and sid:
        session_key = f"{ch_row.id}|{sid}"
    if not session_key:
        session_key = legacy or scope_label or "未选择"

    chapter_text = scope_label or legacy or "（未选择小节）"

    q_plain = (question_text or "").strip()
    assert_user_content_safe(q_plain)
    if not q_plain and images:
        q_plain = "请结合附图进行说明、分析与解答。"

    try:
        stored_user = encode_user_message_for_db(q_plain, images)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    title_src = q_plain if q_plain else ("附图提问" if images else "")
    if not session:
        session = ChatSessionDB(
            user_id=db_user.id,
            subject=subject,
            chapter=session_key[:512],
            title=make_session_title(title_src),
            session_kind="chat",
        )
        db.add(session)
    else:
        session.chapter = session_key[:512]
        session.updated_at = datetime.utcnow()

    db.flush()
    db.add(ChatHistoryDB(session_id=session.id, role="user", content=stored_user))
    db.commit()

    db_messages = (
        db.query(ChatHistoryDB)
        .filter(ChatHistoryDB.session_id == session.id)
        .order_by(ChatHistoryDB.id.desc())
        .limit(6)
        .all()
    )

    ref_for_prompt = ref_block.strip() or "（这一节暂时没有更细的资料。请围绕章节名称，用易懂、简短、可想象的方式说明；不要写成教材摘要。）"
    vision_note = ""
    if images or any(
        (h.role == "user" and (h.content or "").startswith(ASK_USER_JSON_PREFIX)) for h in db_messages
    ):
        vision_note = (
            "\n若学员附带图片：请结合图片、文字与参考资料作答；若图片与当前课程无关或无法辨认，请如实说明。"
        )
    system_prompt = (
        f"你是「{subject}」学习伙伴，正在陪用户看：{chapter_text}。\n"
        "你要像一个会把复杂事讲清楚的同伴：少术语、重点清楚、有画面感。必须出现术语时，马上用一句人话解释。\n"
        "禁止写任何开场句或免责声明；不要用“好的/我们来看/下面是/根据你提供的资料为空/我将保守说明/教材化解释”开头。资料少时，直接给出最基础、最可靠的理解。\n"
        "必须使用下面的 Markdown 结构，并保留这四个标题：\n"
        "第一行必须是 `## 先抓重点`。\n"
        "## 先抓重点\n用 2-4 条短句回答问题，每条只讲一个意思；第一句直接回答用户的问题。\n"
        "## 换个说法\n用一个生活画面、故事或比喻解释核心想法，不要写成教材摘要。\n"
        "## 小例子\n给一个小例子、反例或一步步的小推演，让用户看见它怎么用；例子必须算对，不确定时就换成更简单的例子。\n"
        "## 继续往前\n给一个可以马上尝试的问题、练习或下一步提醒。\n"
        "排版要求：段落要短；不要把单个字母、公式符号单独拆成一行；列表最多 4 条；重点词可以加粗，但不要满屏加粗。\n"
        "依据下方「这一节可参考的内容」展开；如果内容不足，可以用该章节最基础的常识补足，但要保持简短，不要引入远离当前章节的大段内容。\n"
        "若学员问题明显超出当前范围：先用一句话点明，再给一个可以回到当前范围的小入口。"
        f"{vision_note}\n\n"
        f"【这一节可参考的内容】\n{ref_for_prompt}"
        + ANTI_HALLUCINATION_SYSTEM_SUFFIX
    )
    messages: List[Any] = [{"role": "system", "content": system_prompt}]
    for m in reversed(db_messages):
        messages.append(history_content_to_chat_message(m.role, m.content))

    sid_for_stream = session.id
    uid_for_stream = db_user.id
    subject_for_stream = subject
    cid_for_signal = cid
    sid_for_signal = sid
    scope_for_signal = scope_label

    def generate_chunks():
        try:
            response = _get_llm_client().chat.completions.create(
                model=os.getenv("MODEL_NAME", "gpt-4o-mini"),
                messages=cast(List[ChatCompletionMessageParam], messages),
                stream=True,
            )
        except Exception:
            yield "【AI 服务暂时不可用，请稍后重试。】"
            return

        raw_answer, clean_answer = "", ""
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                delta = chunk.choices[0].delta.content
                raw_answer += delta
                new_clean = strip_intro_before_answer_heading(
                    collapse_repetition(raw_answer),
                    wait_for_heading=True,
                )
                emit = safe_stream_delta(clean_answer, new_clean)
                if emit:
                    yield emit
                clean_answer = new_clean

        if not clean_answer:
            clean_answer = strip_intro_before_answer_heading(
                collapse_repetition(raw_answer),
                wait_for_heading=False,
            )

        with SessionLocal() as save_db:
            save_db.add(ChatHistoryDB(session_id=sid_for_stream, role="assistant", content=clean_answer))
            s = save_db.query(ChatSessionDB).filter(ChatSessionDB.id == sid_for_stream).first()
            if s:
                s.updated_at = datetime.utcnow()
            save_db.commit()

        if course and cid_for_signal and sid_for_signal and clean_answer.strip():
            try:
                with SessionLocal() as signal_db:
                    sig_course = resolve_course(signal_db, subject_for_stream)
                    sig_ch = _chapter_row(signal_db, sig_course.id, cid_for_signal) if sig_course else None
                    sig_sec = find_section(sig_ch.subsections, sid_for_signal) if sig_ch else None
                    if sig_course and sig_ch and sig_sec:
                        signal = _ask_extract_learning_signal(clean_answer, q_plain, scope_for_signal)
                        weak_payload = _normalize_weak_points_payload(
                            signal.get("weak_points"),
                            scope_for_signal,
                            source_type="free_question",
                        )
                        prog = _get_or_create_section_progress(
                            signal_db,
                            uid_for_stream,
                            subject_for_stream,
                            cid_for_signal,
                            sid_for_signal,
                        )
                        if weak_payload:
                            prog.weak_points_json = json.dumps(
                                _merge_weak_points(prog, weak_payload),
                                ensure_ascii=False,
                            )[:12000]
                            if prog.phase == "idle":
                                prog.phase = "questioning"
                            prog.pending_quiz_json = None
                            existing_summary = (prog.section_summary or "").strip()
                            note = "\n".join(
                                f"- {x.get('section')}: {x.get('question')} -> {x.get('reason')}"
                                for x in weak_payload
                            )
                            prog.section_summary = (existing_summary + "\n\n[free_question_weak_points]\n" + note).strip()[-8000:]
                        elif signal.get("summary"):
                            existing_summary = (prog.section_summary or "").strip()
                            prog.section_summary = (
                                existing_summary + "\n\n[free_question_observation]\n" + str(signal.get("summary") or "")
                            ).strip()[-8000:]
                        prog.updated_at = datetime.utcnow()
                        signal_db.commit()
                        meta = {
                            "source": "free_question",
                            "weak_points": _load_weak_points(prog, limit=5),
                            "control": _learning_control_state(
                                signal_db,
                                uid_for_stream,
                                subject_for_stream,
                                sig_course,
                                cid_for_signal,
                                sid_for_signal,
                            ),
                        }
                        yield LEARN_META_BEGIN + json.dumps(meta, ensure_ascii=False) + LEARN_META_END
            except Exception as exc:
                print(f"[ASK_LEARNING_SIGNAL] skipped: {exc}", flush=True)

    return StreamingResponse(
        generate_chunks(),
        media_type="text/plain",
        headers=stream_response_headers({"X-Session-Id": str(sid_for_stream)}),
    )


@app.get("/ask")
def ask_ai(
    question: str,
    username: str,
    subject: str,
    chapter: Optional[str] = None,
    chapter_id: Optional[str] = None,
    section_id: Optional[str] = None,
    session_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    db_user = db.query(UserDB).filter(UserDB.username == username).first()
    if not db_user:
        raise HTTPException(
            status_code=404,
            detail="用户不存在：请在本网站重新注册并登录。公网实例数据库若未挂载持久盘，服务重启后账号会丢失，需重新注册。",
        )
    q = (question or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="问题不能为空")
    assert_user_content_safe(q)
    return _execute_ask_stream(
        db,
        db_user=db_user,
        subject=subject,
        question_text=q,
        images=[],
        chapter=chapter,
        chapter_id=chapter_id,
        section_id=section_id,
        session_id=session_id,
    )


@app.post("/ask")
def ask_ai_post(body: AskPostBody, db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not db_user:
        raise HTTPException(
            status_code=404,
            detail="用户不存在：请在本网站重新注册并登录。公网实例数据库若未挂载持久盘，服务重启后账号会丢失，需重新注册。",
        )

    imgs = normalize_ask_image_payload(body.images)

    q = (body.question or "").strip()
    if not q and not imgs:
        raise HTTPException(status_code=400, detail="请输入文字或上传至少一张图片")
    assert_user_content_safe(q)

    return _execute_ask_stream(
        db,
        db_user=db_user,
        subject=body.subject,
        question_text=q,
        images=imgs,
        chapter=body.chapter,
        chapter_id=body.chapter_id,
        section_id=body.section_id,
        session_id=body.session_id,
    )


_sd_root = static_site_dir()
if _sd_root is not None:
    _assets_root = (_sd_root / "assets").resolve()
    if _assets_root.is_dir():

        @app.get("/assets/{filepath:path}")
        async def mentor_serve_asset(filepath: str):
            if "\\" in filepath:
                raise HTTPException(status_code=404)
            try:
                target = (_assets_root / filepath).resolve()
                target.relative_to(_assets_root)
            except ValueError:
                raise HTTPException(status_code=404)
            if not target.is_file():
                raise HTTPException(status_code=404)
            return FileResponse(target)

    def _public_file_handler(path: Path):
        async def _send() -> FileResponse:
            return FileResponse(path)

        return _send

    for _name in ("favicon.svg", "icons.svg"):
        _p = _sd_root / _name
        if _p.is_file():
            app.add_api_route(f"/{_name}", _public_file_handler(_p), methods=["GET"])

    @app.get("/{frontend_path:path}", include_in_schema=False)
    async def mentor_spa_fallback(frontend_path: str, request: Request):
        if "text/html" not in request.headers.get("accept", "").lower():
            raise HTTPException(status_code=404, detail="Not Found")
        index = _sd_root / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
