const SPREADSHEET_ID = "1_D-joRy7T6VnLgwT06MsVHj62sY71foAJOP2mTBMAFY"; // Hive Data Sheet's ID
const SHEET_NAME = "telemetry";
const SHARED_SECRET = "watson-doesnt-eat-avi-but-poppy-does"; // same secret used in Arduino webhook URL
const MAX_DEFAULT_ROWS = 1000;
const DEDUPE_WINDOW_MS = 45000; // collapse burst updates from one wake cycle
const STAY_AWAKE_INFER_THRESHOLD_MS = 25000;
const STAY_AWAKE_INFER_STREAK = 3;
const GET_CACHE_SECONDS = 30;
const MAX_CACHE_PAYLOAD_CHARS = 90000;
const SUPABASE_DUAL_WRITE_ENABLED_DEFAULT = false;
const WEBHOOK_SLOW_WARN_MS = 20000;
const WEBHOOK_SAMPLE_LOG_RATE = 0.02; // 2% of all webhook calls
const HIVE_CONFIG_PROP_KEY = "HIVE_CONFIG_JSON";
const HIVE_CONFIG_CACHE_KEY = "hive_config_cache_v1";
const HIVE_CONFIG_ADMIN_PROP_KEY = "HIVE_CONFIG_ADMIN_KEY";
const LBS_PER_KG = 2.2046226218;
const WEIGHT_FILTER_MAX_RATE_LB_PER_MIN = 0.05;
const WEIGHT_FILTER_STEP_MARGIN_LB = 0.24;
const WEIGHT_FILTER_EMA_TAU_MIN = 300;
const WEIGHT_FILTER_CONSISTENCY_BAND_LB = 0.28;
const WEIGHT_FILTER_UNLOCK_MIN_POINTS = 4;
const WEIGHT_FILTER_UNLOCK_MIN_MINUTES = 20;
const WEIGHT_INVALID_CALIBRATION_SENTINEL_LBS = -1234.5;
const WEIGHT_READ_FAILED_SENTINEL_LBS = -2234.5;
const RAW_SCALE_READ_FAILED_SENTINEL_COUNTS = -2147483000;
const TEMP_SENSOR_NOT_CONNECTED_SENTINEL_F = -999.0;
const HUMIDITY_SENSOR_NOT_CONNECTED_SENTINEL_PCT = -1.0;
const WEIGHT_SENTINEL_EPS = 0.02;

// ── Webhook receiver (Arduino Cloud POST) ────────────────────────────────────

