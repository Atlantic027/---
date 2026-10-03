$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'classroom-server.pid'
$repoRoot = Split-Path -Parent $PSScriptRoot
$serverScript = [IO.Path]::GetFullPath((Join-Path $repoRoot 'cloud-server\server.js'))
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No launcher-owned server process record was found. Nothing was stopped.'
    exit 0
}
$targetPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
$commandLine = if ($process) { [string]$process.CommandLine } else { '' }
if ($process -and $commandLine -match [regex]::Escape($serverScript)) {
    Stop-Process -Id $targetPid -Force
    Write-Host "Stopped classroom server process PID $targetPid."
} else {
    Write-Host 'PID is not the launcher-owned server.js process. Nothing was stopped.'
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
