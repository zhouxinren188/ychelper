param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [long]$InstallerSize,

  [Parameter(Mandatory = $true)]
  [string]$InstallerSha512,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$ExpectedCurrentVersion,

  [string]$ProjectDir = 'C:\ychelper-server',
  [string]$ServerBaseUrl = 'http://150.158.54.108:3000',
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$publicDir = Join-Path $ProjectDir 'public'
$updatesDir = Join-Path $publicDir 'updates'
$installerName = "ychelper-setup-$Version.exe"
$installerPath = Join-Path $publicDir $installerName
$blockmapPath = "$installerPath.blockmap"
$notesPath = Join-Path $updatesDir "full-release-notes-$Version.pending.txt"
$latestPending = Join-Path $publicDir "latest-$Version.pending.yml"
$metaPending = Join-Path $updatesDir "full-update-meta-$Version.pending.json"

function Get-InstallerSha512([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return [Convert]::ToBase64String(([System.Security.Cryptography.SHA512]::Create()).ComputeHash($stream))
  } finally {
    $stream.Dispose()
  }
}

function Assert-ReleaseFiles {
  if (-not (Test-Path -LiteralPath $installerPath)) { throw "${installerName} is missing" }
  if (-not (Test-Path -LiteralPath $blockmapPath)) { throw "${installerName}.blockmap is missing" }
  if ((Get-Item -LiteralPath $installerPath).Length -ne $InstallerSize) {
    throw "${installerName} size does not match the build"
  }
  if ((Get-InstallerSha512 $installerPath) -ne $InstallerSha512) {
    throw "${installerName} SHA-512 does not match the build"
  }
}

function Read-And-ValidateLatest {
  $content = [System.IO.File]::ReadAllText($latestPending, $utf8NoBom)
  $versionMatch = [regex]::Match($content, '(?m)^version:\s*([^\r\n]+)\s*$')
  $pathMatch = [regex]::Match($content, '(?m)^path:\s*([^\r\n]+)\s*$')
  $sizeMatch = [regex]::Match($content, '(?m)^\s*size:\s*(\d+)\s*$')
  $shaMatches = [regex]::Matches($content, '(?m)^\s*sha512:\s*([^\r\n]+)\s*$')
  $expectedPath = "api/update/file/$installerName"
  if ($versionMatch.Groups[1].Value.Trim() -ne $Version) { throw 'Cannot parse pending latest version' }
  if ($pathMatch.Groups[1].Value.Trim() -ne $expectedPath) { throw 'Cannot parse pending latest path' }
  if (-not $sizeMatch.Success -or [long]$sizeMatch.Groups[1].Value -ne $InstallerSize) {
    throw 'Cannot parse pending latest size'
  }
  if ($shaMatches.Count -ne 2 -or $shaMatches[0].Groups[1].Value.Trim() -ne $InstallerSha512 -or $shaMatches[1].Groups[1].Value.Trim() -ne $InstallerSha512) {
    throw 'Cannot parse pending latest sha512'
  }
  return $content
}

function Read-And-ValidateMeta {
  $content = [System.IO.File]::ReadAllText($metaPending, $utf8NoBom)
  $meta = $content | ConvertFrom-Json
  if ($meta.version -ne $Version -or [long]$meta.size -ne $InstallerSize -or $meta.sha512 -ne $InstallerSha512 -or [string]::IsNullOrWhiteSpace($meta.changelog) -or $meta.changelog.Length -lt 100) {
    throw 'Cannot parse pending full-update-meta.json'
  }
  return $meta
}

Assert-ReleaseFiles

if (-not $Publish) {
  if (-not (Test-Path -LiteralPath $notesPath)) { throw 'Pending release notes are missing' }
  $changelog = [System.IO.File]::ReadAllText($notesPath, $utf8NoBom).Trim()
  if ($changelog -notmatch '[\u4e00-\u9fff]') { throw 'Release notes do not contain valid Chinese text' }
  $releaseDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $updaterPath = "api/update/file/$installerName"
  $latestContent = "version: $Version`nfiles:`n  - url: $updaterPath`n    sha512: $InstallerSha512`n    size: $InstallerSize`npath: $updaterPath`nsha512: $InstallerSha512`nreleaseDate: '$releaseDate'`n"
  $metaObject = [ordered]@{
    version = $Version
    downloadUrl = "$ServerBaseUrl/$installerName"
    changelog = $changelog
    size = $InstallerSize
    sha512 = $InstallerSha512
    updatedAt = $releaseDate
  }
  [System.IO.File]::WriteAllText($latestPending, $latestContent, $utf8NoBom)
  [System.IO.File]::WriteAllText($metaPending, ($metaObject | ConvertTo-Json -Depth 4), $utf8NoBom)
  $null = Read-And-ValidateLatest
  $meta = Read-And-ValidateMeta
  Write-Output "PENDING_METADATA_OK version=$Version changelogChars=$($meta.changelog.Length)"
  Write-Output "PENDING_LATEST_SHA256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $latestPending).Hash)"
  exit 0
}

$latestContent = Read-And-ValidateLatest
$meta = Read-And-ValidateMeta
$latestPath = Join-Path $publicDir 'latest.yml'
$metaPath = Join-Path $updatesDir 'full-update-meta.json'
$currentLatest = [System.IO.File]::ReadAllText($latestPath, $utf8NoBom)
if ($currentLatest -notmatch "(?m)^version:\s*$([regex]::Escape($ExpectedCurrentVersion))\s*$") {
  throw "Current latest.yml is not v${ExpectedCurrentVersion}"
}
$latestBackup = Join-Path $publicDir "latest-before-${Version}.yml"
$metaBackup = Join-Path $updatesDir "full-update-meta-before-${Version}.json"
if ((Test-Path -LiteralPath $latestBackup) -or (Test-Path -LiteralPath $metaBackup)) {
  throw "v${Version} publication backup already exists"
}
[System.IO.File]::Replace($latestPending, $latestPath, $latestBackup, $true)
[System.IO.File]::Replace($metaPending, $metaPath, $metaBackup, $true)
if (Test-Path -LiteralPath $notesPath) { Remove-Item -LiteralPath $notesPath -Force }
Write-Output "PUBLISHED_METADATA_OK version=$Version previous=$ExpectedCurrentVersion changelogChars=$($meta.changelog.Length)"
