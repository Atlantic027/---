[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'classroom-config.local.json'
$ssid = Read-Host 'WiFi SSID'
$password = Read-Host 'WiFi password (hidden input)' -AsSecureString
$serverAddress = Read-Host 'Server address (for example http://192.168.1.100:8080)'
$encryptedPassword = ConvertFrom-SecureString $password
$config = [ordered]@{
    wifiSsid = $ssid
    wifiPasswordProtected = $encryptedPassword
    serverAddress = $serverAddress
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
Write-Host "Configuration saved to $configPath. The password was not printed and is protected for this Windows user."
Write-Host 'The file is ignored by launcher/.gitignore and does not modify or flash ESP32 firmware.'
