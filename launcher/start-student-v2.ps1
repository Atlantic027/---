[CmdletBinding()]
param(
    [string]$ServerUrl = 'http://127.0.0.1:8080'
)

$ErrorActionPreference = 'Stop'
$url = $ServerUrl.TrimEnd('/') + '/student-v2.html'
Write-Host "Student URL: $url"
Start-Process $url
