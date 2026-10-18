@echo off
REM ============================================================
REM  NapCat auto-login launcher (TEMPLATE)
REM
REM  HOW TO USE:
REM    1. Copy this file into the "napcat" folder
REM    2. Replace the QQ number below with your own
REM    3. In config.json set:
REM         "napcat": { "command": "C:\\...\\napcat\\launcher-autologin.bat" }
REM
REM  NOTE: quick-login only skips the QR scan when Tencent still
REM        has a valid local session. If you have not logged in
REM        for a while (or changed network), you must scan once.
REM ============================================================

set "QQNUMBER=PUT_YOUR_QQ_HERE"

chcp 65001 >nul
title NapCat Auto Login

net session >nul 2>&1
if %ERRORLEVEL% == 0 (
    echo Administrator mode OK.
) else (
    echo Requesting administrator...
    powershell -Command "Start-Process 'cmd.exe' -ArgumentList '/c cd /d \"%cd%\" && \"%~f0\" %*' -Verb runAs"
    exit
)

set NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json
set NAPCAT_LOAD_PATH=%cd%\loadNapCat.js
set NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll
set NAPCAT_LAUNCHER_PATH=%cd%\NapCatWinBootMain.exe
set NAPCAT_MAIN_PATH=%cd%\napcat.mjs

REM ---- locate QQ.exe from registry ----
for /f "tokens=2*" %%a in ('reg query "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString"') do (
    set "RetString=%%~b"
    goto :napcat_boot
)

:napcat_boot
for %%a in ("%RetString%") do (
    set "pathWithoutUninstall=%%~dpa"
)
set "QQPath=%pathWithoutUninstall%QQ.exe"

if not exist "%QQPath%" (
    echo [ERROR] QQ.exe not found at: %QQPath%
    pause
    exit /b
)

set NAPCAT_MAIN_PATH=%NAPCAT_MAIN_PATH:\=/%
echo (async () =^> {await import("file:///%NAPCAT_MAIN_PATH%")})() > "%NAPCAT_LOAD_PATH%"

echo.
echo ============================================================
echo   Starting QQ + NapCat with auto-login
echo   Account: %QQNUMBER%
echo ============================================================
echo.

REM ---- -q ^<QQ number^> = quick login (no QR scan) ----
"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%" -q %QQNUMBER%
