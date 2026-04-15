@echo off
title Tax Database Server - by Rendi Siagian
color 0A

echo.
echo  ============================================
echo   Tax Database System - by Rendi Siagian
echo  ============================================
echo.
echo  [*] Menyalakan server...
echo  [*] Buka browser: http://localhost:3000
echo.
echo  Tekan CTRL+C untuk mematikan server.
echo  ============================================
echo.

SET PATH=C:\laragon\bin\nodejs\node-v22;%PATH%
node app.js

echo.
echo  [!] Server berhenti.
pause
