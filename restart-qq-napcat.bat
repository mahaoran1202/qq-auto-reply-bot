@echo off
chcp 65001 <nul >nul
title 重启 QQ 和 NapCat

net session >nul 2>&1
if not %ERRORLEVEL% == 0 (
    echo.
    echo    需要管理员权限
    echo    请右键这个文件 -^> 以管理员身份运行
    echo.
    pause
    exit /b
)

echo ================================================
echo    正在重启 QQ 和 NapCat
echo ================================================
echo.

echo [1/4] 正在关闭旧进程...
taskkill /F /IM NapCatWinBootMain.exe /T >nul 2>&1
taskkill /F /IM QQ.exe /T >nul 2>&1
echo       完成
timeout /t 5 /nobreak >nul

echo.
echo [2/4] 正在确认关干净了...
tasklist /FI "IMAGENAME eq QQ.exe" 2>nul | find /I "QQ.exe" >nul
if %ERRORLEVEL%==0 ( echo       警告：QQ 还在运行 ) else ( echo       QQ 已关闭 )
tasklist /FI "IMAGENAME eq NapCatWinBootMain.exe" 2>nul | find /I "NapCatWinBootMain.exe" >nul
if %ERRORLEVEL%==0 ( echo       警告：NapCat 还在运行 ) else ( echo       NapCat 已关闭 )

echo.
echo [3/4] 正在启动 NapCat（会自动带起 QQ）...
cd /d "%~dp0napcat"
if exist "launcher-autologin.bat" (
    start "" launcher-autologin.bat
    echo       使用自动登录模式
) else if exist "launcher-win10.bat" (
    start "" launcher-win10.bat
    echo       使用普通模式（需要扫码）
) else (
    echo   [错误] 找不到 napcat 启动脚本
    pause
    exit /b
)

echo.
echo [4/4] 等待 25 秒...
timeout /t 25 /nobreak >nul

echo.
echo ================================================
echo    端口检查
echo ================================================
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul
if %ERRORLEVEL%==0 (
    echo    [成功] 3001 端口正常 - NapCat 工作正常
) else (
    echo    [失败] 3001 端口不通
    echo           再等 10 秒，或者在 QQ 窗口里扫码
)
netstat -ano | findstr ":6099" | findstr "LISTENING" >nul
if %ERRORLEVEL%==0 ( echo    [成功] 6099 端口正常 - 管理页面可用 ) else ( echo    [失败] 6099 端口不通 )

echo.
echo ================================================
echo    下一步
echo ================================================
echo    1. 如果 QQ 窗口出现二维码，用手机 QQ 扫一下
echo    2. 打开面板点「启动机器人」
echo       http://127.0.0.1:4399
echo ================================================
echo.
pause