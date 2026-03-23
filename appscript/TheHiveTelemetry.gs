const SPREADSHEET_ID = "1_D-joRy7T6VnLgwT06MsVHj62sY71foAJOP2mTBMAFY"; // Hive Data Sheet's ID
const SHEET_NAME = "telemetry";
const SHARED_SECRET = "watson-doesnt-eat-avi-but-poppy-does"; // same secret used in Arduino webhook URL
const MAX_DEFAULT_ROWS = 1000;
const DEDUPE_WINDOW_MS = 45000; // collapse burst updates from one wake cycle

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

    return json_({ ok: true, received: merged });
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
    if (mode !== "data") return json_({ ok: false, error: "Unsupported mode" });

    const limitParam = Number(e.parameter.limit || MAX_DEFAULT_ROWS);
    const limit = Math.min(Math.max(limitParam, 1), 10000);

    const sh = getOrCreateSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return json_({ ok: true, rows: [] });

    const startRow = Math.max(2, lastRow - limit + 1);
    const numRows = lastRow - startRow + 1;
    const values = sh.getRange(startRow, 1, numRows, 11).getValues();
    const rows = values.map(r => ({
      timestamp_iso: r[0], device_id: r[1],
      weight_kg: toNumOrNull_(r[2]), battery_v: toNumOrNull_(r[3]),
      battery_pct: toNumOrNull_(r[4]), battery_charge_rate: toNumOrNull_(r[5]),
      battery_connected: r[6] === "" ? null : Boolean(r[6]),
      temperature_c: toNumOrNull_(r[7]), humidity_pct: toNumOrNull_(r[8]),
      source: r[9]
    }));

    return json_({ ok: true, rows: rows });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
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

// ── Debug helper (run from editor to test sheet access) ──────────────────────

function testWrite() {
  const sh = getOrCreateSheet_();
  Logger.log("Sheet found: " + sh.getName());
  Logger.log("Last row: " + sh.getLastRow());
  sh.appendRow(["TEST", "debug", 99, 4.2, 100, 0.5, true, 24.5, 55.0, "test", "debug-payload"]);
  Logger.log("Row appended!");
}

// ── Utilities ────────────────────────────────────────────────────────────────

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
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