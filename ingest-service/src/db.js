import pg from "pg";

const { Pool } = pg;

export function createDb(dbUrl) {
  const pool = new Pool({ connectionString: dbUrl });

  async function getFilterState(client, deviceId) {
    const res = await client.query(
      "select state from telemetry_filter_state where device_id = $1",
      [deviceId]
    );
    return res.rows[0]?.state || {};
  }

  async function saveFilterState(client, deviceId, state) {
    await client.query(
      `insert into telemetry_filter_state(device_id, state, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (device_id)
       do update set state = excluded.state, updated_at = now()`,
      [deviceId, JSON.stringify(state || {})]
    );
  }

  async function upsertTelemetry(client, merged, eventRaw) {
    await client.query(
      `insert into telemetry_raw(
        ts, device_id, weight_lbs, filtered_weight_lbs,
        battery_v, battery_pct, battery_charge_rate, battery_connected,
        temperature_c, humidity_pct, source, event_raw
      ) values (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12::jsonb
      )
      on conflict (device_id, ts)
      do update set
        weight_lbs = excluded.weight_lbs,
        filtered_weight_lbs = excluded.filtered_weight_lbs,
        battery_v = excluded.battery_v,
        battery_pct = excluded.battery_pct,
        battery_charge_rate = excluded.battery_charge_rate,
        battery_connected = excluded.battery_connected,
        temperature_c = excluded.temperature_c,
        humidity_pct = excluded.humidity_pct,
        source = excluded.source,
        event_raw = excluded.event_raw`,
      [
        merged.timestamp_iso,
        merged.device_id,
        merged.weight_lbs,
        merged.filtered_weight_lbs,
        merged.battery_v,
        merged.battery_pct,
        merged.battery_charge_rate,
        merged.battery_connected,
        merged.temperature_c,
        merged.humidity_pct,
        merged.source,
        JSON.stringify(eventRaw || {}),
      ]
    );

    await client.query(
      `insert into telemetry_latest(
        device_id, ts, weight_lbs, filtered_weight_lbs,
        battery_v, battery_pct, battery_charge_rate, battery_connected,
        temperature_c, humidity_pct, source, event_raw, updated_at
      ) values (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12::jsonb, now()
      )
      on conflict (device_id)
      do update set
        ts = excluded.ts,
        weight_lbs = excluded.weight_lbs,
        filtered_weight_lbs = excluded.filtered_weight_lbs,
        battery_v = excluded.battery_v,
        battery_pct = excluded.battery_pct,
        battery_charge_rate = excluded.battery_charge_rate,
        battery_connected = excluded.battery_connected,
        temperature_c = excluded.temperature_c,
        humidity_pct = excluded.humidity_pct,
        source = excluded.source,
        event_raw = excluded.event_raw,
        updated_at = now()
      where excluded.ts >= telemetry_latest.ts`,
      [
        merged.device_id,
        merged.timestamp_iso,
        merged.weight_lbs,
        merged.filtered_weight_lbs,
        merged.battery_v,
        merged.battery_pct,
        merged.battery_charge_rate,
        merged.battery_connected,
        merged.temperature_c,
        merged.humidity_pct,
        merged.source,
        JSON.stringify(eventRaw || {}),
      ]
    );
  }

  async function getLatest(deviceIds) {
    if (!deviceIds?.length) {
      const all = await pool.query(
        `select
          ts as timestamp_iso,
          device_id,
          weight_lbs,
          filtered_weight_lbs,
          battery_v,
          battery_pct,
          battery_charge_rate,
          battery_connected,
          temperature_c,
          humidity_pct,
          source
         from telemetry_latest
         order by device_id asc`
      );
      return all.rows;
    }

    const res = await pool.query(
      `select
        ts as timestamp_iso,
        device_id,
        weight_lbs,
        filtered_weight_lbs,
        battery_v,
        battery_pct,
        battery_charge_rate,
        battery_connected,
        temperature_c,
        humidity_pct,
        source
       from telemetry_latest
       where device_id = any($1::text[])
       order by device_id asc`,
      [deviceIds]
    );
    return res.rows;
  }

  async function getHistory(deviceId, fromIso, toIso, limit) {
    const clauses = ["device_id = $1"];
    const values = [deviceId];
    let idx = 2;

    if (fromIso) {
      clauses.push(`ts >= $${idx++}`);
      values.push(fromIso);
    }
    if (toIso) {
      clauses.push(`ts <= $${idx++}`);
      values.push(toIso);
    }

    clauses.push(`true order by ts asc limit $${idx}`);
    values.push(limit);

    const sql = `select
      ts as timestamp_iso,
      device_id,
      weight_lbs,
      filtered_weight_lbs,
      battery_v,
      battery_pct,
      battery_charge_rate,
      battery_connected,
      temperature_c,
      humidity_pct,
      source,
      event_raw
      from telemetry_raw
      where ${clauses.join(" and ")}`;

    const res = await pool.query(sql, values);
    return res.rows;
  }

  async function queryRecomputeRows(deviceIds) {
    if (!deviceIds?.length) {
      const res = await pool.query(
        `select ts, device_id, weight_lbs
         from telemetry_raw
         order by device_id asc, ts asc`
      );
      return res.rows;
    }

    const res = await pool.query(
      `select ts, device_id, weight_lbs
       from telemetry_raw
       where device_id = any($1::text[])
       order by device_id asc, ts asc`,
      [deviceIds]
    );
    return res.rows;
  }

  async function updateFilteredBatch(client, updates) {
    for (const row of updates) {
      await client.query(
        `update telemetry_raw
         set filtered_weight_lbs = $3
         where device_id = $1 and ts = $2`,
        [row.device_id, row.ts, row.filtered_weight_lbs]
      );
    }
  }

  async function patchLatestFiltered(client, deviceId, filteredWeightLbs) {
    await client.query(
      `update telemetry_latest
       set filtered_weight_lbs = $2,
           updated_at = now()
       where device_id = $1`,
      [deviceId, filteredWeightLbs]
    );
  }

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    getFilterState,
    saveFilterState,
    upsertTelemetry,
    getLatest,
    getHistory,
    queryRecomputeRows,
    updateFilteredBatch,
    patchLatestFiltered,
    withTransaction,
  };
}
