param(
  [Parameter(Mandatory = $true)]
  [string]$DeviceId,

  [Parameter(Mandatory = $true)]
  [string]$SketchPath,

  [Parameter(Mandatory = $true)]
  [string]$Fqbn,

  [string]$BuildPath = "arduino/build",

  [string]$ThingId,

  [int]$ReadyTimeoutMinutes = 45,

  [int]$ReadyPollSeconds = 10,

  [int]$OtaTimeoutMinutes = 45,

  [int]$OtaPollSeconds = 10,

  [bool]$AutoEnableStayAwake = $true,

  [bool]$AutoDisableStayAwakeOnSuccess = $true
)

$ErrorActionPreference = "Stop"

function Resolve-ToolPath {
  param(
    [string]$CommandName,
    [string[]]$FallbackPaths
  )

  $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  foreach ($p in $FallbackPaths) {
    if (Test-Path $p) {
      return $p
    }
  }

  return $null
}

function Invoke-ArduinoCli {
  param([Parameter(ValueFromRemainingArguments = $true)]$Args)
  & $script:ArduinoCliExe @Args
}

function Invoke-CloudCli {
  param([Parameter(ValueFromRemainingArguments = $true)]$Args)
  & $script:CloudCliExe @Args
}

$script:ArduinoCliExe = Resolve-ToolPath -CommandName "arduino-cli" -FallbackPaths @(
  "C:\Program Files\Arduino CLI\arduino-cli.exe",
  "$env:LOCALAPPDATA\Programs\Arduino CLI\arduino-cli.exe"
)

if (-not $script:ArduinoCliExe) {
  throw "arduino-cli was not found in PATH. Install it from https://arduino.github.io/arduino-cli/latest/installation/"
}

$script:CloudCliExe = Resolve-ToolPath -CommandName "arduino-cloud-cli" -FallbackPaths @(
  "$env:USERPROFILE\tools\arduino-cloud-cli\arduino-cloud-cli.exe"
)

if (-not $script:CloudCliExe) {
  throw "arduino-cloud-cli was not found in PATH. Install it from https://github.com/arduino/arduino-cloud-cli/releases"
}

if (-not (Test-Path $SketchPath)) {
  throw "SketchPath not found: $SketchPath"
}

function Parse-KeyValueYaml {
  param([string]$Path)

  $map = @{}
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([a-zA-Z_]+):\s*(.+?)\s*$') {
      $map[$matches[1]] = $matches[2]
    }
  }
  return $map
}

function Get-CloudAccessToken {
  $credPath = Join-Path $env:LOCALAPPDATA "Arduino15\arduino-cloud-credentials.yaml"
  if (-not (Test-Path $credPath)) {
    throw "Cloud credentials file not found at $credPath. Run: arduino-cloud-cli credentials init"
  }

  $cred = Parse-KeyValueYaml -Path $credPath
  if (-not $cred.client -or -not $cred.secret) {
    throw "Could not parse client/secret from $credPath"
  }

  $token = Invoke-RestMethod -Method Post -Uri "https://api2.arduino.cc/iot/v1/clients/token" -Body @{
    grant_type    = "client_credentials"
    client_id     = $cred.client
    client_secret = $cred.secret
    audience      = "https://api2.arduino.cc/iot"
  } -ContentType "application/x-www-form-urlencoded"

  if (-not $token.access_token) {
    throw "Failed to obtain Arduino IoT API access token"
  }

  return $token.access_token
}

function Get-CloudHeaders {
  $token = Get-CloudAccessToken
  return @{ Authorization = "Bearer $token" }
}

function Get-DeviceInfo {
  param([string]$TargetDeviceId)

  $devices = Invoke-CloudCli device list --format json | ConvertFrom-Json
  return $devices | Where-Object { $_.id -eq $TargetDeviceId } | Select-Object -First 1
}

function Get-ThingProperties {
  param(
    [string]$TargetThingId,
    [hashtable]$Headers
  )

  return Invoke-RestMethod -Method Get -Uri "https://api2.arduino.cc/iot/v2/things/$TargetThingId/properties" -Headers $Headers
}

function Get-StayAwakeProperty {
  param(
    [string]$TargetThingId,
    [hashtable]$Headers
  )

  $props = Get-ThingProperties -TargetThingId $TargetThingId -Headers $Headers
  return $props | Where-Object { $_.variable_name -eq "stay_awake_for_update" } | Select-Object -First 1
}

