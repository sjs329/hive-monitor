param(
  [string]$SketchPath = "arduino/bee_monitor.ino",
  [string]$Fqbn = "esp32:esp32:adafruit_feather_esp32s3_nopsram",
  [string]$BuildPath = "arduino/build"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command "arduino-cli" -ErrorAction SilentlyContinue)) {
  throw "arduino-cli not found in PATH."
}

$requiredLibs = @(
  "ArduinoIoTCloud",
  "Arduino_ConnectionHandler",
  "Arduino_CloudUtils",
  "Adafruit MAX1704X",
  "Adafruit BusIO"
)

$optionalLibs = @(
  "Arduino_DebugUtils",
  "ArduinoMqttClient",
  "ArduinoHttpClient",
  "ArduinoBearSSL",
  "ArduinoECCX08",
  "Arduino_NetworkConfigurator",
  "Arduino_SecureElement"
)

Write-Host "Updating indexes and installing core..."
arduino-cli core update-index
arduino-cli lib update-index
arduino-cli core install esp32:esp32

foreach ($lib in $requiredLibs) {
  Write-Host "Installing required library: $lib"
  arduino-cli lib install "$lib"
}

foreach ($lib in $optionalLibs) {
  try {
    Write-Host "Installing optional library: $lib"
    arduino-cli lib install "$lib"
  } catch {
    Write-Warning "Optional library install failed: $lib"
  }
}

$sketchFullPath = (Resolve-Path $SketchPath).Path
$sketchDir = Split-Path -Parent $sketchFullPath
$sketchName = [System.IO.Path]::GetFileNameWithoutExtension($sketchFullPath)
$buildDirAbs = Resolve-Path -Path "." | ForEach-Object { Join-Path $_ $BuildPath }
$stageRoot = Join-Path $buildDirAbs "deps_check"
$stageSketchDir = Join-Path $stageRoot $sketchName

if (Test-Path $stageSketchDir) {
  Remove-Item -Recurse -Force $stageSketchDir
}

New-Item -ItemType Directory -Path $stageSketchDir -Force | Out-Null
Get-ChildItem -Path $sketchDir -File | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $stageSketchDir $_.Name) -Force
}

$stageIno = Join-Path $stageSketchDir "$sketchName.ino"
if (-not (Test-Path $stageIno)) {
  Copy-Item -Path $sketchFullPath -Destination $stageIno -Force
}

$secretsHeader = Join-Path $stageSketchDir "arduino_secrets.h"
if (-not (Test-Path $secretsHeader)) {
  @(
    '#pragma once',
    '#define SECRET_SSID ""',
    '#define SECRET_OPTIONAL_PASS ""',
    '#define SECRET_DEVICE_KEY ""'
  ) | Set-Content -Path $secretsHeader -Encoding ascii
}

Write-Host "Validating compile for $Fqbn ..."
arduino-cli compile --fqbn $Fqbn --output-dir $buildDirAbs $stageSketchDir

Write-Host "Dependency bootstrap complete. OTA compile is ready."
