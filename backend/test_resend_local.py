#!/usr/bin/env python3
"""
本地验证 Resend API Key（优先官方 SDK resend.Emails.send，与 main.py 一致）。

用法（在 backend 目录）:
  python test_resend_local.py --to 你的邮箱@example.com

从 backend/.env 读取（任选其一）:
  PASSWORD_RESET_RESEND_API_KEY 或 RESEND_API_KEY
  PASSWORD_RESET_RESEND_FROM 或 RESEND_FROM（默认 onboarding@resend.dev）

环境变量 PASSWORD_RESET_RESEND_USE_SDK=0 可强制仅用 urllib（与旧版测试一致）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _strip(val: str) -> str:
    s = (val or "").strip().strip("\ufeff")
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1].strip()
    return s


def _send_via_urllib(key: str, from_addr: str, to_addr: str) -> None:
    payload = json.dumps(
        {
            "from": from_addr,
            "to": [to_addr.strip()],
            "subject": "Mentor 本地 Resend 测试",
            "text": "若收到此邮件，说明 Key 与 from 配置正确。",
            "html": "<p>若收到此邮件，说明 Key 与 <code>from</code> 配置正确。</p>",
        },
        ensure_ascii=False,
    ).encode("utf-8")

    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": "Mentor-Academic-Suite/1.0-local-test (+https://resend.com/docs)",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(f"HTTP {resp.status} OK (urllib)")
            print(body[:500])
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}", file=sys.stderr)
        print(err[:800], file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        print(f"网络错误: {e}", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="本地测试 Resend 发信")
    parser.add_argument(
        "--to",
        required=True,
        help="收件邮箱（Resend 测试域名可能对收件人有限制）",
    )
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv

        env_path = Path(__file__).resolve().parent / ".env"
        if env_path.is_file():
            load_dotenv(env_path)
    except ImportError:
        print("提示: 未安装 python-dotenv，仅使用当前 shell 已 export 的环境变量。", file=sys.stderr)

    key = _strip(os.getenv("PASSWORD_RESET_RESEND_API_KEY", "")) or _strip(os.getenv("RESEND_API_KEY", ""))
    from_addr = (
        _strip(os.getenv("PASSWORD_RESET_RESEND_FROM", ""))
        or _strip(os.getenv("RESEND_FROM", ""))
        or "onboarding@resend.dev"
    )

    if not key:
        print(
            "未找到 API Key。请在 backend/.env 中设置:\n"
            "  PASSWORD_RESET_RESEND_API_KEY=re_...\n"
            "  或 RESEND_API_KEY=re_...\n"
            "可选: PASSWORD_RESET_RESEND_FROM / RESEND_FROM",
            file=sys.stderr,
        )
        sys.exit(1)

    print(
        "诊断（不含密钥）:",
        f"Key 长度={len(key)}, re_前缀={'是' if key.startswith('re_') else '否'},",
        f"from={from_addr!r}, to={args.to!r}",
    )

    use_sdk = os.getenv("PASSWORD_RESET_RESEND_USE_SDK", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )

    send_params = {
        "from": from_addr,
        "to": [args.to.strip()],
        "subject": "Mentor 本地 Resend 测试",
        "text": "若收到此邮件，说明 Key 与 from 配置正确。",
        "html": "<p>若收到此邮件，说明 Key 与 <code>from</code> 配置正确。</p>",
    }

    if use_sdk:
        try:
            import resend
            from resend.exceptions import ResendError
        except ImportError:
            print("未安装 resend 包，改用 urllib。可执行: pip install -r requirements-resend-test.txt", file=sys.stderr)
            _send_via_urllib(key, from_addr, args.to)
            return
        try:
            resend.api_key = key
            out = resend.Emails.send(send_params)
            eid = getattr(out, "id", None)
            print(f"HTTP OK (Resend SDK)，email id={eid!r}")
        except ResendError as exc:
            print(f"Resend SDK HTTP {exc.code}: {exc.message} ({exc.error_type})", file=sys.stderr)
            sys.exit(1)
        except Exception as exc:
            print(f"Resend SDK 异常，回退 urllib：{exc}", file=sys.stderr)
            _send_via_urllib(key, from_addr, args.to)
        return

    _send_via_urllib(key, from_addr, args.to)


if __name__ == "__main__":
    main()
