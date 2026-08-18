@echo off
set "ROOT=%~dp0"
set "PORT=3211"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$conn = Get-NetTCPConnection -LocalPort ([int]$env:PORT) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue; if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } }"
start "Image Studio Standalone Server" /min cmd /c node "%ROOT%server.js"
timeout /t 1 >nul

start "" "http://127.0.0.1:%PORT%/"
