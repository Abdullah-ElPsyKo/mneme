@echo off
setlocal
cd /d "%~dp0"
if not exist "dist\server\cli.js" (
  echo Mneme needs its first build. Run npm ci and npm run build first.
  pause
  exit /b 1
)
node dist\server\cli.js serve --open %*
if errorlevel 1 pause
