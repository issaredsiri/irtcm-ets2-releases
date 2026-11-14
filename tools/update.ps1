# Auto-update: pulls the newest patch from the public releases repo before the dashboard starts.
# Run by "Start Dashboard.bat". Never blocks the start: no internet / GitHub down = keep the current version.
#
# The releases repo (see tools\release.ps1) holds only the app files + version.json, so this needs no
# GitHub API (no rate limit, no token): raw version.json to compare, branch zip to download.
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$ReleaseRepo = 'issaredsiri/irtcm-ets2-releases'
$Branch      = 'main'
$root        = Split-Path -Parent $PSScriptRoot
# test hook: TRUCKDASH_UPDATE_BASE=http://localhost:8123 serves /version.json and /patch.zip instead of GitHub
$RawUrl = "https://raw.githubusercontent.com/$ReleaseRepo/$Branch/version.json"
$ZipUrl = "https://github.com/$ReleaseRepo/archive/refs/heads/$Branch.zip"
if ($env:TRUCKDASH_UPDATE_BASE) { $RawUrl = "$env:TRUCKDASH_UPDATE_BASE/version.json"; $ZipUrl = "$env:TRUCKDASH_UPDATE_BASE/patch.zip" }

# a git checkout is the developer's copy: update with git, not this
if ((Test-Path (Join-Path $root '.git')) -and -not $Force) { exit 0 }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }   # Thai release notes
function Get-Ver($text) { try { [version](($text | ConvertFrom-Json).version) } catch { [version]'0.0.0' } }

$localFile = Join-Path $root 'version.json'
$local = if (Test-Path $localFile) { Get-Ver (Get-Content $localFile -Raw) } else { [version]'0.0.0' }

try {
    $raw = $RawUrl
    $resp = Invoke-WebRequest -Uri $raw -UseBasicParsing -TimeoutSec 6 -Headers @{ 'Cache-Control' = 'no-cache' }
    # always UTF-8, whatever charset the server announces
    $remoteText = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
    $remoteInfo = $remoteText | ConvertFrom-Json
    $remote = [version]$remoteInfo.version
} catch {
    Write-Host 'Update check skipped (offline or GitHub unreachable).' -ForegroundColor DarkGray
    exit 0
}

if ($remote -le $local) {
    Write-Host "Truck Dash v$local (latest)" -ForegroundColor DarkGray
    exit 0
}

Write-Host ''
Write-Host "  Updating Truck Dash v$local -> v$remote" -ForegroundColor Cyan
if ($remoteInfo.notes) { Write-Host "  $($remoteInfo.notes)" -ForegroundColor Gray }

$tmp = Join-Path $env:TEMP ("truckdash-update-" + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = Join-Path $tmp 'patch.zip'
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 120
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'version.json'))) { throw 'patch archive has no version.json' }

    # stop what runs from the files being replaced (route server / bridge restart in start.ps1 anyway)
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$root*" -or $_.CommandLine -like '*tools\bridge.js*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    # copy every file of the patch over the install (README / git files of the releases repo excluded)
    $skip = @('README.md', '.gitattributes', '.gitignore')
    $count = 0
    Get-ChildItem $src.FullName -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($src.FullName.Length + 1)
        if ($skip -contains $rel) { return }
        $dest = Join-Path $root $rel
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        Copy-Item $_.FullName $dest -Force
        $count++
    }
    Write-Host "  Updated $count files. Now v$remote." -ForegroundColor Green
} catch {
    Write-Host "  Update failed, keeping v$local : $($_.Exception.Message)" -ForegroundColor Yellow
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