function doPost(e) {
  const startedAtMs = Date.now();
  let lockAcquiredAtMs = startedAtMs;
  let parseMergedDoneAtMs = startedAtMs;
  let sheetWriteDoneAtMs = startedAtMs;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    lockAcquiredAtMs = Date.now();

    const mode = (e.parameter && e.parameter.mode) ? String(e.parameter.mode) : "";
    if (mode === "config_save") {
      return handleConfigSaveRequest_(e);
    }

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
    parseMergedDoneAtMs = Date.now();

    const sh = getOrCreateSheet_();
    upsertTelemetryRow_(sh, merged, raw);
    sheetWriteDoneAtMs = Date.now();

    // Optional migration path: write to Supabase too, without blocking Sheets writes.
    const supabase = writeSupabaseBestEffort_(merged, raw);

    const finishedAtMs = Date.now();
    const timing = {
      total_ms: finishedAtMs - startedAtMs,
      lock_wait_ms: lockAcquiredAtMs - startedAtMs,
      parse_merge_ms: parseMergedDoneAtMs - lockAcquiredAtMs,
      sheet_write_ms: sheetWriteDoneAtMs - parseMergedDoneAtMs,
      supabase_ms: finishedAtMs - sheetWriteDoneAtMs
    };

    const isSlow = timing.total_ms >= WEBHOOK_SLOW_WARN_MS;
    const isSupabaseError = Boolean(supabase && supabase.ok === false);
    const isSampled = !isSlow && !isSupabaseError && Math.random() < WEBHOOK_SAMPLE_LOG_RATE;

    if (isSlow || isSupabaseError || isSampled) {
      const logReason = isSlow ? "slow" : (isSupabaseError ? "supabase_error" : "sampled");
      const sbTimings = (supabase && supabase.timings_ms) || {};
      Logger.log(
        "doPost timing reason=%s device=%s total=%sms lock=%sms parse=%sms sheet=%sms supabase=%sms supabase_ok=%s supabase_action=%s supabase_status=%s supabase_error=%s sb_total=%s sb_latest_fetch=%s sb_raw_write=%s sb_latest_upsert=%s",
        logReason,
        String(merged.device_id || ""),
        timing.total_ms,
        timing.lock_wait_ms,
        timing.parse_merge_ms,
        timing.sheet_write_ms,
        timing.supabase_ms,
        String(supabase && supabase.ok),
        String(supabase && supabase.action),
        String(supabase && supabase.status),
        String((supabase && supabase.error) || ""),
        String(sbTimings.total),
        String(sbTimings.latest_fetch),
        String(sbTimings.raw_write),
        String(sbTimings.latest_upsert)
      );
    }

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

    if (mode !== "data" && mode !== "latest" && mode !== "compare" && mode !== "config_get" && mode !== "recompute_filter_history") {
      return json_({ ok: false, error: "Unsupported mode" });
    }

    if (mode === "recompute_filter_history") {
      if (!isAuthorizedAdminRequest_(e)) {
        return json_({ ok: false, error: "Unauthorized" });
      }
      const target = (e.parameter && e.parameter.target) ? String(e.parameter.target) : "all";
      const deviceIdsCsv = (e.parameter && e.parameter.device_ids) ? String(e.parameter.device_ids) : "";
      const result = recomputeFilteredWeightHistory(target, deviceIdsCsv);
      return json_(Object.assign({ ok: Boolean(result && result.ok) }, result));
    }

    if (mode === "config_get") {
      const rows = getHiveConfig_();
      return json_({ ok: true, hives: rows });
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

function handleConfigSaveRequest_(e) {
  const payloadText = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "{}";
  let payload;

  try {
    payload = JSON.parse(payloadText || "{}");
  } catch (err) {
    return json_({ ok: false, error: "Invalid JSON body" });
  }

  const rawRows = payload && Array.isArray(payload.hives) ? payload.hives : null;
  if (!rawRows) {
    return json_({ ok: false, error: "Missing hives array" });
  }

  const normalized = normalizeHiveConfigRows_(rawRows);
  const saved = saveHiveConfig_(normalized);
  return json_({ ok: true, hives: saved });
}

function getHiveConfig_() {
  const cache = CacheService.getScriptCache();
  try {
    const cached = cache.get(HIVE_CONFIG_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (cacheErr) {
    // Ignore cache failures and continue.
  }

  let rows = [];
  const supabaseCfg = getSupabaseAdminConfig_();
  if (supabaseCfg.enabled) {
    rows = fetchHiveConfigFromSupabase_(supabaseCfg);
  }

  if (!rows.length) {
    rows = fetchHiveConfigFromProperties_();
  }

  const normalized = normalizeHiveConfigRows_(rows);
  try {
    cache.put(HIVE_CONFIG_CACHE_KEY, JSON.stringify(normalized), GET_CACHE_SECONDS);
  } catch (cacheErr) {
    // Ignore cache write failures.
  }
  return normalized;
}

function saveHiveConfig_(rows) {
  const normalized = normalizeHiveConfigRows_(rows);
  const supabaseCfg = getSupabaseAdminConfig_();

  if (supabaseCfg.enabled) {
    try {
      saveHiveConfigToSupabase_(supabaseCfg, normalized);
    } catch (err) {
      // Keep config writes available even if Supabase hive_config table is not ready yet.
      Logger.log("Supabase hive_config save failed, using Script Properties fallback: %s", String(err));
    }
  }

  PropertiesService.getScriptProperties().setProperty(HIVE_CONFIG_PROP_KEY, JSON.stringify(normalized));
  try {
    CacheService.getScriptCache().remove(HIVE_CONFIG_CACHE_KEY);
  } catch (cacheErr) {
    // Non-fatal.
  }
  return normalized;
}

function fetchHiveConfigFromProperties_() {
  try {
    const text = String(PropertiesService.getScriptProperties().getProperty(HIVE_CONFIG_PROP_KEY) || "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function fetchHiveConfigFromSupabase_(cfg) {
  const url = cfg.url
    + "/rest/v1/hive_config?select=id,label,icon,device_id,active,location,sort_order"
    + "&order=sort_order.asc,id.asc";

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
  if (code < 200 || code >= 300) {
    Logger.log("Supabase hive_config fetch failed (%s): %s", code, String(res.getContentText() || ""));
    return [];
  }

  const parsed = JSON.parse(String(res.getContentText() || "[]"));
  return Array.isArray(parsed) ? parsed : [];
}

function saveHiveConfigToSupabase_(cfg, rows) {
  const deleteRes = UrlFetchApp.fetch(cfg.url + "/rest/v1/hive_config?id=not.is.null", {
    method: "delete",
    muteHttpExceptions: true,
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      Prefer: "return=minimal",
      "User-Agent": "the-hive-appscript/1.0",
      "X-Client-Info": "the-hive-appscript/1.0"
    }
  });

  const deleteCode = Number(deleteRes.getResponseCode());
  if (deleteCode < 200 || deleteCode >= 300) {
    throw new Error("Failed to clear hive_config (HTTP " + deleteCode + ")");
  }

  const payload = rows.map((row, index) => ({
    id: row.id,
    label: row.label,
    icon: row.icon,
    device_id: row.device_id,
    active: Boolean(row.active),
    location: row.location,
    sort_order: index + 1
  }));

  const insertRes = UrlFetchApp.fetch(cfg.url + "/rest/v1/hive_config", {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      Prefer: "return=minimal",
      "User-Agent": "the-hive-appscript/1.0",
      "X-Client-Info": "the-hive-appscript/1.0"
    },
    payload: JSON.stringify(payload)
  });

  const insertCode = Number(insertRes.getResponseCode());
  if (insertCode < 200 || insertCode >= 300) {
    throw new Error("Failed to write hive_config (HTTP " + insertCode + "): " + String(insertRes.getContentText() || ""));
  }
}

function normalizeHiveConfigRows_(rows) {
  const fallback = [
    { id: "pooh", label: "Pooh", icon: "icons/pooh.svg", device_id: "1e432d9f-0798-4578-9da1-31471c5ba848", active: true, location: "" },
    { id: "piglet", label: "Piglet", icon: "icons/piglet.svg", device_id: null, active: false, location: "Coming soon" },
    { id: "eeyore", label: "Eeyore", icon: "icons/eeyore.svg", device_id: null, active: false, location: "Coming soon" }
  ];

  const input = Array.isArray(rows) && rows.length ? rows : fallback;
  const usedIds = {};
  const usedDeviceIds = {};
  const out = [];

  input.forEach((row, idx) => {
    const raw = row || {};
    const label = String(raw.label || raw.id || ("Hive " + (idx + 1))).trim() || ("Hive " + (idx + 1));
    const baseId = String(raw.id || label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "hive";

    let id = baseId;
    let suffix = 2;
    while (usedIds[id]) {
      id = baseId + "-" + suffix;
      suffix += 1;
    }
    usedIds[id] = true;

    let deviceId = raw.device_id == null ? "" : String(raw.device_id).trim();
    if (deviceId && usedDeviceIds[deviceId]) {
      deviceId = "";
    }
    if (deviceId) usedDeviceIds[deviceId] = true;

    out.push({
      id: id,
      label: label,
      icon: String(raw.icon || "favicon.svg").trim() || "favicon.svg",
      device_id: deviceId || null,
      active: Boolean(raw.active) && Boolean(deviceId),
      location: String(raw.location || "").trim()
    });
  });

  return out;
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
    weight_lbs: toNumOrNull_(r[2]), filtered_weight_lbs: toNumOrNull_(r[3]), battery_v: toNumOrNull_(r[4]),
    battery_pct: toNumOrNull_(r[5]), battery_charge_rate: toNumOrNull_(r[6]),
    battery_connected: r[7] === "" ? null : Boolean(r[7]),
    temperature_c: toNumOrNull_(r[8]), humidity_pct: toNumOrNull_(r[9]),
    source: r[10]
  }));
}

function getRecentRows_(sh, lastRow, limit, deviceId) {
  const startRow = Math.max(2, lastRow - limit + 1);
  const numRows = lastRow - startRow + 1;
  const values = sh.getRange(startRow, 1, numRows, 12).getValues();
  const rows = mapSheetRows_(values);

  if (!deviceId) return rows;
  return rows.filter(r => r.device_id === deviceId);
}

function getLatestRows_(sh, lastRow, scanLimit, deviceIds) {
  const startRow = Math.max(2, lastRow - scanLimit + 1);
  const numRows = lastRow - startRow + 1;
  const values = sh.getRange(startRow, 1, numRows, 12).getValues();
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
      weight_lbs_diff: diffNumber_(sheet && sheet.weight_lbs, supabase && supabase.weight_lbs),
      filtered_weight_lbs_diff: diffNumber_(sheet && sheet.filtered_weight_lbs, supabase && supabase.filtered_weight_lbs),
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
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    const weightValue = toNumOrNull_((row && row.weight_lbs) != null ? row.weight_lbs : (row && row.weight_kg));
    const filteredWeightValue = toNumOrNull_(row && row.filtered_weight_lbs);
    return Object.assign({}, row, {
      weight_lbs: weightValue,
      filtered_weight_lbs: filteredWeightValue
    });
  });
}

