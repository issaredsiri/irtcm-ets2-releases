# Starts the telemetry server, prints the phone URL and opens a QR code page.
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$exe    = Join-Path $root 'server\Ets2Telemetry.exe'
$port   = 25555
$local  = "http://localhost:$port"

# 1. start server if not already running
if (-not (Get-Process -Name 'Ets2Telemetry' -ErrorAction SilentlyContinue)) {
    Write-Host 'Starting Ets2Telemetry server...' -ForegroundColor Cyan
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
} else {
    Write-Host 'Server already running.' -ForegroundColor DarkGray
}

# 1b. start the route server too, if route data has been built (routing\build-route-data.cmd)
$routeData = Join-Path $root 'routing\data\europe\europe-graph.json'
$routeCmd  = Join-Path $root 'routing\start-route-server.cmd'
if ((Test-Path $routeData) -and (Test-Path $routeCmd)) {
    # always restart so the latest route-server code is used
    Get-NetTCPConnection -LocalPort 25556 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Write-Host 'Starting route server (loads road data, a few seconds)...' -ForegroundColor Cyan
    Start-Process -FilePath $routeCmd -WindowStyle Minimized
} else {
    Write-Host 'Route data not built yet - map will show straight lines only (run routing\build-route-data.cmd).' -ForegroundColor DarkGray
}

# 1c. bridge: pushes this truck into the shared room (only once Supabase is set in room-config.js)
$node       = Join-Path $root 'routing\node\node.exe'
$bridge     = Join-Path $root 'tools\bridge.js'
$bridgeCfg  = Join-Path $root 'tools\bridge.config.json'
$roomCfg    = Join-Path $root 'server\Html\m\room-config.js'
$roomQuery  = ''
$roomReady  = (Test-Path $roomCfg) -and ((Get-Content $roomCfg -Raw) -match "supabaseAnonKey:\s*'[^']+'")
if ($roomReady -and (Test-Path $node)) {
    if (-not (Test-Path $bridgeCfg)) { & $node $bridge --setup-only }   # asks name + room code once
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*tools\bridge.js*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host 'Starting room bridge...' -ForegroundColor Cyan
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', "title Truck Dash bridge && `"$node`" `"$bridge`"" -WindowStyle Minimized
    try {
        $cfg = Get-Content $bridgeCfg -Raw | ConvertFrom-Json
        $roomQuery = '&room=' + [uri]::EscapeDataString($cfg.room) + '&name=' + [uri]::EscapeDataString($cfg.name)
        Write-Host ("Room: {0} (as {1})" -f $cfg.room, $cfg.name) -ForegroundColor Green
    } catch { }
} elseif (-not $roomReady) {
    Write-Host 'Room not set up (server\Html\m\room-config.js) - single-player mode.' -ForegroundColor DarkGray
}

# 2. wait until the API answers (first run may show admin/setup prompts)
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        Invoke-WebRequest -Uri "$local/api/ets2/telemetry" -UseBasicParsing -TimeoutSec 2 | Out-Null
        $ready = $true; break
    } catch { Start-Sleep -Seconds 1 }
}
if (-not $ready) {
    Write-Host "Server did not respond on port $port. Finish the setup in the server window, then run this again." -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

# 3. find LAN IPv4 addresses (adapters with a default gateway first)
$ips = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
         ForEach-Object { $_.IPv4Address.IPAddress })
if (-not $ips) {
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 |
             Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
             Select-Object -ExpandProperty IPAddress)
}

Write-Host ''
Write-Host '  ===============================================' -ForegroundColor DarkCyan
Write-Host '   Open on your phone (same Wi-Fi):' -ForegroundColor White
foreach ($ip in $ips) {
    Write-Host ("     http://{0}:{1}/m/index.html" -f $ip, $port) -ForegroundColor Green
}
Write-Host '  ===============================================' -ForegroundColor DarkCyan
Write-Host ''

# 4. open QR page in the default browser
Start-Process ("$local/m/connect.html?ips=" + ($ips -join ',') + $roomQuery)
Write-Host 'QR code opened in your browser. You can close this window.' -ForegroundColor DarkGray
Start-Sleep -Seconds 8
