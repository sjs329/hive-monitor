param(
  [string]$DeploymentId = "AKfycbztKeecB0nywOhAiUg0raMUyaW7S9CLonxD29ffsRSBea-hPz6Fh6r2kRVEBOIEtKO3GA",
  [string]$ScriptId,
  [string]$Description = "Repo deploy with preserved public web app access",
  [ValidateSet("ANYONE_ANONYMOUS", "ANYONE", "DOMAIN", "MYSELF")]
  [string]$Access = "ANYONE_ANONYMOUS",
  [ValidateSet("USER_DEPLOYING", "USER_ACCESSING")]
  [string]$ExecuteAs = "USER_DEPLOYING",
  [string]$ClaspUser = "default",
  [string]$AuthPath,
  [string]$ManifestPath,
  [int]$VersionNumber,
  [switch]$SkipManifestUpdate,
  [switch]$SkipPush,
  [switch]$SkipVersion
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

  foreach ($path in $FallbackPaths) {
    if (Test-Path $path) {
      return $path
    }
  }

  return $null
}

function Invoke-Clasp {
  param([Parameter(ValueFromRemainingArguments = $true)]$Args)
  & $script:NodeExe $script:ClaspEntry @Args
}

function Resolve-ManifestPath {
  param([string]$PathFromParam)

  if ($PathFromParam) {
    return $PathFromParam
  }

  $claspProject = Get-Content ".clasp.json" -Raw | ConvertFrom-Json
  $rootDir = if ($claspProject.rootDir) { $claspProject.rootDir } else { "." }
  return Join-Path $rootDir "appsscript.json"
}

function Get-RequiredTokenField {
  param(
    [psobject]$TokenObj,
    [string]$Name
  )

  $direct = $TokenObj.$Name
  if ($direct) {
    return $direct
  }

  if ($TokenObj.token -and $TokenObj.token.$Name) {
    return $TokenObj.token.$Name
  }

  throw "Missing '$Name' in clasp auth token object."
}

if (-not $AuthPath) {
  $AuthPath = Join-Path $HOME ".clasprc.json"
}

$script:NodeExe = Resolve-ToolPath -CommandName "node" -FallbackPaths @(
  "C:\Program Files\nodejs\node.exe",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)
if (-not $script:NodeExe) {
  throw "node.exe not found. Install Node.js or add it to PATH."
}

$script:ClaspEntry = Join-Path $env:APPDATA "npm\node_modules\@google\clasp\build\src\index.js"
if (-not (Test-Path $script:ClaspEntry)) {
  throw "Could not find clasp entrypoint at: $script:ClaspEntry"
}

if (-not (Test-Path ".clasp.json")) {
  throw ".clasp.json not found in current directory. Run this script from repo root."
}

if (-not $ScriptId) {
  $claspProject = Get-Content ".clasp.json" -Raw | ConvertFrom-Json
  $ScriptId = $claspProject.scriptId
}

if (-not $ScriptId) {
  throw "ScriptId is required. Pass -ScriptId or ensure .clasp.json has scriptId."
}

if (-not (Test-Path $AuthPath)) {
  throw "clasp auth file not found at: $AuthPath"
}

$resolvedManifestPath = Resolve-ManifestPath -PathFromParam $ManifestPath
if (-not (Test-Path $resolvedManifestPath)) {
  throw "Manifest file not found at: $resolvedManifestPath"
}

if (-not $SkipManifestUpdate) {
  Write-Host "Ensuring manifest webapp settings are access=$Access executeAs=$ExecuteAs ..."
  $manifest = Get-Content $resolvedManifestPath -Raw | ConvertFrom-Json
  if (-not $manifest.webapp) {
    $manifest | Add-Member -NotePropertyName webapp -NotePropertyValue ([PSCustomObject]@{})
  }
  $manifest.webapp.executeAs = $ExecuteAs
  $manifest.webapp.access = $Access
  ($manifest | ConvertTo-Json -Depth 10) | Set-Content -Path $resolvedManifestPath -Encoding ascii
}

