@echo off
rem Codex memo installer / updater: downloads install.ps1 from GitHub and runs it.
set "PS1=%TEMP%\codex-memo-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest 'https://raw.githubusercontent.com/plushg0724-web/codex-memo-public/main/install.ps1' -OutFile $env:TEMP\codex-memo-install.ps1 -UseBasicParsing; & $env:TEMP\codex-memo-install.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. Please send a screenshot of this window.
)
pause
