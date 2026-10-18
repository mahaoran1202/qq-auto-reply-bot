# 一键升级 QQ NT 到兼容 NapCat 的版本（以管理员运行，自动写日志，装完自动退出）
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'qq_upgrade.log'
"===== 开始 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====" | Out-File $log -Encoding utf8

Write-Host '正在用 winget 升级 QQ (Tencent.QQ.NT) ...' -ForegroundColor Cyan
winget install --id Tencent.QQ.NT --accept-source-agreements --accept-package-agreements --disable-interactivity *>> $log 2>&1
$code = $LASTEXITCODE
"===== winget exit code: $code =====" | Out-File $log -Append -Encoding utf8
