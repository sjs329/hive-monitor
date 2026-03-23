// ─────────────────────────────────────────────────────────────────────────────
// CONFIG is loaded from hives.js (API_URL, FETCH_LIMIT, AUTO_REFRESH_MS, HIVES_CONFIG)
// ─────────────────────────────────────────────────────────────────────────────

// Read ?device= from URL to know which hive to show
const params     = new URLSearchParams(window.location.search);
const deviceId   = params.get("device") || null;
const hiveCfg    = HIVES_CONFIG.find(h => h.device_id === deviceId) || HIVES_CONFIG[0];

// Set page title
if (document.getElementById("page-title")) {
  document.getElementById("page-title").textContent = hiveCfg.label;
}
if (document.getElementById("page-hive-icon")) {
  const src = hiveCfg.icon || "favicon.svg";
  document.getElementById("page-hive-icon").innerHTML = `<img class="badge-icon badge-icon--header" src="${src}" alt="${hiveCfg.label} badge" />`;
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

const SHUTDOWN_PCT = 2;
const MIN_RATE_FOR_ETA = 0.05;
// Solar systems can swing over a day; keep trend window short to avoid
// blending morning charge with overnight drain.
const EST_WINDOW_HOURS = 4;
const EST_MIN_SEGMENTS = 3;
const EST_MAX_POINTS = 240;
const EST_MIN_DT_HOURS = 1 / 120; // 30s
const EST_MAX_DT_HOURS = 3;
const EST_MAX_ABS_RATE = 30;
const EST_SMOOTHING_HOURS = 0.75;
const EST_DECAY_HOURS = 1.5;

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
async function fetchData() {
  const url = `${API_URL}?mode=data&limit=${FETCH_LIMIT}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API returned ok:false");
  const rows = (json.rows || []).map(r => ({ ...r, ts: new Date(r.timestamp_iso) }));
  // Filter to the hive shown on this page
  return deviceId ? rows.filter(r => r.device_id === deviceId) : rows;
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

function getTrendPoints(rows, windowHours = EST_WINDOW_HOURS) {
  const points = getPctPoints(rows);
  if (!points.length) return [];

  const cutoffMs = Date.now() - windowHours * 3600000;
  const inWindow = points.filter(p => p.ts.getTime() >= cutoffMs);

  if (inWindow.length >= 2) {
    return inWindow.slice(-EST_MAX_POINTS);
  }

  // Fallback to recent points when window is sparse.
  return points.slice(-Math.min(48, points.length));
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

function rejectRateOutliers(segments) {
  if (segments.length < EST_MIN_SEGMENTS) return segments;

  const rates = segments.map(s => s.rawRate);
  const med = median(rates);
  if (med == null) return segments;

  const absDevs = rates.map(r => Math.abs(r - med));
  const mad = median(absDevs);
  if (mad == null) return segments;

  // If variation is near-zero, keep close-to-median values.
  if (mad < 0.02) {
    const tightThreshold = 0.5;
    return segments.filter(s => Math.abs(s.rawRate - med) <= tightThreshold);
  }

  return segments.filter(s => {
    const robustZ = 0.6745 * (s.rawRate - med) / mad;
    return Math.abs(robustZ) <= 3.5;
  });
}

// Estimate rate from battery % deltas and smooth it for chart readability.
function buildEstimatedRateSeries(rows) {
  const points = getTrendPoints(rows);
  if (points.length < 2) return { x: [], y: [], latestRate: null };

  const segments = rejectRateOutliers(buildRateSegments(points));
  if (segments.length < EST_MIN_SEGMENTS) return { x: [], y: [], latestRate: null };

  const x = [];
  const y = [];
  let smoothed = null;

  for (const seg of segments) {
    const alpha = 1 - Math.exp(-seg.dtHours / EST_SMOOTHING_HOURS);
    smoothed = smoothed == null
      ? seg.rawRate
      : (alpha * seg.rawRate) + ((1 - alpha) * smoothed);

    x.push(seg.ts);
    y.push(smoothed);
  }

  let latestRate = y.length ? y[y.length - 1] : null;
  if (latestRate != null && x.length) {
    const nowMs = x[x.length - 1].getTime();
    let weightSum = 0;
    let weightedValue = 0;

    for (let i = 0; i < y.length; i++) {
      const ageHours = (nowMs - x[i].getTime()) / 3600000;
      const w = Math.exp(-ageHours / EST_DECAY_HOURS);
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

function estimateShutdown(rows) {
  const points = getTrendPoints(rows);
  if (!points.length) return { etaText: "—", etaDate: null, hoursLeft: null, rate: null };

  const latest = points[points.length - 1];
  const { latestRate } = buildEstimatedRateSeries(points);

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
function updateStats(rows, trendRows = rows) {
  if (!rows.length) return;
  const latest = rows[rows.length - 1];

  const weight = latest.weight_kg;
  document.getElementById("stat-weight").textContent =
    weight != null ? weight.toFixed(2) : "—";

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

function renderWeightChart(rows) {
  const withWeight = rows.filter(r => r.weight_kg != null);
  const card = document.getElementById("weight-card");
  const noDataMsg = document.getElementById("weight-no-data");

  if (!withWeight.length) {
    noDataMsg.classList.remove("hidden");
    document.getElementById("chart-weight").style.display = "none";
    return;
  }
  noDataMsg.classList.add("hidden");
  document.getElementById("chart-weight").style.display = "";

  Plotly.react("chart-weight", [{
    x: withWeight.map(r => r.ts),
    y: withWeight.map(r => r.weight_kg),
    mode: "lines+markers",
    name: "Weight (kg)",
    line: { color: "#c8820a", width: 2.5 },
    marker: { size: 4 },
    hovertemplate: "%{y:.3f} kg<extra></extra>",
  }], layout("kg"), { responsive: true });
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

  Plotly.react("chart-charge-rate", traces, {
    ...layout("%/hr"),
    shapes: [{
      type: "line", y0: 0, y1: 0, x0: 0, x1: 1, xref: "paper",
      line: { color: "#e4d9c8", width: 1 }
    }]
  }, { responsive: true });
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

function renderAll(rows) {
  renderWeightChart(rows);
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
    const filtered = filterByHours(allRows, activeHours);
    updateStats(filtered, allRows);
    renderAll(filtered);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────
async function refresh() {
  const btn = document.getElementById("refresh-btn");
  const errBanner = document.getElementById("error-banner");
  btn.disabled = true;
  btn.textContent = "↻ Loading…";

  try {
    allRows = await fetchData();
    errBanner.classList.add("hidden");

    // Battery connection should not be shown as a normal stat; only warn on error.
    const latest = allRows.length ? allRows[allRows.length - 1] : null;
    if (latest && latest.battery_connected === false) {
      errBanner.textContent = "Battery error: no battery reported by monitor.";
      errBanner.classList.remove("hidden");
    }

    const filtered = filterByHours(allRows, activeHours);
    updateStats(filtered, allRows);
    renderAll(filtered);

    document.getElementById("last-updated").textContent =
      "Updated " + new Date().toLocaleTimeString();
  } catch (err) {
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
