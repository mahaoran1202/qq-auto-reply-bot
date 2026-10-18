@echo off
chcp 65001 <nul >nul
title QQ 机器人控制面板（保持窗口开着）

setlocal
cd /d "%~dp0"

echo ============================================
echo    QQ 机器人控制面板
echo ============================================
echo.
echo    正在启动...
echo    浏览器会自动打开：http://127.0.0.1:4399
echo.
echo    这个窗口不要关！
echo    关掉窗口 = 机器人停止运行。
echo.
echo ============================================
echo.

call "%~dp0_node.bat"
if not defined NODE_EXE (
    echo   [错误] 找不到 Node.js 运行环境
    echo.
    echo   请先双击「第一次用点我.bat」做一次自检。
    echo.
    pause
    exit /b 1
)

"%NODE_EXE%" src\web-ui.js
pause
exit /b %ERRORLEVEL%
