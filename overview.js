// overview.js — landing page logic

const LIVE_TIMEOUT_MS = 15 * 60 * 1000;
const INVALID_CALIBRATION_WEIGHT_SENTINEL = -1234.5;
const INVALID_CALIBRATION_WEIGHT_EPS = 0.01;

const OVERVIEW_PROFILE = (() => {
  try {
    if (typeof window !== "undefined" && window.OVERVIEW_PROFILE === true) return true;
    if (typeof localStorage !== "undefined" && localStorage.getItem("hive:overviewProfile") === "1") return true;
    if (typeof location !== "undefined") {
      const params = new URLSearchParams(location.search || "");
      if (params.get("profile") === "1") return true;
    }
  } catch (err) {
    // Profiling must never break runtime behavior.
  }
  return false;
})();

function profileStart_(label) {
  if (!OVERVIEW_PROFILE || typeof performance === "undefined") return null;
  return { label, t0: performance.now() };
}

function profileEnd_(token, extra) {
  if (!token || !OVERVIEW_PROFILE || typeof performance === "undefined") return;
  const ms = performance.now() - token.t0;
  const detail = extra ? ` ${extra}` : "";
  console.log(`[overview-prof] ${token.label}: ${ms.toFixed(1)}ms${detail}`);
}

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

function getHivesConfig_() {
  if (typeof getConfiguredHives === "function") return getConfiguredHives();
  return Array.isArray(HIVES_CONFIG) ? HIVES_CONFIG : [];
}

function getConfigSignature_(hives) {
  return (Array.isArray(hives) ? hives : []).map(hive => [
    String(hive && hive.id || ""),
    String(hive && hive.label || ""),
    String(hive && hive.icon || ""),
    String(hive && hive.device_id || ""),
    String(hive && hive.location || ""),
    String(Boolean(hive && hive.active))
  ].join("|")).join("||");
}

async function ensureConfiguredHivesLoaded_() {
  const p = profileStart_("config_sync_total");
  const beforeSig = getConfigSignature_(configuredHives);
  if (typeof loadConfiguredHives === "function") {
    try {
      await loadConfiguredHives(false);
    } catch (err) {
      // Keep running with the last loaded/default config if server config is temporarily unavailable.
    }
  }
  configuredHives = getHivesConfig_();
  const changed = getConfigSignature_(configuredHives) !== beforeSig;
  profileEnd_(p, `changed=${changed}`);
  return changed;
}

let configuredHives = getHivesConfig_();
let lastByDevice = {};

