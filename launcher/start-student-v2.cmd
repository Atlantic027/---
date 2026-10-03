@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-student-v2.ps1" %*
if errorlevel 1 pause
endlocal
