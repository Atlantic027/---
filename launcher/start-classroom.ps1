[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$launcherRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $launcherRoot
$serverRoot = Join-Path $repoRoot 'cloud-server'
$serverScript = Join-Path $serverRoot 'server.js'
$pidFile = Join-Path $launcherRoot 'classroom-server.pid'
$port = 8080

function Find-Node {
    $candidates = @()
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $candidates += @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique) ) {
        if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw 'Node.js was not found. Install Node.js LTS and retry.'
}

function Get-LocalIPv4 {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
    $wifi = $addresses | Where-Object { $_.InterfaceAlias -match 'Wi-Fi|WLAN' } | Select-Object -First 1
    if ($wifi) { return $wifi.IPAddress }
    $first = $addresses | Select-Object -First 1
    if ($first) { return $first.IPAddress }
    return 'NO_IPV4'
}

function Test-PortInUse {
    $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($connection) { return $true }
    $netstat = netstat.exe -ano -p TCP 2>$null
    return [bool]($netstat | Select-String (':{0}\s+.*LISTENING' -f $port))
}

if (-not (Test-Path -LiteralPath $serverScript)) { throw "Server entry not found: $serverScript" }
if (Test-PortInUse) {
    $existingUrl = "http://127.0.0.1:$port/teacher-v2.html"
    try {
        Invoke-WebRequest -Uri $existingUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
        Write-Host "Classroom is already running. Opening $existingUrl"
        if (-not $NoBrowser) { Start-Process $existingUrl }
        exit 0
    } catch {
        throw "Port $port is already in use by another application. Stop that application or choose a free port."
    }
}

$node = Find-Node
$localIp = Get-LocalIPv4
$localUrl = "http://127.0.0.1:$port/teacher-v2.html"
$lanUrl = if ($localIp -eq 'NO_IPV4') { 'LAN IPv4 not found' } else { "http://$localIp`:$port/student-v2.html" }
$stdout = Join-Path $launcherRoot 'server.stdout.log'
$stderr = Join-Path $launcherRoot 'server.stderr.log'
$process = Start-Process -FilePath $node -ArgumentList @('"' + $serverScript + '"') -WorkingDirectory $serverRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII

$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-PortInUse) { $ready = $true; break }
    if ($process.HasExited) { break }
}

if (-not $ready) {
    Write-Host 'Server did not listen on port 8080. Check launcher/server.stderr.log.' -ForegroundColor Red
    exit 1
}

Write-Host "Local URL: $localUrl"
Write-Host "LAN URL:   $lanUrl"
Write-Host 'Server started. Run stop-classroom.ps1 to stop it.'
if (-not $NoBrowser) {
    Start-Process $localUrl
}
