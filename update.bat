@echo off
chcp 65001 >nul
title School board - update
cd /d "%~dp0"

echo.
echo === Step 1: download the latest version from GitHub ===
git pull
if errorlevel 1 (
  echo.
  echo ERROR: git pull failed. Take a screenshot and send it to Claude.
  pause
  exit /b 1
)

echo.
echo === Step 2: install dependencies if needed ===
if not exist node_modules (
  call npm install
)

echo.
echo === Step 3: start the panel ===
echo Close this window to stop the panel.
echo Admin:  http://localhost:3000/admin
echo TV:     http://localhost:3000/tv
echo.
call npm start
pause
