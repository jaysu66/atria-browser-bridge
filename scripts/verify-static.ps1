$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,
    [string[]] $Arguments = @()
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $FilePath $($Arguments -join ' ')"
  }
}

Invoke-Checked node @("--check", "mcp-server.js")
Invoke-Checked node @("--check", "native-host\native-host.js")
Invoke-Checked node @("--check", "extension\service-worker.js")
Invoke-Checked node @("--check", "extension\content\accessibility-tree.js")
Invoke-Checked node @("--check", "extension\content\visual-indicator.js")
Invoke-Checked node @("--check", "extension\popup.js")
Invoke-Checked node @("-e", "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')")
Invoke-Checked node @("scripts\smoke-mcp.js")

$script = Get-Content -LiteralPath "scripts\install-native-host.ps1" -Raw -Encoding UTF8
[scriptblock]::Create($script) | Out-Null
Write-Host "install script parse ok"
Write-Host "browser-bridge static verification ok"
