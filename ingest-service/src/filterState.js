const WEIGHT_FILTER_MAX_RATE_LB_PER_MIN = 0.05;
const WEIGHT_FILTER_STEP_MARGIN_LB = 0.24;
const WEIGHT_FILTER_EMA_TAU_MIN = 300;
const WEIGHT_FILTER_CONSISTENCY_BAND_LB = 0.28;
const WEIGHT_FILTER_UNLOCK_MIN_POINTS = 4;
const WEIGHT_FILTER_UNLOCK_MIN_MINUTES = 20;

const LBS_PER_KG = 2.2046226218;
const WEIGHT_INVALID_CALIBRATION_SENTINEL_LBS = -1234.5;
const WEIGHT_READ_FAILED_SENTINEL_LBS = -2234.5;
const WEIGHT_SENTINEL_EPS = 0.02;

export function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isLikelyStepJump(rawWeight, lastAcceptedWeight, lastAcceptedTs, ts) {
  if (!Number.isFinite(rawWeight) || !Number.isFinite(lastAcceptedWeight)) return false;
  if (!(lastAcceptedTs instanceof Date) || Number.isNaN(lastAcceptedTs.getTime())) return false;
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) return false;

  const dtMin = Math.max(0.1, (ts.getTime() - lastAcceptedTs.getTime()) / 60000);
  const maxStep = (WEIGHT_FILTER_MAX_RATE_LB_PER_MIN * dtMin) + WEIGHT_FILTER_STEP_MARGIN_LB;
  return Math.abs(rawWeight - lastAcceptedWeight) > maxStep;
}

export function updateFilteredWeightState(weightLbs, tsIso, prev = {}) {
  const hasWeightInput = !(
    weightLbs === null
    || weightLbs === undefined
    || (typeof weightLbs === "string" && weightLbs.trim() === "")
  );

  const parsedWeight = Number(weightLbs);
  let effectiveWeight = parsedWeight;
  const ts = new Date(String(tsIso || ""));

  if (!hasWeightInput || !Number.isFinite(parsedWeight) || Number.isNaN(ts.getTime())) {
    const prevFiltered = toNumOrNull(prev.fw_last_filtered);
    return {
      filtered: prevFiltered,
      state: {
        fw_last_filtered: prevFiltered,
        fw_last_accepted_raw: prev.fw_last_accepted_raw ?? null,
        fw_last_accepted_ts: prev.fw_last_accepted_ts ?? null,
        fw_candidate_value: prev.fw_candidate_value ?? null,
        fw_candidate_started_ts: prev.fw_candidate_started_ts ?? null,
        fw_candidate_count: prev.fw_candidate_count ?? 0,
      },
    };
  }

  let lastFiltered = toNumOrNull(prev.fw_last_filtered);
  let lastAcceptedRaw = toNumOrNull(prev.fw_last_accepted_raw);
  const lastAcceptedTs = new Date(String(prev.fw_last_accepted_ts || ""));

  let candidateValue = toNumOrNull(prev.fw_candidate_value);
  let candidateStartedTs = new Date(String(prev.fw_candidate_started_ts || ""));
  let candidateCount = Number(prev.fw_candidate_count) || 0;

  if (Number.isNaN(lastAcceptedTs.getTime())) {
    lastAcceptedRaw = null;
  }
  if (Number.isNaN(candidateStartedTs.getTime())) {
    candidateValue = null;
    candidateCount = 0;
  }

  let acceptNow = true;
  let unlockedNow = false;
  const stepJump = isLikelyStepJump(effectiveWeight, lastAcceptedRaw, lastAcceptedTs, ts);

  if (stepJump) {
    acceptNow = false;

    if (Number.isFinite(candidateValue) && !Number.isNaN(candidateStartedTs.getTime())) {
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
      lastFiltered = effectiveWeight;
    } else if (lastFiltered == null || !Number.isFinite(lastFiltered) || Number.isNaN(lastAcceptedTs.getTime())) {
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
      fw_candidate_started_ts: candidateStartedTs instanceof Date && !Number.isNaN(candidateStartedTs.getTime())
        ? candidateStartedTs.toISOString()
        : null,
      fw_candidate_count: candidateCount,
    },
  };
}

function parseWeightMaybeNull(value, state) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n - WEIGHT_INVALID_CALIBRATION_SENTINEL_LBS) <= WEIGHT_SENTINEL_EPS) return null;
  if (Math.abs(n - WEIGHT_READ_FAILED_SENTINEL_LBS) <= WEIGHT_SENTINEL_EPS) {
    state.weightReadFailed = true;
    return null;
  }
  return n;
}

function parseTimestamp(payload) {
  const direct = payload.timestamp || payload.time || payload.created_at || payload.at;
  if (payload.values && Array.isArray(payload.values) && payload.values[0] && payload.values[0].updated_at) {
    const d = new Date(payload.values[0].updated_at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  if (!direct) return new Date().toISOString();
  if (typeof direct === "number") {
    const ms = direct < 1e12 ? direct * 1000 : direct;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  const d = new Date(direct);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function parseArduinoPayload(payload) {
  const ts = parseTimestamp(payload);
  const deviceId = String(payload.device_id || payload.deviceId || payload.thing_id || payload.thingId || payload.id || "");

  let weightLbs = NaN;
  let battV = NaN;
  let battPct = NaN;
  let battChargeRate = NaN;
  let battConnected = null;
  let temp = NaN;
  let humidity = NaN;
  let weightPresent = false;
  const localState = { weightReadFailed: false };

  if (Array.isArray(payload.values)) {
    for (const item of payload.values) {
      const name = String(item?.name || "").toLowerCase();
      const value = item?.value;

      if (name === "battery_charge") battPct = Number(value);
      else if (name === "battery_voltage") battV = Number(value);
      else if (name === "battery_charge_rate") battChargeRate = Number(value);
      else if (name === "battery_connected") battConnected = Boolean(value);
      else if (name === "weight_lbs") {
        weightPresent = true;
        const parsed = parseWeightMaybeNull(value, localState);
        weightLbs = parsed == null ? NaN : parsed;
      } else if (name === "weight_kg") {
        const kg = Number(value);
        if (Number.isFinite(kg)) {
          weightPresent = true;
          const parsed = parseWeightMaybeNull(kg * LBS_PER_KG, localState);
          weightLbs = parsed == null ? NaN : parsed;
        }
      } else if (name.includes("weight") || name.includes("hive_weight")) {
        weightPresent = true;
        const parsed = parseWeightMaybeNull(value, localState);
        weightLbs = parsed == null ? NaN : parsed;
      } else if (name === "temperature" || name === "temperature_c" || name === "temp") {
        temp = Number(value);
      } else if (name === "humidity" || name === "humidity_pct" || name === "relative_humidity") {
        humidity = Number(value);
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
    temperature_c: Number.isFinite(temp) ? temp : null,
    humidity_pct: Number.isFinite(humidity) ? humidity : null,
    weight_present: weightPresent,
    weight_read_failed: localState.weightReadFailed,
    source: "local-ingest",
  };
}