function isLikelyStepJump_(rawWeight, lastAcceptedWeight, lastAcceptedTs, ts) {
  if (!Number.isFinite(rawWeight) || !Number.isFinite(lastAcceptedWeight)) return false;
  if (!(lastAcceptedTs instanceof Date) || Number.isNaN(lastAcceptedTs.getTime())) return false;
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) return false;

  const dtMin = Math.max(0.1, (ts.getTime() - lastAcceptedTs.getTime()) / 60000);
  const maxStep = (WEIGHT_FILTER_MAX_RATE_LB_PER_MIN * dtMin) + WEIGHT_FILTER_STEP_MARGIN_LB;
  return Math.abs(rawWeight - lastAcceptedWeight) > maxStep;
}

function updateFilteredWeightState_(weightLbs, tsIso, prev) {
  const hasWeightInput = !(
    weightLbs === null
    || weightLbs === undefined
    || (typeof weightLbs === "string" && weightLbs.trim() === "")
  );
  const parsedWeight = Number(weightLbs);
  let effectiveWeight = parsedWeight;
  const ts = new Date(String(tsIso || ""));
  if (!hasWeightInput || !Number.isFinite(parsedWeight) || !(ts instanceof Date) || Number.isNaN(ts.getTime())) {
    const prevFiltered = toNumOrNull_(prev.fw_last_filtered);
    return {
      filtered: prevFiltered,
      state: {
        fw_last_filtered: prevFiltered,
        fw_last_accepted_raw: prev.fw_last_accepted_raw ?? null,
        fw_last_accepted_ts: prev.fw_last_accepted_ts ?? null,
        fw_candidate_value: prev.fw_candidate_value ?? null,
        fw_candidate_started_ts: prev.fw_candidate_started_ts ?? null,
        fw_candidate_count: prev.fw_candidate_count ?? 0
      }
    };
  }

  let lastFiltered = toNumOrNull_(prev.fw_last_filtered);
  let lastAcceptedRaw = toNumOrNull_(prev.fw_last_accepted_raw);
  const lastAcceptedTs = new Date(String(prev.fw_last_accepted_ts || ""));

  let candidateValue = toNumOrNull_(prev.fw_candidate_value);
  let candidateStartedTs = new Date(String(prev.fw_candidate_started_ts || ""));
  let candidateCount = Number(prev.fw_candidate_count) || 0;

  if (!(lastAcceptedTs instanceof Date) || Number.isNaN(lastAcceptedTs.getTime())) {
    lastAcceptedRaw = null;
  }
  if (!(candidateStartedTs instanceof Date) || Number.isNaN(candidateStartedTs.getTime())) {
    candidateValue = null;
    candidateCount = 0;
  }

  let acceptNow = true;
  let unlockedNow = false;
  const isStepJump = isLikelyStepJump_(effectiveWeight, lastAcceptedRaw, lastAcceptedTs, ts);
  if (isStepJump) {
    acceptNow = false;

    if (Number.isFinite(candidateValue) && candidateStartedTs instanceof Date && !Number.isNaN(candidateStartedTs.getTime())) {
      if (Math.abs(effectiveWeight - candidateValue) <= WEIGHT_FILTER_CONSISTENCY_BAND_LB) {
        candidateCount += 1;
        candidateValue = (candidateValue * 0.7) + (effectiveWeight * 0.3);
      } else {
        candidateValue = effectiveWeight;
        candidateStartedTs = ts;
        candidateCount = 1;
      }
    } else {
      candidateValue = effectiveWeight;
      candidateStartedTs = ts;
      candidateCount = 1;
    }

    const candidateMinutes = Math.max(0, (ts.getTime() - candidateStartedTs.getTime()) / 60000);
    if (candidateCount >= WEIGHT_FILTER_UNLOCK_MIN_POINTS && candidateMinutes >= WEIGHT_FILTER_UNLOCK_MIN_MINUTES) {
      acceptNow = true;
      unlockedNow = true;
      effectiveWeight = candidateValue;
    }
  } else {
    candidateValue = null;
    candidateStartedTs = null;
    candidateCount = 0;
  }

  if (acceptNow) {
    if (unlockedNow) {
      // Once the candidate plateau is sustained long enough, shift baseline immediately.
      lastFiltered = effectiveWeight;
    } else if (lastFiltered == null || !Number.isFinite(lastFiltered) || !(lastAcceptedTs instanceof Date) || Number.isNaN(lastAcceptedTs.getTime())) {
      lastFiltered = effectiveWeight;
    } else {
      const dtMin = Math.max(0.1, (ts.getTime() - lastAcceptedTs.getTime()) / 60000);
      const alpha = 1 - Math.exp(-dtMin / WEIGHT_FILTER_EMA_TAU_MIN);
      lastFiltered = (alpha * effectiveWeight) + ((1 - alpha) * lastFiltered);
    }

    lastAcceptedRaw = effectiveWeight;

    candidateValue = null;
    candidateStartedTs = null;
    candidateCount = 0;
  }

  return {
    filtered: Number.isFinite(lastFiltered) ? lastFiltered : null,
    state: {
      fw_last_filtered: Number.isFinite(lastFiltered) ? lastFiltered : null,
      fw_last_accepted_raw: Number.isFinite(lastAcceptedRaw) ? lastAcceptedRaw : null,
      fw_last_accepted_ts: acceptNow ? ts.toISOString() : (prev.fw_last_accepted_ts || null),
      fw_candidate_value: Number.isFinite(candidateValue) ? candidateValue : null,
      fw_candidate_started_ts: candidateStartedTs instanceof Date && !Number.isNaN(candidateStartedTs.getTime()) ? candidateStartedTs.toISOString() : null,
      fw_candidate_count: candidateCount
    }
  };
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

  let weightLbs = NaN;
  let battV = NaN;
  let battPct = NaN;
  let battChargeRate = NaN;
  let battConnected = null;
  let stayAwakeForUpdate = null;
  let temp = NaN; 
  let humidity = NaN;
  let rawScaleCounts = NaN;
  let tempPresent = false;
  let humidityPresent = false;
  let weightPresent = false;
  let weightReadFailed = false;

  function parseWeightMaybeNull_(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n - WEIGHT_INVALID_CALIBRATION_SENTINEL_LBS) <= WEIGHT_SENTINEL_EPS) return null;
    if (Math.abs(n - WEIGHT_READ_FAILED_SENTINEL_LBS) <= WEIGHT_SENTINEL_EPS) {
      weightReadFailed = true;
      return null;
    }
    return n;
  }

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
      } else if (name === "stay_awake_for_update") {
        if (v === true || v === false) {
          stayAwakeForUpdate = v;
        } else {
          const text = String(v || "").trim().toLowerCase();
          if (text === "true" || text === "1") stayAwakeForUpdate = true;
          if (text === "false" || text === "0") stayAwakeForUpdate = false;
        }
      } else if (name === "weight_lbs") {
        weightPresent = true;
        const parsed = parseWeightMaybeNull_(v);
        weightLbs = parsed == null ? NaN : parsed;
      } else if (name === "raw_scale_counts") {
        const counts = Number(v);
        if (Number.isFinite(counts)) {
          rawScaleCounts = counts;
          if (Math.abs(counts - RAW_SCALE_READ_FAILED_SENTINEL_COUNTS) <= 1000) {
            weightReadFailed = true;
          }
        }
      } else if (name === "weight_kg") {
        const kg = Number(v);
        if (Number.isFinite(kg)) {
          weightPresent = true;
          const parsed = parseWeightMaybeNull_(kg * LBS_PER_KG);
          weightLbs = parsed == null ? NaN : parsed;
        }
      } else if (name.includes("weight") || name.includes("hive_weight")) {
        // Backward compatibility for legacy variable names.
        weightPresent = true;
        const parsed = parseWeightMaybeNull_(v);
        weightLbs = parsed == null ? NaN : parsed;
      } else if (name === "temp_f" || name === "temperature_f") {
        tempPresent = true;
        if (v != null && String(v).trim() !== "") {
          const f = Number(v);
          if (Number.isFinite(f) && Math.abs(f - TEMP_SENSOR_NOT_CONNECTED_SENTINEL_F) > WEIGHT_SENTINEL_EPS) {
            temp = (f - 32) * (5 / 9);
          }
        }
      } else if (name === "temperature" || name === "temperature_c" || name === "temp") {
        tempPresent = true;
        if (v != null && String(v).trim() !== "") {
          const parsed = Number(v);
          if (Number.isFinite(parsed) && parsed > -200) {
            temp = parsed;
          }
        }
      } else if (name === "humidity" || name === "humidity_pct" || name === "relative_humidity") {
        humidityPresent = true;
        if (v != null && String(v).trim() !== "") {
          const parsed = Number(v);
          if (Number.isFinite(parsed) && Math.abs(parsed - HUMIDITY_SENSOR_NOT_CONNECTED_SENTINEL_PCT) > WEIGHT_SENTINEL_EPS) {
            humidity = parsed;
          }
        }
      }
    }
  }

  return {
    timestamp_iso: ts,
    device_id: deviceId,
    weight_lbs: Number.isFinite(weightLbs) ? weightLbs : null,
    battery_v: Number.isFinite(battV) ? battV : null,
    battery_pct: Number.isFinite(battPct) ? battPct : null,
    battery_charge_rate: Number.isFinite(battChargeRate) ? battChargeRate : null,
    battery_connected: battConnected,
    stay_awake_for_update: stayAwakeForUpdate,
    temperature_c: Number.isFinite(temp) ? temp : null,
    humidity_pct: Number.isFinite(humidity) ? humidity : null,
    temp_present: tempPresent,
    humidity_present: humidityPresent,
    raw_scale_counts: Number.isFinite(rawScaleCounts) ? rawScaleCounts : null,
    weight_present: weightPresent,
    weight_read_failed: weightReadFailed,
    source: "arduino-cloud"
  };
}

