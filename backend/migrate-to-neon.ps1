# Migrate backend/users.db to Neon (or any Postgres).
# DATABASE_URL from (priority):
#   1) backend/.neon_database_url (single line URI, no quotes)
#   2) repo root render.deploy.env line DATABASE_URL=...
#
# Usage: cd backend ; .\migrate-to-neon.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$dbUrl = $null
$neonFile = Join-Path $PSScriptRoot ".neon_database_url"
if (Test-Path $neonFile) {
    $dbUrl = (Get-Content $neonFile -Raw).Trim()
}

if (-not $dbUrl) {
    $renderEnv = Join-Path (Split-Path $PSScriptRoot -Parent) "render.deploy.env"
    if (Test-Path $renderEnv) {
        foreach ($line in Get-Content $renderEnv) {
            $t = $line.Trim()
            if ($t -match '^\s*#' -or $t -eq "") { continue }
            if ($t -match '^\s*DATABASE_URL\s*=\s*(.+)$') {
                $dbUrl = $matches[1].Trim().Trim('"').Trim("'")
                break
            }
        }
    }
}

if (-not $dbUrl) {
    Write-Host "Missing DATABASE_URL. Do one of:"
    Write-Host "  A) Create backend/.neon_database_url with one line (postgresql://...)"
    Write-Host "  B) Add to repo root render.deploy.env: DATABASE_URL=postgresql://..."
    Write-Host "Then run: .\migrate-to-neon.ps1"
    exit 1
}

if ($dbUrl -notmatch '^(postgres|postgresql)://') {
    Write-Error "DATABASE_URL must start with postgres:// or postgresql://"
    exit 1
}

$sqliteDb = Join-Path $PSScriptRoot "users.db"
if (-not (Test-Path $sqliteDb)) {
    Write-Error "SQLite file not found: $sqliteDb"
    exit 1
}

$py = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Error "venv not found. Run: python -m venv venv ; pip install -r requirements.txt"
    exit 1
}

$env:DATABASE_URL = $dbUrl
Write-Host "Migrating $sqliteDb to Postgres..."
& $py (Join-Path $PSScriptRoot "migrate_sqlite_to_postgres.py") $sqliteDb
exit $LASTEXITCODE
