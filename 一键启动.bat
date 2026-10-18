@echo off
chcp 65001 <nul >nul
title QQ 机器人 一键启动

rem ============================================================
rem  一键启动 —— 给完全没弄过的人用：只需要双击这一个文件
rem
rem  每一步都会写进「一键启动日志.txt」，出问题看那个文件。
rem  这个脚本里不用任何跨行的 if (...) 块（cmd 解析中文时容易拆坏），
rem  一律用 goto 扁平跳转。
rem ============================================================

set "LOG=%~dp0一键启动日志.txt"
set "EFILE=%~dp0_elevate.txt"
set "SELF=%~f0"
cd /d "%~dp0"

>"%LOG%" echo ================ QQ 机器人 一键启动 ================

call :say "================================================"
call :say "   QQ 机器人 一键启动"
call :say "================================================"
call :say ""

rem ---------- 0. 提权 ----------
if "%~1"=="elevated" goto :elevated
net session >nul 2>&1
if "%ERRORLEVEL%"=="0" goto :elevated

call :say "   需要管理员权限（NapCat 要把模块注入 QQ 进程）"
call :say "   马上会弹「用户账户控制」窗口，请点「是」"
call :say "   如果没看到弹窗，看看任务栏有没有一个闪烁的盾牌图标。"
call :say ""

del "%EFILE%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:SELF -ArgumentList 'elevated' -Verb RunAs -ErrorAction Stop; 'OK' | Out-File -FilePath $env:EFILE -Encoding utf8 -Force } catch { ('FAIL: ' + $_.Exception.Message) | Out-File -FilePath $env:EFILE -Encoding utf8 -Force; exit 1 }"
set "ELEV_RC=%ERRORLEVEL%"
call :say "   提权请求已发出（返回码 %ELEV_RC%）"
if not "%ELEV_RC%"=="0" goto :elev_failed
call :show ""
call :show "   新的管理员窗口已经打开，这个窗口 8 秒后关闭。"
call :bye 8
exit /b 0

:elev_failed
call :say ""
call :say "   [失败] 没有拿到管理员权限，所以没法启动 NapCat。"
call :say "   详细原因："
type "%EFILE%" 2>nul
call :say ""
call :say "   解决办法：右键「一键启动.bat」-> 以管理员身份运行"
call :say ""
echo.
pause
exit /b 1

rem ---------- 已提权 ----------
:elevated
call :say "[0/5] 管理员权限 OK"

rem ---------- 1. 自检 Node.js ----------
call :say ""
call :say "[1/5] 检查 Node.js ..."
call "%~dp0_node.bat"
if not defined NODE_EXE goto :err_node
call :say "      Node.js 就绪（%NODE_EXE%）"

rem ---------- 2. 自检 NapCat ----------
if not exist "%~dp0napcat\NapCatWinBootMain.exe" goto :err_napcat
call :say "      NapCat 就绪"

rem ---------- 3. 自检 QQ ----------
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v UninstallString >nul 2>&1
if not "%ERRORLEVEL%"=="0" goto :err_qq
call :say "      电脑上的 QQ 就绪"

rem ---------- 4. 配置 ----------
if exist "%~dp0config.json" goto :have_config
call :say ""
call :say "      第一次用，先回答几个问题（直接回车 = 用括号里的默认值）："
call :say ""
call "%~dp0setup.bat"
if not exist "%~dp0config.json" goto :err_config
:have_config
call :say "      配置文件就绪"

rem ---------- 5. 启动 QQ + NapCat ----------
call :say ""
call :port_open 3001
if "%PORT_OPEN%"=="1" goto :napcat_running

call :say "[4/5] 正在启动 QQ + NapCat ..."

tasklist /FI "IMAGENAME eq NapCatWinBootMain.exe" /NH 2>nul | findstr /I "NapCatWinBootMain" >nul
if errorlevel 1 goto :no_boot_proc
call :say "      先关掉旧的 NapCat 进程"
taskkill /F /IM NapCatWinBootMain.exe /T >nul 2>&1
:no_boot_proc

tasklist /FI "IMAGENAME eq QQ.exe" /NH 2>nul | findstr /I "QQ.exe" >nul
if errorlevel 1 goto :no_qq_proc
call :say "      检测到 QQ 正在运行，先关闭它（NapCat 必须在 QQ 启动那一刻注入）"
taskkill /F /IM QQ.exe /T >nul 2>&1
:no_qq_proc

ping -n 3 127.0.0.1 >nul 2>&1

