$p = Start-Process -FilePath "$PSScriptRoot\node_modules\electron\dist\electron.exe" -ArgumentList $PSScriptRoot -NoNewWindow -PassThru -RedirectStandardOutput "$PSScriptRoot\stdout.log" -RedirectStandardError "$PSScriptRoot\stderr.log"
Write-Host "Started PID: $($p.Id)"
