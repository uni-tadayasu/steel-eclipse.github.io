@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title STEEL ECLIPSE - Multiplayer Server
where node >nul 2>&1
if errorlevel 1 (
 echo [ERROR] Node.js is not installed or not on PATH.
 echo Download from: https://nodejs.org/
 echo Install Node.js 22 or newer and restart this window.
 pause
 exit /b 1
)
echo ===========================================================
echo  STEEL ECLIPSE / REFORGED RECORDS / LIVE ROOM SERVER
 echo ===========================================================
echo.
echo  PC browser : http://localhost:3000/
echo  MOBILE     : http://[YOUR PC IPv4 ADDRESS]:3000/
echo.
echo  Find your local address with: ipconfig
 echo  Keep this window open while your friends play.
echo ===========================================================
echo.
node server.js
if errorlevel 1 (
 echo.
 echo [ERROR] Server stopped. Check if port 3000 is already used.
 pause
)
endlocal
