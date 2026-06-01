param(
  [Parameter(Mandatory = $true)]
  [string] $ExtensionId
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceHostDir = Join-Path $root "native-host"
$installDir = Join-Path $env:APPDATA "AtriaBrowserBridge\native-host"
$manifestDir = Join-Path $env:APPDATA "AtriaBrowserBridge"
$manifestPath = Join-Path $manifestDir "com.atria.browser_bridge.json"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null

Copy-Item -LiteralPath (Join-Path $sourceHostDir "native-host.js") -Destination (Join-Path $installDir "native-host.js") -Force
Copy-Item -LiteralPath (Join-Path $sourceHostDir "native-host.cmd") -Destination (Join-Path $installDir "native-host.cmd") -Force

$cmdPath = Join-Path $installDir "native-host.cmd"
$manifest = @{
  name = "com.atria.browser_bridge"
  description = "Atria Agent Browser Bridge Native Host"
  path = $cmdPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$chromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.atria.browser_bridge"
$edgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.atria.browser_bridge"
New-Item -Force -Path $chromeKey | Out-Null
New-Item -Force -Path $edgeKey | Out-Null
(Get-Item $chromeKey).SetValue("", $manifestPath)
(Get-Item $edgeKey).SetValue("", $manifestPath)

Write-Host "Native host installed."
Write-Host "Manifest: $manifestPath"
Write-Host "Extension: chrome-extension://$ExtensionId/"
Write-Host "Restart Chrome or disable/enable the extension if nativeMessaging does not connect immediately."
