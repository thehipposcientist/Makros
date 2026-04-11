@echo off
echo.
echo [reset-db] Stopping backend on port 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo        Done.
echo.

echo [reset-db] Deleting database...
if exist "%~dp0backend\workoutpal.db" (
    del /F "%~dp0backend\workoutpal.db"
    echo        Deleted workoutpal.db
) else (
    echo        No database found.
)
echo.
echo [reset-db] Done. Run start.bat to restart.
pause
