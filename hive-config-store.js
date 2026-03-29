(function (global) {
  const ICON_OPTIONS = [
    "icons/pooh.svg",
    "icons/piglet.svg",
    "icons/eeyore.svg",
    "favicon.svg",
  ];
  const CONFIG_READ_TIMEOUT_MS = 12000;
  const CONFIG_WRITE_TIMEOUT_MS = 12000;

  function slugify(text) {
    return String(text || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function ensureUniqueId(baseId, usedIds) {
    let id = slugify(baseId) || "hive";
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }

    let suffix = 2;
    while (usedIds.has(`${id}-${suffix}`)) {
      suffix += 1;
    }
    const unique = `${id}-${suffix}`;
    usedIds.add(unique);
    return unique;
  }

  function normalizeHive(raw, index, usedIds) {
    const row = raw || {};
    const label = String(row.label || row.id || `Hive ${index + 1}`).trim() || `Hive ${index + 1}`;
    const id = ensureUniqueId(row.id || label, usedIds);
    const icon = String(row.icon || ICON_OPTIONS[index % ICON_OPTIONS.length]).trim() || "favicon.svg";
    const location = String(row.location || "").trim();
    const deviceIdRaw = row.device_id == null ? "" : String(row.device_id).trim();
    const device_id = deviceIdRaw || null;
    const active = row.active == null ? Boolean(device_id) : Boolean(row.active);

    return {
      id,
      label,
      icon,
      device_id,
      active,
      location,
    };
  }

  function normalizeHives(rawHives, fallbackHives) {
    const input = Array.isArray(rawHives) && rawHives.length ? rawHives : (Array.isArray(fallbackHives) ? fallbackHives : []);
    const usedIds = new Set();
    const normalized = input.map((hive, index) => normalizeHive(hive, index, usedIds));

    if (!normalized.length) {
      normalized.push(normalizeHive({ id: "hive-1", label: "Hive 1", icon: ICON_OPTIONS[0], active: false }, 0, usedIds));
    }

    return normalized;
  }

  function getDefaultHives() {
    return normalizeHives(global.HIVES_CONFIG || [], []);
  }

  function getConfigApiUrl_() {
    const raw = String(global.CONFIG_API_URL || global.API_URL || "").trim();
    return raw;
  }

  function withTimeout_(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  }

  let stateHives = normalizeHives([], getDefaultHives());
  let didLoadOnce = false;

  function getConfiguredHives() {
    return clone(stateHives);
  }

  async function loadConfiguredHives(forceReload) {
    if (didLoadOnce && !forceReload) return clone(stateHives);

    const apiUrl = getConfigApiUrl_();
    if (!apiUrl) {
      stateHives = normalizeHives([], getDefaultHives());
      didLoadOnce = true;
      return clone(stateHives);
    }

    try {
      const url = `${apiUrl}?mode=config_get`;
      const res = await withTimeout_(fetch(url, { cache: "no-store" }), CONFIG_READ_TIMEOUT_MS, "Config load");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !json.ok || !Array.isArray(json.hives)) throw new Error((json && json.error) || "invalid config response");

      stateHives = normalizeHives(json.hives, getDefaultHives());
      didLoadOnce = true;
      return clone(stateHives);
    } catch (err) {
      if (!didLoadOnce) {
        stateHives = normalizeHives([], getDefaultHives());
        didLoadOnce = true;
      }
      throw err;
    }
  }

  async function saveConfiguredHives(hives, adminKey) {
    const apiUrl = getConfigApiUrl_();
    if (!apiUrl) throw new Error("Missing CONFIG_API_URL/API_URL");

    const normalized = normalizeHives(hives, getDefaultHives());
    const url = `${apiUrl}?mode=config_save${adminKey ? `&admin_key=${encodeURIComponent(adminKey)}` : ""}`;

    const res = await withTimeout_(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ hives: normalized }),
      }),
      CONFIG_WRITE_TIMEOUT_MS,
      "Config save"
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !json.ok || !Array.isArray(json.hives)) {
      throw new Error((json && json.error) || "save failed");
    }

    stateHives = normalizeHives(json.hives, getDefaultHives());
    didLoadOnce = true;
    return clone(stateHives);
  }

  async function resetConfiguredHives(adminKey) {
    return saveConfiguredHives(getDefaultHives(), adminKey);
  }

  function getHiveByDeviceId(deviceId) {
    const target = String(deviceId || "");
    if (!target) return null;
    const hives = getConfiguredHives();
    return hives.find(hive => String(hive.device_id || "") === target) || null;
  }

  global.HIVE_ICON_OPTIONS = ICON_OPTIONS.slice();
  global.getConfiguredHives = getConfiguredHives;
  global.loadConfiguredHives = loadConfiguredHives;
  global.saveConfiguredHives = saveConfiguredHives;
  global.resetConfiguredHives = resetConfiguredHives;
  global.getHiveByDeviceId = getHiveByDeviceId;
})(window);