// ── State persistence (handles partial variable updates) ─────────────────────

function mergeWithLastKnownState_(incoming) {
  const props = PropertiesService.getScriptProperties();
  const key = "last_state_" + (incoming.device_id || "default");
  const prev = JSON.parse(props.getProperty(key) || "{}");

  const prevTsMs = Date.parse(String(prev.timestamp_iso || ""));
  const currentTsMs = Date.parse(String(incoming.timestamp_iso || ""));
  const rapidUpdate = Number.isFinite(prevTsMs)
    && Number.isFinite(currentTsMs)
    && Math.abs(currentTsMs - prevTsMs) <= STAY_AWAKE_INFER_THRESHOLD_MS;
  const rapidUpdateStreak = rapidUpdate ? (Number(prev.rapid_update_streak) || 0) + 1 : 0;

  let stayAwakeState = null;
  if (incoming.stay_awake_for_update != null) {
    stayAwakeState = incoming.stay_awake_for_update;
  } else if (rapidUpdate && prev.stay_awake_for_update === true) {
    stayAwakeState = true;
  } else if (rapidUpdateStreak >= STAY_AWAKE_INFER_STREAK) {
    stayAwakeState = true;
  } else if (!rapidUpdate) {
    stayAwakeState = false;
  } else {
    stayAwakeState = prev.stay_awake_for_update != null ? prev.stay_awake_for_update : null;
  }

  const mergedWeight = incoming.weight_present
    ? (incoming.weight_lbs ?? null)
    : (incoming.weight_lbs ?? incoming.weight_kg ?? prev.weight_lbs ?? prev.weight_kg ?? null);

  const filteredState = updateFilteredWeightState_(mergedWeight, incoming.timestamp_iso, prev);

  const merged = {
    timestamp_iso: incoming.timestamp_iso,
    device_id: incoming.device_id || prev.device_id || "",
    weight_lbs: mergedWeight,
    filtered_weight_lbs: filteredState.filtered,
    battery_v: incoming.battery_v ?? prev.battery_v ?? null,
    battery_pct: incoming.battery_pct ?? prev.battery_pct ?? null,
    battery_charge_rate: incoming.battery_charge_rate ?? null,
    battery_connected: incoming.battery_connected ?? null,
    stay_awake_for_update: stayAwakeState,
    rapid_update_streak: rapidUpdateStreak,
    temperature_c: incoming.temp_present ? (incoming.temperature_c ?? null) : (prev.temperature_c ?? null),
    humidity_pct: incoming.humidity_present ? (incoming.humidity_pct ?? null) : (prev.humidity_pct ?? null),
    raw_scale_counts: incoming.raw_scale_counts ?? null,
    weight_read_failed: incoming.weight_read_failed === true,
    source: incoming.source || "arduino-cloud",
    fw_last_filtered: filteredState.state.fw_last_filtered,
    fw_last_accepted_raw: filteredState.state.fw_last_accepted_raw,
    fw_last_accepted_ts: filteredState.state.fw_last_accepted_ts,
    fw_candidate_value: filteredState.state.fw_candidate_value,
    fw_candidate_started_ts: filteredState.state.fw_candidate_started_ts,
    fw_candidate_count: filteredState.state.fw_candidate_count
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
    sh.appendRow(["timestamp_iso", "device_id", "weight_lbs", "filtered_weight_lbs", "battery_v", "battery_pct", "battery_charge_rate", "battery_connected", "temperature_c", "humidity_pct", "source", "event_raw"]);
  }

  // One-time header rename keeps Sheets aligned with lbs semantics.
  const headerWeightName = String(sh.getRange(1, 3).getValue() || "").trim().toLowerCase();
  if (headerWeightName === "weight_kg") {
    sh.getRange(1, 3).setValue("weight_lbs");
  }

  const headerFilteredWeightName = String(sh.getRange(1, 4).getValue() || "").trim().toLowerCase();
  if (headerFilteredWeightName !== "filtered_weight_lbs") {
    sh.insertColumnAfter(3);
    sh.getRange(1, 4).setValue("filtered_weight_lbs");
  }

  return sh;
}

