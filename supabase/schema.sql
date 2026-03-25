-- The Hive Supabase schema
-- Apply in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.telemetry_raw (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  device_id text not null,
  weight_kg double precision,
  battery_v double precision,
  battery_pct double precision,
  battery_charge_rate double precision,
  battery_connected boolean,
  temperature_c double precision,
  humidity_pct double precision,
  source text not null default 'arduino-cloud',
  event_raw jsonb,
  received_at timestamptz not null default now()
);

create index if not exists telemetry_raw_device_ts_idx
  on public.telemetry_raw (device_id, ts desc);

create index if not exists telemetry_raw_ts_idx
  on public.telemetry_raw (ts desc);

create table if not exists public.telemetry_latest (
  device_id text primary key,
  ts timestamptz not null,
  weight_kg double precision,
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

create or replace function public.upsert_latest_from_raw()
returns trigger
language plpgsql
as $$
begin
  insert into public.telemetry_latest (
    device_id,
    ts,
    weight_kg,
    battery_v,
    battery_pct,
    battery_charge_rate,
    battery_connected,
    temperature_c,
    humidity_pct,
    source,
    event_raw,
    updated_at
  ) values (
    new.device_id,
    new.ts,
    new.weight_kg,
    new.battery_v,
    new.battery_pct,
    new.battery_charge_rate,
    new.battery_connected,
    new.temperature_c,
    new.humidity_pct,
    new.source,
    new.event_raw,
    now()
  )
  on conflict (device_id)
  do update set
    ts = excluded.ts,
    weight_kg = excluded.weight_kg,
    battery_v = excluded.battery_v,
    battery_pct = excluded.battery_pct,
    battery_charge_rate = excluded.battery_charge_rate,
    battery_connected = excluded.battery_connected,
    temperature_c = excluded.temperature_c,
    humidity_pct = excluded.humidity_pct,
    source = excluded.source,
    event_raw = excluded.event_raw,
    updated_at = now()
  where excluded.ts >= public.telemetry_latest.ts;

  return new;
end;
$$;

drop trigger if exists trg_upsert_latest_from_raw on public.telemetry_raw;
create trigger trg_upsert_latest_from_raw
after insert on public.telemetry_raw
for each row execute function public.upsert_latest_from_raw();

create or replace function public.get_latest(p_device_ids text[] default null)
returns table (
  timestamp_iso timestamptz,
  device_id text,
  weight_kg double precision,
  battery_v double precision,
  battery_pct double precision,
  battery_charge_rate double precision,
  battery_connected boolean,
  temperature_c double precision,
  humidity_pct double precision,
  source text
)
language sql
stable
as $$
  select
    l.ts as timestamp_iso,
    l.device_id,
    l.weight_kg,
    l.battery_v,
    l.battery_pct,
    l.battery_charge_rate,
    l.battery_connected,
    l.temperature_c,
    l.humidity_pct,
    l.source
  from public.telemetry_latest l
  where p_device_ids is null or l.device_id = any(p_device_ids)
  order by l.device_id;
$$;

create or replace function public.get_series(
  p_device_id text,
  p_hours integer default 24,
  p_bucket_minutes integer default 5
)
returns table (
  timestamp_iso timestamptz,
  device_id text,
  weight_kg double precision,
  battery_v double precision,
  battery_pct double precision,
  battery_charge_rate double precision,
  battery_connected boolean,
  temperature_c double precision,
  humidity_pct double precision,
  source text,
  samples integer
)
language sql
stable
as $$
  with filtered as (
    select *
    from public.telemetry_raw
    where device_id = p_device_id
      and ts >= now() - make_interval(hours => greatest(1, p_hours))
  ),
  bucketed as (
    select
      date_bin(make_interval(mins => greatest(1, p_bucket_minutes)), ts, '2000-01-01'::timestamptz) as bucket_ts,
      device_id,
      avg(weight_kg) as weight_kg,
      avg(battery_v) as battery_v,
      avg(battery_pct) as battery_pct,
      avg(battery_charge_rate) as battery_charge_rate,
      bool_or(coalesce(battery_connected, false)) as battery_connected,
      avg(temperature_c) as temperature_c,
      avg(humidity_pct) as humidity_pct,
      max(source) as source,
      count(*)::int as samples
    from filtered
    group by 1, 2
  )
  select
    bucket_ts as timestamp_iso,
    device_id,
    weight_kg,
    battery_v,
    battery_pct,
    battery_charge_rate,
    battery_connected,
    temperature_c,
    humidity_pct,
    source,
    samples
  from bucketed
  order by bucket_ts;
$$;

alter table public.telemetry_raw enable row level security;
alter table public.telemetry_latest enable row level security;

-- Public dashboard reads (anon/authenticated) are allowed.
drop policy if exists telemetry_raw_read on public.telemetry_raw;
create policy telemetry_raw_read
on public.telemetry_raw
for select
using (true);

drop policy if exists telemetry_latest_read on public.telemetry_latest;
create policy telemetry_latest_read
on public.telemetry_latest
for select
using (true);

-- Writes should come from a secret API key (or legacy service role key), which can bypass RLS.
