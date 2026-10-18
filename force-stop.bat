@echo off
chcp 65001 <nul >nul
title 全部停止（机器人 / 面板 / NapCat / QQ）

echo ================================================
echo    全部停止
echo ================================================
echo.
echo    会关掉：机器人、控制面板、NapCat、QQ
echo    不会动：DSH、其他软件
echo.
pause

echo.
echo [1/3] 正在关闭机器人和面板...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bot\.js|web-ui' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('  已关闭 node 进程 ' + $_.ProcessId) }"
echo       完成

echo.
echo [2/3] 正在关闭 NapCat...
taskkill /F /IM NapCatWinBootMain.exe /T >nul 2>&1
echo       完成

echo.
echo [3/3] 正在关闭 QQ...
taskkill /F /IM QQ.exe /T >nul 2>&1
echo       完成

echo.
echo ================================================
echo    全部已停止
echo    重新启动：右键 restart-qq-napcat.bat（管理员）
echo              然后双击 open-panel.bat
echo ================================================
echo.
pause