if not exist "%~dp0napcat\launcher-autologin.bat" goto :launch_manual
call :say "      用自动登录模式启动（-q）"
start "" /D "%~dp0napcat" launcher-autologin.bat
goto :wait_napcat

:launch_manual
call :say "      用扫码登录模式启动"
start "" /D "%~dp0napcat" launcher-win10.bat

:wait_napcat
call :say "      等待连接（最多 90 秒）..."
set /a WAITED=0
:wait_loop
call :port_open 3001
if "%PORT_OPEN%"=="1" goto :napcat_ready
if %WAITED% GEQ 45 goto :napcat_timeout
set /a WAITED+=1
ping -n 3 127.0.0.1 >nul 2>&1
goto :wait_loop

:napcat_ready
call :say "      连上了"

:napcat_running
if "%PORT_OPEN%"=="1" call :say "[4/5] QQ + NapCat 已就绪"
goto :start_bot

:napcat_timeout
call :say ""
call :say "      [注意] 90 秒还没连上，多半是要扫码登录："
call :say "        1. 屏幕上会有一个 QQ 登录窗口（没看到就看任务栏）"
call :say "        2. 用手机 QQ 扫上面的二维码，点「允许登录」"
call :say "        3. 登录成功后它自己会连上，这个窗口不用管"

rem ---------- 6. 机器人和面板 ----------
:start_bot
call :say ""
call :port_open 4399
if "%PORT_OPEN%"=="1" goto :bot_running
call :say "[5/5] 正在启动机器人和控制面板 ..."
start "" "%~dp0start.bat"
ping -n 4 127.0.0.1 >nul 2>&1
goto :done

:bot_running
call :say "[5/5] 控制面板已经在跑（4399 通了），跳过"

:done
call :say ""
call :say "================================================"
call :say "   启动完成"
call :say "================================================"
call :say "   控制面板： http://127.0.0.1:4399"
call :say ""
call :say "   会留下两个窗口，都别关："
call :say "     「QQ 机器人控制面板」  机器人在里面跑"
call :say "     「NapCat Auto Login」  连 QQ 的"
call :say ""
call :say "   如果机器人窗口里一直刷 ECONNREFUSED，"
call :say "   说明 QQ 还没登录成功，扫码后就会自己连上。"
call :say ""
call :say "   这个窗口 15 秒后自动关闭。"
call :say "================================================"
start "" "http://127.0.0.1:4399"
call :bye 15
exit /b 0

rem ---------- 出错分支：一律不自动关窗，让用户看到原因 ----------
:err_node
call :say ""
call :say "   [错误] 找不到 Node.js"
call :say "          包里应该自带 runtime\node\node.exe"
call :say "          多半是压缩包没解压完整，请重新解压。"
goto :halt

:err_napcat
call :say ""
call :say "   [错误] NapCat 文件不全"
call :say "          找不到 napcat\NapCatWinBootMain.exe"
call :say "          请重新解压整个压缩包。"
goto :halt

:err_qq
call :say ""
call :say "   [错误] 电脑上没找到 QQ（PC 版）"
call :say "          NapCat 是把模块注入 QQ 来工作的，所以必须先装 QQ。"
call :say "          去 qq.com 下载安装 Windows 版 QQ，装好再双击这个文件。"
goto :halt

:err_config
call :say ""
call :say "   [错误] 配置没有生成，已停止。"

:halt
call :say ""
call :say "   日志文件：%~dp0一键启动日志.txt"
call :say ""
echo.
pause
exit /b 1

rem ============================================================
rem  子程序：打印一行 + 写日志
rem ============================================================
:say
echo(%~1
>>"%LOG%" echo([%TIME%] %~1
goto :eof

rem ============================================================
rem  子程序：只打印，不写日志
rem  （提权那一段要用它；否则父窗口和子窗口会同时写一个日志文件，
rem    内容会交错在一起，看起来顺序全乱）
rem ============================================================
:show
echo(%~1
goto :eof

rem ============================================================
rem  子程序：倒计时若干秒后自动关窗
rem  （不用 timeout，避免它去读 stdin）
rem ============================================================
:bye
set "BYE_N=%~1"
if "%BYE_N%"=="" set "BYE_N=15"
ping -n %BYE_N% 127.0.0.1 >nul 2>&1
goto :eof

rem ============================================================
rem  子程序：检测端口是否在监听，结果放 PORT_OPEN（1/0）
rem ============================================================
:port_open
set "PORT_OPEN=0"
netstat -ano | findstr ":%1 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 set "PORT_OPEN=1"
goto :eof