async function fetchLatestPerDevice() {
  const p = profileStart_("fetch_latest_total");
  const useSupabase = DATA_SOURCE !== "appscript";
  let rows = [];

  if (useSupabase) {
    if (!SUPABASE_ANON_KEY) {
      throw new Error("Missing SUPABASE_ANON_KEY in hives.js");
    }

    const deviceIds = configuredHives
      .map(hive => hive.device_id)
      .filter(Boolean);
    if (!deviceIds.length) return {};
    const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/get_latest`;
    const reqP = profileStart_("fetch_latest_request_supabase");
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_device_ids: deviceIds }),
    });
    profileEnd_(reqP, `status=${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = (await res.json() || []).map(r => ({ ...r, ts: new Date(r.timestamp_iso || r.ts) }));
  } else {
    const deviceIds = configuredHives
      .map(hive => hive.device_id)
      .filter(Boolean)
      .join(",");
    const url = `${API_URL}?mode=latest&device_ids=${encodeURIComponent(deviceIds)}&scan_limit=500&_=${Date.now()}`;
    const reqP = profileStart_("fetch_latest_request_appscript");
    const res = await fetch(url, { cache: "no-store" });
    profileEnd_(reqP, `status=${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "API returned ok:false");
    rows = (json.rows || []).map(r => ({ ...r, ts: new Date(r.timestamp_iso) }));
  }

  profileEnd_(p, `rows=${rows.length}`);

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

function renderHiveIcon(hive) {
  const alt = `${hive.label} badge`;
  const icon = String(hive.icon || "").trim();
  if (!icon || isImageIconValue_(icon)) {
    const src = icon || "favicon.svg";
    return `<img class="badge-icon" src="${src}" alt="${alt}" />`;
  }
  return `<span class="badge-emoji" role="img" aria-label="${escapeHtml_(alt)}">${escapeHtml_(icon)}</span>`;
}

function buildCard(hive, latest) {
  const isConfigured = Boolean(hive.device_id);
  const isActive = Boolean(hive.active) && isConfigured;
  const hasData = !!latest;
  const isRecent = hasData && latest.ts instanceof Date && !Number.isNaN(latest.ts.getTime())
    ? (Date.now() - latest.ts.getTime()) <= LIVE_TIMEOUT_MS
    : false;
  const lastSeen = hasData
    ? latest.ts.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
    : null;

  const weightLbs = hasData ? getWeightLbs_(latest) : null;
  const filteredWeightLbs = hasData && Number.isFinite(Number(latest.filtered_weight_lbs))
    ? Number(latest.filtered_weight_lbs)
    : null;
  const hasInvalidWeight = hasData && isInvalidCalibrationWeight_(weightLbs);
  const weight = hasInvalidWeight
    ? "Calibrate scale"
    : ((filteredWeightLbs != null ? filteredWeightLbs : weightLbs) != null
      ? (filteredWeightLbs != null ? filteredWeightLbs : weightLbs).toFixed(2)
      : null);
  const pct    = hasData && latest.battery_pct != null ? latest.battery_pct.toFixed(1) : null;
  const volts  = hasData && latest.battery_v != null ? latest.battery_v.toFixed(3) : null;
  const rate   = hasData && latest.battery_charge_rate != null ? latest.battery_charge_rate.toFixed(1) : null;
  const temp   = hasData && latest.temperature_c != null ? latest.temperature_c.toFixed(1) : null;
  const hum    = hasData && latest.humidity_pct != null ? latest.humidity_pct.toFixed(1) : null;

  if (!isActive) {
    const statusText = hive.active && !isConfigured ? "Missing Device ID" : "Coming Soon";
    const detailText = hive.active && !isConfigured
      ? "Set a device id in Edit Hives to enable telemetry"
      : "Sensor not yet installed";
    return `
      <div class="hive-card hive-card--inactive">
        <div class="hc-header">
          <span class="hc-emoji">${renderHiveIcon(hive)}</span>
          <div>
            <div class="hc-title">${hive.label}</div>
            <div class="hc-location">${hive.location || ""}</div>
          </div>
          <span class="hc-badge hc-badge--soon">${statusText}</span>
        </div>
        <div class="hc-placeholder">${detailText}</div>
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
        ${!hasData
          ? '<span class="hc-badge hc-badge--wait">No data</span>'
          : isRecent
            ? '<span class="hc-badge hc-badge--live">● Live</span>'
            : '<span class="hc-badge hc-badge--wait">Stale</span>'}
      </div>
      <div class="hc-stats">
        ${statLine("Weight", weight, hasInvalidWeight ? "" : "lbs")}
        ${statLine("Temperature", temp, "°C")}
        ${statLine("Humidity", hum, "%")}
      </div>
      <div class="hc-monitor">
        <span class="hc-monitor-label">Monitor</span>
        <span class="hc-monitor-value">🔋 ${pct != null ? pct + "%" : "—"}</span>
      </div>
      ${hasInvalidWeight ? '<div class="hc-footer hc-footer--warn">Scale not calibrated. Run tare, then calibrate with a known weight.</div>' : ""}
      ${lastSeen ? `<div class="hc-footer">Last reading: ${lastSeen}</div>` : ""}
      <div class="hc-cta">View Details →</div>
    </a>`;
}

function renderOverviewGrid(byDevice) {
  const grid = document.getElementById("hive-grid");
  grid.innerHTML = configuredHives.map(hive => {
    const latest = hive.device_id ? byDevice[hive.device_id] : null;
    return buildCard(hive, latest || null);
  }).join("");
}

function renderOverviewLoading(message) {
  const grid = document.getElementById("hive-grid");
  if (!grid) return;
  grid.innerHTML = `<div class="hive-grid-loading">${escapeHtml_(message || "Loading hives...")}</div>`;
}

function initOverviewConfigEditor() {
  if (typeof initHiveConfigEditor !== "function") return;

  initHiveConfigEditor({
    onSave: (nextHives) => {
      configuredHives = nextHives;
      renderOverviewGrid(lastByDevice);
      updateWebhookStaleBanner(lastByDevice);
      refreshOverview();
    },
  });
}

function formatAge(ms) {
  const totalMins = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function updateWebhookStaleBanner(byDevice) {
  const banner = document.getElementById("webhook-stale-banner");
  if (!banner) return;

  const rows = Object.values(byDevice || {}).filter(r => r && r.ts instanceof Date && !Number.isNaN(r.ts.getTime()));
  if (!rows.length) {
    banner.classList.add("hidden");
    return;
  }

  const newest = rows.reduce((best, row) => (row.ts > best.ts ? row : best), rows[0]);
  const ageMs = Date.now() - newest.ts.getTime();

  if (ageMs <= LIVE_TIMEOUT_MS) {
    banner.classList.add("hidden");
    return;
  }

  banner.textContent = `No new webhook posts for ${formatAge(ageMs)}. Latest reading: ${newest.ts.toLocaleString()}.`;
  banner.classList.remove("hidden");
}

async function refreshOverview() {
  const p = profileStart_("refresh_total");
  const btn = document.getElementById("refresh-btn");
  const errBanner = document.getElementById("error-banner");
  btn.disabled = true;
  btn.textContent = "↻ Loading…";

  try {
    if (!Object.keys(lastByDevice).length) {
      renderOverviewLoading("Loading hives...");
    }
    const fetchP = profileStart_("refresh_fetch_latest");
    const byDevice = await fetchLatestPerDevice();
    profileEnd_(fetchP, `devices=${Object.keys(byDevice || {}).length}`);
    lastByDevice = byDevice;
    errBanner.classList.add("hidden");

    const renderP = profileStart_("refresh_render");
    renderOverviewGrid(byDevice);
    updateWebhookStaleBanner(byDevice);
    profileEnd_(renderP);

    document.getElementById("last-updated").textContent =
      "Updated " + new Date().toLocaleTimeString();
  } catch (err) {
    errBanner.textContent = "Failed to load data: " + err.message;
    errBanner.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "↻ Refresh";
    profileEnd_(p);
  }
}

// Auto-refresh
initOverviewConfigEditor();
renderOverviewLoading("Loading hives...");
refreshOverview();

// Sync server-side hive config in the background so a slow config endpoint
// does not block first paint or manual refresh latency.
ensureConfiguredHivesLoaded_().then((changed) => {
  if (changed) {
    renderOverviewGrid(lastByDevice);
    updateWebhookStaleBanner(lastByDevice);
    refreshOverview();
  }
}).finally(() => {
  setInterval(refreshOverview, AUTO_REFRESH_MS);
});
