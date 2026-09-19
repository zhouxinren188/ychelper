param([string]$Version = '1.0.94', [string]$ExistingFixtureRoot = '')
$ErrorActionPreference = 'Stop'
$releaseRoot = [IO.Path]::GetFullPath($(if ($ExistingFixtureRoot) { $ExistingFixtureRoot } else { Join-Path $env:TEMP ('ychelper-release-smoke-' + $Version + '-' + [guid]::NewGuid().ToString('N')) }))
if (-not $releaseRoot.StartsWith([IO.Path]::GetFullPath($env:TEMP) + '\')) { throw 'Test directory is outside TEMP' }
$releaseBackup = Join-Path $releaseRoot ('backup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $releaseBackup -Force | Out-Null
$releaseGuid = 'ec28313f-d784-5e52-8ed5-a59efff37e23'
$releaseRegistry = @("HKCU\Software\$releaseGuid", "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$releaseGuid")
$releaseLinks = @((Join-Path ([Environment]::GetFolderPath('Desktop')) '云仓助手.lnk'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\云仓助手.lnk'))
$releaseInstallerCache = Join-Path $env:LOCALAPPDATA 'cloud-warehouse-assistant-updater\installer.exe'
$releaseExe = Join-Path $env:LOCALAPPDATA 'Programs\cloud-warehouse-assistant\云仓助手.exe'
$releaseExeHash = if (Test-Path -LiteralPath $releaseExe) { (Get-FileHash -LiteralPath $releaseExe).Hash } else { '' }
foreach ($releaseIndex in 0..1) {
  & reg.exe export $releaseRegistry[$releaseIndex] (Join-Path $releaseBackup "registry-$releaseIndex.reg") /y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot back up exact installation registration' }
  if (Test-Path -LiteralPath $releaseLinks[$releaseIndex]) { Copy-Item -LiteralPath $releaseLinks[$releaseIndex] -Destination (Join-Path $releaseBackup "shortcut-$releaseIndex.lnk") }
}
if (Test-Path -LiteralPath $releaseInstallerCache) { Copy-Item -LiteralPath $releaseInstallerCache -Destination (Join-Path $releaseBackup 'installer-cache.exe') }
try {
  foreach ($releaseRegistryKey in $releaseRegistry) {
    & reg.exe delete $releaseRegistryKey /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot isolate exact installation registration' }
  }
  $releaseInstall = Join-Path $releaseRoot 'install'
  if (-not $ExistingFixtureRoot) {
  $releaseStart = [Diagnostics.ProcessStartInfo]::new()
  $releaseStart.FileName = (Resolve-Path -LiteralPath 'dist/ychelper-setup-1.0.66.exe').Path
  $releaseStart.Arguments = "/S /D=$releaseInstall"
  $releaseStart.UseShellExecute = $false
  $releaseStart.CreateNoWindow = $true
  $releaseStart.WindowStyle = 'Hidden'
  $releaseInstaller = [Diagnostics.Process]::Start($releaseStart)
  if (-not $releaseInstaller.WaitForExit(60000)) { $releaseInstaller.Kill(); throw 'Oldest isolated installer timed out' }
  if ($releaseInstaller.ExitCode -ne 0) { throw 'Oldest isolated installer failed' }
  } else {
    $releaseFixtureExe = Join-Path $releaseInstall '云仓助手.exe'
    $releaseFixtureUninstaller = Join-Path $releaseInstall 'Uninstall 云仓助手.exe'
    if (-not (Test-Path -LiteralPath $releaseFixtureExe) -or -not (Test-Path -LiteralPath $releaseFixtureUninstaller)) { throw 'Previously installed fixture is incomplete' }
    & reg.exe add $releaseRegistry[0] /v InstallLocation /t REG_SZ /d $releaseInstall /f | Out-Null
    & reg.exe add $releaseRegistry[0] /v KeepShortcuts /t REG_SZ /d true /f | Out-Null
    & reg.exe add $releaseRegistry[0] /v ShortcutName /t REG_SZ /d '云仓助手' /f | Out-Null
    & reg.exe add $releaseRegistry[1] /v UninstallString /t REG_SZ /d ('"' + $releaseFixtureUninstaller + '" /currentuser') /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Isolated fixture registration failed' }
    $releaseShell = New-Object -ComObject WScript.Shell
    foreach ($releaseLink in $releaseLinks) { $releaseShortcut = $releaseShell.CreateShortcut($releaseLink); $releaseShortcut.TargetPath = $releaseFixtureExe; $releaseShortcut.Save() }
  }
  & node.exe scripts/release-smoke.js $releaseRoot $Version $(if ($ExistingFixtureRoot) { '--resume' } else { '--fresh' })
  if ($LASTEXITCODE -ne 0) { throw 'Packaged real upgrade smoke failed' }
} finally {
  # Only stop executables installed in this exact temporary test directory.
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($releaseRoot + '\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($releaseIndex in 0..1) {
    & reg.exe delete $releaseRegistry[$releaseIndex] /f 2>$null | Out-Null
    & reg.exe import (Join-Path $releaseBackup "registry-$releaseIndex.reg") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Original installation registry restore failed' }
    $releaseSavedLink = Join-Path $releaseBackup "shortcut-$releaseIndex.lnk"
    if (Test-Path -LiteralPath $releaseSavedLink) { Copy-Item -LiteralPath $releaseSavedLink -Destination $releaseLinks[$releaseIndex] -Force }
    elseif (Test-Path -LiteralPath $releaseLinks[$releaseIndex]) { Remove-Item -LiteralPath $releaseLinks[$releaseIndex] }
  }
  $releaseSavedCache = Join-Path $releaseBackup 'installer-cache.exe'
  if (Test-Path -LiteralPath $releaseSavedCache) { Copy-Item -LiteralPath $releaseSavedCache -Destination $releaseInstallerCache -Force }
  elseif (Test-Path -LiteralPath $releaseInstallerCache) { Remove-Item -LiteralPath $releaseInstallerCache }
  if ($releaseExeHash -and (Get-FileHash -LiteralPath $releaseExe).Hash -ne $releaseExeHash) { throw 'Original installed application changed' }
  Write-Output "ORIGINAL_INSTALLATION_SHORTCUTS_CACHE_RESTORED fixture=$releaseRoot"
}
