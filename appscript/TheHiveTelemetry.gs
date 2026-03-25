const SPREADSHEET_ID = "1_D-joRy7T6VnLgwT06MsVHj62sY71foAJOP2mTBMAFY"; // Hive Data Sheet's ID
const SHEET_NAME = "telemetry";
const SHARED_SECRET = "watson-doesnt-eat-avi-but-poppy-does"; // same secret used in Arduino webhook URL
const MAX_DEFAULT_ROWS = 1000;
const DEDUPE_WINDOW_MS = 45000; // collapse burst updates from one wake cycle
const GET_CACHE_SECONDS = 30;
const MAX_CACHE_PAYLOAD_CHARS = 90000;
const SUPABASE_DUAL_WRITE_ENABLED_DEFAULT = false;

// ── Webhook receiver (Arduino Cloud POST) ────────────────────────────────────

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);

    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: "Empty POST body" });
    }

    const key = (e.parameter && e.parameter.key) ? e.parameter.key : "";
    if (key !== SHARED_SECRET) {
      return json_({ ok: false, error: "Unauthorized" });
    }

    const raw = e.postData.contents;
    const payload = JSON.parse(raw);

    const parsed = parseArduinoPayload_(payload);
    const merged = mergeWithLastKnownState_(parsed);

    const sh = getOrCreateSheet_();
    upsertTelemetryRow_(sh, merged, raw);

    // Optional migration path: write to Supabase too, without blocking Sheets writes.
    const supabase = writeSupabaseBestEffort_(merged, raw);

    return json_({ ok: true, received: merged, supabase: supabase });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try {
      lock.releaseLock();
    } catch (ignored) {}
  }
}

// ── Data API for GitHub Pages frontend ──────────────────────────────────────
// GET .../exec?mode=data&limit=500

