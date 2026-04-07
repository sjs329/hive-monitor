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
let hasWeightChartSyncBinding = false;
let hasRawChartSyncBinding = false;
let isSyncingAxisRange = false;
let fullWeightCtx = null;

const SHUTDOWN_PCT = 2;
const INVALID_CALIBRATION_WEIGHT_SENTINEL = -1234.5;
const INVALID_CALIBRATION_WEIGHT_EPS = 0.01;
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

function isInvalidCalibrationWeight_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n - INVALID_CALIBRATION_WEIGHT_SENTINEL) <= INVALID_CALIBRATION_WEIGHT_EPS;
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
    select: "ts,device_id,weight_lbs,filtered_weight_lbs,battery_v,battery_pct,battery_charge_rate,battery_connected,temperature_c,humidity_pct,source,event_raw",
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

  return {
    points,
    filteredWeights,
    outlierMask,
    hasInvalidWeight: rows.some(r => isInvalidCalibrationWeight_(getWeightLbs_(r))),
    latestRawWeight,
    latestFilteredWeight,
    rawCountsPoints: points.filter(p => Number.isFinite(p.rawCounts)),
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

  return {
    points: slicedPoints,
    filteredWeights: slicedFiltered,
    outlierMask: slicedOutliers,
    hasInvalidWeight: weightCtx.hasInvalidWeight,
    latestRawWeight: slicedPoints.length ? slicedPoints[slicedPoints.length - 1].rawWeight : null,
    latestFilteredWeight,
    rawCountsPoints: slicedPoints.filter(p => Number.isFinite(p.rawCounts)),
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

  const rate = latest.battery_charge_rate;
  document.getElementById("stat-charge-rate").textContent =
    rate != null ? rate.toFixed(1) : "—";

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

  const temp = latest.temperature_c;
  document.getElementById("stat-temp").textContent =
    temp != null ? temp.toFixed(1) : "—";

  const hum = latest.humidity_pct;
  document.getElementById("stat-humidity").textContent =
    hum != null ? hum.toFixed(1) : "—";
}

// ─────────────────────────────────────────────────────────────────────────────
// Charts
// ─────────────────────────────────────────────────────────────────────────────
function layout(yTitle, extraY) {
  return {
    ...PLOTLY_LAYOUT_BASE,
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, title: yTitle },
    ...(extraY || {})
  };
}

function renderWeightChart(rows, weightCtx) {
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

  const xRange = withWeight.length
    ? [withWeight[0].ts, withWeight[withWeight.length - 1].ts]
    : undefined;

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
    line: { color: "rgba(200,130,10,0.2)", width: 1, dash: "dot" },
    marker: { size: 2, color: "rgba(200,130,10,0.18)" },
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

  if (!hasWeightChartSyncBinding) {
    const weightChartEl = document.getElementById("chart-weight");
    if (weightChartEl) {
      weightChartEl.on("plotly_relayout", (ev) => {
        if (!showRawCountsDebug) return;
        if (isSyncingAxisRange) return;
        const rawChartEl = document.getElementById("chart-raw-counts");
        if (!rawChartEl) return;

        isSyncingAxisRange = true;
        try {
          if (ev["xaxis.autorange"]) {
            Plotly.relayout(rawChartEl, { "xaxis.autorange": true });
            return;
          }

          if (ev["xaxis.range[0]"] && ev["xaxis.range[1]"]) {
            Plotly.relayout(rawChartEl, {
              "xaxis.range[0]": ev["xaxis.range[0]"],
              "xaxis.range[1]": ev["xaxis.range[1]"],
            });
          }
        } finally {
          setTimeout(() => { isSyncingAxisRange = false; }, 0);
        }
      });
      hasWeightChartSyncBinding = true;
    }
  }
}

function renderRawCountsChart_(rows, weightCtx) {
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
  const weightPoints = (weightCtx && weightCtx.points) || [];
  if (!rawPoints.length) {
    noData.classList.remove("hidden");
    chart.style.display = "none";
    return;
  }

  noData.classList.add("hidden");
  chart.style.display = "";

  const xRange = weightPoints.length
    ? [weightPoints[0].ts, weightPoints[weightPoints.length - 1].ts]
    : undefined;

  Plotly.react("chart-raw-counts", [{
    x: rawPoints.map(p => p.ts),
    y: rawPoints.map(p => p.rawCounts),
    mode: "lines+markers",
    name: "Raw scale counts",
    line: { color: "#1f4f82", width: 2 },
    marker: { size: 3 },
    hovertemplate: "%{y:.0f} counts<extra></extra>",
  }], {
    ...layout("counts"),
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, range: xRange },
  }, { responsive: true });

  if (!hasRawChartSyncBinding) {
    chart.on("plotly_relayout", (ev) => {
      if (!showRawCountsDebug) return;
      if (isSyncingAxisRange) return;
      const weightChartEl = document.getElementById("chart-weight");
      if (!weightChartEl) return;

      isSyncingAxisRange = true;
      try {
        if (ev["xaxis.autorange"]) {
          Plotly.relayout(weightChartEl, { "xaxis.autorange": true });
          return;
        }

        if (ev["xaxis.range[0]"] && ev["xaxis.range[1]"]) {
          Plotly.relayout(weightChartEl, {
            "xaxis.range[0]": ev["xaxis.range[0]"],
            "xaxis.range[1]": ev["xaxis.range[1]"],
          });
        }
      } finally {
        setTimeout(() => { isSyncingAxisRange = false; }, 0);
      }
    });
    hasRawChartSyncBinding = true;
  }
}

