@echo off
chcp 65001 <nul >nul
rem ============================================================
rem  定位 node.exe，供其它 bat 调用。
rem  优先用包里自带的 runtime\node\node.exe；
rem  找不到就退回系统装的 node。
rem
rem  用法： call "%~dp0_node.bat"      之后用 "%NODE_EXE%"
rem
rem  注意：这里刻意不写 for /f ... in ('where node.exe')。
rem        虽然实测 for /f 并不会吃掉重定向的输入（真凶是 chcp，
rem        见下面那行的 <nul），但它要起子进程解析输出，
rem        慢且脆。where /q 只判存在，再用裸命令名 node
rem        让 cmd 自己从 PATH 里解析，更简单。
rem ============================================================

set "NODE_EXE="

if exist "%~dp0runtime\node\node.exe" (
    set "NODE_EXE=%~dp0runtime\node\node.exe"
    goto :node_ready
)

where /q node.exe
if not errorlevel 1 (
    set "NODE_EXE=node"
    goto :node_ready
)

:node_ready
