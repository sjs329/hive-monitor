param(
  [string]$SupabaseUrl = $(if ($env:SUPABASE_URL) { $env:SUPABASE_URL } else { "https://wivbegbxspqfypuilwzj.supabase.co" }),
  [string]$ApiSecretKey = $(if ($env:SUPABASE_SECRET_KEY) { $env:SUPABASE_SECRET_KEY } else { $env:SUPABASE_SERVICE_ROLE_KEY }),
  [string]$DeviceId = "1e432d9f-0798-4578-9da1-31471c5ba848"
)

$ErrorActionPreference = "Stop"

if (-not $SupabaseUrl) {
  throw "Missing Supabase URL. Set SUPABASE_URL or pass -SupabaseUrl."
}

if (-not $ApiSecretKey) {
  throw "Missing Supabase secret key. Set SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY, or pass -ApiSecretKey."
}

$base = $SupabaseUrl.TrimEnd("/")
$userAgent = "the-hive-smoke-test/1.0 (powershell)"
$headers = @{
  apikey = $ApiSecretKey
  Authorization = "Bearer $ApiSecretKey"
  Prefer = "return=representation"
}

$nowUtc = (Get-Date).ToUniversalTime().ToString("o")
$payload = @{
  ts = $nowUtc
  device_id = $DeviceId
  weight_kg = 0
  battery_v = 3.82
  battery_pct = 54.2
  battery_charge_rate = -1.7
  battery_connected = $true
  temperature_c = 22.5
  humidity_pct = 51.4
  source = "supabase-smoke-test"
  event_raw = @{ test = $true; inserted_at = $nowUtc }
} | ConvertTo-Json -Depth 8

Write-Host "Inserting smoke-test row into telemetry_raw..."
$insertUri = "$base/rest/v1/telemetry_raw"
$insertRes = Invoke-RestMethod -Method Post -Uri $insertUri -Headers $headers -UserAgent $userAgent -ContentType "application/json" -Body $payload
Write-Host "Inserted row count: $(@($insertRes).Count)"

Write-Host "Reading latest state via RPC get_latest..."
$rpcUri = "$base/rest/v1/rpc/get_latest"
$rpcBody = @{ p_device_ids = @($DeviceId) } | ConvertTo-Json
$latest = Invoke-RestMethod -Method Post -Uri $rpcUri -Headers $headers -UserAgent $userAgent -ContentType "application/json" -Body $rpcBody

if (-not @($latest).Count) {
  throw "RPC get_latest returned no rows for device $DeviceId"
}

$row = @($latest)[-1]
Write-Host "Latest timestamp: $($row.timestamp_iso)"
Write-Host "Latest device_id: $($row.device_id)"
Write-Host "Latest battery_pct: $($row.battery_pct)"
Write-Host "Supabase smoke test succeeded."
