@echo off
REM One-click launcher: serve this folder over HTTP and open the browser.
cd /d "%~dp0"
start "" http://localhost:8099
python -m http.server 8099
