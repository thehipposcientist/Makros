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

echo [0/2] Clearing old backend processes on port 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo       Done.
echo.

echo [1/2] Starting backend (port 8000)...
echo Note: If you update .env variables, restart the backend window manually
start "Makros Backend" cmd /k "cd /d "%~dp0backend" && venv\Scripts\activate && uvicorn app.main:app --host 0.0.0.0 --port 8000"

timeout /t 3 /nobreak >nul

echo [2/2] Starting Expo (LAN mode)...
echo       Phone must be on the same WiFi as this PC.
echo       If connection fails, run: start-tunnel.bat
echo.
npx expo start --clear
