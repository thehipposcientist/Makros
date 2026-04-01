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

echo [1/2] Starting backend (port 8000)...
echo Note: If you update .env variables, restart the backend window manually
start "Makros Backend" cmd /k "cd /d "%~dp0backend" && venv\Scripts\activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

timeout /t 2 /nobreak >nul

echo [2/2] Starting Expo (with cache clear)...
echo.
npx expo start --clear