function doGet(e) {
  try {
    const mode = (e.parameter && e.parameter.mode) ? e.parameter.mode : "data";
    const limitParam = Number(e.parameter.limit || MAX_DEFAULT_ROWS);
    const limit = Math.min(Math.max(limitParam, 1), 10000);
    const scanLimitParam = Number(e.parameter.scan_limit || 500);
    const scanLimit = Math.min(Math.max(scanLimitParam, 1), 5000);
    const deviceId = (e.parameter && e.parameter.device_id) ? String(e.parameter.device_id) : "";
    const deviceIds = parseDeviceIds_(e.parameter && e.parameter.device_ids);

    if (mode !== "data" && mode !== "latest" && mode !== "compare") {
      return json_({ ok: false, error: "Unsupported mode" });
    }

    if (mode === "compare") {
      const rows = getCompareRows_(deviceIds);
      return json_({ ok: true, rows: rows });
    }

    const cache = CacheService.getScriptCache();
    const cacheKey = buildGetCacheKey_(mode, limit, scanLimit, deviceId, deviceIds);
    const cached = cache.get(cacheKey);
    if (cached) return jsonText_(cached);

    const sh = getOrCreateSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return json_({ ok: true, rows: [] });

    let rows = [];
    if (mode === "latest") {
      rows = getLatestRowsFromState_(deviceIds);
      if (!rows.length) {
        rows = getLatestRows_(sh, lastRow, scanLimit, deviceIds);
      }
    } else {
      rows = getRecentRows_(sh, lastRow, limit, deviceId);
    }

    const payload = JSON.stringify({ ok: true, rows: rows });
    if (payload.length <= MAX_CACHE_PAYLOAD_CHARS) {
      try {
        cache.put(cacheKey, payload, GET_CACHE_SECONDS);
      } catch (cacheErr) {
        // Cache writes are best-effort only; serve data even if cache rejects payload size.
      }
    }
    return jsonText_(payload);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function buildGetCacheKey_(mode, limit, scanLimit, deviceId, deviceIds) {
  const devicePart = deviceId || "all";
  const deviceIdsPart = deviceIds.length ? deviceIds.join(",") : "all";
  return ["get", mode, limit, scanLimit, devicePart, deviceIdsPart].join(":");
}

function parseDeviceIds_(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function mapSheetRows_(values) {
  return values.map(r => ({
    timestamp_iso: r[0], device_id: r[1],
    weight_kg: toNumOrNull_(r[2]), battery_v: toNumOrNull_(r[3]),
    battery_pct: toNumOrNull_(r[4]), battery_charge_rate: toNumOrNull_(r[5]),
    battery_connected: r[6] === "" ? null : Boolean(r[6]),
    temperature_c: toNumOrNull_(r[7]), humidity_pct: toNumOrNull_(r[8]),
    source: r[9]
  }));
}

function getRecentRows_(sh, lastRow, limit, deviceId) {
  const startRow = Math.max(2, lastRow - limit + 1);
  const numRows = lastRow - startRow + 1;
  const values = sh.getRange(startRow, 1, numRows, 11).getValues();
  const rows = mapSheetRows_(values);

  if (!deviceId) return rows;
  return rows.filter(r => r.device_id === deviceId);
}

function getLatestRows_(sh, lastRow, scanLimit, deviceIds) {
  const startRow = Math.max(2, lastRow - scanLimit + 1);
  const numRows = lastRow - startRow + 1;
  const values = sh.getRange(startRow, 1, numRows, 11).getValues();
  const rows = mapSheetRows_(values);
  const wanted = deviceIds.length ? new Set(deviceIds) : null;
  const seen = new Set();
  const latestRows = [];

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const did = String(row.device_id || "");
    if (!did) continue;
    if (wanted && !wanted.has(did)) continue;
    if (seen.has(did)) continue;

    seen.add(did);
    latestRows.push(row);

    if (wanted && seen.size >= wanted.size) break;
  }

  return latestRows.reverse();
}

function getLatestRowsFromState_(deviceIds) {
  const props = PropertiesService.getScriptProperties().getProperties();
  const wanted = deviceIds.length ? new Set(deviceIds) : null;
  const rows = [];

  Object.keys(props).forEach(key => {
    if (!key.startsWith("last_state_")) return;

    try {
      const row = JSON.parse(props[key]);
      const did = String((row && row.device_id) || "");
      if (!did) return;
      if (wanted && !wanted.has(did)) return;
      rows.push(row);
    } catch (ignored) {
      // Skip malformed state entries.
    }
  });

  rows.sort((a, b) => {
    const ta = Date.parse(a.timestamp_iso || "");
    const tb = Date.parse(b.timestamp_iso || "");
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return -1;
    if (!Number.isFinite(tb)) return 1;
    return ta - tb;
  });

  return rows;
}

function getCompareRows_(deviceIds) {
  const sheetRows = getLatestRowsFromState_(deviceIds);
  const supabaseRows = getSupabaseLatestRows_(deviceIds);

  const wantedIds = deviceIds.length
    ? deviceIds
    : uniqueNonEmpty_([
        sheetRows.map(r => r.device_id),
        supabaseRows.map(r => r.device_id)
      ]);

  const sheetByDevice = indexByDeviceId_(sheetRows);
  const supabaseByDevice = indexByDeviceId_(supabaseRows);

  return wantedIds.map(deviceId => {
    const sheet = sheetByDevice[deviceId] || null;
    const supabase = supabaseByDevice[deviceId] || null;

    return {
      device_id: deviceId,
      sheets: sheet,
      supabase: supabase,
      ts_diff_ms: diffMillis_(sheet && sheet.timestamp_iso, supabase && supabase.timestamp_iso),
      battery_pct_diff: diffNumber_(sheet && sheet.battery_pct, supabase && supabase.battery_pct),
      battery_v_diff: diffNumber_(sheet && sheet.battery_v, supabase && supabase.battery_v),
      battery_charge_rate_diff: diffNumber_(sheet && sheet.battery_charge_rate, supabase && supabase.battery_charge_rate),
      weight_kg_diff: diffNumber_(sheet && sheet.weight_kg, supabase && supabase.weight_kg),
      temperature_c_diff: diffNumber_(sheet && sheet.temperature_c, supabase && supabase.temperature_c),
      humidity_pct_diff: diffNumber_(sheet && sheet.humidity_pct, supabase && supabase.humidity_pct)
    };
  });
}

function getSupabaseLatestRows_(deviceIds) {
  const cfg = getSupabaseConfig_();
  if (!cfg.enabled) return [];

  const payload = deviceIds.length ? { p_device_ids: deviceIds } : {};
  const res = UrlFetchApp.fetch(cfg.url + "/rest/v1/rpc/get_latest", {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      "User-Agent": "the-hive-appscript/1.0",
      "X-Client-Info": "the-hive-appscript/1.0"
    },
    payload: JSON.stringify(payload)
  });

  const code = Number(res.getResponseCode());
  if (code < 200 || code >= 300) {
    Logger.log("Supabase compare fetch failed (%s): %s", code, String(res.getContentText() || ""));
    return [];
  }

  const rows = JSON.parse(String(res.getContentText() || "[]"));
  return Array.isArray(rows) ? rows : [];
}

function indexByDeviceId_(rows) {
  const byDevice = {};
  (rows || []).forEach(row => {
    const did = String((row && row.device_id) || "");
    if (!did) return;
    byDevice[did] = row;
  });
  return byDevice;
}

function uniqueNonEmpty_(groups) {
  const seen = {};
  const out = [];
  (groups || []).forEach(group => {
    (group || []).forEach(value => {
      const text = String(value || "");
      if (!text || seen[text]) return;
      seen[text] = true;
      out.push(text);
    });
  });
  return out;
}

function diffNumber_(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
  return na - nb;
}

function diffMillis_(a, b) {
  const ta = Date.parse(String(a || ""));
  const tb = Date.parse(String(b || ""));
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return ta - tb;
}

// ── Payload parser ───────────────────────────────────────────────────────────

function parseArduinoPayload_(p) {
  const ts = parseTimestamp_(p);
  const deviceId = String(p.device_id || p.deviceId || p.thing_id || p.thingId || p.id || "");

  let weight = NaN;
  let battV = NaN;
  let battPct = NaN;
  let battChargeRate = NaN;
  let battConnected = null;
  let temp = NaN; 
  let humidity = NaN;

  if (Array.isArray(p.values)) {
    for (const item of p.values) {
      const name = String(item.name || "").toLowerCase();
      const v = item.value;

      if (name === "battery_charge") {
        battPct = Number(v);
      } else if (name === "battery_voltage") {
        battV = Number(v);
      } else if (name === "battery_charge_rate") {
        battChargeRate = Number(v);
      } else if (name === "battery_connected") {
        battConnected = Boolean(v);
      } else if (name.includes("weight") || name.includes("hive_weight")) {
        weight = Number(v);
      } else if (name === "temperature" || name === "temperature_c" || name === "temp") {
        temp = Number(v);
      } else if (name === "humidity" || name === "humidity_pct" || name === "relative_humidity") {
        humidity = Number(v);
      }
    }
  }

  return {
    timestamp_iso: ts,
    device_id: deviceId,
    weight_kg: Number.isFinite(weight) ? weight : null,
    battery_v: Number.isFinite(battV) ? battV : null,
    battery_pct: Number.isFinite(battPct) ? battPct : null,
    battery_charge_rate: Number.isFinite(battChargeRate) ? battChargeRate : null,
    battery_connected: battConnected,
    temperature_c: Number.isFinite(temp) ? temp : null,
    humidity_pct: Number.isFinite(humidity) ? humidity : null,
    source: "arduino-cloud"
  };
}

// ── State persistence (handles partial variable updates) ─────────────────────

function mergeWithLastKnownState_(incoming) {
  const props = PropertiesService.getScriptProperties();
  const key = "last_state_" + (incoming.device_id || "default");
  const prev = JSON.parse(props.getProperty(key) || "{}");

  const merged = {
    timestamp_iso: incoming.timestamp_iso,
    device_id: incoming.device_id || prev.device_id || "",
    weight_kg: incoming.weight_kg ?? prev.weight_kg ?? null,
    battery_v: incoming.battery_v ?? prev.battery_v ?? null,
    battery_pct: incoming.battery_pct ?? prev.battery_pct ?? null,
    battery_charge_rate: incoming.battery_charge_rate ?? prev.battery_charge_rate ?? null,
    battery_connected: incoming.battery_connected ?? prev.battery_connected ?? null,
    temperature_c: incoming.temperature_c ?? prev.temperature_c ?? null,
    humidity_pct: incoming.humidity_pct ?? prev.humidity_pct ?? null,
    source: incoming.source || "arduino-cloud"
  };

  props.setProperty(key, JSON.stringify(merged));
  return merged;
}

// ── Sheet setup ──────────────────────────────────────────────────────────────

function getOrCreateSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(["timestamp_iso", "device_id", "weight_kg", "battery_v", "battery_pct", "battery_charge_rate", "battery_connected", "temperature_c", "humidity_pct", "source", "event_raw"]);
  }
  return sh;
}