function upsertTelemetryRow_(sh, merged, raw) {
  const rowValues = [
    merged.timestamp_iso,
    merged.device_id || "",
    merged.weight_lbs ?? "",
    merged.filtered_weight_lbs ?? "",
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

  const last = sh.getRange(lastRow, 1, 1, 12).getValues()[0];
  const lastTs = new Date(last[0]);
  const currentTs = new Date(merged.timestamp_iso);
  const lastDevice = String(last[1] || "");
  const currentDevice = String(merged.device_id || "");

  const canDedupe =
    merged.stay_awake_for_update !== true &&
    currentDevice !== "" &&
    lastDevice === currentDevice &&
    !isNaN(lastTs.getTime()) &&
    !isNaN(currentTs.getTime()) &&
    Math.abs(currentTs.getTime() - lastTs.getTime()) <= DEDUPE_WINDOW_MS;

  if (canDedupe) {
    sh.getRange(lastRow, 1, 1, 12).setValues([rowValues]);
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
  const startedAtMs = Date.now();
  let latestFetchDoneAtMs = startedAtMs;
  let rawWriteDoneAtMs = startedAtMs;

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
    weight_lbs: merged.weight_lbs,
    filtered_weight_lbs: merged.filtered_weight_lbs,
    battery_v: merged.battery_v,
    battery_pct: merged.battery_pct,
    battery_charge_rate: merged.battery_charge_rate,
    battery_connected: merged.battery_connected,
    temperature_c: merged.temperature_c,
    humidity_pct: merged.humidity_pct,
    raw_scale_counts: merged.raw_scale_counts,
    source: merged.source || "arduino-cloud",
    event_raw: eventRaw
  };

  const latestPayload = {
    device_id: deviceId,
    ts: merged.timestamp_iso,
    weight_lbs: merged.weight_lbs,
    filtered_weight_lbs: merged.filtered_weight_lbs,
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
    latestFetchDoneAtMs = Date.now();
    let res;
    let action = "inserted";

    if (merged.stay_awake_for_update !== true && latestRow && shouldDedupeSupabaseRow_(latestRow.ts, merged.timestamp_iso, deviceId, latestRow.device_id)) {
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
    rawWriteDoneAtMs = Date.now();

    const code = Number(res.getResponseCode());
    if (code >= 200 && code < 300) {
      const latestRes = upsertSupabaseLatest_(cfg, latestPayload, baseHeaders);
      if (latestRes.ok) {
        const finishedAtMs = Date.now();
        return {
          enabled: true,
          ok: true,
          status: code,
          action: action,
          timings_ms: {
            total: finishedAtMs - startedAtMs,
            latest_fetch: latestFetchDoneAtMs - startedAtMs,
            raw_write: rawWriteDoneAtMs - latestFetchDoneAtMs,
            latest_upsert: finishedAtMs - rawWriteDoneAtMs
          }
        };
      }

      const finishedAtMs = Date.now();
      return {
        enabled: true,
        ok: false,
        status: code,
        action: action,
        error: latestRes.error || "telemetry_latest upsert failed",
        timings_ms: {
          total: finishedAtMs - startedAtMs,
          latest_fetch: latestFetchDoneAtMs - startedAtMs,
          raw_write: rawWriteDoneAtMs - latestFetchDoneAtMs,
          latest_upsert: finishedAtMs - rawWriteDoneAtMs
        }
      };
    }

    const body = String(res.getContentText() || "");
    Logger.log("Supabase dual-write failed (%s): %s", code, body);
    const finishedAtMs = Date.now();
    return {
      enabled: true,
      ok: false,
      status: code,
      error: body.slice(0, 300),
      timings_ms: {
        total: finishedAtMs - startedAtMs,
        latest_fetch: latestFetchDoneAtMs - startedAtMs,
        raw_write: rawWriteDoneAtMs - latestFetchDoneAtMs,
        latest_upsert: finishedAtMs - rawWriteDoneAtMs
      }
    };
  } catch (err) {
    Logger.log("Supabase dual-write exception: %s", String(err));
    const finishedAtMs = Date.now();
    return {
      enabled: true,
      ok: false,
      error: String(err),
      timings_ms: {
        total: finishedAtMs - startedAtMs,
        latest_fetch: latestFetchDoneAtMs - startedAtMs,
        raw_write: rawWriteDoneAtMs - latestFetchDoneAtMs,
        latest_upsert: finishedAtMs - rawWriteDoneAtMs
      }
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

// ── One-time maintenance helpers ─────────────────────────────────────────────

/**
 * Clears only weight values while preserving every row and all non-weight data.
 *
 * Targets:
 * - Google Sheet columns C/D (weight_lbs + filtered_weight_lbs) for all data rows in SHEET_NAME.
 * - Supabase public.telemetry_raw/telemetry_latest weight_lbs + filtered_weight_lbs.
 *
 * Safe to run multiple times.
 */
function clearWeightDataOnly() {
  const result = {
    ok: true,
    sheet: {
      rows_total: 0,
      weight_cells_cleared: 0,
      filtered_weight_cells_cleared: 0
    },
    supabase: {
      attempted: false,
      telemetry_raw_status: null,
      telemetry_latest_status: null,
      legacy_weight_kg_status: null,
      warning: ""
    }
  };

  const sh = getOrCreateSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    const numRows = lastRow - 1;
    const values = sh.getRange(2, 3, numRows, 1).getValues();
    let nonEmpty = 0;
    for (const r of values) {
      if (String(r[0] || "").trim() !== "") nonEmpty++;
    }

    const filteredValues = sh.getRange(2, 4, numRows, 1).getValues();
    let filteredNonEmpty = 0;
    for (const r of filteredValues) {
      if (String(r[0] || "").trim() !== "") filteredNonEmpty++;
    }

    sh.getRange(2, 3, numRows, 1).clearContent();
    sh.getRange(2, 4, numRows, 1).clearContent();
    result.sheet.rows_total = numRows;
    result.sheet.weight_cells_cleared = nonEmpty;
    result.sheet.filtered_weight_cells_cleared = filteredNonEmpty;
  }

  const cfg = getSupabaseAdminConfig_();
  if (!cfg.enabled) {
    result.supabase.warning = "supabase_not_configured";
    return result;
  }

  result.supabase.attempted = true;
  const baseHeaders = {
    apikey: cfg.key,
    Authorization: "Bearer " + cfg.key,
    Prefer: "return=minimal",
    "User-Agent": "the-hive-appscript/1.0",
    "X-Client-Info": "the-hive-appscript/1.0"
  };

  const rawRes = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_raw?weight_lbs=not.is.null", {
    method: "patch",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: baseHeaders,
    payload: JSON.stringify({ weight_lbs: null })
  });
  result.supabase.telemetry_raw_status = Number(rawRes.getResponseCode());

  const latestRes = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_latest?weight_lbs=not.is.null", {
    method: "patch",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: baseHeaders,
    payload: JSON.stringify({ weight_lbs: null })
  });
  result.supabase.telemetry_latest_status = Number(latestRes.getResponseCode());

  const rawFilteredRes = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_raw?filtered_weight_lbs=not.is.null", {
    method: "patch",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: baseHeaders,
    payload: JSON.stringify({ filtered_weight_lbs: null })
  });
  result.supabase.telemetry_raw_filtered_status = Number(rawFilteredRes.getResponseCode());

  const latestFilteredRes = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_latest?filtered_weight_lbs=not.is.null", {
    method: "patch",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: baseHeaders,
    payload: JSON.stringify({ filtered_weight_lbs: null })
  });
  result.supabase.telemetry_latest_filtered_status = Number(latestFilteredRes.getResponseCode());

  // Optional legacy cleanup for projects that still use weight_kg.
  const legacyRes = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_raw?weight_kg=not.is.null", {
    method: "patch",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: baseHeaders,
    payload: JSON.stringify({ weight_kg: null })
  });
  result.supabase.legacy_weight_kg_status = Number(legacyRes.getResponseCode());

  const rawOk = result.supabase.telemetry_raw_status >= 200 && result.supabase.telemetry_raw_status < 300;
  const latestOk = result.supabase.telemetry_latest_status >= 200 && result.supabase.telemetry_latest_status < 300;
  const rawFilteredOk = result.supabase.telemetry_raw_filtered_status >= 200 && result.supabase.telemetry_raw_filtered_status < 300;
  const latestFilteredOk = result.supabase.telemetry_latest_filtered_status >= 200 && result.supabase.telemetry_latest_filtered_status < 300;
  const legacyOk = result.supabase.legacy_weight_kg_status >= 200 && result.supabase.legacy_weight_kg_status < 300;
  const legacyIgnored = result.supabase.legacy_weight_kg_status === 400 || result.supabase.legacy_weight_kg_status === 404;

  result.ok = rawOk && latestOk && rawFilteredOk && latestFilteredOk && (legacyOk || legacyIgnored);
  if (!result.ok) {
    result.supabase.warning = "supabase_weight_clear_incomplete";
  }

  Logger.log("clearWeightDataOnly result: %s", JSON.stringify(result));
  return result;
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
  const values = sh.getRange(2, 1, numRows, 12).getValues();

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

      // event_raw (col L) is stored as a JSON string in Sheets
      let eventRaw = null;
      try {
        const rawStr = String(r[11] || "").trim();
        eventRaw = rawStr ? JSON.parse(rawStr) : null;
      } catch (ignored) {
        eventRaw = r[11] ? { raw: String(r[11]).slice(0, 1000) } : null;
      }

      payloads.push({
        ts: tsIso,
        device_id: deviceId,
        weight_lbs: toNumOrNull_(r[2]),
        filtered_weight_lbs: toNumOrNull_(r[3]),
        battery_v: toNumOrNull_(r[4]),
        battery_pct: toNumOrNull_(r[5]),
        battery_charge_rate: toNumOrNull_(r[6]),
        battery_connected: r[7] === "" ? null : Boolean(r[7]),
        temperature_c: toNumOrNull_(r[8]),
        humidity_pct: toNumOrNull_(r[9]),
        source: String(r[10] || "arduino-cloud") || "arduino-cloud",
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

/**
 * Recomputes filtered_weight_lbs for historical data using the current filter implementation.
 *
 * @param {string=} target Optional: "all" (default), "sheets", or "supabase".
 * @param {string=} deviceIdsCsv Optional comma-separated device_id list.
 */
function recomputeFilteredWeightHistory(target, deviceIdsCsv) {
  const mode = String(target || "all").trim().toLowerCase();
  const applySheets = mode === "all" || mode === "sheets";
  const applySupabase = mode === "all" || mode === "supabase";
  const deviceIds = parseDeviceIds_(deviceIdsCsv || "");
  const wanted = deviceIds.length ? new Set(deviceIds) : null;

  const result = {
    ok: true,
    mode: mode || "all",
    device_ids: deviceIds,
    sheets: null,
    supabase: null,
    warning: ""
  };

  if (applySheets) {
    result.sheets = recomputeFilteredWeightInSheet_(wanted);
    if (!result.sheets.ok) result.ok = false;
  }

  if (applySupabase) {
    result.supabase = recomputeFilteredWeightInSupabase_(wanted);
    if (!result.supabase.ok) result.ok = false;
  }

  if (!applySheets && !applySupabase) {
    result.ok = false;
    result.warning = "invalid_target";
  }

  Logger.log("recomputeFilteredWeightHistory result: %s", JSON.stringify(result));
  return result;
}

function recomputeFilteredWeightInSheet_(wantedDeviceIds) {
  const sh = getOrCreateSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    return { ok: true, rows_total: 0, rows_updated: 0, devices_updated: 0 };
  }

  const numRows = lastRow - 1;
  const values = sh.getRange(2, 1, numRows, 12).getValues();
  const rows = [];

  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const deviceId = String(r[1] || "").trim();
    if (!deviceId) continue;
    if (wantedDeviceIds && !wantedDeviceIds.has(deviceId)) continue;

    const tsRaw = r[0];
    const tsIso = normalizeIso_(tsRaw);
    if (!tsIso) continue;

    rows.push({
      idx: i,
      device_id: deviceId,
      timestamp_iso: tsIso,
      ts_ms: Date.parse(tsIso),
      weight_lbs: toNumOrNull_(r[2])
    });
  }

  rows.sort((a, b) => {
    if (a.device_id < b.device_id) return -1;
    if (a.device_id > b.device_id) return 1;
    if (a.ts_ms < b.ts_ms) return -1;
    if (a.ts_ms > b.ts_ms) return 1;
    return a.idx - b.idx;
  });

  const filteredCol = values.map(r => [r[3]]);
  const stateByDevice = {};
  const latestByDevice = {};
  let updated = 0;

  for (const row of rows) {
    const did = row.device_id;
    const prevState = stateByDevice[did] || {};
    const next = updateFilteredWeightState_(row.weight_lbs, row.timestamp_iso, prevState);
    stateByDevice[did] = next.state;
    latestByDevice[did] = {
      timestamp_iso: row.timestamp_iso,
      weight_lbs: row.weight_lbs,
      filtered_weight_lbs: next.filtered,
      state: next.state
    };

    filteredCol[row.idx] = [next.filtered == null ? "" : next.filtered];
    updated += 1;
  }

  sh.getRange(2, 4, numRows, 1).setValues(filteredCol);
  persistFilterStateFromLatest_(latestByDevice);

  return {
    ok: true,
    rows_total: numRows,
    rows_recomputed: rows.length,
    rows_updated: updated,
    devices_updated: Object.keys(latestByDevice).length
  };
}

