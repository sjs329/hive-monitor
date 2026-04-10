create extension if not exists pgcrypto;

create table if not exists telemetry_raw (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  device_id text not null,
  weight_lbs double precision,
  filtered_weight_lbs double precision,
  battery_v double precision,
  battery_pct double precision,
  battery_charge_rate double precision,
  battery_connected boolean,
  temperature_c double precision,
  humidity_pct double precision,
  source text not null default 'local-ingest',
  event_raw jsonb,
  received_at timestamptz not null default now(),
  unique (device_id, ts)
);

create index if not exists telemetry_raw_device_ts_idx
  on telemetry_raw (device_id, ts desc);

create index if not exists telemetry_raw_ts_idx
  on telemetry_raw (ts desc);

create table if not exists telemetry_latest (
  device_id text primary key,
  ts timestamptz not null,
  weight_lbs double precision,
  filtered_weight_lbs double precision,
  battery_v double precision,
  battery_pct double precision,
  battery_charge_rate double precision,
  battery_connected boolean,
  temperature_c double precision,
  humidity_pct double precision,
  source text not null,
  event_raw jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists telemetry_filter_state (
  device_id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
