"""
清除 users.db 中所有账号与关联聊天数据（用户 / 会话 / 消息）。
不删除课程数据（courses / chapters）。

使用：在 backend 目录执行
  python clear_auth_data.py
"""
from pathlib import Path
import sqlite3


def main() -> None:
    db_path = Path(__file__).resolve().parent / "users.db"
    if not db_path.is_file():
        print("DB not found:", db_path)
        return

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.cursor()
        cur.execute("DELETE FROM chat_history")
        cur.execute("DELETE FROM chat_sessions")
        try:
            cur.execute("DELETE FROM password_reset_tokens")
        except sqlite3.OperationalError:
            pass
        cur.execute("DELETE FROM users")
        conn.commit()
        print("OK: cleared chat_history, chat_sessions, users.")
        print("Browser: remove localStorage key 'currentUser' and keys starting with 'section_progress_' / 'chapter_progress_' (or clear site data).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
