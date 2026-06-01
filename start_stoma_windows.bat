@echo off
setlocal
cd /d "%~dp0"
set PORT=8765

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set PYCMD=py
) else (
  set PYCMD=python
)

start "" http://127.0.0.1:%PORT%/index.html
%PYCMD% -m http.server %PORT%
