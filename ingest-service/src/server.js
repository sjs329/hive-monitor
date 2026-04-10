import Fastify from "fastify";
import { config } from "./config.js";
import { createDb } from "./db.js";
import {
  parseArduinoPayload,
  toNumOrNull,
  updateFilteredWeightState,
} from "./filterState.js";

const app = Fastify({ logger: true });
const db = createDb(config.dbUrl);

app.addHook("onRequest", async (req, reply) => {
  if (config.corsOrigin) {
    reply.header("Access-Control-Allow-Origin", config.corsOrigin);
    reply.header("Access-Control-Allow-Headers", "content-type,x-api-key");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }

  if (req.method === "OPTIONS") {
    reply.status(204).send();
  }
});

function parseCsv(text) {
  return String(text || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function requireApiKey(req, reply, expected) {
  const apiKey = String(req.headers["x-api-key"] || req.query.key || "").trim();
  if (!expected || apiKey !== expected) {
    reply.code(401).send({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function mergeWithLastKnownState(incoming, prev) {
  const mergedWeight = incoming.weight_present
    ? (incoming.weight_lbs ?? null)
    : (incoming.weight_lbs ?? prev.weight_lbs ?? null);

  const filtered = updateFilteredWeightState(mergedWeight, incoming.timestamp_iso, prev || {});

  return {
    timestamp_iso: incoming.timestamp_iso,
    device_id: incoming.device_id || prev.device_id || "",
    weight_lbs: mergedWeight,
    filtered_weight_lbs: filtered.filtered,
    battery_v: incoming.battery_v ?? prev.battery_v ?? null,
    battery_pct: incoming.battery_pct ?? prev.battery_pct ?? null,
    battery_charge_rate: incoming.battery_charge_rate ?? prev.battery_charge_rate ?? null,
    battery_connected: incoming.battery_connected ?? prev.battery_connected ?? null,
    temperature_c: incoming.temperature_c ?? prev.temperature_c ?? null,
    humidity_pct: incoming.humidity_pct ?? prev.humidity_pct ?? null,
    weight_read_failed: incoming.weight_read_failed === true,
    source: incoming.source || "local-ingest",
    fw_last_filtered: filtered.state.fw_last_filtered,
    fw_last_accepted_raw: filtered.state.fw_last_accepted_raw,
    fw_last_accepted_ts: filtered.state.fw_last_accepted_ts,
    fw_candidate_value: filtered.state.fw_candidate_value,
    fw_candidate_started_ts: filtered.state.fw_candidate_started_ts,
    fw_candidate_count: filtered.state.fw_candidate_count,
  };
}

app.get("/health", async () => ({ ok: true, service: "the-hive-ingest" }));

app.post("/api/telemetry", async (req, reply) => {
  if (!requireApiKey(req, reply, config.ingestSharedSecret)) return;

  const payload = req.body || {};
  const incoming = parseArduinoPayload(payload);
  if (!incoming.device_id) {
    return reply.code(400).send({ ok: false, error: "Missing device_id" });
  }

  const merged = await db.withTransaction(async (client) => {
    const prev = await db.getFilterState(client, incoming.device_id);
    const next = mergeWithLastKnownState(incoming, prev);

    await db.upsertTelemetry(client, next, payload);

    const stateToStore = {
      device_id: next.device_id,
      timestamp_iso: next.timestamp_iso,
      weight_lbs: next.weight_lbs,
      filtered_weight_lbs: next.filtered_weight_lbs,
      fw_last_filtered: next.fw_last_filtered,
      fw_last_accepted_raw: next.fw_last_accepted_raw,
      fw_last_accepted_ts: next.fw_last_accepted_ts,
      fw_candidate_value: next.fw_candidate_value,
      fw_candidate_started_ts: next.fw_candidate_started_ts,
      fw_candidate_count: next.fw_candidate_count,
      battery_v: next.battery_v,
      battery_pct: next.battery_pct,
      battery_charge_rate: next.battery_charge_rate,
      battery_connected: next.battery_connected,
      temperature_c: next.temperature_c,
      humidity_pct: next.humidity_pct,
    };

    await db.saveFilterState(client, next.device_id, stateToStore);
    return next;
  });

  return { ok: true, received: merged };
});

app.get("/api/latest", async (req) => {
  const deviceIds = parseCsv(req.query.device_ids);
  const rows = await db.getLatest(deviceIds);
  return { ok: true, rows };
});

app.get("/api/history", async (req, reply) => {
  const deviceId = String(req.query.device_id || "").trim();
  if (!deviceId) {
    return reply.code(400).send({ ok: false, error: "device_id is required" });
  }

  const hours = Number(req.query.hours || 24);
  const limit = Math.min(Math.max(Number(req.query.limit || 2000), 1), 20000);
  const toIso = req.query.to ? new Date(String(req.query.to)).toISOString() : null;
  const fromIso = req.query.from
    ? new Date(String(req.query.from)).toISOString()
    : new Date(Date.now() - Math.max(1, hours) * 3600 * 1000).toISOString();

  const rows = await db.getHistory(deviceId, fromIso, toIso, limit);
  return { ok: true, rows };
});

app.post("/api/admin/recompute-filter", async (req, reply) => {
  if (!requireApiKey(req, reply, config.adminKey || config.ingestSharedSecret)) return;

  const deviceIds = parseCsv(req.query.device_ids || req.body?.device_ids || "");
  const rows = await db.queryRecomputeRows(deviceIds);
  const updates = [];
  const latestByDevice = new Map();
  const stateByDevice = new Map();

  for (const row of rows) {
    const did = String(row.device_id || "").trim();
    if (!did) continue;

    const prev = stateByDevice.get(did) || {};
    const next = updateFilteredWeightState(toNumOrNull(row.weight_lbs), row.ts, prev);
    stateByDevice.set(did, next.state);

    updates.push({
      device_id: did,
      ts: row.ts,
      filtered_weight_lbs: next.filtered,
    });

    latestByDevice.set(did, {
      filtered_weight_lbs: next.filtered,
      state: next.state,
      ts: row.ts,
      weight_lbs: toNumOrNull(row.weight_lbs),
    });
  }

  await db.withTransaction(async (client) => {
    await db.updateFilteredBatch(client, updates);

    for (const [deviceId, latest] of latestByDevice.entries()) {
      await db.patchLatestFiltered(client, deviceId, latest.filtered_weight_lbs);
      await db.saveFilterState(client, deviceId, {
        device_id: deviceId,
        timestamp_iso: new Date(latest.ts).toISOString(),
        weight_lbs: latest.weight_lbs,
        filtered_weight_lbs: latest.filtered_weight_lbs,
        ...latest.state,
      });
    }
  });

  return {
    ok: true,
    rows_recomputed: updates.length,
    devices_updated: latestByDevice.size,
  };
});

const boot = async () => {
  try {
    await db.pool.query("select 1");
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

boot();
