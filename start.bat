@echo off
title Tax Database Server - by Rendi Siagian
color 0A

:: Mendeteksi IP Lokal
for /f "delims=" %%a in ('powershell -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress -First 1"') do set LOCAL_IP=%%a

echo.
echo  ============================================
echo   Tax Database System - by Rendi Siagian
echo  ============================================
echo.
echo  [*] Menyalakan server...
echo  [*] Localhost: http://localhost:3000
if not "%LOCAL_IP%"=="" echo  [*] Network:   http://%LOCAL_IP%:3000
echo.
echo  Tekan CTRL+C untuk mematikan server.
echo  ============================================
echo.

SET PATH=C:\laragon\bin\nodejs\node-v22;%PATH%
node app.js

echo.
echo  [!] Server berhenti.
pause
