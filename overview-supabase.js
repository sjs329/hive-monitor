// overview.js — landing page logic

const OVERVIEW_CACHE_KEY = "overview_latest_cache_supabase_v1";
const OVERVIEW_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const LIVE_TIMEOUT_MS = 15 * 60 * 1000;

async function fetchLatestPerDevice() {
  if (!SUPABASE_ANON_KEY) {
    throw new Error("Missing SUPABASE_ANON_KEY in hives-supabase.js");
  }

  const deviceIds = HIVES_CONFIG
    .map(hive => hive.device_id)
    .filter(Boolean);
  const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/get_latest`;
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json() || []).map(r => ({ ...r, ts: new Date(r.timestamp_iso) }));

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

function saveOverviewCache(byDevice) {
  try {
    const payload = {
      fetchedAt: Date.now(),
      rows: Object.values(byDevice).map(row => ({
        ...row,
        ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
      })),
    };
    localStorage.setItem(OVERVIEW_CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Non-fatal: cached render is a best-effort optimization.
  }
}

function loadOverviewCache() {
  try {
    const raw = localStorage.getItem(OVERVIEW_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rows) || !Number.isFinite(parsed.fetchedAt)) return null;

    const ageMs = Date.now() - parsed.fetchedAt;
    if (ageMs > OVERVIEW_CACHE_MAX_AGE_MS) return null;

    const byDevice = {};
    parsed.rows.forEach(row => {
      const ts = new Date(row.ts || row.timestamp_iso);
      if (Number.isNaN(ts.getTime())) return;
      const did = row.device_id || "__unknown__";
      byDevice[did] = { ...row, ts };
    });

    return {
      byDevice,
      fetchedAt: new Date(parsed.fetchedAt),
    };
  } catch (err) {
    return null;
  }
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
  const isRecent = hasData && latest.ts instanceof Date && !Number.isNaN(latest.ts.getTime())
    ? (Date.now() - latest.ts.getTime()) <= LIVE_TIMEOUT_MS
    : false;
  const lastSeen = hasData
    ? latest.ts.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
    : null;

  const weight = hasData && latest.weight_kg != null ? latest.weight_kg.toFixed(2) : null;
  const pct    = hasData && latest.battery_pct != null ? latest.battery_pct.toFixed(1) : null;
  const volts  = hasData && latest.battery_v != null ? latest.battery_v.toFixed(3) : null;
  const rate   = hasData && latest.battery_charge_rate != null ? latest.battery_charge_rate.toFixed(1) : null;
  const temp   = hasData && latest.temperature_c != null ? latest.temperature_c.toFixed(1) : null;
  const hum    = hasData && latest.humidity_pct != null ? latest.humidity_pct.toFixed(1) : null;

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
        ${!hasData
          ? '<span class="hc-badge hc-badge--wait">No data</span>'
          : isRecent
            ? '<span class="hc-badge hc-badge--live">● Live</span>'
            : '<span class="hc-badge hc-badge--wait">Stale</span>'}
      </div>
      <div class="hc-stats">
        ${statLine("Weight", weight, "kg")}
        ${statLine("Temperature", temp, "°C")}
        ${statLine("Humidity", hum, "%")}
      </div>
      <div class="hc-monitor">
        <span class="hc-monitor-label">Monitor</span>
        <span class="hc-monitor-value">🔋 ${pct != null ? pct + "%" : "—"}</span>
      </div>
      ${lastSeen ? `<div class="hc-footer">Last reading: ${lastSeen}</div>` : ""}
      <div class="hc-cta">View Details →</div>
    </a>`;
}

function renderOverviewGrid(byDevice) {
  const grid = document.getElementById("hive-grid");
  grid.innerHTML = HIVES_CONFIG.map(hive => {
    const latest = hive.device_id ? byDevice[hive.device_id] : null;
    return buildCard(hive, latest || null);
  }).join("");
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

function renderCachedOverviewIfAvailable() {
  const cached = loadOverviewCache();
  if (!cached) return false;

  renderOverviewGrid(cached.byDevice);
  updateWebhookStaleBanner(cached.byDevice);
  document.getElementById("last-updated").textContent =
    "Updated " + cached.fetchedAt.toLocaleTimeString() + " (cached)";
  return true;
}

async function refreshOverview() {
  const btn = document.getElementById("refresh-btn");
  const errBanner = document.getElementById("error-banner");
  btn.disabled = true;
  btn.textContent = "↻ Loading…";

  try {
    const byDevice = await fetchLatestPerDevice();
    errBanner.classList.add("hidden");

    renderOverviewGrid(byDevice);
    updateWebhookStaleBanner(byDevice);
    saveOverviewCache(byDevice);

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
renderCachedOverviewIfAvailable();
refreshOverview().then(() => {
  setInterval(refreshOverview, AUTO_REFRESH_MS);
});
