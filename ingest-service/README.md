# Local Ingest Service (No Home Assistant Required)

This service replaces the cloud write path with a local API + Postgres while keeping dashboard reads fast.

## What it provides

- `POST /api/telemetry`: ingest webhook payloads from Arduino Cloud or your device relay.
- `GET /api/latest`: latest row per device for overview cards.
- `GET /api/history`: time-series rows for a single device.
- `POST /api/admin/recompute-filter`: historical filtered-weight recompute.
- Filter behavior compatible with `appscript/TheHiveTelemetry.gs` including:
  - read-failure sentinel handling
  - sustained-step unlock logic
  - null-safe handling (no `null -> 0` coercion)

## Quick start

1. Create a local Postgres database (example: `the_hive`).
2. Apply schema:

```sql
-- ingest-service/sql/001_init.sql
```

3. Configure env:

```bash
cp .env.example .env
```

4. Install + run:

```bash
npm install
npm run start
```

Service default URL: `http://localhost:8787`.

## Environment variables

- `DATABASE_URL` (required)
- `INGEST_SHARED_SECRET` (required): used by `POST /api/telemetry` via `x-api-key` header or `?key=`.
- `ADMIN_KEY` (optional): admin API key, falls back to `INGEST_SHARED_SECRET`.
- `PORT` (default `8787`)
- `HOST` (default `0.0.0.0`)
- `CORS_ORIGIN` (default `*`)

## Endpoint contracts

### `POST /api/telemetry`

Auth:
- Header `x-api-key: <INGEST_SHARED_SECRET>` (or query `?key=`)

Body:
- Accepts Arduino Cloud style payload with `device_id` (or aliases) and `values[]` entries.
- Example:

```json
{
  "device_id": "1e432d9f-0798-4578-9da1-31471c5ba848",
  "values": [
    { "name": "weight_lbs", "value": 70.2, "updated_at": "2026-04-09T20:00:50.000Z" },
    { "name": "raw_scale_counts", "value": -375890 },
    { "name": "battery_voltage", "value": 4.11 },
    { "name": "battery_charge", "value": 78 }
  ]
}
```

Response:

```json
{
  "ok": true,
  "received": {
    "timestamp_iso": "2026-04-09T20:00:50.000Z",
    "device_id": "1e432d9f-0798-4578-9da1-31471c5ba848",
    "weight_lbs": 70.239,
    "filtered_weight_lbs": 70.3602
  }
}
```

### `GET /api/latest`

Query:
- `device_ids` (optional CSV)

Response:

```json
{ "ok": true, "rows": [{ "timestamp_iso": "...", "device_id": "..." }] }
```

### `GET /api/history`

Query:
- `device_id` (required)
- `hours` (optional, default `24`)
- `from` / `to` ISO timestamps (optional)
- `limit` (optional, default `2000`, max `20000`)

Response:

```json
{ "ok": true, "rows": [{ "timestamp_iso": "...", "device_id": "...", "event_raw": {} }] }
```

### `POST /api/admin/recompute-filter`

Auth:
- `x-api-key: <ADMIN_KEY>`

Query/body:
- `device_ids` CSV (optional)

Response:

```json
{ "ok": true, "rows_recomputed": 9168, "devices_updated": 1 }
```

## Migration notes for this repo

Current frontend uses either Apps Script or Supabase. To use this service directly, add a new datasource option (for example `"local"`) and map calls as:

- Overview latest read:
  - from Supabase RPC `get_latest`
  - to `GET /api/latest?device_ids=<csv>`

- Dashboard history read:
  - from Supabase `telemetry_raw` REST
  - to `GET /api/history?device_id=<id>&hours=<n>&limit=<n>`

Response row shape already includes `timestamp_iso`, `weight_lbs`, `filtered_weight_lbs`, and `event_raw`, so chart code can stay mostly unchanged.

## Remote access options

- Cloudflare Tunnel: expose only API endpoint over HTTPS.
- Tailscale: private network access only.
- Reverse proxy (Caddy/Nginx) with TLS and IP filtering.

Do not expose Postgres directly to the internet.
