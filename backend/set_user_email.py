"""
为已存在用户补绑邮箱（用于旧账号或未在注册时填写邮箱、导致无法收重置邮件）。

用法（在 backend 目录）:
  python set_user_email.py niao your@email.com

依赖: 与本项目相同的 users.db（与 main.py 中 SQLALCHEMY_DATABASE_URL 一致）。
"""
import re
import sys
from pathlib import Path

import sqlite3

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")


def main() -> None:
    if len(sys.argv) != 3:
        print("用法: python set_user_email.py <用户名> <邮箱>")
        sys.exit(1)
    username, email = sys.argv[1].strip(), sys.argv[2].strip()
    if not _EMAIL_RE.fullmatch(email):
        print("邮箱格式不正确")
        sys.exit(1)
    db_path = Path(__file__).resolve().parent / "users.db"
    if not db_path.is_file():
        print("未找到数据库:", db_path)
        sys.exit(1)
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM users WHERE username = ?", (username,))
        row = cur.fetchone()
        if not row:
            print("用户不存在:", username)
            sys.exit(1)
        cur.execute(
            "UPDATE users SET email = ? WHERE username = ?",
            (email, username),
        )
        conn.commit()
        print(f"OK: 用户 {username} 已绑定邮箱 {email}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