function upsertTelemetryRow_(sh, merged, raw) {
  const rowValues = [
    merged.timestamp_iso,
    merged.device_id || "",
    merged.weight_kg ?? "",
    merged.battery_v ?? "",
    merged.battery_pct ?? "",
    merged.battery_charge_rate ?? "",
    merged.battery_connected ?? "",
    merged.temperature_c ?? "",
    merged.humidity_pct ?? "",
    merged.source || "arduino-cloud",
    raw
  ];

  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    sh.appendRow(rowValues);
    return;
  }

  const last = sh.getRange(lastRow, 1, 1, 11).getValues()[0];
  const lastTs = new Date(last[0]);
  const currentTs = new Date(merged.timestamp_iso);
  const lastDevice = String(last[1] || "");
  const currentDevice = String(merged.device_id || "");

  const canDedupe =
    currentDevice !== "" &&
    lastDevice === currentDevice &&
    !isNaN(lastTs.getTime()) &&
    !isNaN(currentTs.getTime()) &&
    Math.abs(currentTs.getTime() - lastTs.getTime()) <= DEDUPE_WINDOW_MS;

  if (canDedupe) {
    sh.getRange(lastRow, 1, 1, 11).setValues([rowValues]);
    return;
  }

  sh.appendRow(rowValues);
}