function recomputeFilteredWeightInSupabase_(wantedDeviceIds) {
  const cfg = getSupabaseAdminConfig_();
  if (!cfg.enabled) {
    return { ok: false, warning: "supabase_not_configured", rows_recomputed: 0, devices_updated: 0 };
  }

  const headers = {
    apikey: cfg.key,
    Authorization: "Bearer " + cfg.key,
    Prefer: "resolution=merge-duplicates,return=minimal",
    "User-Agent": "the-hive-appscript/1.0",
    "X-Client-Info": "the-hive-appscript/1.0"
  };

  const allRows = fetchAllSupabaseRowsForRecompute_(cfg, wantedDeviceIds);
  if (!allRows.length) {
    return { ok: true, rows_recomputed: 0, devices_updated: 0, write_batches: 0 };
  }

  const stateByDevice = {};
  const latestByDevice = {};
  const updates = [];

  for (const row of allRows) {
    const did = String(row.device_id || "").trim();
    if (!did) continue;

    const prevState = stateByDevice[did] || {};
    const next = updateFilteredWeightState_(toNumOrNull_(row.weight_lbs), row.ts, prevState);
    stateByDevice[did] = next.state;
    latestByDevice[did] = {
      timestamp_iso: row.ts,
      weight_lbs: toNumOrNull_(row.weight_lbs),
      filtered_weight_lbs: next.filtered,
      state: next.state
    };

    updates.push({
      device_id: did,
      ts: row.ts,
      filtered_weight_lbs: next.filtered
    });
  }

  const BATCH = 500;
  let writeBatches = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const res = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_raw?on_conflict=device_id,ts", {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      headers: headers,
      payload: JSON.stringify(batch)
    });

    const code = Number(res.getResponseCode());
    if (code < 200 || code >= 300) {
      return {
        ok: false,
        warning: "supabase_raw_recompute_failed",
        status: code,
        error: String(res.getContentText() || "").slice(0, 300),
        rows_recomputed: updates.length,
        devices_updated: Object.keys(latestByDevice).length,
        write_batches: writeBatches
      };
    }

    writeBatches += 1;
  }

  let latestPatches = 0;
  for (const did of Object.keys(latestByDevice)) {
    const latest = latestByDevice[did];
    const res = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_latest?device_id=eq." + encodeURIComponent(did), {
      method: "patch",
      contentType: "application/json",
      muteHttpExceptions: true,
      headers: {
        apikey: cfg.key,
        Authorization: "Bearer " + cfg.key,
        Prefer: "return=minimal",
        "User-Agent": "the-hive-appscript/1.0",
        "X-Client-Info": "the-hive-appscript/1.0"
      },
      payload: JSON.stringify({ filtered_weight_lbs: latest.filtered_weight_lbs })
    });

    const code = Number(res.getResponseCode());
    if (code >= 200 && code < 300) {
      latestPatches += 1;
    }
  }

  persistFilterStateFromLatest_(latestByDevice);

  return {
    ok: true,
    rows_recomputed: updates.length,
    devices_updated: Object.keys(latestByDevice).length,
    write_batches: writeBatches,
    latest_rows_patched: latestPatches
  };
}

