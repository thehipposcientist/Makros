@echo off
echo.
echo  ███╗   ███╗ █████╗ ██╗  ██╗██████╗  ██████╗ ███████╗
echo  ████╗ ████║██╔══██╗██║ ██╔╝██╔══██╗██╔═══██╗██╔════╝
echo  ██╔████╔██║███████║█████╔╝ ██████╔╝██║   ██║███████╗
echo  ██║╚██╔╝██║██╔══██║██╔═██╗ ██╔══██╗██║   ██║╚════██║
echo  ██║ ╚═╝ ██║██║  ██║██║  ██╗██║  ██║╚██████╔╝███████║
echo  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
echo.
echo Starting Thallo (TUNNEL mode)...
echo.
echo NOTE: Tunnel mode requires a free ngrok account.
echo       If you see an error, run: npx ngrok authtoken YOUR_TOKEN
echo       Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken
echo.

echo [1/3] Starting PostgreSQL + Backend (Docker Compose)...
docker compose up -d --build
if %errorlevel% neq 0 (
    echo       ERROR: Docker Compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)
echo       Done.
echo.

echo [2/3] Waiting for backend to be ready...
:wait_backend
curl -sf http://localhost:8000/health >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 2 /nobreak >nul
    goto wait_backend
)
echo       Done.
echo.

echo [3/3] Starting Expo (tunnel)...
echo.
npx expo start --clear --tunnel