// ── Optional dual-write to Supabase (best effort) ───────────────────────────

function getSupabaseConfig_() {
  const props = PropertiesService.getScriptProperties();
  const enabledRaw = props.getProperty("SUPABASE_DUAL_WRITE_ENABLED");
  const enabled = enabledRaw == null
    ? SUPABASE_DUAL_WRITE_ENABLED_DEFAULT
    : String(enabledRaw).toLowerCase() === "true";

  if (!enabled) {
    return { enabled: false, reason: "disabled" };
  }

  const urlRaw = String(props.getProperty("SUPABASE_URL") || "").trim();
  const keyRaw = String(
    props.getProperty("SUPABASE_SERVICE_ROLE_KEY") ||
    props.getProperty("SUPABASE_SECRET_KEY") ||
    ""
  ).trim();

  if (!urlRaw || !keyRaw) {
    return { enabled: false, reason: "missing_config" };
  }

  return {
    enabled: true,
    url: urlRaw.replace(/\/+$/, ""),
    key: keyRaw
  };
}

function writeSupabaseBestEffort_(merged, raw) {
  const cfg = getSupabaseConfig_();
  if (!cfg.enabled) {
    return { enabled: false, ok: null, reason: cfg.reason };
  }

  const deviceId = String(merged.device_id || "");
  if (!deviceId) {
    return { enabled: true, ok: false, error: "missing_device_id" };
  }

  let eventRaw = null;
  try {
    eventRaw = JSON.parse(raw);
  } catch (ignored) {
    eventRaw = { raw: String(raw || "") };
  }

  const payload = {
    ts: merged.timestamp_iso,
    device_id: deviceId,
    weight_kg: merged.weight_kg,
    battery_v: merged.battery_v,
    battery_pct: merged.battery_pct,
    battery_charge_rate: merged.battery_charge_rate,
    battery_connected: merged.battery_connected,
    temperature_c: merged.temperature_c,
    humidity_pct: merged.humidity_pct,
    source: merged.source || "arduino-cloud",
    event_raw: eventRaw
  };

  const latestPayload = {
    device_id: deviceId,
    ts: merged.timestamp_iso,
    weight_kg: merged.weight_kg,
    battery_v: merged.battery_v,
    battery_pct: merged.battery_pct,
    battery_charge_rate: merged.battery_charge_rate,
    battery_connected: merged.battery_connected,
    temperature_c: merged.temperature_c,
    humidity_pct: merged.humidity_pct,
    source: merged.source || "arduino-cloud",
    event_raw: eventRaw
  };

  const baseHeaders = {
    apikey: cfg.key,
    Authorization: "Bearer " + cfg.key,
    Prefer: "return=minimal",
    "User-Agent": "the-hive-appscript/1.0",
    "X-Client-Info": "the-hive-appscript/1.0"
  };

  const options = {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: baseHeaders,
    payload: JSON.stringify(payload)
  };

  try {
    const latestRow = getSupabaseLatestRawRow_(cfg, deviceId);
    let res;
    let action = "inserted";

    if (latestRow && shouldDedupeSupabaseRow_(latestRow.ts, merged.timestamp_iso, deviceId, latestRow.device_id)) {
      res = UrlFetchApp.fetch(
        cfg.url + "/rest/v1/telemetry_raw?id=eq." + encodeURIComponent(String(latestRow.id)),
        {
          method: "patch",
          contentType: "application/json",
          muteHttpExceptions: true,
          headers: baseHeaders,
          payload: JSON.stringify(payload)
        }
      );
      action = "updated";
    } else {
      res = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_raw", options);
    }

    const code = Number(res.getResponseCode());
    if (code >= 200 && code < 300) {
      const latestRes = upsertSupabaseLatest_(cfg, latestPayload, baseHeaders);
      if (latestRes.ok) {
        return { enabled: true, ok: true, status: code, action: action };
      }

      return {
        enabled: true,
        ok: false,
        status: code,
        action: action,
        error: latestRes.error || "telemetry_latest upsert failed"
      };
    }

    const body = String(res.getContentText() || "");
    Logger.log("Supabase dual-write failed (%s): %s", code, body);
    return {
      enabled: true,
      ok: false,
      status: code,
      error: body.slice(0, 300)
    };
  } catch (err) {
    Logger.log("Supabase dual-write exception: %s", String(err));
    return {
      enabled: true,
      ok: false,
      error: String(err)
    };
  }
}

