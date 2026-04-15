// ─────────────────────────────────────────────────────────────────────────────
// CONFIG is loaded from hives.js (SUPABASE_URL, SUPABASE_ANON_KEY, FETCH_LIMIT, AUTO_REFRESH_MS, HIVES_CONFIG)
// ─────────────────────────────────────────────────────────────────────────────

// Read ?device= from URL to know which hive to show
const params     = new URLSearchParams(window.location.search);
const deviceId   = params.get("device") || null;
const hiveList   = (typeof getConfiguredHives === "function" ? getConfiguredHives() : HIVES_CONFIG) || [];
const hiveCfg    = hiveList.find(h => h.device_id === deviceId)
  || hiveList[0]
  || { label: "Hive Detail", icon: "favicon.svg", location: "" };

function escapeHtml_(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isImageIconValue_(icon) {
  const value = String(icon || "").trim();
  if (!value) return true;
  return /[./\\]/.test(value) || /^(https?:|data:|blob:)/i.test(value);
}

function renderHiveIconMarkup_(hive) {
  const alt = `${hive.label} badge`;
  const icon = String(hive.icon || "").trim();
  if (!icon || isImageIconValue_(icon)) {
    const src = icon || "favicon.svg";
    return `<img class="badge-icon badge-icon--header" src="${src}" alt="${alt}" />`;
  }
  return `<span class="badge-emoji badge-emoji--header" role="img" aria-label="${escapeHtml_(alt)}">${escapeHtml_(icon)}</span>`;
}

// Set page title
if (document.getElementById("page-title")) {
  document.getElementById("page-title").textContent = hiveCfg.label;
}
if (document.getElementById("page-hive-icon")) {
  document.getElementById("page-hive-icon").innerHTML = renderHiveIconMarkup_(hiveCfg);
}
if (document.getElementById("page-subtitle") && hiveCfg.location) {
  document.getElementById("page-subtitle").textContent = hiveCfg.location;
}
document.title = `The Hive — ${hiveCfg.label}`;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let allRows = [];
let activeHours = 24;
let refreshTimer = null;
let refreshSeq = 0;
let historyLoadSeq = 0;
let hasCompleteHistory = false;
let isHistoryLoading = false;
let showRawCountsDebug = false;
const chartSyncBound = new Set();
let isSyncingAxisRange = false;
let fullWeightCtx = null;

const SHUTDOWN_PCT = 2;
const INVALID_CALIBRATION_WEIGHT_SENTINEL = -1234.5;
const INVALID_CALIBRATION_WEIGHT_EPS = 0.01;
const RAW_SCALE_READ_FAILED_SENTINEL = -2147483000;
const RAW_SCALE_READ_FAILED_EPS = 1000;
const MIN_RATE_FOR_ETA = 0.05;
const EST_MIN_POINTS = 4;
const EST_HISTORY_WINDOW_HOURS = 2.25;
const EST_RECENT_WINDOW_HOURS = 0.9;
const EST_RECENT_EDGE_HOURS = 2.5;
const EST_FUTURE_SHARE = 0.35;
const EST_RECENT_FUTURE_SHARE = 0.12;
const EST_MIN_DT_HOURS = 1 / 30; // 2m
const EST_MAX_DT_HOURS = 3;
const EST_MAX_ABS_RATE = 30;
const EST_LOCAL_OUTLIER_Z = 3.25;
const EST_MIN_LOCAL_SPAN_HOURS = 0.4;
const EST_LATEST_DECAY_HOURS = 0.7;
const EST_FALLBACK_NEAREST_SEGMENTS = 8;
const WEIGHT_NO_DATA_DEFAULT_TEXT = "No weight data yet — add a weight sensor to your Arduino Thing to enable this chart.";
const WEIGHT_NEEDS_CALIBRATION_TEXT = "Scale not calibrated yet. In IoT Cloud, run Tare with empty hive, then Calibrate with a known weight.";
const WEIGHT_SENSOR_FAILURE_TIMEOUT_MS = 60 * 60 * 1000;
const WEIGHT_SENSOR_FAILURE_TEXT = "Sensor read failure";
const INCLUDE_EVENT_RAW_COLUMN = false;
const BUCKET_TIER_MAX_24H = 24;
const BUCKET_TIER_MAX_7D = 168;
const BUCKET_TIER_MAX_30D = 720;
const BUCKET_MINUTES_24H = 5;
const BUCKET_MINUTES_7D = 15;
const BUCKET_MINUTES_30D = 60;
const BUCKET_MINUTES_OLDER = 180;
const TEMP_SENSOR_NOT_CONNECTED_SENTINEL_F = -999.0;
const HUMIDITY_SENSOR_NOT_CONNECTED_SENTINEL_PCT = -1.0;

function isInvalidCalibrationWeight_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n - INVALID_CALIBRATION_WEIGHT_SENTINEL) <= INVALID_CALIBRATION_WEIGHT_EPS;
}

function isRawScaleSensorError_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n - RAW_SCALE_READ_FAILED_SENTINEL) <= RAW_SCALE_READ_FAILED_EPS;
}

function getWeightLbs_(row) {
  if (!row) return null;
  const direct = Number(row.weight_lbs);
  if (Number.isFinite(direct)) return direct;
  const legacy = Number(row.weight_kg);
  return Number.isFinite(legacy) ? legacy : null;
}

function getFilteredWeightLbs_(row) {
  if (!row) return null;
  const n = Number(row.filtered_weight_lbs);
  return Number.isFinite(n) ? n : null;
}

function getTemperatureF_(row) {
  if (!row) return null;

  const tempFValue = row.temp_f;
  if (tempFValue != null && String(tempFValue).trim() !== "") {
    const directF = Number(tempFValue);
    if (Number.isFinite(directF)) {
      if (Math.abs(directF - TEMP_SENSOR_NOT_CONNECTED_SENTINEL_F) <= 0.25) return null;
      return directF;
    }
  }

  const tempCValue = row.temperature_c;
  if (tempCValue == null || String(tempCValue).trim() === "") return null;

  const c = Number(tempCValue);
  if (!Number.isFinite(c) || c <= -200) return null;
  return (c * 9 / 5) + 32;
}

