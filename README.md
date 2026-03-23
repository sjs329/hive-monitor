# The Hive Monitor

Multi-part beehive telemetry system:
- Adafruit ESP32-S3 Feather firmware (Arduino Cloud client)
- Google Apps Script webhook + Google Sheets storage
- GitHub Pages dashboard for multi-hive visualization

## Architecture

1. ESP32 wakes from deep sleep, reads battery/sensors, publishes to Arduino Cloud, and sleeps again.
2. Arduino Cloud webhook calls Apps Script `doPost`.
3. Apps Script parses and upserts telemetry rows in Google Sheets.
4. Dashboard fetches JSON from Apps Script `doGet` and renders charts.

## Repository Layout

- `arduino/bee_monitor.ino`:
  Firmware for ESP32-S3 Feather (deep sleep + cloud sync + stay-awake mode)
- `arduino/thingProperties.h`:
  Arduino Cloud generated property bindings (can be regenerated)
- `appscript/TheHiveTelemetry.gs`:
  Webhook receiver + sheet persistence + JSON API
- `appscript/appsscript.json`:
  Apps Script manifest for clasp
- `.clasp.json`:
  Links this repo to existing Apps Script project
- `index.html`, `hive.html`, `overview.js`, `dashboard.js`, `style.css`, `hives.js`:
  GitHub Pages frontend
- `icons/*.svg`, `bee-logo.svg`, `favicon.svg`:
  Site and hive icon assets

## Key Config Values

### Firmware (`arduino/bee_monitor.ino`)

- `SLEEP_INTERVAL_US`:
  Deep sleep period (currently 2 minutes)
- `CLOUD_AWAKE_WINDOW_MS`:
  Awake window to sync cloud (currently 15s)
- `stay_awake_for_update`:
  Cloud boolean (READWRITE) that keeps device awake for OTA/maintenance

OTA note:
- To perform over-the-air firmware updates, set `stay_awake_for_update = true` in Arduino Cloud before the next wake cycle.
- The device will enter stay-awake mode when it wakes and remain online for OTA.
- Set `stay_awake_for_update = false` after the update so the device returns to deep-sleep operation.

### Apps Script (`appscript/TheHiveTelemetry.gs`)

- `SPREADSHEET_ID`: target Google Sheet
- `SHEET_NAME`: tab name (`telemetry`)
- `SHARED_SECRET`: webhook key check
- `DEDUPE_WINDOW_MS`: dedupe window for same-device burst events

### Frontend (`hives.js`)

- `API_URL`: Apps Script `/exec` URL
- `HIVES_CONFIG`: hive labels/icons/device mapping

## Day-to-Day Workflows

## 1) Update Firmware

1. Edit `arduino/bee_monitor.ino`.
2. If Cloud variables changed, regenerate `thingProperties.h` from Arduino Cloud.
3. Re-apply any custom property settings if regeneration overwrote them.
4. Flash from Arduino IDE / CLI.
5. Verify webhook payload and sheet rows.

For OTA firmware updates (no USB cable):
1. In Arduino Cloud Dashboard, turn on `stay_awake_for_update`.
2. Wait for the next wake (up to `SLEEP_INTERVAL_US`).
3. Perform OTA update while the board is awake.
4. Turn off `stay_awake_for_update` when done.

## 2) Update Apps Script from Repo (clasp)

Prereqs:
- Node + npm installed
- `clasp` installed globally
- Apps Script API enabled in account settings
- `clasp` login completed

Commands from repo root:

```powershell
clasp.cmd status
clasp.cmd push
clasp.cmd version "describe change"
clasp.cmd deployments
clasp.cmd deploy --deploymentId <DEPLOYMENT_ID> --description "update"
```

Notes:
- This repo is linked to an existing script via `.clasp.json`.
- Use `--deploymentId` to keep the existing `/exec` URL.

## 3) Update GitHub Pages Dashboard

1. Edit frontend files in repo root.
2. Commit and push to `main` branch of `hive-monitor`.
3. GitHub Pages updates from branch root.
4. Site URL: `https://sjs329.github.io/hive-monitor/`

## Apps Script Behavior Summary

`doPost`:
- Validates `?key=` against `SHARED_SECRET`
- Parses Arduino webhook payload (`values[]`)
- Merges partial updates with last known per-device state
- Dedupes bursts by updating last row if same device within `DEDUPE_WINDOW_MS`

`doGet`:
- Returns recent telemetry rows as JSON for frontend
- Supports `?mode=data&limit=<n>`

## Sheet Schema

`telemetry` header row (A..K):

- `timestamp_iso`
- `device_id`
- `weight_kg`
- `battery_v`
- `battery_pct`
- `battery_charge_rate`
- `battery_connected`
- `temperature_c`
- `humidity_pct`
- `source`
- `event_raw`

## Storage Planning

Google Sheets limit is 10,000,000 cells.
At 11 columns, practical max is about 909k telemetry rows.
Use Apps Script dedupe and longer wake intervals to extend retention.

## Troubleshooting

### Zero battery values

- Ensure `Wire.begin()` is called before MAX17048 access.
- Keep battery init/read retries in place after deep sleep wake.
- Reject impossible readings before publishing.

### Too many rows per wake

- Increase `DEDUPE_WINDOW_MS` in Apps Script.
- Optionally reduce cloud publish frequency/window in firmware.

### No webhook writes

- Confirm deployed Apps Script version is current.
- Verify Arduino webhook URL includes `?key=<SHARED_SECRET>`.
- Confirm script has sheet edit access and correct `SPREADSHEET_ID`.

### clasp push fails

- Ensure Apps Script API enabled: `https://script.google.com/home/usersettings`
- Ensure `appscript/appsscript.json` exists.

## Security Notes

- Rotate `SHARED_SECRET` if exposed.
- Consider moving secret values out of committed source and into Script Properties.
- Treat webhook endpoint as public; rely on secret validation and monitoring.

## Suggested Backup/Retention Strategy

- Keep all raw data in sheet during early development.
- Later, add archival job (monthly copy to another sheet or CSV in Drive).
- Keep dashboard using only recent `limit` rows for performance.

## Quick Commands

From repo root:

```powershell
# GitHub repo status
git status
git remote -v

# Apps Script
clasp.cmd status
clasp.cmd push
clasp.cmd deployments

# Create version + deploy existing web app
clasp.cmd version "update"
clasp.cmd deploy --deploymentId <DEPLOYMENT_ID> --description "update"
```