function getSupabaseLatestRawRow_(cfg, deviceId) {
  const url = cfg.url
    + "/rest/v1/telemetry_raw?select=id,ts,device_id"
    + "&device_id=eq." + encodeURIComponent(deviceId)
    + "&order=ts.desc&id.desc&limit=1";

  const res = UrlFetchApp.fetch(url, {
    method: "get",
    muteHttpExceptions: true,
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      "User-Agent": "the-hive-appscript/1.0",
      "X-Client-Info": "the-hive-appscript/1.0"
    }
  });

  const code = Number(res.getResponseCode());
  if (code < 200 || code >= 300) return null;

  const rows = JSON.parse(String(res.getContentText() || "[]"));
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function shouldDedupeSupabaseRow_(latestTs, currentTs, currentDeviceId, latestDeviceId) {
  if (!latestTs || !currentTs) return false;
  if (String(currentDeviceId || "") === "") return false;
  if (String(currentDeviceId || "") !== String(latestDeviceId || "")) return false;

  const last = new Date(latestTs);
  const current = new Date(currentTs);
  if (isNaN(last.getTime()) || isNaN(current.getTime())) return false;

  return Math.abs(current.getTime() - last.getTime()) <= DEDUPE_WINDOW_MS;
}

function upsertSupabaseLatest_(cfg, payload, headers) {
  const res = UrlFetchApp.fetch(
    cfg.url + "/rest/v1/telemetry_latest?on_conflict=device_id",
    {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      headers: Object.assign({}, headers, {
        Prefer: "resolution=merge-duplicates,return=minimal"
      }),
      payload: JSON.stringify(payload)
    }
  );

  const code = Number(res.getResponseCode());
  if (code >= 200 && code < 300) {
    return { ok: true, status: code };
  }

  return {
    ok: false,
    status: code,
    error: String(res.getContentText() || "").slice(0, 300)
  };
}

