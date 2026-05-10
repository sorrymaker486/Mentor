# One-shot backend setup: .env from example, venv, pip install.
# Run from backend folder:
#   powershell -ExecutionPolicy Bypass -File .\setup_local.ps1
# Edit .env: PASSWORD_RESET_RESEND_API_KEY=re_...
# Full test:
#   powershell -ExecutionPolicy Bypass -File .\setup_local.ps1 -TestEmail you@example.com

param(
    [string]$TestEmail = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[OK] Created .env from .env.example. Edit it: set PASSWORD_RESET_RESEND_API_KEY=re_..."
} else {
    Write-Host "[SKIP] .env already exists."
}

if (-not (Test-Path ".venv")) {
    python -m venv .venv
    Write-Host "[OK] Created .venv"
}

& .\.venv\Scripts\python.exe -m pip install -q --upgrade pip

Write-Host "[OK] Installing python-dotenv (for Resend local test + main.py .env)..."
& .\.venv\Scripts\pip.exe install -q -r requirements-resend-test.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERR] Minimal install failed."
    exit $LASTEXITCODE
}

Write-Host "[OK] Installing full backend deps (optional; may fail on slow network)..."
& .\.venv\Scripts\pip.exe install -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARN] Full requirements.txt install failed. You can still run test_resend_local.py if Resend key is set."
} else {
    Write-Host "[OK] Full requirements.txt installed."
}

if ($TestEmail -ne "") {
    Write-Host "--- Resend test ---"
    & .\.venv\Scripts\python.exe test_resend_local.py --to $TestEmail
} else {
    Write-Host "Next: edit .env with your Resend key, then:"
    Write-Host '  .\.venv\Scripts\python.exe test_resend_local.py --to YOUR_EMAIL'
}
