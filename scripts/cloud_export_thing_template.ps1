param(
  [Parameter(Mandatory = $true)]
  [string]$ThingId,

  [string]$OutFile = "arduino/cloud/thing.template.json"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command "arduino-cloud-cli" -ErrorAction SilentlyContinue)) {
  throw "arduino-cloud-cli was not found in PATH. Install it from https://github.com/arduino/arduino-cloud-cli/releases"
}

$target = Resolve-Path -Path "." | ForEach-Object { Join-Path $_ $OutFile }
$targetDir = Split-Path -Parent $target
if (-not (Test-Path $targetDir)) {
  New-Item -ItemType Directory -Path $targetDir | Out-Null
}

Write-Host "Exporting Thing template for ThingId=$ThingId ..."
arduino-cloud-cli thing extract --id $ThingId --format json | Out-File -FilePath $target -Encoding utf8

Write-Host "Saved: $target"