// ── One-time Sheet → Supabase backfill ───────────────────────────────────────

/**
 * Copies every row in the Google Sheet into Supabase telemetry_raw.
 * Rows that already exist (same device_id + ts) are silently skipped thanks to
 * the UNIQUE (device_id, ts) constraint and ON CONFLICT DO NOTHING.
 *
 * Run once from the Apps Script editor (Function: backfillSheetDataToSupabase).
 * Check View → Logs for progress and a final summary.
 */
function backfillSheetDataToSupabase() {
  const BATCH_SIZE = 200;

  const cfg = getSupabaseConfig_();
  if (!cfg.enabled) {
    Logger.log("Supabase not enabled. Set SUPABASE_DUAL_WRITE_ENABLED=true first.");
    return { ok: false, error: "not_enabled" };
  }

  const sh = getOrCreateSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    Logger.log("Sheet has no data rows — nothing to backfill.");
    return { ok: true, total: 0, batches_ok: 0, batches_err: 0 };
  }

  const numRows = lastRow - 1; // header is row 1
  Logger.log("Reading %s rows from sheet…", numRows);
  const values = sh.getRange(2, 1, numRows, 11).getValues();

  const baseHeaders = {
    apikey: cfg.key,
    Authorization: "Bearer " + cfg.key,
    // ON CONFLICT (device_id, ts) DO NOTHING — skips duplicates silently
    Prefer: "resolution=ignore-duplicates,return=minimal",
    "User-Agent": "the-hive-appscript/1.0",
    "X-Client-Info": "the-hive-appscript/1.0"
  };

  let totalPayloads = 0;
  let batchesOk = 0;
  let batchesErr = 0;

  for (let start = 0; start < values.length; start += BATCH_SIZE) {
    const batch = values.slice(start, start + BATCH_SIZE);

    const payloads = [];
    for (const r of batch) {
      // timestamp_iso (col A) — Sheets may return a Date object or an ISO string
      const tsRaw = r[0];
      if (!tsRaw) continue; // skip blank rows
      let tsIso;
      if (tsRaw instanceof Date) {
        if (isNaN(tsRaw.getTime())) continue;
        tsIso = tsRaw.toISOString();
      } else {
        const s = String(tsRaw).trim();
        if (!s) continue;
        const d = new Date(s);
        tsIso = isNaN(d.getTime()) ? s : d.toISOString();
      }

      const deviceId = String(r[1] || "").trim();
      if (!deviceId) continue;

      // event_raw (col K) is stored as a JSON string in Sheets
      let eventRaw = null;
      try {
        const rawStr = String(r[10] || "").trim();
        eventRaw = rawStr ? JSON.parse(rawStr) : null;
      } catch (ignored) {
        eventRaw = r[10] ? { raw: String(r[10]).slice(0, 1000) } : null;
      }

      payloads.push({
        ts: tsIso,
        device_id: deviceId,
        weight_kg: toNumOrNull_(r[2]),
        battery_v: toNumOrNull_(r[3]),
        battery_pct: toNumOrNull_(r[4]),
        battery_charge_rate: toNumOrNull_(r[5]),
        battery_connected: r[6] === "" ? null : Boolean(r[6]),
        temperature_c: toNumOrNull_(r[7]),
        humidity_pct: toNumOrNull_(r[8]),
        source: String(r[9] || "arduino-cloud") || "arduino-cloud",
        event_raw: eventRaw
      });
    }

    if (!payloads.length) continue;
    totalPayloads += payloads.length;

    const res = UrlFetchApp.fetch(
      cfg.url + "/rest/v1/telemetry_raw?on_conflict=device_id,ts",
      {
        method: "post",
        contentType: "application/json",
        muteHttpExceptions: true,
        headers: baseHeaders,
        payload: JSON.stringify(payloads)
      }
    );

    const code = Number(res.getResponseCode());
    if (code >= 200 && code < 300) {
      batchesOk++;
      Logger.log(
        "Batch %s–%s / %s: OK (HTTP %s)",
        start + 1, start + payloads.length, numRows, code
      );
    } else {
      batchesErr++;
      Logger.log(
        "Batch %s–%s: ERROR HTTP %s — %s",
        start + 1, start + payloads.length,
        code, String(res.getContentText() || "").slice(0, 500)
      );
    }
  }

  const result = {
    ok: batchesErr === 0,
    sheet_rows: numRows,
    payloads_sent: totalPayloads,
    batches_ok: batchesOk,
    batches_err: batchesErr
  };
  Logger.log("Backfill complete: %s", JSON.stringify(result));
  return result;
}

