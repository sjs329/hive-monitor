// overview.js — landing page logic

async function fetchLatestPerDevice() {
  const url = `${API_URL}?mode=data&limit=${FETCH_LIMIT}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API returned ok:false");

  const rows = (json.rows || []).map(r => ({ ...r, ts: new Date(r.timestamp_iso) }));

  // Group by device_id, keep only the latest row per device
  const byDevice = {};
  for (const row of rows) {
    const did = row.device_id || "__unknown__";
    if (!byDevice[did] || row.ts > byDevice[did].ts) {
      byDevice[did] = row;
    }
  }
  return byDevice;
}

function batteryColor(pct) {
  if (pct == null) return "";
  if (pct < 20) return "var(--danger)";
  if (pct < 50) return "var(--accent)";
  return "var(--accent2)";
}

function statLine(label, value, unit) {
  const display = value != null ? `${value}${unit ? " " + unit : ""}` : "—";
  return `<div class="hc-stat"><span class="hc-stat-label">${label}</span><span class="hc-stat-value">${display}</span></div>`;
}

function renderHiveIcon(hive) {
  const src = hive.icon || "favicon.svg";
  const alt = `${hive.label} badge`;
  return `<img class="badge-icon" src="${src}" alt="${alt}" />`;
}

function buildCard(hive, latest) {
  const hasData = !!latest;
  const lastSeen = hasData
    ? latest.ts.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
    : null;

  const weight = hasData && latest.weight_kg != null ? latest.weight_kg.toFixed(2) : null;
  const pct    = hasData && latest.battery_pct != null ? latest.battery_pct.toFixed(1) : null;
  const volts  = hasData && latest.battery_v != null ? latest.battery_v.toFixed(3) : null;
  const rate   = hasData && latest.battery_charge_rate != null ? latest.battery_charge_rate.toFixed(1) : null;
  const temp   = hasData && latest.temperature_c != null ? latest.temperature_c.toFixed(1) : null;
  const hum    = hasData && latest.humidity_pct != null ? latest.humidity_pct.toFixed(1) : null;

  const connText = hasData
    ? (latest.battery_connected === true ? "Connected" : latest.battery_connected === false ? "Disconnected" : "—")
    : null;
  const connColor = hasData
    ? (latest.battery_connected === true ? "var(--accent2)" : latest.battery_connected === false ? "var(--danger)" : "")
    : "";

  if (!hive.active) {
    return `
      <div class="hive-card hive-card--inactive">
        <div class="hc-header">
          <span class="hc-emoji">${renderHiveIcon(hive)}</span>
          <div>
            <div class="hc-title">${hive.label}</div>
            <div class="hc-location">${hive.location || ""}</div>
          </div>
          <span class="hc-badge hc-badge--soon">Coming Soon</span>
        </div>
        <div class="hc-placeholder">Sensor not yet installed</div>
      </div>`;
  }

  return `
    <a class="hive-card hive-card--active" href="hive.html?device=${encodeURIComponent(hive.device_id)}">
      <div class="hc-header">
        <span class="hc-emoji">${renderHiveIcon(hive)}</span>
        <div>
          <div class="hc-title">${hive.label}</div>
          <div class="hc-location">${hive.location || ""}</div>
        </div>
        ${hasData ? '<span class="hc-badge hc-badge--live">● Live</span>' : '<span class="hc-badge hc-badge--wait">No data</span>'}
      </div>
      <div class="hc-stats">
        ${statLine("Weight", weight, "kg")}
        ${statLine("Temperature", temp, "°C")}
        ${statLine("Humidity", hum, "%")}
      </div>
      <div class="hc-monitor">
        <span class="hc-monitor-label">Monitor</span>
        <span class="hc-monitor-value">🔋 ${pct != null ? pct + "%" : "—"}</span>
        <span class="hc-monitor-value" style="color:${connColor}">${connText ?? "—"}</span>
      </div>
      ${lastSeen ? `<div class="hc-footer">Last reading: ${lastSeen}</div>` : ""}
      <div class="hc-cta">View Details →</div>
    </a>`;
}

async function refreshOverview() {
  const btn = document.getElementById("refresh-btn");
  const errBanner = document.getElementById("error-banner");
  btn.disabled = true;
  btn.textContent = "↻ Loading…";

  try {
    const byDevice = await fetchLatestPerDevice();
    errBanner.classList.add("hidden");

    const grid = document.getElementById("hive-grid");
    grid.innerHTML = HIVES_CONFIG.map(hive => {
      const latest = hive.device_id ? byDevice[hive.device_id] : null;
      return buildCard(hive, latest || null);
    }).join("");

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
refreshOverview().then(() => {
  setInterval(refreshOverview, AUTO_REFRESH_MS);
});