function getHumidityPct_(row) {
  if (!row) return null;

  const humidityValue = row.humidity_pct;
  if (humidityValue == null || String(humidityValue).trim() === "") return null;

  const n = Number(humidityValue);
  if (!Number.isFinite(n) || Math.abs(n - HUMIDITY_SENSOR_NOT_CONNECTED_SENTINEL_PCT) <= 0.25 || n < 0) return null;
  return n;
}

function getRawScaleCounts_(row) {
  if (!row) return null;

  const direct = Number(row.raw_scale_counts);
  if (Number.isFinite(direct)) return direct;

  const eventRaw = row.event_raw;
  if (!eventRaw || !Array.isArray(eventRaw.values)) return null;

  for (const item of eventRaw.values) {
    if (String(item && item.name || "").toLowerCase() !== "raw_scale_counts") continue;
    const parsed = Number(item.value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getRawScaleErrorSamples_(row) {
  if (!row) return 0;
  const n = Number(row.raw_scale_error_samples);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const PLOTLY_LAYOUT_BASE = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor:  "rgba(0,0,0,0)",
  font: { family: "'Segoe UI', system-ui, sans-serif", color: "#2b241b", size: 12 },
  margin: { l: 55, r: 20, t: 10, b: 50 },
  xaxis: { gridcolor: "#e4d9c8", linecolor: "#e4d9c8", tickformat: "%b %d\n%H:%M" },
  yaxis: { gridcolor: "#e4d9c8", linecolor: "#e4d9c8", zeroline: false },
  hovermode: "x unified",
  legend: { orientation: "h", y: -0.15 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Data fetching
// ─────────────────────────────────────────────────────────────────────────────
function supabaseAuthHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

function mapSupabaseRows(rows) {
  return (rows || []).map(r => ({
    ...r,
    timestamp_iso: r.ts,
    ts: new Date(r.ts),
  }));
}

function normalizeRowsForCharts(rows) {
  const filtered = deviceId ? rows.filter(r => r.device_id === deviceId) : rows;
  return filtered.reverse();
}

function getRangeCutoff(hours) {
  if (!hours) return null;
  return new Date(Date.now() - hours * 3600 * 1000);
}

function formatHistoryTs(ts) {
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) return "unknown";

  const now = new Date();
  const isToday = ts.getFullYear() === now.getFullYear()
    && ts.getMonth() === now.getMonth()
    && ts.getDate() === now.getDate();

  if (isToday) {
    return ts.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  return ts.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function updateHeaderTimes_() {
  const newestEl = document.getElementById("newest-data");
  const oldestEl = document.getElementById("oldest-data");
  if (!newestEl || !oldestEl) return;

  if (!allRows.length) {
    newestEl.textContent = "—";
    oldestEl.textContent = "—";
    return;
  }

  newestEl.textContent = formatHistoryTs(allRows[allRows.length - 1]?.ts);
  oldestEl.textContent = formatHistoryTs(allRows[0]?.ts);
}

function needsMoreHistory(hours) {
  if (hasCompleteHistory) return false;
  if (!allRows.length) return false;
  if (!hours) return true;

  const cutoff = getRangeCutoff(hours);
  const oldest = allRows[0]?.ts;
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) return true;
  if (!(oldest instanceof Date) || Number.isNaN(oldest.getTime())) return true;
  return oldest > cutoff;
}

async function fetchTelemetryPage(limit, beforeTsIso = null) {
  if (!SUPABASE_ANON_KEY) {
    throw new Error("Missing SUPABASE_ANON_KEY in hives.js");
  }

  const query = new URLSearchParams({
    select: INCLUDE_EVENT_RAW_COLUMN
      ? "ts,device_id,weight_lbs,filtered_weight_lbs,raw_scale_counts,battery_v,battery_pct,temperature_c,humidity_pct,source,event_raw"
      : "ts,device_id,weight_lbs,filtered_weight_lbs,raw_scale_counts,battery_v,battery_pct,temperature_c,humidity_pct,source",
    order: "ts.desc",
    limit: String(limit),
  });
  if (deviceId) query.set("device_id", `eq.${deviceId}`);
  if (beforeTsIso) query.set("ts", `lt.${beforeTsIso}`);

  const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/telemetry_raw?${query.toString()}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: supabaseAuthHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return mapSupabaseRows(await res.json());
}

async function fetchTelemetrySeries_(hours, bucketMinutes) {
  if (!SUPABASE_ANON_KEY) {
    throw new Error("Missing SUPABASE_ANON_KEY in hives.js");
  }
  if (!deviceId) return [];

  const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/get_series`;
  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...supabaseAuthHeaders(),
    },
    body: JSON.stringify({
      p_device_id: deviceId,
      p_hours: Math.max(1, Math.floor(hours)),
      p_bucket_minutes: Math.max(1, Math.floor(bucketMinutes)),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return (await res.json() || []).map(r => ({
    ...r,
    ts: new Date(r.timestamp_iso || r.ts),
  }));
}

function getBucketTierRequests_(hours) {
  const requestedHours = Number(hours);
  if (!Number.isFinite(requestedHours) || requestedHours <= 0) return [];

  const tiers = [
    { maxHours: BUCKET_TIER_MAX_24H, bucketMinutes: BUCKET_MINUTES_24H },
    { maxHours: BUCKET_TIER_MAX_7D, bucketMinutes: BUCKET_MINUTES_7D },
    { maxHours: BUCKET_TIER_MAX_30D, bucketMinutes: BUCKET_MINUTES_30D },
    { maxHours: requestedHours, bucketMinutes: BUCKET_MINUTES_OLDER },
  ];

  const requests = [];
  let coveredHours = 0;
  for (const tier of tiers) {
    const endHours = Math.min(requestedHours, tier.maxHours);
    if (endHours <= coveredHours) continue;

    requests.push({
      newerThanHoursAgo: coveredHours,
      olderThanHoursAgo: endHours,
      p_hours: endHours,
      p_bucket_minutes: tier.bucketMinutes,
    });

    coveredHours = endHours;
    if (coveredHours >= requestedHours) break;
  }

  return requests;
}

function filterRowsByAgeWindow_(rows, newerThanHoursAgo, olderThanHoursAgo) {
  const nowMs = Date.now();
  const newerCutoffMs = nowMs - Math.max(0, newerThanHoursAgo) * 3600 * 1000;
  const olderCutoffMs = nowMs - Math.max(0, olderThanHoursAgo) * 3600 * 1000;

  return (rows || []).filter(r => {
    if (!(r.ts instanceof Date) || Number.isNaN(r.ts.getTime())) return false;
    const tsMs = r.ts.getTime();
    return tsMs <= newerCutoffMs && tsMs > olderCutoffMs;
  });
}

function dedupeAndSortRowsAsc_(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const ts = row.timestamp_iso || (row.ts instanceof Date ? row.ts.toISOString() : "");
    const key = `${String(row.device_id || "")}|${String(ts)}`;
    byKey.set(key, row);
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const ta = a.ts instanceof Date ? a.ts.getTime() : 0;
    const tb = b.ts instanceof Date ? b.ts.getTime() : 0;
    return ta - tb;
  });
}

async function fetchTieredBucketedHistory_(hours) {
  const requests = getBucketTierRequests_(hours);
  if (!requests.length) return [];

  const allRowsBucketed = [];
  for (const req of requests) {
    const rows = await fetchTelemetrySeries_(req.p_hours, req.p_bucket_minutes);
    const filtered = filterRowsByAgeWindow_(rows, req.newerThanHoursAgo, req.olderThanHoursAgo);
    allRowsBucketed.push(...filtered);
  }

  return dedupeAndSortRowsAsc_(allRowsBucketed);
}

function applyCurrentView() {
  const filtered = filterByHours(allRows, activeHours);
  const weightCtx = sliceWeightPlotContextByHours_(fullWeightCtx, activeHours);
  updateStats(filtered, allRows, weightCtx);
  renderAll(filtered, weightCtx);
  updateHeaderTimes_();
}

function toPlotlyGap_(v) {
  return Number.isFinite(v) ? v : null;
}

function buildWeightPlotContext_(rows) {
  const points = rows
    .map(r => ({
      ts: r.ts,
      rawWeight: getWeightLbs_(r),
      filteredWeight: getFilteredWeightLbs_(r),
      rawCounts: getRawScaleCounts_(r),
      rawScaleErrorSamples: getRawScaleErrorSamples_(r),
    }))
    .filter(p => p.ts instanceof Date && !Number.isNaN(p.ts.getTime()) && p.rawWeight != null && !isInvalidCalibrationWeight_(p.rawWeight));

  if (!points.length) {
    const hasInvalidWeight = rows.some(r => isInvalidCalibrationWeight_(getWeightLbs_(r)));
    return {
      points: [],
      filteredWeights: [],
      outlierMask: [],
      hasInvalidWeight,
      latestRawWeight: null,
      latestFilteredWeight: null,
      rawCountsPoints: [],
    };
  }

  // The frontend should display server-computed filtered weights only.
  // Raw fallback keeps historic pre-backfill ranges viewable.
  const filteredWeights = points.map(p => Number.isFinite(p.filteredWeight) ? p.filteredWeight : p.rawWeight);
  const outlierMask = new Array(points.length).fill(false);

  const latestRawWeight = points[points.length - 1].rawWeight;
  let latestFilteredWeight = null;
  for (let i = filteredWeights.length - 1; i >= 0; i--) {
    if (Number.isFinite(filteredWeights[i])) {
      latestFilteredWeight = filteredWeights[i];
      break;
    }
  }

  const rawCountsPoints = [];
  const rawCountsErrorPoints = [];
  let lastValidCounts = null;
  for (const p of points) {
    const hasSentinelError = Number.isFinite(p.rawCounts) && isRawScaleSensorError_(p.rawCounts);
    const hasBucketedError = p.rawScaleErrorSamples > 0;
    if (hasSentinelError || hasBucketedError) {
      rawCountsErrorPoints.push({ ts: p.ts, displayCounts: lastValidCounts });
    }

    if (!Number.isFinite(p.rawCounts) || hasSentinelError) {
      continue;
    }

    {
      rawCountsPoints.push(p);
      lastValidCounts = p.rawCounts;
    }
  }

  return {
    points,
    filteredWeights,
    outlierMask,
    hasInvalidWeight: rows.some(r => isInvalidCalibrationWeight_(getWeightLbs_(r))),
    latestRawWeight,
    latestFilteredWeight,
    rawCountsPoints,
    rawCountsErrorPoints,
  };
}

function sliceWeightPlotContextByHours_(weightCtx, hours) {
  if (!weightCtx || !Array.isArray(weightCtx.points) || !weightCtx.points.length) {
    return weightCtx || {
      points: [],
      filteredWeights: [],
      outlierMask: [],
      hasInvalidWeight: false,
      latestRawWeight: null,
      latestFilteredWeight: null,
      rawCountsPoints: [],
      rawCountsErrorPoints: [],
    };
  }

  if (!hours) return weightCtx;

  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  let start = 0;
  while (start < weightCtx.points.length && weightCtx.points[start].ts < cutoff) {
    start++;
  }

  const slicedPoints = weightCtx.points.slice(start);
  const slicedFiltered = weightCtx.filteredWeights.slice(start);
  const slicedOutliers = weightCtx.outlierMask.slice(start);

  let latestFilteredWeight = null;
  for (let i = slicedFiltered.length - 1; i >= 0; i--) {
    if (Number.isFinite(slicedFiltered[i])) {
      latestFilteredWeight = slicedFiltered[i];
      break;
    }
  }

  // Recompute raw counts split for the sliced window, carrying forward the
  // last valid reading from before the cutoff so error markers get a y-value.
  let lastValidCounts = null;
  for (const p of weightCtx.points.slice(0, start)) {
    if (Number.isFinite(p.rawCounts) && !isRawScaleSensorError_(p.rawCounts)) {
      lastValidCounts = p.rawCounts;
    }
  }
  const rawCountsPoints = [];
  const rawCountsErrorPoints = [];
  for (const p of slicedPoints) {
    const hasSentinelError = Number.isFinite(p.rawCounts) && isRawScaleSensorError_(p.rawCounts);
    const hasBucketedError = Number(p.rawScaleErrorSamples) > 0;
    if (hasSentinelError || hasBucketedError) {
      rawCountsErrorPoints.push({ ts: p.ts, displayCounts: lastValidCounts });
    }

    if (!Number.isFinite(p.rawCounts) || hasSentinelError) {
      continue;
    }

    {
      rawCountsPoints.push(p);
      lastValidCounts = p.rawCounts;
    }
  }

  return {
    points: slicedPoints,
    filteredWeights: slicedFiltered,
    outlierMask: slicedOutliers,
    hasInvalidWeight: weightCtx.hasInvalidWeight,
    latestRawWeight: slicedPoints.length ? slicedPoints[slicedPoints.length - 1].rawWeight : null,
    latestFilteredWeight,
    rawCountsPoints,
    rawCountsErrorPoints,
  };
}

function recomputeWeightCtx_() {
  fullWeightCtx = buildWeightPlotContext_(allRows);
}

async function loadMoreHistoryInBackground(seq) {
  if (!needsMoreHistory(activeHours)) return;
  historyLoadSeq = seq;
  isHistoryLoading = true;
  updateHeaderTimes_();

  let beforeTsIso = allRows[0]?.timestamp_iso || null;
  if (!beforeTsIso) return;

  const MAX_BATCHES_PER_PASS = 100;
  let batches = 0;

  try {
    while (seq === refreshSeq && seq === historyLoadSeq && needsMoreHistory(activeHours) && batches < MAX_BATCHES_PER_PASS) {
      const pageDesc = await fetchTelemetryPage(FETCH_LIMIT, beforeTsIso);
      batches += 1;

      if (!pageDesc.length) {
        hasCompleteHistory = true;
        break;
      }

      const pageAsc = normalizeRowsForCharts(pageDesc);
      allRows = pageAsc.concat(allRows);
      recomputeWeightCtx_();
      beforeTsIso = allRows[0]?.timestamp_iso || null;

      // Repaint as history arrives so "All" and multi-day ranges expand in-place.
      applyCurrentView();
    }
  } finally {
    if (seq === refreshSeq && seq === historyLoadSeq) {
      isHistoryLoading = false;
      updateHeaderTimes_();
    }
  }
}

function filterByHours(rows, hours) {
  if (!hours) return rows;
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  return rows.filter(r => r.ts >= cutoff);
}

function getPctPoints(rows) {
  return rows
    .filter(r => r.battery_pct != null && r.ts instanceof Date && !Number.isNaN(r.ts.getTime()))
    .sort((a, b) => a.ts - b.ts);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function buildRateSegments(points) {
  const segments = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dtHours = (curr.ts - prev.ts) / 3600000;
    if (!Number.isFinite(dtHours) || dtHours < EST_MIN_DT_HOURS || dtHours > EST_MAX_DT_HOURS) continue;

    const rawRate = (curr.battery_pct - prev.battery_pct) / dtHours;
    if (!Number.isFinite(rawRate) || Math.abs(rawRate) > EST_MAX_ABS_RATE) continue;

    segments.push({
      ts: curr.ts,
      dtHours,
      rawRate,
    });
  }

  return segments;
}

function getLocalWindowConfig(pointTs, endTs) {
  const edgeHours = Math.max(0, (endTs - pointTs) / 3600000);
  const nearRightEdge = edgeHours <= EST_RECENT_EDGE_HOURS;
  const windowHours = nearRightEdge ? EST_RECENT_WINDOW_HOURS : EST_HISTORY_WINDOW_HOURS;
  const futureShare = nearRightEdge ? EST_RECENT_FUTURE_SHARE : EST_FUTURE_SHARE;
  const futureHours = windowHours * futureShare;
  const pastHours = Math.max(windowHours - futureHours, EST_MIN_LOCAL_SPAN_HOURS);

  return {
    nearRightEdge,
    pastHours,
    futureHours,
  };
}

function getSegmentsNearTime(segments, targetTs, endTs) {
  const { pastHours, futureHours } = getLocalWindowConfig(targetTs, endTs);
  const targetMs = targetTs.getTime();
  const startMs = targetMs - (pastHours * 3600000);
  const stopMs = targetMs + (futureHours * 3600000);

  const local = segments.filter(seg => {
    const segMs = seg.ts.getTime();
    return segMs >= startMs && segMs <= stopMs;
  });

  if (local.length >= EST_MIN_POINTS) {
    return local;
  }

  return [...segments]
    .sort((a, b) => Math.abs(a.ts.getTime() - targetMs) - Math.abs(b.ts.getTime() - targetMs))
    .slice(0, Math.max(EST_FALLBACK_NEAREST_SEGMENTS, EST_MIN_POINTS))
    .sort((a, b) => a.ts - b.ts);
}

function filterLocalSegments(segments) {
  if (segments.length < EST_MIN_POINTS) return segments;

  const rates = segments.map(s => s.rawRate);
  const med = median(rates);
  const mad = median(rates.map(r => Math.abs(r - med)));
  if (med == null || mad == null) return segments;

  if (mad < 0.05) {
    return segments.filter(s => Math.abs(s.rawRate - med) <= 1.0);
  }

  return segments.filter(s => {
    const robustZ = 0.6745 * (s.rawRate - med) / mad;
    return Math.abs(robustZ) <= EST_LOCAL_OUTLIER_Z;
  });
}

function tricubeWeight(distanceRatio) {
  if (!Number.isFinite(distanceRatio) || distanceRatio >= 1) return 0;
  const term = 1 - Math.pow(distanceRatio, 3);
  return Math.pow(term, 3);
}

function weightedLinearSlope(segments, targetTs, endTs) {
  if (segments.length < EST_MIN_POINTS) return null;

  const targetMs = targetTs.getTime();
  const distances = segments.map(seg => Math.abs(seg.ts.getTime() - targetMs) / 3600000);
  const maxDistance = Math.max(...distances, EST_MIN_LOCAL_SPAN_HOURS);

  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  let sumWXX = 0;
  let sumWXY = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const distHours = Math.abs(seg.ts.getTime() - targetMs) / 3600000;
    const x = (seg.ts.getTime() - targetMs) / 3600000;
    const baseWeight = tricubeWeight(distHours / maxDistance);
    if (baseWeight <= 0) continue;

    const directionBias = seg.ts <= targetTs ? 1 : 0.75;
    const w = baseWeight * directionBias * Math.max(seg.dtHours, EST_MIN_DT_HOURS);

    sumW += w;
    sumWX += w * x;
    sumWY += w * seg.rawRate;
    sumWXX += w * x * x;
    sumWXY += w * x * seg.rawRate;
  }

  const denom = (sumW * sumWXX) - (sumWX * sumWX);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6 || sumW <= 0) return null;

  const intercept = ((sumWY * sumWXX) - (sumWX * sumWXY)) / denom;
  return Number.isFinite(intercept) ? intercept : null;
}

function buildEstimatedRateSeries(rows) {
  const points = getPctPoints(rows);
  if (points.length < 2) return { x: [], y: [], latestRate: null };

  const segments = buildRateSegments(points);
  if (segments.length < EST_MIN_POINTS) return { x: [], y: [], latestRate: null };

  const x = [];
  const y = [];
  const endTs = points[points.length - 1].ts;

  for (const seg of segments) {
    const local = filterLocalSegments(getSegmentsNearTime(segments, seg.ts, endTs));
    const slope = weightedLinearSlope(local, seg.ts, endTs);
    if (slope == null || !Number.isFinite(slope) || Math.abs(slope) > EST_MAX_ABS_RATE) continue;

    x.push(seg.ts);
    y.push(slope);
  }

  let latestRate = y.length ? y[y.length - 1] : null;
  if (latestRate != null && x.length) {
    const nowMs = x[x.length - 1].getTime();
    let weightSum = 0;
    let weightedValue = 0;

    for (let i = 0; i < y.length; i++) {
      const ageHours = (nowMs - x[i].getTime()) / 3600000;
      const w = Math.exp(-ageHours / EST_LATEST_DECAY_HOURS);
      weightedValue += y[i] * w;
      weightSum += w;
    }

    if (weightSum > 0) latestRate = weightedValue / weightSum;
  }

  return {
    x,
    y,
    latestRate,
  };
}

function formatDuration(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return "0m";
  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const remAfterDays = totalMinutes % (24 * 60);
  const hrs = Math.floor(remAfterDays / 60);
  const mins = remAfterDays % 60;

  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

function getWeightFailureState_(rows, weightCtx) {
  if (!rows.length) {
    return {
      latestHasUsableWeight: false,
      hasAnyValidWeight: false,
      lastValidAgeMs: null,
      showSensorFailure: false,
    };
  }

  const latest = rows[rows.length - 1];
  const latestRawWeight = getWeightLbs_(latest);
  const latestFilteredWeight = getFilteredWeightLbs_(latest);
  const latestHasUsableWeight = Number.isFinite(latestFilteredWeight)
    || (latestRawWeight != null && !isInvalidCalibrationWeight_(latestRawWeight));

  const latestTs = latest.ts instanceof Date && !Number.isNaN(latest.ts.getTime()) ? latest.ts : null;
  const lastValidTs = weightCtx && Array.isArray(weightCtx.points) && weightCtx.points.length
    ? weightCtx.points[weightCtx.points.length - 1].ts
    : null;

  const hasAnyValidWeight = lastValidTs instanceof Date && !Number.isNaN(lastValidTs.getTime());
  const lastValidAgeMs = latestTs && hasAnyValidWeight
    ? Math.max(0, latestTs.getTime() - lastValidTs.getTime())
    : null;

  const showSensorFailure = !latestHasUsableWeight
    && (!hasAnyValidWeight || (lastValidAgeMs != null && lastValidAgeMs > WEIGHT_SENSOR_FAILURE_TIMEOUT_MS));

  return {
    latestHasUsableWeight,
    hasAnyValidWeight,
    lastValidAgeMs,
    showSensorFailure,
  };
}

function estimateShutdown(rows) {
  const points = getPctPoints(rows);
  if (!points.length) return { etaText: "—", etaDate: null, hoursLeft: null, rate: null };

  const latest = points[points.length - 1];
  const { latestRate } = buildEstimatedRateSeries(rows);

  if (latestRate == null) {
    return { etaText: "Estimating", etaDate: null, hoursLeft: null, rate: null };
  }

  if (latestRate >= -MIN_RATE_FOR_ETA) {
    return { etaText: "Not draining", etaDate: null, hoursLeft: null, rate: latestRate };
  }

  const pctRemaining = latest.battery_pct - SHUTDOWN_PCT;
  if (!Number.isFinite(pctRemaining) || pctRemaining <= 0) {
    return {
      etaText: "Now",
      etaDate: new Date(),
      hoursLeft: 0,
      rate: latestRate,
    };
  }

  const hoursLeft = pctRemaining / Math.abs(latestRate);
  if (!Number.isFinite(hoursLeft)) {
    return { etaText: "—", etaDate: null, hoursLeft: null, rate: latestRate };
  }

  const etaDate = new Date(Date.now() + (hoursLeft * 3600000));
  return {
    etaText: formatDuration(hoursLeft),
    etaDate,
    hoursLeft,
    rate: latestRate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat cards
// ─────────────────────────────────────────────────────────────────────────────
function updateStats(rows, trendRows = rows, weightCtx = null) {
  if (!rows.length) return;
  const latest = rows[rows.length - 1];

  const weight = getWeightLbs_(latest);
  const statWeightEl = document.getElementById("stat-weight");
  const statWeightRawEl = document.getElementById("stat-weight-raw");
  const filteredWeight = weightCtx && Number.isFinite(weightCtx.latestFilteredWeight)
    ? weightCtx.latestFilteredWeight
    : null;
  const rawWeight = weightCtx && Number.isFinite(weightCtx.latestRawWeight)
    ? weightCtx.latestRawWeight
    : (weight != null ? Number(weight) : null);
  const weightFailure = getWeightFailureState_(rows, weightCtx);

  if (isInvalidCalibrationWeight_(weight)) {
    statWeightEl.textContent = "Calibrate";
    statWeightEl.style.color = "var(--danger)";
    statWeightEl.setAttribute("title", "Scale not calibrated. Run tare, then calibrate with a known weight.");
    if (statWeightRawEl) statWeightRawEl.textContent = "";
  } else if (weightFailure.showSensorFailure) {
    statWeightEl.textContent = "Sensor fail";
    statWeightEl.style.color = "var(--danger)";
    statWeightEl.setAttribute("title", WEIGHT_SENSOR_FAILURE_TEXT);
    if (statWeightRawEl) statWeightRawEl.textContent = "";
  } else {
    statWeightEl.textContent = filteredWeight != null ? filteredWeight.toFixed(2) : (rawWeight != null ? rawWeight.toFixed(2) : "—");
    statWeightEl.style.color = "";
    statWeightEl.removeAttribute("title");
    if (statWeightRawEl) {
      statWeightRawEl.textContent = rawWeight != null ? `raw ${rawWeight.toFixed(2)} lbs` : "";
    }
  }

  const pct = latest.battery_pct;
  const statPctEl = document.getElementById("stat-battery-pct");
  statPctEl.textContent = pct != null ? pct.toFixed(1) : "—";
  statPctEl.style.color = pct != null
    ? pct < 20 ? "var(--danger)" : pct < 50 ? "#c8820a" : "var(--accent2)"
    : "";

  const v = latest.battery_v;
  document.getElementById("stat-battery-v").textContent =
    v != null ? v.toFixed(3) : "—";

  const trend = estimateShutdown(trendRows);
  const estRateEl = document.getElementById("stat-charge-rate-est");
  estRateEl.textContent = trend.rate != null ? trend.rate.toFixed(1) : "—";
  estRateEl.style.color = trend.rate != null && trend.rate < 0 ? "var(--danger)" : "var(--accent2)";

  const etaEl = document.getElementById("stat-shutdown-eta");
  etaEl.textContent = trend.etaText;
  etaEl.style.color = trend.hoursLeft != null && trend.hoursLeft < 24 ? "var(--danger)" : "var(--ink-mute)";
  if (trend.etaDate instanceof Date && !Number.isNaN(trend.etaDate.getTime())) {
    etaEl.setAttribute("data-tooltip", `Estimated shutdown: ${trend.etaDate.toLocaleString()}`);
    etaEl.setAttribute("aria-label", `Estimated shutdown: ${trend.etaDate.toLocaleString()}`);
  } else {
    etaEl.removeAttribute("data-tooltip");
    etaEl.removeAttribute("aria-label");
  }

  const temp = getTemperatureF_(latest);
  document.getElementById("stat-temp").textContent =
    temp != null ? temp.toFixed(1) : "—";

  const hum = getHumidityPct_(latest);
  document.getElementById("stat-humidity").textContent =
    hum != null ? hum.toFixed(1) : "—";
}

// ─────────────────────────────────────────────────────────────────────────────
// Charts
// ─────────────────────────────────────────────────────────────────────────────

const ALL_SYNCED_CHART_IDS = [
  "chart-weight",
  "chart-raw-counts",
  "chart-temp-humidity",
  "chart-battery-pct",
  "chart-battery-v",
  "chart-charge-rate",
];

function bindXAxisSync_(chartId) {
  if (chartSyncBound.has(chartId)) return;
  const el = document.getElementById(chartId);
  if (!el) return;

  el.on("plotly_relayout", (ev) => {
    if (isSyncingAxisRange) return;
    if (chartId === "chart-raw-counts" && !showRawCountsDebug) return;

    const isAutorange = ev["xaxis.autorange"];
    const r0 = ev["xaxis.range[0]"];
    const r1 = ev["xaxis.range[1]"];
    if (!isAutorange && (r0 == null || r1 == null)) return;

    isSyncingAxisRange = true;
    try {
      ALL_SYNCED_CHART_IDS.forEach(otherId => {
        if (otherId === chartId) return;
        if (otherId === "chart-raw-counts" && !showRawCountsDebug) return;
        const otherEl = document.getElementById(otherId);
        if (!otherEl || otherEl.style.display === "none") return;

        if (isAutorange) {
          Plotly.relayout(otherEl, { "xaxis.autorange": true });
        } else {
          Plotly.relayout(otherEl, {
            "xaxis.range[0]": r0,
            "xaxis.range[1]": r1,
          });
        }
      });
    } finally {
      setTimeout(() => { isSyncingAxisRange = false; }, 0);
    }
  });

  chartSyncBound.add(chartId);
}

function layout(yTitle, extraY) {
  return {
    ...PLOTLY_LAYOUT_BASE,
    uirevision: activeHours,
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, title: yTitle },
    ...(extraY || {})
  };
}

function renderWeightChart(rows, weightCtx, xRange) {
  const withWeight = weightCtx ? weightCtx.points : [];
  const hasInvalidWeight = weightCtx ? weightCtx.hasInvalidWeight : false;
  const weightFailure = getWeightFailureState_(rows, weightCtx);
  const noDataMsg = document.getElementById("weight-no-data");

  if (!withWeight.length) {
    if (hasInvalidWeight) {
      noDataMsg.textContent = WEIGHT_NEEDS_CALIBRATION_TEXT;
    } else if (weightFailure.showSensorFailure) {
      noDataMsg.textContent = WEIGHT_SENSOR_FAILURE_TEXT;
    } else {
      noDataMsg.textContent = WEIGHT_NO_DATA_DEFAULT_TEXT;
    }
    noDataMsg.classList.remove("hidden");
    document.getElementById("chart-weight").style.display = "none";
    return;
  }

  if (weightFailure.showSensorFailure) {
    const ageText = weightFailure.lastValidAgeMs != null
      ? ` for ${formatDuration(weightFailure.lastValidAgeMs / 3600000)}`
      : "";
    noDataMsg.textContent = `${WEIGHT_SENSOR_FAILURE_TEXT}${ageText}. Showing last valid trend.`;
    noDataMsg.classList.remove("hidden");
  } else {
    noDataMsg.textContent = WEIGHT_NO_DATA_DEFAULT_TEXT;
    noDataMsg.classList.add("hidden");
  }
  document.getElementById("chart-weight").style.display = "";

  const filteredTrace = {
    x: withWeight.map(r => r.ts),
    y: weightCtx.filteredWeights.map(toPlotlyGap_),
    mode: "lines",
    name: "Filtered",
    line: { color: "#3b7a57", width: 3.2 },
    hovertemplate: "%{y:.3f} lbs (filtered)<extra></extra>",
  };

  const rawTrace = {
    x: withWeight.map(r => r.ts),
    y: withWeight.map(r => r.rawWeight),
    mode: "lines+markers",
    name: "Raw",
    line: { color: "rgba(200,130,10,0.42)", width: 1.5, dash: "dot" },
    marker: { size: 2.5, color: "rgba(200,130,10,0.36)" },
    hovertemplate: "%{y:.3f} lbs (raw)<extra></extra>",
  };

  const outlierPoints = withWeight.filter((_, idx) => weightCtx.outlierMask[idx]);
  const outlierTrace = {
    x: outlierPoints.map(p => p.ts),
    y: outlierPoints.map(p => p.rawWeight),
    mode: "markers",
    name: "Rejected outliers",
    marker: { size: 5, color: "rgba(176,58,46,0.28)", symbol: "x" },
    hovertemplate: "%{y:.3f} lbs (rejected)<extra></extra>",
  };

  Plotly.react("chart-weight", [filteredTrace, rawTrace, outlierTrace], {
    ...layout("lbs"),
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: xRange },
    yaxis: { ...layout("lbs").yaxis },
  }, { responsive: true });

  bindXAxisSync_("chart-weight");
}

function renderRawCountsChart_(rows, weightCtx, xRange) {
  const wrap = document.getElementById("raw-counts-wrap");
  const chart = document.getElementById("chart-raw-counts");
  const noData = document.getElementById("raw-counts-no-data");
  const toggle = document.getElementById("toggle-raw-counts");

  if (!wrap || !chart || !noData || !toggle) return;

  wrap.classList.toggle("hidden", !showRawCountsDebug);
  toggle.textContent = showRawCountsDebug ? "Hide Raw Counts Debug" : "Show Raw Counts Debug";
  toggle.setAttribute("aria-expanded", showRawCountsDebug ? "true" : "false");

  if (!showRawCountsDebug) return;

  const rawPoints = (weightCtx && weightCtx.rawCountsPoints) || [];
  const rawErrorPoints = (weightCtx && weightCtx.rawCountsErrorPoints) || [];
  const weightPoints = (weightCtx && weightCtx.points) || [];
  if (!rawPoints.length && !rawErrorPoints.length) {
    noData.classList.remove("hidden");
    chart.style.display = "none";
    return;
  }

  noData.classList.add("hidden");
  chart.style.display = "";

  const traces = [{
    x: rawPoints.map(p => p.ts),
    y: rawPoints.map(p => p.rawCounts),
    mode: "lines+markers",
    name: "Raw scale counts",
    line: { color: "#1f4f82", width: 2 },
    marker: { size: 3 },
    hovertemplate: "%{y:.0f} counts<extra></extra>",
  }];

  if (rawErrorPoints.length) {
    traces.push({
      x: rawErrorPoints.map(p => p.ts),
      y: rawErrorPoints.map(p => p.displayCounts),
      mode: "markers",
      name: "Sensor read error",
      marker: { symbol: "x", size: 10, color: "#c0392b", line: { width: 2, color: "#c0392b" } },
      hovertemplate: "Sensor read error<extra></extra>",
    });
  }

  Plotly.react("chart-raw-counts", traces, {
    ...layout("counts"),
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: xRange },
  }, { responsive: true });

  bindXAxisSync_("chart-raw-counts");
}

function renderBatteryPctChart(rows, xRange) {
  const x = rows.map(r => r.ts);
  const y = rows.map(r => r.battery_pct);

  Plotly.react("chart-battery-pct", [{
    x, y,
    mode: "lines",
    name: "Charge (%)",
    fill: "tozeroy",
    fillcolor: "rgba(59,122,87,.12)",
    line: { color: "#3b7a57", width: 2.5 },
    hovertemplate: "%{y:.1f}%<extra></extra>",
  }], {
    ...layout("%"),
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: xRange },
    yaxis: { ...layout("%").yaxis, range: [0, 115] },
    shapes: [{
      type: "line", y0: 20, y1: 20, x0: 0, x1: 1, xref: "paper",
      line: { color: "var(--danger)", width: 1, dash: "dot" }
    }]
  }, { responsive: true });

  bindXAxisSync_("chart-battery-pct");
}

function renderBatteryVChart(rows, xRange) {
  Plotly.react("chart-battery-v", [{
    x: rows.map(r => r.ts),
    y: rows.map(r => r.battery_v),
    mode: "lines",
    name: "Voltage (V)",
    line: { color: "#1f4f82", width: 2.5 },
    hovertemplate: "%{y:.4f} V<extra></extra>",
  }], { ...layout("V"), xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: xRange } }, { responsive: true });

  bindXAxisSync_("chart-battery-v");
}

function renderChargeRateChart(rows, xRange) {
  const estimated = buildEstimatedRateSeries(rows);

  const traces = [];

  if (estimated.x.length) {
    traces.push({
      x: estimated.x,
      y: estimated.y,
      mode: "lines",
      name: "Estimated rate (%/hr)",
      line: { color: "#1f4f82", width: 2.5, dash: "dot" },
      hovertemplate: "%{y:.1f} %/hr<extra></extra>",
    });
  }

  const chartLayout = {
    ...layout("%/hr"),
    xaxis: {
      ...PLOTLY_LAYOUT_BASE.xaxis,
      range: xRange,
    },
    shapes: [{
      type: "line", y0: 0, y1: 0, x0: 0, x1: 1, xref: "paper",
      line: { color: "#e4d9c8", width: 1 }
    }]
  };

  Plotly.react("chart-charge-rate", traces, chartLayout, { responsive: true });

  bindXAxisSync_("chart-charge-rate");
}

function renderTempHumidityChart(rows, xRange) {
  const withData = rows.filter(r => getTemperatureF_(r) != null || getHumidityPct_(r) != null);
  const noDataMsg = document.getElementById("temp-humidity-no-data");

  if (!withData.length) {
    noDataMsg.classList.remove("hidden");
    document.getElementById("chart-temp-humidity").style.display = "none";
    return;
  }
  noDataMsg.classList.add("hidden");
  document.getElementById("chart-temp-humidity").style.display = "";

  const x = withData.map(r => r.ts);

  Plotly.react("chart-temp-humidity", [
    {
      x,
      y: withData.map(r => getTemperatureF_(r)),
      mode: "lines",
      name: "Temperature (°F)",
      line: { color: "#c8820a", width: 2.5 },
      yaxis: "y1",
      hovertemplate: "%{y:.1f} °F<extra></extra>",
    },
    {
      x,
      y: withData.map(r => getHumidityPct_(r)),
      mode: "lines",
      name: "Humidity (%)",
      line: { color: "#1f4f82", width: 2.5, dash: "dot" },
      yaxis: "y2",
      hovertemplate: "%{y:.1f}%<extra></extra>",
    },
  ], {
    ...PLOTLY_LAYOUT_BASE,
    uirevision: activeHours,
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: xRange },
    yaxis:  { ...PLOTLY_LAYOUT_BASE.yaxis, title: "°F" },
    yaxis2: { title: "%", overlaying: "y", side: "right", gridcolor: "rgba(0,0,0,0)", zeroline: false },
  }, { responsive: true });

  bindXAxisSync_("chart-temp-humidity");
}

function getActiveXRange_() {
  for (const id of ALL_SYNCED_CHART_IDS) {
    if (id === "chart-raw-counts") continue;
    const el = document.getElementById(id);
    if (el && el._fullLayout && el.style.display !== "none") {
      const r = el._fullLayout.xaxis.range;
      if (r && r.length === 2) return r;
    }
  }
  return null;
}

function renderAll(rows, weightCtx) {
  const sharedXRange = rows.length ? [rows[0].ts, rows[rows.length - 1].ts] : undefined;
  renderWeightChart(rows, weightCtx, sharedXRange);
  renderRawCountsChart_(rows, weightCtx, sharedXRange);
  renderBatteryPctChart(rows, sharedXRange);
  renderBatteryVChart(rows, sharedXRange);
  renderChargeRateChart(rows, sharedXRange);
  renderTempHumidityChart(rows, sharedXRange);
}

// ─────────────────────────────────────────────────────────────────────────────
// Range buttons
// ─────────────────────────────────────────────────────────────────────────────
document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeHours = Number(btn.dataset.hours);
    refresh();
  });
});

const rawCountsToggleBtn = document.getElementById("toggle-raw-counts");
if (rawCountsToggleBtn) {
  rawCountsToggleBtn.addEventListener("click", () => {
    showRawCountsDebug = !showRawCountsDebug;
    const filtered = filterByHours(allRows, activeHours);
    const weightCtx = sliceWeightPlotContextByHours_(fullWeightCtx, activeHours);
    const xRange = showRawCountsDebug ? getActiveXRange_() : undefined;
    renderRawCountsChart_(filtered, weightCtx, xRange);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────
async function refresh() {
  const btn = document.getElementById("refresh-btn");
  const errBanner = document.getElementById("error-banner");
  btn.disabled = true;
  btn.textContent = "↻ Loading…";
  const seq = ++refreshSeq;

  try {
    isHistoryLoading = false;
    hasCompleteHistory = false;
    updateHeaderTimes_();

    if (activeHours > 0) {
      allRows = await fetchTieredBucketedHistory_(activeHours);
      hasCompleteHistory = true;
      recomputeWeightCtx_();
    } else {
      const firstPageDesc = await fetchTelemetryPage(FETCH_LIMIT, null);
      allRows = normalizeRowsForCharts(firstPageDesc);
      recomputeWeightCtx_();
      if (!firstPageDesc.length) {
        hasCompleteHistory = true;
      }
    }

    if (seq !== refreshSeq) return;

    errBanner.classList.add("hidden");

    applyCurrentView();

    if (activeHours === 0) {
      loadMoreHistoryInBackground(seq).catch(err => {
        if (seq !== refreshSeq) return;
        isHistoryLoading = false;
        updateHeaderTimes_();
        errBanner.textContent = "Background history load failed: " + err.message;
        errBanner.classList.remove("hidden");
      });
    }

    document.getElementById("last-updated").textContent =
      formatHistoryTs(new Date());
  } catch (err) {
    isHistoryLoading = false;
    updateHeaderTimes_();
    errBanner.textContent = "Failed to load data: " + err.message;
    errBanner.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "↻ Refresh";
  }
}

// Auto-refresh
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const hiddenMs = Number(window.HIDDEN_TAB_REFRESH_MS);
  const waitMs = (document.hidden && Number.isFinite(hiddenMs) && hiddenMs > 0)
    ? hiddenMs
    : AUTO_REFRESH_MS;

  refreshTimer = setTimeout(() => {
    refresh().then(scheduleRefresh).catch(scheduleRefresh);
  }, waitMs);
}

// Boot
refresh().then(scheduleRefresh);

document.addEventListener("visibilitychange", () => {
  scheduleRefresh();
  if (!document.hidden) {
    refresh();
  }
});
