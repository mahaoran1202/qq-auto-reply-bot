@echo off
chcp 65001 <nul >nul
title QQ 机器人控制面板
cd /d "%~dp0"

echo 正在启动控制面板...
echo.

if not exist "src\web-ui.js" (
    echo   [错误] 找不到 src\web-ui.js，是不是放错文件夹了？
    pause
    exit /b 1
)

call "%~dp0_node.bat"
if not defined NODE_EXE (
    echo   [错误] 找不到 Node.js 运行环境
    echo   请先双击「第一次用点我.bat」做一次自检。
    pause
    exit /b 1
)

start "" /B "%NODE_EXE%" src\web-ui.js
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:4399

echo 面板地址：http://127.0.0.1:4399
echo.
echo 这个窗口可以关掉，面板会继续运行。
timeout /t 5 /nobreak >nul
