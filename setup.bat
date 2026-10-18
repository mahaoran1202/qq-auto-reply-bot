@echo off
chcp 65001 <nul >nul
title QQ 机器人 - 第一次使用
cd /d "%~dp0"

echo.
echo ============================================================
echo    QQ 自动回复机器人 - 第一次使用
echo ============================================================
echo.

if not exist "tools\setup.mjs" (
    echo   [错误] 找不到 tools\setup.mjs
    echo   压缩包可能没解压完整，重新解压一次试试。
    echo.
    pause
    exit /b 1
)

call "%~dp0_node.bat"

if not defined NODE_EXE (
    echo   [错误] 找不到 Node.js 运行环境
    echo.
    echo   压缩包里本该自带 runtime\node\node.exe。
    echo   如果没有，请到 https://nodejs.org 下载 LTS 版装一下，
    echo   然后再运行本文件。
    echo.
    pause
    exit /b 1
)

"%NODE_EXE%" "tools\setup.mjs" %*
set "RC=%ERRORLEVEL%"

echo.
pause
exit /b %RC%
