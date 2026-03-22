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

// ─────────────────────────────────────────────────────────────────────────────
// Stat cards
// ─────────────────────────────────────────────────────────────────────────────
function updateStats(rows) {
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

  const conn = latest.battery_connected;
  const connEl = document.getElementById("stat-connected");
  if (conn === true)       { connEl.textContent = "Connected";    connEl.style.color = "var(--accent2)"; }
  else if (conn === false) { connEl.textContent = "Disconnected"; connEl.style.color = "var(--danger)"; }
  else                     { connEl.textContent = "—";            connEl.style.color = ""; }

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
  const x = rows.map(r => r.ts);
  const y = rows.map(r => r.battery_charge_rate);

  // Colour positive vs negative (charging vs discharging)
  Plotly.react("chart-charge-rate", [{
    x, y,
    mode: "lines",
    name: "Charge rate (%/hr)",
    line: { color: "#c8820a", width: 2 },
    hovertemplate: "%{y:.1f} %/hr<extra></extra>",
  }, {
    x, y: y.map(v => (v != null && v < 0 ? v : null)),
    mode: "lines",
    name: "Discharging",
    line: { color: "var(--danger)", width: 2 },
    hoverinfo: "skip",
    showlegend: false,
  }], {
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
    updateStats(filtered);
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

    const filtered = filterByHours(allRows, activeHours);
    updateStats(filtered);
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
