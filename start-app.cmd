@echo off
rem Starts Auto-Encoder with a visible window, for troubleshooting: messages appear here. Close it to stop the app.
rem Day to day, use the desktop shortcut instead (start-app.vbs), which runs it without a window.
cd /d "%~dp0"
if not exist "web\dist\index.html" (
  echo Building the screens for the first time...
  call npm --prefix web run build || goto :error
)
rem The browser opens two seconds later, once the server is listening.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server\index.js
goto :eof
:error
echo.
echo The screens could not be built. See the messages above.
pause
