@echo off
echo.
echo Stopping Makros...
echo.

echo [1/2] Stopping Expo / Metro (port 8081)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8081 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo       Done.
echo.

echo [2/2] Stopping PostgreSQL + Backend (Docker Compose)...
docker compose down
echo       Done.
echo.

echo All services stopped.
pause
