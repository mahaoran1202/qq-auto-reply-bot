@echo off
chcp 65001 <nul >nul
title 修复 NapCat 连接（需管理员）

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
echo    修复 NapCat / QQ 连接
echo ================================================
echo.

echo [1/4] 正在清理残留进程...
taskkill /F /IM NapCatWinBootMain.exe /T >nul 2>&1
taskkill /F /IM QQ.exe /T >nul 2>&1
echo       完成
timeout /t 4 /nobreak >nul

echo.
echo [2/4] 正在确认...
tasklist /FI "IMAGENAME eq QQ.exe" 2>nul | find /I "QQ.exe" >nul
if %ERRORLEVEL%==0 ( echo       警告：QQ 还在运行 ) else ( echo       QQ 已关闭 )
tasklist /FI "IMAGENAME eq NapCatWinBootMain.exe" 2>nul | find /I "NapCatWinBootMain.exe" >nul
if %ERRORLEVEL%==0 ( echo       警告：NapCat 还在运行 ) else ( echo       NapCat 已关闭 )

echo.
echo [3/4] 正在启动 NapCat（会自动带起 QQ）...
cd /d "%~dp0napcat"
if exist "launcher-autologin.bat" (
    start "" launcher-autologin.bat
) else (
    start "" launcher-win10.bat
)
echo       已启动

echo.
echo [4/4] 等待 25 秒让 NapCat 就绪...
timeout /t 25 /nobreak >nul

echo.
echo ================================================
echo    端口检查
echo ================================================
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul
if %ERRORLEVEL%==0 ( echo    [成功] 3001 端口已监听 - NapCat 正常 ) else ( echo    [失败] 3001 端口未监听 - 可能还需要扫码 )

echo.
echo ================================================
echo    下一步：如果 QQ 窗口有二维码就扫码，
echo    然后回面板点「启动机器人」。
echo ================================================
echo.
pause