function renderBatteryPctChart(rows) {
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
    yaxis: { ...layout("%").yaxis, range: [0, 115] },
    shapes: [{
      type: "line", y0: 20, y1: 20, x0: 0, x1: 1, xref: "paper",
      line: { color: "var(--danger)", width: 1, dash: "dot" }
    }]
  }, { responsive: true });
}

function renderBatteryVChart(rows) {
  Plotly.react("chart-battery-v", [{
    x: rows.map(r => r.ts),
    y: rows.map(r => r.battery_v),
    mode: "lines",
    name: "Voltage (V)",
    line: { color: "#1f4f82", width: 2.5 },
    hovertemplate: "%{y:.4f} V<extra></extra>",
  }], layout("V"), { responsive: true });
}

function renderChargeRateChart(rows) {
  const withReported = rows.filter(r => r.battery_charge_rate != null);
  const x = withReported.map(r => r.ts);
  const y = withReported.map(r => r.battery_charge_rate);
  const estimated = buildEstimatedRateSeries(rows);

  // Colour positive vs negative (charging vs discharging)
  const traces = [];

  if (x.length) {
    traces.push({
      x, y,
      mode: "lines",
      name: "Arduino rate (%/hr)",
      line: { color: "#c8820a", width: 2 },
      hovertemplate: "%{y:.1f} %/hr<extra></extra>",
    });
  }

  if (estimated.x.length) {
    traces.push({
      x: estimated.x,
      y: estimated.y,
      mode: "lines",
      name: "Web estimate (%/hr)",
      line: { color: "#1f4f82", width: 2, dash: "dot" },
      hovertemplate: "%{y:.1f} %/hr<extra></extra>",
    });
  }

  const chartLayout = {
    ...layout("%/hr"),
    xaxis: {
      ...PLOTLY_LAYOUT_BASE.xaxis,
      range: rows.length ? [rows[0].ts, rows[rows.length - 1].ts] : undefined,
    },
    shapes: [{
      type: "line", y0: 0, y1: 0, x0: 0, x1: 1, xref: "paper",
      line: { color: "#e4d9c8", width: 1 }
    }]
  };

  Plotly.react("chart-charge-rate", traces, chartLayout, { responsive: true });
}

function renderTempHumidityChart(rows) {
  const withData = rows.filter(r => r.temperature_c != null || r.humidity_pct != null);
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
      y: withData.map(r => r.temperature_c),
      mode: "lines",
      name: "Temperature (°C)",
      line: { color: "#c8820a", width: 2.5 },
      yaxis: "y1",
      hovertemplate: "%{y:.1f} °C<extra></extra>",
    },
    {
      x,
      y: withData.map(r => r.humidity_pct),
      mode: "lines",
      name: "Humidity (%)",
      line: { color: "#1f4f82", width: 2.5, dash: "dot" },
      yaxis: "y2",
      hovertemplate: "%{y:.1f}%<extra></extra>",
    },
  ], {
    ...PLOTLY_LAYOUT_BASE,
    yaxis:  { ...PLOTLY_LAYOUT_BASE.yaxis, title: "°C" },
    yaxis2: { title: "%", overlaying: "y", side: "right", gridcolor: "rgba(0,0,0,0)", zeroline: false },
  }, { responsive: true });
}

function renderAll(rows, weightCtx) {
  renderWeightChart(rows, weightCtx);
  renderRawCountsChart_(rows, weightCtx);
  renderBatteryPctChart(rows);
  renderBatteryVChart(rows);
  renderChargeRateChart(rows);
  renderTempHumidityChart(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// Range buttons
// ─────────────────────────────────────────────────────────────────────────────
document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeHours = Number(btn.dataset.hours);
    applyCurrentView();

    // If the newly selected range needs older points, continue paginating in background.
    loadMoreHistoryInBackground(refreshSeq).catch(err => {
      isHistoryLoading = false;
      updateHeaderTimes_();
      const errBanner = document.getElementById("error-banner");
      errBanner.textContent = "Background history load failed: " + err.message;
      errBanner.classList.remove("hidden");
    });
  });
});

const rawCountsToggleBtn = document.getElementById("toggle-raw-counts");
if (rawCountsToggleBtn) {
  rawCountsToggleBtn.addEventListener("click", () => {
    showRawCountsDebug = !showRawCountsDebug;
    const filtered = filterByHours(allRows, activeHours);
    const weightCtx = sliceWeightPlotContextByHours_(fullWeightCtx, activeHours);
    renderRawCountsChart_(filtered, weightCtx);
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

    const firstPageDesc = await fetchTelemetryPage(FETCH_LIMIT, null);
    allRows = normalizeRowsForCharts(firstPageDesc);
    recomputeWeightCtx_();
    if (!firstPageDesc.length) {
      hasCompleteHistory = true;
    }

    if (seq !== refreshSeq) return;

    errBanner.classList.add("hidden");

    // Battery connection should not be shown as a normal stat; only warn on error.
    const latest = allRows.length ? allRows[allRows.length - 1] : null;
    if (latest && latest.battery_connected === false) {
      errBanner.textContent = "Battery error: no battery reported by monitor.";
      errBanner.classList.remove("hidden");
    }

    applyCurrentView();

    loadMoreHistoryInBackground(seq).catch(err => {
      if (seq !== refreshSeq) return;
      isHistoryLoading = false;
      updateHeaderTimes_();
      errBanner.textContent = "Background history load failed: " + err.message;
      errBanner.classList.remove("hidden");
    });

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
  refreshTimer = setTimeout(() => { refresh().then(scheduleRefresh); }, AUTO_REFRESH_MS);
}

// Boot
refresh().then(scheduleRefresh);
