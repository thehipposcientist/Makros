@echo off
echo.
echo  WARNING: This will delete ALL data and recreate the database from scratch.
echo.
set /p confirm="Are you sure? (y/N): "
if /i not "%confirm%"=="y" (
    echo Cancelled.
    pause
    exit /b 0
)
echo.

echo [1/3] Stopping everything...
docker compose down -v
echo       Done.
echo.

echo [2/3] Rebuilding and starting fresh...
docker compose up -d --build
if %errorlevel% neq 0 (
    echo       ERROR: Docker Compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)
echo       Done.
echo.

echo [3/3] Waiting for backend to seed database...
:wait_backend
curl -sf http://localhost:8000/health >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 2 /nobreak >nul
    goto wait_backend
)
echo       Done.
echo.

echo Database reset complete. Run "start.bat" to launch the app.
pause
