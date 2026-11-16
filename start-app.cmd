@echo off
rem Starts Auto-Encoder and opens it in the browser. Close this window to stop the app.
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
