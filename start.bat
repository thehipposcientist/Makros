@echo off
echo.
echo  ███╗   ███╗ █████╗ ██╗  ██╗██████╗  ██████╗ ███████╗
echo  ████╗ ████║██╔══██╗██║ ██╔╝██╔══██╗██╔═══██╗██╔════╝
echo  ██╔████╔██║███████║█████╔╝ ██████╔╝██║   ██║███████╗
echo  ██║╚██╔╝██║██╔══██║██╔═██╗ ██╔══██╗██║   ██║╚════██║
echo  ██║ ╚═╝ ██║██║  ██║██║  ██╗██║  ██║╚██████╔╝███████║
echo  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
echo.
echo Starting Makros...
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

echo [3/3] Starting Expo (LAN mode)...
echo       Scan the QR code with Expo Go on your phone.
echo       Both devices must be on the same WiFi network.
echo.
npx expo start --clear
