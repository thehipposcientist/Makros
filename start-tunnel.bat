@echo off
echo.
echo  ███╗   ███╗ █████╗ ██╗  ██╗██████╗  ██████╗ ███████╗
echo  ████╗ ████║██╔══██╗██║ ██╔╝██╔══██╗██╔═══██╗██╔════╝
echo  ██╔████╔██║███████║█████╔╝ ██████╔╝██║   ██║███████╗
echo  ██║╚██╔╝██║██╔══██║██╔═██╗ ██╔══██╗██║   ██║╚════██║
echo  ██║ ╚═╝ ██║██║  ██║██║  ██╗██║  ██║╚██████╔╝███████║
echo  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
echo.
echo Starting Makros (TUNNEL mode)...
echo.
echo NOTE: Tunnel mode requires a free ngrok account.
echo       If you see an error, run: npx ngrok authtoken YOUR_TOKEN
echo       Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken
echo.

echo [0/2] Clearing old backend processes on port 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo       Done.
echo.

echo [1/2] Starting backend (port 8000)...
start "Makros Backend" cmd /k "cd /d "%~dp0backend" && venv\Scripts\activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"

timeout /t 2 /nobreak >nul

echo [2/2] Starting Expo (tunnel)...
echo.
npx expo start --clear --tunnel