function fetchAllSupabaseRowsForRecompute_(cfg, wantedDeviceIds) {
  const out = [];
  const PAGE = 1000;
  let offset = 0;

  while (true) {
    const queryParts = [
      "select=" + encodeURIComponent("ts,device_id,weight_lbs"),
      "order=" + encodeURIComponent("device_id.asc,ts.asc"),
      "limit=" + encodeURIComponent(String(PAGE)),
      "offset=" + encodeURIComponent(String(offset))
    ];

    if (wantedDeviceIds && wantedDeviceIds.size) {
      const encoded = Array.from(wantedDeviceIds).map(id => '"' + String(id).replace(/"/g, "") + '"').join(",");
      queryParts.push("device_id=" + encodeURIComponent("in.(" + encoded + ")"));
    }

    const res = UrlFetchApp.fetch(cfg.url + "/rest/v1/telemetry_raw?" + queryParts.join("&"), {
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
    if (code < 200 || code >= 300) break;

    const rows = JSON.parse(String(res.getContentText() || "[]"));
    if (!Array.isArray(rows) || !rows.length) break;

    out.push.apply(out, rows);
    if (rows.length < PAGE) break;
    offset += rows.length;
  }

  return out;
}

function normalizeIso_(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString();
  }

  const text = String(value).trim();
  if (!text) return null;
  const d = new Date(text);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

function persistFilterStateFromLatest_(latestByDevice) {
  const props = PropertiesService.getScriptProperties();

  Object.keys(latestByDevice || {}).forEach(did => {
    const key = "last_state_" + did;
    const latest = latestByDevice[did] || {};
    const prev = JSON.parse(props.getProperty(key) || "{}");
    const state = latest.state || {};

    const merged = Object.assign({}, prev, {
      device_id: did,
      timestamp_iso: latest.timestamp_iso || prev.timestamp_iso || null,
      weight_lbs: latest.weight_lbs ?? prev.weight_lbs ?? null,
      filtered_weight_lbs: latest.filtered_weight_lbs ?? prev.filtered_weight_lbs ?? null,
      fw_last_filtered: state.fw_last_filtered ?? prev.fw_last_filtered ?? null,
      fw_last_accepted_raw: state.fw_last_accepted_raw ?? prev.fw_last_accepted_raw ?? null,
      fw_last_accepted_ts: state.fw_last_accepted_ts ?? prev.fw_last_accepted_ts ?? null,
      fw_candidate_value: state.fw_candidate_value ?? prev.fw_candidate_value ?? null,
      fw_candidate_started_ts: state.fw_candidate_started_ts ?? prev.fw_candidate_started_ts ?? null,
      fw_candidate_count: state.fw_candidate_count ?? prev.fw_candidate_count ?? 0
    });

    props.setProperty(key, JSON.stringify(merged));
  });
}

// ── Debug helper (run from editor to test sheet access) ──────────────────────

function testWrite() {
  const sh = getOrCreateSheet_();
  Logger.log("Sheet found: " + sh.getName());
  Logger.log("Last row: " + sh.getLastRow());
  sh.appendRow(["TEST", "debug", 99, 99, 4.2, 100, 0.5, true, 24.5, 55.0, "test", "debug-payload"]);
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

function setHiveConfigAdminKey(key) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(HIVE_CONFIG_ADMIN_PROP_KEY, String(key || "").trim());
  return getSupabaseDualWriteConfigStatus();
}

function clearHiveConfigAdminKey() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(HIVE_CONFIG_ADMIN_PROP_KEY);
  return getSupabaseDualWriteConfigStatus();
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
  const hiveConfigAdminKey = String(props.getProperty(HIVE_CONFIG_ADMIN_PROP_KEY) || "");

  return {
    enabled: enabledRaw == null ? SUPABASE_DUAL_WRITE_ENABLED_DEFAULT : String(enabledRaw).toLowerCase() === "true",
    url_set: Boolean(url),
    key_set: Boolean(key),
    key_preview: key ? (key.slice(0, 6) + "..." + key.slice(-4)) : "",
    hive_config_admin_key_set: Boolean(hiveConfigAdminKey)
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
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
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

function getSupabaseAdminConfig_() {
  const props = PropertiesService.getScriptProperties();
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

function isAuthorizedAdminRequest_(e) {
  const key = (e.parameter && e.parameter.key) ? String(e.parameter.key) : "";
  if (key && key === SHARED_SECRET) return true;
  const adminKey = String(PropertiesService.getScriptProperties().getProperty(HIVE_CONFIG_ADMIN_PROP_KEY) || "").trim();
  return Boolean(adminKey) && key === adminKey;
}