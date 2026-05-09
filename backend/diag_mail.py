"""一次性诊断：.env SMTP、users 表邮箱、向本邮箱发测试信。"""
from pathlib import Path

import os
import sqlite3
import ssl
import smtplib
from email.message import EmailMessage

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


def main() -> None:
    host = (os.getenv("PASSWORD_RESET_SMTP_HOST") or "").strip()
    port = int(os.getenv("PASSWORD_RESET_SMTP_PORT", "587"))
    user = (os.getenv("PASSWORD_RESET_SMTP_USER") or "").strip()
    password = os.getenv("PASSWORD_RESET_SMTP_PASSWORD") or ""
    sender = (os.getenv("PASSWORD_RESET_SMTP_FROM") or user or "").strip()

    print("SMTP_HOST:", repr(host))
    print("SMTP_PORT:", port)
    print("SMTP_USER set:", bool(user))
    print("SMTP_PASSWORD len:", len(password))
    print("SMTP_FROM:", repr(sender))

    db = Path(__file__).resolve().parent / "users.db"
    conn = sqlite3.connect(db)
    print("\nusers (username, email):")
    for row in conn.execute("SELECT username, email FROM users"):
        print(" ", row[0], "|", row[1] or "(无)")
    conn.close()

    if not host or not user or not password or not sender:
        print("\n[结论] .env 中 SMTP 配置不完整，无法发信。")
        return

    to_addr = user
    msg = EmailMessage()
    msg["Subject"] = "Mentor SMTP 自检"
    msg["From"] = sender
    msg["To"] = to_addr
    msg.set_content("若收到本邮件，说明 SMTP 与授权码可用。可删除本脚本后正常使用找回密码。")

    ctx = ssl.create_default_context()
    print("\n尝试连接并发送测试邮件到:", to_addr)

    def try_send(p: int, use_ssl: bool) -> bool:
        label = f"{'SSL' if use_ssl else 'STARTTLS'} port {p}"
        print(f"\n--- 尝试 {label} ---")
        try:
            if use_ssl:
                with smtplib.SMTP_SSL(host, p, timeout=45, context=ctx) as smtp:
                    smtp.login(user, password)
                    smtp.send_message(msg)
            else:
                with smtplib.SMTP(host, p, timeout=45) as smtp:
                    smtp.ehlo()
                    smtp.starttls(context=ctx)
                    smtp.ehlo()
                    smtp.login(user, password)
                    smtp.send_message(msg)
            print(f"[成功] {label}，请到收件箱/垃圾箱查看。")
            return True
        except Exception as e:
            print(f"[失败] {label}:", type(e).__name__, str(e))
            return False

    ok = try_send(587, False)
    if not ok:
        try_send(465, True)


if __name__ == "__main__":
    main()