function Request-StayAwakeTrue {
  param(
    [string]$TargetThingId,
    [string]$PropertyId,
    [hashtable]$Headers
  )

  $body = @{ value = $true } | ConvertTo-Json
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Invoke-RestMethod -Method Put -Uri "https://api2.arduino.cc/iot/v2/things/$TargetThingId/properties/$PropertyId/publish" -Headers $Headers -ContentType "application/json" -Body $body | Out-Null
      return
    } catch {
      if ($attempt -ge 4) { throw }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

function Request-StayAwakeFalse {
  param(
    [string]$TargetThingId,
    [string]$PropertyId,
    [hashtable]$Headers
  )

  $body = @{ value = $false } | ConvertTo-Json
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Invoke-RestMethod -Method Put -Uri "https://api2.arduino.cc/iot/v2/things/$TargetThingId/properties/$PropertyId/publish" -Headers $Headers -ContentType "application/json" -Body $body | Out-Null
      return
    } catch {
      if ($attempt -ge 4) { throw }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

function Wait-ForReadyState {
  param(
    [string]$TargetDeviceId,
    [string]$TargetThingId,
    [bool]$EnableStayAwake,
    [bool]$InitialStayAwakeRequested,
    [int]$TimeoutMinutes,
    [int]$PollSeconds
  )

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $headers = Get-CloudHeaders
  $requestedStayAwake = $InitialStayAwakeRequested

  Write-Host "Waiting for device readiness (ONLINE + stay_awake_for_update=true)..."

  while ((Get-Date) -lt $deadline) {
    $device = Get-DeviceInfo -TargetDeviceId $TargetDeviceId
    if (-not $device) {
      throw "Device $TargetDeviceId not found in Arduino Cloud."
    }

    $stay = Get-StayAwakeProperty -TargetThingId $TargetThingId -Headers $headers
    if (-not $stay) {
      throw "Thing $TargetThingId does not have variable 'stay_awake_for_update'."
    }

    $online = ($device.status -eq "ONLINE")
    $stayReportedOn = ($stay.last_value -eq $true -or $stay.last_value -eq "true")
    # Cloud writes to READWRITE props can be eventually reflected; if we have
    # already requested stay-awake, don't block solely on stale last_value.
    $stayConditionMet = $stayReportedOn -or ($EnableStayAwake -and $requestedStayAwake)

    if ($EnableStayAwake -and -not $requestedStayAwake) {
      Write-Host "Requesting stay_awake_for_update=true from Cloud..."
      Request-StayAwakeTrue -TargetThingId $TargetThingId -PropertyId $stay.id -Headers $headers
      $requestedStayAwake = $true
    }

    $stamp = (Get-Date).ToString("HH:mm:ss")
    Write-Host "[$stamp] Device=$($device.status)  stay_awake_for_update=$($stay.last_value)  requested=$requestedStayAwake"

    if ($online -and $stayConditionMet) {
      Write-Host "Device is ready for OTA."
      return
    }

    Start-Sleep -Seconds $PollSeconds
  }

  throw "Timed out after $TimeoutMinutes minutes waiting for ONLINE + stay_awake_for_update=true."
}

function Get-OtaState {
  param([string]$OtaId)

  $raw = & $script:CloudCliExe ota status --ota-id $OtaId --format json 2>&1 | Out-String
  try {
    $parsed = $raw | ConvertFrom-Json
    if ($parsed -is [System.Array]) {
      return $parsed[0]
    }
    return $parsed
  } catch {
    return [PSCustomObject]@{ status = "unknown"; raw = $raw.Trim() }
  }
}

function Wait-ForOtaCompletion {
  param(
    [string]$OtaId,
    [int]$TimeoutMinutes,
    [int]$PollSeconds
  )

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $successStates = @("DONE", "COMPLETED", "SUCCESS", "SUCCEEDED", "OK")
  $failureStates = @("FAILED", "ERROR", "CANCELED", "CANCELLED", "REJECTED")

  Write-Host "Monitoring OTA status for $OtaId ..."

  while ((Get-Date) -lt $deadline) {
    $state = Get-OtaState -OtaId $OtaId
    $status = ("$($state.status)").ToUpperInvariant()
    $stamp = (Get-Date).ToString("HH:mm:ss")

    if ($state.message) {
      Write-Host "[$stamp] OTA status: $status ($($state.message))"
    } else {
      Write-Host "[$stamp] OTA status: $status"
    }

    if ($successStates -contains $status) {
      Write-Host "OTA completed successfully."
      return
    }

    if ($failureStates -contains $status) {
      throw "OTA failed with status: $status"
    }

    Start-Sleep -Seconds $PollSeconds
  }

  throw "Timed out after $TimeoutMinutes minutes while waiting for OTA completion."
}

$sketchFullPath = (Resolve-Path $SketchPath).Path
$sketchDir = Split-Path -Parent $sketchFullPath
$sketchName = [System.IO.Path]::GetFileNameWithoutExtension($sketchFullPath)
$buildDirAbs = Resolve-Path -Path "." | ForEach-Object { Join-Path $_ $BuildPath }

# arduino-cli expects <folder>/<folder>.ino, so stage the sketch accordingly.
$stageRoot = Join-Path $buildDirAbs "ota_sketch"
$stageSketchDir = Join-Path $stageRoot $sketchName
if (Test-Path $stageSketchDir) {
  Remove-Item -Recurse -Force $stageSketchDir
}
New-Item -ItemType Directory -Path $stageSketchDir -Force | Out-Null

# Copy only files needed for compile from the sketch folder (avoid recursive
# re-copy of arduino/build into staging).
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

$compileTarget = $stageSketchDir

$deviceInfo = Get-DeviceInfo -TargetDeviceId $DeviceId
if (-not $deviceInfo) {
  throw "Device $DeviceId not found in Arduino Cloud."
}

if (-not $ThingId) {
  $ThingId = $deviceInfo.thing_id
}

if (-not $ThingId) {
  throw "Could not determine ThingId for device $DeviceId. Pass -ThingId explicitly."
}

$headers = Get-CloudHeaders
$stay = Get-StayAwakeProperty -TargetThingId $ThingId -Headers $headers
if (-not $stay) {
  throw "Thing $ThingId does not have variable 'stay_awake_for_update'."
}

$initialStayAwakeRequested = $false
$otaSucceeded = $false

try {
  if ($AutoEnableStayAwake) {
    Write-Host "Setting stay_awake_for_update=true at start of OTA process..."
    Request-StayAwakeTrue -TargetThingId $ThingId -PropertyId $stay.id -Headers $headers
    $initialStayAwakeRequested = $true
  }

  Write-Host "Compiling $SketchPath for $Fqbn ..."
  Invoke-ArduinoCli compile --fqbn $Fqbn --output-dir $buildDirAbs $compileTarget

  $binPath = Join-Path $buildDirAbs "$sketchName.ino.bin"
  if (-not (Test-Path $binPath)) {
    throw "Compiled binary not found at: $binPath"
  }

  Wait-ForReadyState -TargetDeviceId $DeviceId -TargetThingId $ThingId -EnableStayAwake $AutoEnableStayAwake -InitialStayAwakeRequested $initialStayAwakeRequested -TimeoutMinutes $ReadyTimeoutMinutes -PollSeconds $ReadyPollSeconds

  Write-Host "Uploading OTA to DeviceId=$DeviceId ..."
  $uploadRaw = $null
  $uploadBackoffSecs = @(0, 15, 30, 60)
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    if ($uploadBackoffSecs[$attempt - 1] -gt 0) {
      Write-Host "Rate limited (429). Waiting $($uploadBackoffSecs[$attempt - 1])s before retry $attempt/4 ..."
      Start-Sleep -Seconds $uploadBackoffSecs[$attempt - 1]
    }
    $uploadRaw = & $script:CloudCliExe ota upload --device-id $DeviceId --file $binPath --format json 2>&1 | Out-String
    if ($uploadRaw -match '429') {
      if ($attempt -ge 4) {
        throw "OTA upload failed with 429 after $attempt attempts: $uploadRaw"
      }
      continue
    }
    break
  }

  Write-Host "Upload response: $($uploadRaw.Trim())"

  # Try JSON parse first to extract the OTA record id field directly.
  $otaId = $null
  try {
    $uploadJson = $uploadRaw | ConvertFrom-Json
    $uploadRecord = if ($uploadJson -is [System.Array]) { $uploadJson[0] } else { $uploadJson }
    if ($uploadRecord.id -and $uploadRecord.id -ne $DeviceId) {
      $otaId = $uploadRecord.id
    }
  } catch { }

  # Fallback: pick the first UUID in the output that is not the device ID.
  if (-not $otaId) {
    $uuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    $uuidMatches = [regex]::Matches($uploadRaw, $uuidPattern)
    foreach ($m in $uuidMatches) {
      if ($m.Value -ne $DeviceId) {
        $otaId = $m.Value
        break
      }
    }
  }

  if (-not $otaId) {
    throw "Could not parse OTA ID from upload response: $uploadRaw"
  }

  Write-Host "OTA scheduled. ID: $otaId"

  Wait-ForOtaCompletion -OtaId $otaId -TimeoutMinutes $OtaTimeoutMinutes -PollSeconds $OtaPollSeconds
  $otaSucceeded = $true
}
finally {
  if ($initialStayAwakeRequested -and $AutoDisableStayAwakeOnSuccess -and $otaSucceeded) {
    Write-Host "OTA success confirmed. Setting stay_awake_for_update=false ..."
    Request-StayAwakeFalse -TargetThingId $ThingId -PropertyId $stay.id -Headers $headers
    Write-Host "stay_awake_for_update reset to false."
  }

  if ($initialStayAwakeRequested -and -not $otaSucceeded) {
    Write-Host "OTA did not complete successfully. Resetting stay_awake_for_update=false ..."
    try {
      Request-StayAwakeFalse -TargetThingId $ThingId -PropertyId $stay.id -Headers $headers
      Write-Host "stay_awake_for_update reset to false after failure."
    } catch {
      Write-Warning "Failed to reset stay_awake_for_update after failure: $($_.Exception.Message)"
    }
  }
}
