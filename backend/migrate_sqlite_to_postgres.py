"""
一次性：把本地 SQLite users.db 导入 DATABASE_URL 指向的 Postgres（Neon / Supabase / Render Postgres）。

前置：
  1. 在控制台创建空库，复制连接串（含 sslmode=require 等查询参数）。
  2. 本机已 pip install -r requirements.txt（含 psycopg）。

用法（PowerShell 示例）：
  cd D:\\CSoftCup_Project\\backend
  $env:DATABASE_URL = "postgresql://用户:密码@ep-xxx.region.aws.neon.tech/neondb?sslmode=require"
  .\\venv\\Scripts\\python.exe migrate_sqlite_to_postgres.py ..\\users.db

说明：
  - 请先备份 Postgres；脚本对已存在主键使用 merge，可能覆盖同行。
  - 若 SQLite 路径相对于 backend 目录，请写清楚（如上）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from sqlalchemy import select, text

BACKEND_ROOT = Path(__file__).resolve().parent


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    pg_url = os.getenv("DATABASE_URL", "").strip()
    low = pg_url.lower()
    if not pg_url or not (low.startswith("postgres://") or low.startswith("postgresql")):
        sys.exit(
            "错误：请先在环境中设置 DATABASE_URL 为 Postgres 连接串（postgres:// 或 postgresql://）"
        )

    sqlite_arg = Path(sys.argv[1]).expanduser()
    sqlite_path = sqlite_arg if sqlite_arg.is_absolute() else (Path.cwd() / sqlite_arg).resolve()
    if not sqlite_path.is_file():
        sys.exit(f"找不到 SQLite 文件: {sqlite_path}")

    os.chdir(BACKEND_ROOT)
    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import main as app_main
    from main import (
        ChapterDB,
        ChatHistoryDB,
        ChatSessionDB,
        ChapterLearningProgressDB,
        CourseDB,
        PasswordResetTokenDB,
        SectionLearningProgressDB,
        UserDB,
        UserLearningStudioDB,
    )

    if app_main.engine.dialect.name != "postgresql":
        sys.exit("错误：导入 main 后数据库不是 Postgres，请检查 DATABASE_URL")

    sqlite_engine = create_engine(
        f"sqlite:///{sqlite_path.as_posix()}",
        connect_args={"check_same_thread": False},
    )
    SqlSession = sessionmaker(autocommit=False, autoflush=False, bind=sqlite_engine)
    PgSession = app_main.SessionLocal

    MODEL_ORDER = [
        CourseDB,
        ChapterDB,
        UserDB,
        PasswordResetTokenDB,
        ChatSessionDB,
        ChatHistoryDB,
        SectionLearningProgressDB,
        ChapterLearningProgressDB,
        UserLearningStudioDB,
    ]

    def copy_table(Model) -> None:
        sq = SqlSession()
        pg = PgSession()
        try:
            rows = list(sq.scalars(select(Model)).all())
            for row in rows:
                sq.expunge(row)
                pg.merge(row)
            pg.commit()
            print(f"  OK {Model.__tablename__}: {len(rows)} 行")
        except Exception:
            pg.rollback()
            raise
        finally:
            sq.close()
            pg.close()

    print("创建/校验 Postgres 表结构…")
    app_main.ensure_schema()

    print(f"从 SQLite 复制数据: {sqlite_path}")
    for M in MODEL_ORDER:
        print(f"  … {M.__tablename__}")
        copy_table(M)

    serial_tables = (
        "users",
        "chat_sessions",
        "chat_history",
        "section_learning_progress",
        "chapter_learning_progress",
        "user_learning_studio",
        "password_reset_tokens",
    )
    print("同步 Postgres 自增序列…")
    with app_main.engine.begin() as conn:
        for t in serial_tables:
            conn.execute(
                text(
                    f"SELECT setval(pg_get_serial_sequence('public.{t}', 'id'), "
                    f"(SELECT COALESCE(MAX(id), 1) FROM public.{t}), true)"
                )
            )
    print("完成。")


if __name__ == "__main__":
    main()
