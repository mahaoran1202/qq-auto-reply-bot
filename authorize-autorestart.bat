@echo off
chcp 65001 <nul >nul
title 授权自动重启（跑一次就行）

net session >nul 2>&1
if not %ERRORLEVEL% == 0 (
    echo.
    echo   ==========================================
    echo    需要管理员权限
    echo    请右键这个文件 -^> 以管理员身份运行
    echo   ==========================================
    echo.
    pause
    exit /b
)

echo ================================================
echo    授权 QQ 机器人自动重启
echo ================================================
echo.
echo    这个操作会创建一个计划任务，让机器人
echo    在 QQ 掉线时能自动重启，不用你点确认框。
echo.
echo    只需要跑这一次。以后掉线会自己恢复。
echo.
pause

set SCRIPT=%~dp0restart-qq-napcat.bat
set TASKNAME=QQBot_NapCatRestart

echo 正在创建计划任务...
schtasks /Delete /TN "%TASKNAME%" /F >nul 2>&1
schtasks /Create /TN "%TASKNAME%" /TR "cmd.exe /c \"%SCRIPT%\"" /SC ONCE /ST 00:00 /RL HIGHEST /F >nul 2>&1

if %ERRORLEVEL%==0 (
    echo    [成功] 计划任务已创建
    echo.
    echo ================================================
    echo    完成
    echo ================================================
    echo    以后 QQ 掉线时，机器人会自动：
    echo      1. 弹窗提醒你
    echo      2. 自动重启 QQ 和 NapCat（免确认）
    echo      3. 你只需要扫码登录
    echo ================================================
) else (
    echo    [失败] 请手动运行下面这条命令：
    echo    schtasks /Create /TN "%TASKNAME%" /TR "cmd.exe /c \"%SCRIPT%\"" /SC ONCE /ST 00:00 /RL HIGHEST /F
)

echo.
pause