// ── Debug helper (run from editor to test sheet access) ──────────────────────

function testWrite() {
  const sh = getOrCreateSheet_();
  Logger.log("Sheet found: " + sh.getName());
  Logger.log("Last row: " + sh.getLastRow());
  sh.appendRow(["TEST", "debug", 99, 4.2, 100, 0.5, true, 24.5, 55.0, "test", "debug-payload"]);
  Logger.log("Row appended!");
}

function authorizeSupabaseDualWrite() {
  // Run once from Apps Script editor to grant script.external_request scope.
  const res = UrlFetchApp.fetch("https://www.googleapis.com/generate_204", {
    muteHttpExceptions: true
  });
  return {
    ok: true,
    status: res.getResponseCode(),
    dualWrite: getSupabaseDualWriteConfigStatus()
  };
}

function setSupabaseDualWriteConfig(url, key, enabled) {
  const props = PropertiesService.getScriptProperties();

  if (url != null) props.setProperty("SUPABASE_URL", String(url).trim());
  if (key != null) props.setProperty("SUPABASE_SECRET_KEY", String(key).trim());
  if (enabled != null) props.setProperty("SUPABASE_DUAL_WRITE_ENABLED", String(Boolean(enabled)));

  return getSupabaseDualWriteConfigStatus();
}

// Helper for CLI callers that struggle with JSON array quoting in shell wrappers.
// packed format: <url>|<key>|<enabled>
function setSupabaseDualWriteConfigPacked(packed) {
  const text = String(packed || "");
  const parts = text.split("|");
  const url = parts.length > 0 ? parts[0] : null;
  const key = parts.length > 1 ? parts[1] : null;
  const enabled = parts.length > 2 ? String(parts[2]).toLowerCase() === "true" : null;
  return setSupabaseDualWriteConfig(url, key, enabled);
}

function getSupabaseDualWriteConfigStatus() {
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty("SUPABASE_URL") || "");
  const key = String(
    props.getProperty("SUPABASE_SERVICE_ROLE_KEY") ||
    props.getProperty("SUPABASE_SECRET_KEY") ||
    ""
  );
  const enabledRaw = props.getProperty("SUPABASE_DUAL_WRITE_ENABLED");

  return {
    enabled: enabledRaw == null ? SUPABASE_DUAL_WRITE_ENABLED_DEFAULT : String(enabledRaw).toLowerCase() === "true",
    url_set: Boolean(url),
    key_set: Boolean(key),
    key_preview: key ? (key.slice(0, 6) + "..." + key.slice(-4)) : ""
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonText_(text) {
  return ContentService
    .createTextOutput(text)
    .setMimeType(ContentService.MimeType.JSON);
}

function toNumOrNull_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp_(p) {
  const t = p.timestamp || p.time || p.created_at || p.at;
  if (p.values && Array.isArray(p.values) && p.values.length > 0) {
    const t2 = p.values[0].updated_at;
    if (t2) return new Date(t2).toISOString();
  }
  if (!t) return new Date().toISOString();
  if (typeof t === "number") {
    const ms = t < 1e12 ? t * 1000 : t;
    return new Date(ms).toISOString();
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}