$auth = Get-Content $AuthPath -Raw | ConvertFrom-Json
if (-not $auth.tokens) {
  throw "Invalid clasp auth file (missing tokens): $AuthPath"
}

$userToken = $auth.tokens.$ClaspUser
if (-not $userToken) {
  throw "No clasp token found for user '$ClaspUser' in $AuthPath"
}

if (-not $SkipPush) {
  Write-Host "Pushing Apps Script files via clasp..."
  Invoke-Clasp --user $ClaspUser push -f | Out-Null
}

if (-not $PSBoundParameters.ContainsKey("VersionNumber")) {
  if ($SkipVersion) {
    $versionsRaw = Invoke-Clasp --json --user $ClaspUser list-versions | Out-String
    $versions = $versionsRaw | ConvertFrom-Json
    $allVersions = @($versions)
    if (-not $allVersions.Count) {
      throw "No existing versions found, and -SkipVersion was provided."
    }
    $VersionNumber = ($allVersions | Measure-Object -Property versionNumber -Maximum).Maximum
    Write-Host "Using latest existing version: $VersionNumber"
  } else {
    Write-Host "Creating new Apps Script version..."
    $versionRaw = Invoke-Clasp --user $ClaspUser create-version $Description 2>&1 | Out-String
    $versionMatch = [regex]::Match($versionRaw, 'Created version\s+(\d+)')
    if (-not $versionMatch.Success) {
      throw "Could not parse created version from clasp output: $versionRaw"
    }
    $VersionNumber = [int]$versionMatch.Groups[1].Value
    Write-Host "Created version: $VersionNumber"
  }
}

$clientId = Get-RequiredTokenField -TokenObj $userToken -Name "client_id"
$clientSecret = Get-RequiredTokenField -TokenObj $userToken -Name "client_secret"
$refreshToken = Get-RequiredTokenField -TokenObj $userToken -Name "refresh_token"

Write-Host "Refreshing Google OAuth token..."
$oauth = Invoke-RestMethod -Method Post -Uri "https://oauth2.googleapis.com/token" -Body @{
  client_id = $clientId
  client_secret = $clientSecret
  refresh_token = $refreshToken
  grant_type = "refresh_token"
} -ContentType "application/x-www-form-urlencoded"

if (-not $oauth.access_token) {
  throw "Failed to obtain Google OAuth access token from refresh token."
}

$headers = @{ Authorization = "Bearer $($oauth.access_token)" }
$deploymentUri = "https://script.googleapis.com/v1/projects/$ScriptId/deployments/$DeploymentId"

Write-Host "Reading existing deployment..."
$current = Invoke-RestMethod -Method Get -Uri $deploymentUri -Headers $headers

$descriptionToUse = if ($Description) { $Description } else { $current.deploymentConfig.description }

$updateBody = @{
  deploymentConfig = @{
    scriptId = $ScriptId
    versionNumber = $VersionNumber
    manifestFileName = "appsscript"
    description = $descriptionToUse
  }
} | ConvertTo-Json -Depth 8

Write-Host "Updating deployment with explicit web app access settings..."
$updated = Invoke-RestMethod -Method Put -Uri $deploymentUri -Headers $headers -ContentType "application/json" -Body $updateBody

$webEntry = @($updated.entryPoints | Where-Object { $_.entryPointType -eq "WEB_APP" })[0]

Write-Host "Deployment updated successfully."
Write-Host "DeploymentId: $($updated.deploymentId)"
Write-Host "Version: $($updated.deploymentConfig.versionNumber)"
Write-Host "Access: $($webEntry.webApp.entryPointConfig.access)"
Write-Host "ExecuteAs: $($webEntry.webApp.entryPointConfig.executeAs)"
Write-Host "URL: $($webEntry.webApp.url)"

if ($webEntry.webApp.entryPointConfig.access -ne $Access -or $webEntry.webApp.entryPointConfig.executeAs -ne $ExecuteAs) {
  throw "Deployment updated but web app access settings do not match requested values. Check org policy / UI deployment settings."
}
