#!/usr/bin/env python3
"""Generate a Gmail API refresh token for Mentor password-reset email.

Prerequisites:
  1. Create an OAuth Client ID in Google Cloud Console.
  2. Use an "Desktop app" OAuth client.
  3. Enable the Gmail API.
  4. Run:
       python gmail_oauth_setup.py --client-id ... --client-secret ...

The script starts a local callback server, asks you to sign in with Gmail,
then prints the Railway variables you need. It does not save secrets.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer


SCOPE = "https://www.googleapis.com/auth/gmail.send"


class CallbackHandler(BaseHTTPRequestHandler):
    code: str | None = None
    state: str | None = None
    error: str | None = None

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        CallbackHandler.code = (qs.get("code") or [None])[0]
        CallbackHandler.state = (qs.get("state") or [None])[0]
        CallbackHandler.error = (qs.get("error") or [None])[0]
        body = (
            "<html><body><h2>Mentor Gmail setup received the callback.</h2>"
            "<p>You can close this tab and return to the terminal.</p></body></html>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def exchange_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    data = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Create Gmail API refresh token for Mentor")
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--client-secret", required=True)
    parser.add_argument("--from-email", default="", help="Gmail address used as the sender")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    state = secrets.token_urlsafe(18)
    redirect_uri = f"http://127.0.0.1:{args.port}/"
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(
        {
            "client_id": args.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPE,
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
    )

    print("Open this URL and approve Gmail send access:\n")
    print(auth_url)
    print("\nWaiting for Google callback on", redirect_uri)
    webbrowser.open(auth_url)

    server = HTTPServer(("127.0.0.1", args.port), CallbackHandler)
    server.handle_request()

    if CallbackHandler.error:
        sys.exit(f"Google returned error: {CallbackHandler.error}")
    if not CallbackHandler.code or CallbackHandler.state != state:
        sys.exit("OAuth callback was missing code or state did not match.")

    try:
        token_payload = exchange_code(args.client_id, args.client_secret, CallbackHandler.code, redirect_uri)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        sys.exit(f"Token exchange failed: HTTP {exc.code}\n{detail}")

    refresh_token = token_payload.get("refresh_token")
    if not refresh_token:
        sys.exit(
            "No refresh_token returned. Re-run with the same command and make sure prompt=consent is used; "
            "you may also need to remove the app from your Google Account permissions first."
        )

    print("\nAdd these variables to your Railway web service:\n")
    print(f"PASSWORD_RESET_GMAIL_CLIENT_ID={args.client_id}")
    print(f"PASSWORD_RESET_GMAIL_CLIENT_SECRET={args.client_secret}")
    print(f"PASSWORD_RESET_GMAIL_REFRESH_TOKEN={refresh_token}")
    if args.from_email:
        print(f"PASSWORD_RESET_GMAIL_FROM={args.from_email}")
    else:
        print("PASSWORD_RESET_GMAIL_FROM=your-gmail-address@gmail.com")


if __name__ == "__main__":
    main()
