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
from pydantic import BaseModel, Field, field_validator
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
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        access_token = _gmail_access_token()
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
        print(f"[PASSWORD_RESET] Gmail API HTTP {exc.code}: {detail}")
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
                attach_files_for_course_ids=("dl",),
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
        f"你是资深「{subject}」教师，当前小节：{scope_label}。\n"
        "请按**正规课堂教学**组织第一轮内容（用 Markdown），结构包含：\n"
        "1）**学习目标**（1-3 条，可量化）；2）**核心要点讲解**（分点、小标题，讲清概念与直觉）；"
        "3）**简单示例或类比**（如适用）；4）**课堂互动**：1-2 个引导性问题或小练习，请学员思考。\n"
        "数学公式请用 LaTeX：行内 `$...$`，独立公式 `$$...$$`；代码用 Markdown 围栏代码块（带语言标签）。\n"
        "严格只依据【资料】，不要编造资料中不存在的定理编号；不要输出与教学无关的寒暄套话。\n"
        f"【资料】\n{ref_excerpt[:11000]}\n\n"
        "重要：正文中**禁止**出现子串 [[META]]、[[/META]]（系统预留）。"
        + ANTI_HALLUCINATION_SYSTEM_SUFFIX
    )


def _learn_teaching_system(subject: str, scope_label: str, ref_excerpt: str) -> str:
    return (
        f"你是资深「{subject}」教师，当前小节：{scope_label}。\n"
        "请按**正规课堂教学节奏**组织本轮讲解（Markdown），并与**上文对话自然衔接**：\n"
        "1）**回顾/承上启下**（若有上文）；2）**要点展开**：结合学员上一句作答，先**简短点评**（肯定或纠错），再讲清相关概念；\n"
        "3）**例题、反例或易错点**（如适用）；4）**互动**：提出 1-2 个启发式问题或微型练习，引导学员继续思考。\n"
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
    raw = _learn_chat_complete(
        [{"role": "system", "content": sys_e}, {"role": "user", "content": user_e}],
        temperature=0.1,
    )
    return _parse_json_object_from_llm(raw)


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
    normalized: list[Dict[str, Any]] = []
    for item in raw_questions:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        options = item.get("options")
        if not question or not isinstance(options, list) or len(options) < 4:
            continue
        try:
            correct_index = int(item.get("correct_index", -1))
        except Exception:
            correct_index = -1
        if correct_index < 0 or correct_index > 3:
            continue
        normalized.append(
            {
                "question": question[:800],
                "options": [str(x).strip()[:300] for x in options[:4]],
                "correct_index": correct_index,
                "explanation": str(item.get("explanation") or item.get("analysis") or "此题用于检验本小节核心概念，正确答案见上方选项。").strip()[:1000],
            }
        )
        if len(normalized) >= SMALL_QUIZ_QUESTION_COUNT:
            break
    if len(normalized) < SMALL_QUIZ_QUESTION_COUNT:
        raise ValueError(f"small quiz must contain {SMALL_QUIZ_QUESTION_COUNT} valid questions")
    return normalized


def _generate_small_quiz_for_section(
    subject: str,
    scope_label: str,
    ref_excerpt: str,
    section_summary: str = "",
) -> list[Dict[str, Any]]:
    sys_q = (
        f"你是「{subject}」课程测验设计教师。请根据当前小节资料生成小节测验。\n"
        f"输出**仅一个 JSON 数组**（不要 markdown 围栏），长度恰好为 {SMALL_QUIZ_QUESTION_COUNT}。\n"
        "每项字段：question、options（4 个选项）、correct_index（0-3）、explanation（中文解析，解释为什么正确）。\n"
        "题目必须覆盖本小节核心概念，难度适合作为跳过带学后的准入测验；"
        "不得考资料中没有出现的事实。"
    )
    user_q = (
        f"【小节】{scope_label}\n"
        f"【已有小结】\n{section_summary[:2500] or '暂无，按资料命题。'}\n\n"
        f"【资料】\n{(ref_excerpt or '')[:12000]}"
    )
    raw = _learn_chat_complete(
        [{"role": "system", "content": sys_q}, {"role": "user", "content": user_q}],
        temperature=0.25,
    )
    try:
        arr = _parse_json_array_from_llm(raw)
    except Exception:
        obj = _parse_json_object_from_llm(raw)
        if isinstance(obj, dict) and isinstance(obj.get("questions"), list):
            arr = obj["questions"]
        else:
            raise
    return _normalize_small_quiz_questions(arr)


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
        if not pr or not pr.small_quiz_passed:
            return False
    return True


# ====================== FastAPI 实例 ======================
@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    """每次进程启动（含 --reload 子进程）再跑一次建表，并在控制台标明关键路由已注册。"""
    ensure_schema()
    db = SessionLocal()
    try:
        if db.query(CourseDB).count() == 0:
            seed_courses(db)
            print("[mentor-backend] 空库：已自动导入课程数据（等价于访问一次 /seed）")
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


class UserLogin(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
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
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    password: str = Field(..., min_length=6, max_length=20)
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

    @field_validator("password")
    @classmethod
    def password_policy(cls, v: str) -> str:
        return assert_password_strength(v)


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
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
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
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
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
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    question: str = Field(default="", max_length=8000)
    chapter: Optional[str] = None
    chapter_id: Optional[str] = None
    section_id: Optional[str] = None
    session_id: Optional[int] = None
    images: List[AskImagePart] = Field(default_factory=list, max_length=5)


class LearningAnswerBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    session_id: int = Field(..., ge=1)
    answer: str = Field(default="", max_length=8000)
    images: List[AskImagePart] = Field(default_factory=list, max_length=5)


class StudioPortraitRefreshBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    session_id: Optional[int] = None


class StudioResourceStreamBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    resource_type: str = Field(..., min_length=3, max_length=40)
    extra_hint: str = Field(default="", max_length=2000)


class SmallQuizSubmitBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    answers: List[int] = Field(..., min_length=1, max_length=30)


class SmallQuizPrepareBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    section_id: str = Field(..., min_length=1, max_length=64)
    mode: str = Field(default="direct", max_length=24)


class ChapterQuizPrepareBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)


class ChapterQuizSubmitBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$")
    subject: str = Field(..., min_length=1, max_length=64)
    chapter_id: str = Field(..., min_length=1, max_length=64)
    answers: List[int] = Field(..., min_length=1, max_length=24)


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

def safe_stream_delta(prev_clean: str, new_clean: str) -> str:
    if not prev_clean:
        return new_clean
    if new_clean.startswith(prev_clean):
        return new_clean[len(prev_clean):]
    max_overlap = min(len(prev_clean), len(new_clean))
    for i in range(max_overlap, 0, -1):
        if prev_clean[-i:] == new_clean[:i]:
            return new_clean[i:]
    return new_clean

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
    if not rows:
        return
    avg_mastery = sum(float(r.mastery or 0) for r in rows) / max(len(rows), 1)
    passed = sum(1 for r in rows if r.small_quiz_passed)
    quiz_pending = sum(1 for r in rows if r.phase == "quiz_pending")
    active = sum(1 for r in rows if int(r.learn_turns or 0) > 0 or float(r.mastery or 0) > 0)
    passed_ratio = passed / max(len(rows), 1)
    turn_avg = sum(int(r.learn_turns or 0) for r in rows) / max(active, 1)

    def blend_dimension(key: str, score: float, note: str, weight: float = 0.68) -> None:
        current = portrait["dimensions"].get(key) or {"score": 0.5, "note": ""}
        base = max(0.0, min(1.0, float(current.get("score") or 0.5)))
        merged_score = (base * (1.0 - weight)) + (max(0.0, min(1.0, score)) * weight)
        portrait["dimensions"][key] = {
            "score": max(0.0, min(1.0, merged_score)),
            "note": note[:120],
        }

    blend_dimension("知识基础", avg_mastery, f"随小节掌握度同步，当前均值约 {round(avg_mastery * 100)}%。")
    blend_dimension(
        "学习目标对齐度",
        max(avg_mastery, passed_ratio),
        f"已通过 {passed} 个小节测验，{quiz_pending} 个小节待测。",
        weight=0.58,
    )
    pace_score = min(1.0, 0.42 + passed_ratio * 0.45 + min(turn_avg, SECTION_FORCE_QUIZ_TURNS) / SECTION_FORCE_QUIZ_TURNS * 0.13)
    blend_dimension("学习节奏", pace_score, f"平均带学 {turn_avg:.1f} 轮；通过测验后节奏评分会继续上升。", weight=0.52)


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


def _studio_build_learning_path(db: Session, user_id: int, subject: str, course: CourseDB) -> Dict[str, Any]:
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
            done = bool(pr and pr.small_quiz_passed)
            steps.append(
                {
                    "chapter_id": ch.id,
                    "chapter_title": ch.title,
                    "section_id": sid,
                    "section_title": sec.get("title"),
                    "status": "done" if done else "pending",
                }
            )
    focus_idx = None
    for i, s in enumerate(steps):
        if s["status"] == "pending":
            focus_idx = i
            break
    return {
        "steps": steps,
        "focus_index": focus_idx,
        "hint": "按顺序完成「待学」小节；每节前可在资源工坊生成预习材料，再进行 AI 带学。",
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
    course = db.query(CourseDB).filter(CourseDB.name == subject).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    path = _studio_build_learning_path(db, u.id, subject, course)
    return {"path": path}


@app.post("/learning/studio/path/rebuild")
def learning_studio_path_rebuild(body: StudioPortraitRefreshBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = db.query(CourseDB).filter(CourseDB.name == body.subject).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    path = _studio_build_learning_path(db, u.id, body.subject, course)
    row = _get_or_create_studio_row(db, u.id, body.subject)
    row.learning_path_json = json.dumps(path, ensure_ascii=False)[:48000]
    row.updated_at = datetime.utcnow()
    db.commit()
    return {"path": path}


@app.post("/learning/studio/resources/stream")
def learning_studio_resource_stream(body: StudioResourceStreamBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    if body.resource_type not in RESOURCE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"未知资源类型，可选：{', '.join(RESOURCE_TYPES.keys())}",
        )
    assert_user_content_safe(body.extra_hint)
    hint = sanitize_user_plaintext(body.extra_hint, max_len=2000)
    course = db.query(CourseDB).filter(CourseDB.name == body.subject).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    scope_label, ref = _build_learning_reference(ch_row, body.section_id)
    spec = RESOURCE_TYPES[body.resource_type]
    sys_m = (
        spec["instruction"]
        + f"\n\n【当前范围】{scope_label}\n【资料】\n"
        + (ref or "")[:11000]
        + ANTI_HALLUCINATION_SYSTEM_SUFFIX
    )
    user_lines = [
        f"课程：{body.subject}；大章/小节：{scope_label}。",
        "请严格只输出本任务要求的格式（Markdown / Mermaid / JSON 代码块等），勿输出与任务无关的寒暄。",
    ]
    if hint:
        user_lines.append(f"学员/教师的额外要求：\n{hint}")
    messages: List[Any] = [
        {"role": "system", "content": sys_m},
        {"role": "user", "content": "\n".join(user_lines)},
    ]
    try:
        response = _get_llm_client().chat.completions.create(
            model=os.getenv("MODEL_NAME", "gpt-4o-mini"),
            messages=cast(List[ChatCompletionMessageParam], messages),
            stream=True,
            temperature=0.35,
        )

        def generate_chunks():
            raw_answer, clean_answer = "", ""
            for chunk in response:
                if chunk.choices and chunk.choices[0].delta.content:
                    delta = chunk.choices[0].delta.content
                    raw_answer += delta
                    new_clean = collapse_repetition(raw_answer)
                    emit = safe_stream_delta(clean_answer, new_clean)
                    if emit:
                        yield emit
                    clean_answer = new_clean

        hdr = safety_headers(spec["agent_chain"])
        hdr["X-Resource-Type"] = body.resource_type
        return StreamingResponse(
            generate_chunks(), media_type="text/plain", headers=stream_response_headers(hdr)
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"资源生成失败: {exc}") from exc


@app.get("/learning-catalog")
def learning_catalog(subject: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    """前端章节目录：大章 + 小节 id/title（不含正文，避免响应过大）。"""
    course = db.query(CourseDB).filter(CourseDB.name == subject).first()
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
    username: str = Query(..., min_length=3, max_length=16, pattern=r"^[a-zA-Z0-9_]+$"),
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
    course = db.query(CourseDB).filter(CourseDB.name == body.subject).first()
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
                new_clean = collapse_repetition(raw_answer)
                emit = safe_stream_delta(clean_answer, new_clean)
                if emit:
                    yield emit
                clean_answer = new_clean

        assistant_plain = _strip_learn_meta_trailer(clean_answer).strip()
        if not assistant_plain:
            assistant_plain = "（本节讲解暂时为空，请稍后重试。）"
        with SessionLocal() as save_db:
            save_db.add(ChatHistoryDB(session_id=session_id, role="assistant", content=assistant_plain))
            s_row = save_db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
            if s_row:
                s_row.updated_at = datetime.utcnow()
            save_db.commit()

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

    course = db.query(CourseDB).filter(CourseDB.name == body.subject).first()
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
                new_clean = collapse_repetition(raw_answer)
                emit = safe_stream_delta(clean_answer, new_clean)
                if emit:
                    yield emit
                clean_answer = new_clean

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
                    }

                mastery_new = float(data.get("mastery_total") or 0)
                mastery_new = max(0.0, min(1.0, mastery_new))
                want_complete = bool(data.get("section_complete"))
                small_quiz = data.get("small_quiz")
                summary = str(data.get("section_summary") or "").strip()

                prog.learn_turns = learn_turns_after
                prog.mastery = max(float(prog.mastery or 0), mastery_new)
                prog.updated_at = datetime.utcnow()

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
                        )
                    except Exception:
                        quiz_questions = None

                if want_complete and quiz_questions:
                    prog.phase = "quiz_pending"
                    prog.section_summary = summary[:8000] if summary else None
                    prog.pending_quiz_json = json.dumps(quiz_questions, ensure_ascii=False)[:SMALL_QUIZ_JSON_MAX_CHARS]
                    quiz_ready = True
                    if prog.section_summary:
                        assistant_msg += f"\n\n**学习小结**\n{prog.section_summary}"
                    assistant_msg += "\n\n本节对话已完成。请完成 **小节测验**（在测验窗口中作答）。"
                elif want_complete:
                    prog.phase = "questioning"
                    assistant_msg += (
                        "\n\n（测验未生成完整，我们再巩固一问。）\n请用一句话概括本节最核心的定义。"
                    )
                else:
                    prog.phase = "questioning"

                work_db.add(
                    ChatHistoryDB(session_id=session_id, role="assistant", content=assistant_msg)
                )
                s_row = work_db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()
                if s_row:
                    s_row.updated_at = datetime.utcnow()
                work_db.commit()

                if prog.pending_quiz_json:
                    try:
                        quiz_payload = json.loads(prog.pending_quiz_json)
                    except json.JSONDecodeError:
                        quiz_payload = None

                meta_out = {
                    "mastery_total": float(prog.mastery or 0),
                    "learn_turns": int(prog.learn_turns or 0),
                    "quiz_pending": quiz_ready,
                    "small_quiz": quiz_payload,
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
    db: Session = Depends(get_db),
):
    u = db.query(UserDB).filter(UserDB.username == username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    course = db.query(CourseDB).filter(CourseDB.name == subject).first()
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
        section_map[k] = {
            "mastery": r.mastery,
            "learn_turns": r.learn_turns,
            "phase": r.phase,
            "quiz_pending": r.phase == "quiz_pending" and bool(r.pending_quiz_json),
            "ready_for_quiz": bool(r.pending_quiz_json)
            or float(r.mastery or 0) >= SECTION_QUIZ_MASTERY_THRESHOLD
            or int(r.learn_turns or 0) >= SECTION_FORCE_QUIZ_TURNS,
            "small_quiz_passed": r.small_quiz_passed,
            "small_quiz_score": r.small_quiz_score,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }

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
            if st and st.get("small_quiz_passed"):
                passed += 1
        cq = (
            db.query(ChapterLearningProgressDB)
            .filter(
                ChapterLearningProgressDB.user_id == u.id,
                ChapterLearningProgressDB.subject == subject,
                ChapterLearningProgressDB.chapter_id == ch.id,
            )
            .first()
        )
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
    course = db.query(CourseDB).filter(CourseDB.name == body.subject).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="大章不存在")
    sec = find_section(ch_row.subsections, body.section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="小节不存在")

    prog = _get_or_create_section_progress(db, u.id, body.subject, body.chapter_id, body.section_id)
    if prog.small_quiz_passed:
        return {"questions": [], "already_passed": True}
    if prog.pending_quiz_json and prog.phase == "quiz_pending":
        try:
            return {"questions": _normalize_small_quiz_questions(json.loads(prog.pending_quiz_json))}
        except Exception:
            prog.pending_quiz_json = None

    scope_label, ref = _build_learning_reference(ch_row, body.section_id)
    try:
        questions = _generate_small_quiz_for_section(
            body.subject,
            scope_label,
            ref,
            prog.section_summary or "",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"小节测验生成失败: {exc}") from exc

    prog.phase = "quiz_pending"
    prog.pending_quiz_json = json.dumps(questions, ensure_ascii=False)[:SMALL_QUIZ_JSON_MAX_CHARS]
    if not prog.section_summary:
        prog.section_summary = f"直接进入小节测验：{scope_label}"
    prog.updated_at = datetime.utcnow()
    db.commit()
    return {"questions": questions, "already_passed": False}


@app.post("/learning/quiz/small/submit")
def learning_small_quiz_submit(body: SmallQuizSubmitBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    prog = _get_or_create_section_progress(db, u.id, body.subject, body.chapter_id, body.section_id)
    if not prog.pending_quiz_json or prog.phase != "quiz_pending":
        raise HTTPException(status_code=400, detail="当前没有待提交的小节测验")
    try:
        qs = json.loads(prog.pending_quiz_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="测验数据损坏")
    if not isinstance(qs, list) or len(qs) < SMALL_QUIZ_QUESTION_COUNT:
        raise HTTPException(status_code=500, detail="测验题目不完整")
    correct = 0
    results: list[Dict[str, Any]] = []
    quiz_questions = _normalize_small_quiz_questions(qs)
    for i, qi in enumerate(quiz_questions):
        ci = int(qi.get("correct_index", -1))
        ai = body.answers[i] if i < len(body.answers) else -1
        ok = 0 <= ai < 4 and 0 <= ci < 4 and ai == ci
        if ok:
            correct += 1
        results.append(
            {
                "index": i,
                "question": str(qi.get("question") or ""),
                "options": [str(x) for x in (qi.get("options") or [])[:4]],
                "selected_index": ai,
                "correct_index": ci,
                "is_correct": ok,
                "explanation": str(qi.get("explanation") or "请回到本小节资料，重新核对该知识点。"),
            }
        )
    total = len(quiz_questions)
    score = (correct / max(total, 1)) * 100.0
    passed = score >= QUIZ_PASSING_SCORE
    prog.small_quiz_score = score
    prog.small_quiz_passed = passed
    prog.mastery = max(float(prog.mastery or 0), score / 100.0)
    if passed:
        prog.pending_quiz_json = None
        prog.phase = "done"
    else:
        prog.pending_quiz_json = None
        prog.phase = "questioning"
    prog.updated_at = datetime.utcnow()
    db.commit()
    weak_items = [x for x in results if not x.get("is_correct")][:5]
    remedial_prompt = (
        f"我刚完成「{body.chapter_id} / {body.section_id}」小节测验，得分 {round(score)} 分，未达标。"
        "请根据这些错题继续带我学习，先补核心概念，再给我练习：\n"
        + "\n".join(
            f"{x['index'] + 1}. {x['question']}；正确答案：{chr(65 + int(x['correct_index']))}；解析：{x['explanation']}"
            for x in weak_items
        )
    )
    return {
        "score": score,
        "passed": passed,
        "correct": correct,
        "total": total,
        "passing_score": QUIZ_PASSING_SCORE,
        "items": results,
        "remedial_prompt": "" if passed else remedial_prompt[:4000],
    }


@app.post("/learning/chapter-quiz/prepare")
def learning_chapter_quiz_prepare(body: ChapterQuizPrepareBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    if not _all_sections_quiz_passed(db, u.id, body.subject, body.chapter_id):
        raise HTTPException(status_code=400, detail="需先完成本大章下所有小节测验")
    course = db.query(CourseDB).filter(CourseDB.name == body.subject).first()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")
    ch_row = _chapter_row(db, course.id, body.chapter_id)
    if not ch_row:
        raise HTTPException(status_code=404, detail="大章不存在")

    summaries: list[str] = []
    for sec in sections_natural_order(parse_subsections_json(ch_row.subsections)):
        sid = str(sec.get("id") or "")
        if not sid:
            continue
        pr = (
            db.query(SectionLearningProgressDB)
            .filter(
                SectionLearningProgressDB.user_id == u.id,
                SectionLearningProgressDB.subject == body.subject,
                SectionLearningProgressDB.chapter_id == body.chapter_id,
                SectionLearningProgressDB.section_id == sid,
            )
            .first()
        )
        if pr and pr.section_summary:
            summaries.append(f"【{sec.get('title')}】{pr.section_summary}")
    blob = "\n\n".join(summaries) if summaries else (ch_row.desc or "")
    sys_q = (
        f"你是「{body.subject}」导师。下面是大章「{ch_row.title}」下各小节学习小结与章描述。\n"
        "请输出仅一个 JSON 数组（不要用 markdown 围栏），长度恰好为 5；每项为对象，含字段 "
        "question、options（长度为 4 的字符串数组）、correct_index（0-3 的整数）。覆盖本章综合理解。\n"
        f"【材料】\n{blob[:12000]}"
    )
    try:
        raw = _learn_chat_complete(
            [{"role": "system", "content": sys_q}, {"role": "user", "content": "请生成大章测验题。"}],
            temperature=0.3,
        )
        try:
            arr = _parse_json_array_from_llm(raw)
        except Exception:
            obj = _parse_json_object_from_llm(raw)
            if isinstance(obj, dict) and isinstance(obj.get("questions"), list):
                arr = obj["questions"]
            else:
                raise ValueError("expected array or object.questions") from None
        if not isinstance(arr, list) or len(arr) < 5:
            raise ValueError("bad array")
        arr = arr[:5]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"大章测验生成失败: {exc}") from exc

    cprog = _get_or_create_chapter_progress(db, u.id, body.subject, body.chapter_id)
    cprog.pending_quiz_json = json.dumps(arr, ensure_ascii=False)[:24000]
    cprog.updated_at = datetime.utcnow()
    db.commit()
    return {"questions": arr}


@app.post("/learning/chapter-quiz/submit")
def learning_chapter_quiz_submit(body: ChapterQuizSubmitBody, db: Session = Depends(get_db)):
    u = db.query(UserDB).filter(UserDB.username == body.username).first()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    cprog = _get_or_create_chapter_progress(db, u.id, body.subject, body.chapter_id)
    if not cprog.pending_quiz_json:
        raise HTTPException(status_code=400, detail="请先调用 /learning/chapter-quiz/prepare 生成大章测验")
    try:
        qs = json.loads(cprog.pending_quiz_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="大章测验数据损坏")
    if not isinstance(qs, list) or len(qs) < 5:
        raise HTTPException(status_code=500, detail="大章测验题目不完整")
    correct = 0
    for i in range(5):
        qi = qs[i]
        if not isinstance(qi, dict):
            continue
        ci = int(qi.get("correct_index", -1))
        ai = body.answers[i] if i < len(body.answers) else -1
        if 0 <= ai < 4 and 0 <= ci < 4 and ai == ci:
            correct += 1
    score = (correct / 5.0) * 100.0
    passed = score >= 60.0
    cprog.chapter_quiz_score = score
    cprog.chapter_quiz_passed = passed
    if passed:
        cprog.pending_quiz_json = None
    cprog.updated_at = datetime.utcnow()
    db.commit()
    return {"score": score, "passed": passed, "correct": correct, "total": 5}


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
    course = db.query(CourseDB).filter(CourseDB.name == subject).first()
    cid = (chapter_id or "").strip()
    sid = (section_id or "").strip()

    legacy = (chapter or "").strip()
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
    session = None
    if session_id:
        session = db.query(ChatSessionDB).filter(ChatSessionDB.id == session_id).first()

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

    ref_for_prompt = ref_block.strip() or "（暂无小节级参考资料：请根据章节名称做保守、教材化的解释，并明确标注推理假设。）"
    vision_note = ""
    if images or any(
        (h.role == "user" and (h.content or "").startswith(ASK_USER_JSON_PREFIX)) for h in db_messages
    ):
        vision_note = (
            "\n若学员附带图片：请结合图片、文字与参考资料作答；若图片与当前课程无关或无法辨认，请如实说明。"
        )
    system_prompt = (
        f"你是专业的「{subject}」课程导师。\n"
        f"【当前学习范围】{chapter_text}\n"
        "你必须严格只依据下方「本小节参考资料」展开讲解、推导与举例；不得把其它章节或小节当作已给出的事实来引用，除非在参考资料中出现。\n"
        "若学员问题明显超出当前范围：先简要说明超出点，再建议其切换到对应大章/小节。"
        f"{vision_note}\n\n"
        f"【本小节参考资料】\n{ref_for_prompt}"
        + ANTI_HALLUCINATION_SYSTEM_SUFFIX
    )
    messages: List[Any] = [{"role": "system", "content": system_prompt}]
    for m in reversed(db_messages):
        messages.append(history_content_to_chat_message(m.role, m.content))

    sid_for_stream = session.id

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
                new_clean = collapse_repetition(raw_answer)
                emit = safe_stream_delta(clean_answer, new_clean)
                if emit:
                    yield emit
                clean_answer = new_clean

        with SessionLocal() as save_db:
            save_db.add(ChatHistoryDB(session_id=sid_for_stream, role="assistant", content=clean_answer))
            s = save_db.query(ChatSessionDB).filter(ChatSessionDB.id == sid_for_stream).first()
            if s:
                s.updated_at = datetime.utcnow()
            save_db.commit()

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
