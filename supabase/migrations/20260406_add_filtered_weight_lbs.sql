-- Add server-side filtered weight column and include it in latest/series APIs.

alter table if exists public.telemetry_raw
  add column if not exists filtered_weight_lbs double precision;

alter table if exists public.telemetry_raw
  add column if not exists raw_scale_counts double precision;

alter table if exists public.telemetry_latest
  add column if not exists filtered_weight_lbs double precision;

-- Existing RPC functions have different OUT signatures, so drop before recreate.
drop function if exists public.get_latest(text[]);
drop function if exists public.get_series(text, integer, integer);

create or replace function public.upsert_latest_from_raw()
returns trigger
language plpgsql
as $$
begin
  insert into public.telemetry_latest (
    device_id,
    ts,
    weight_lbs,
    filtered_weight_lbs,
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
    new.weight_lbs,
    new.filtered_weight_lbs,
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
  where excluded.ts >= public.telemetry_latest.ts;

  return new;
end;
$$;

create or replace function public.get_latest(p_device_ids text[] default null)
returns table (
  timestamp_iso timestamptz,
  device_id text,
  weight_lbs double precision,
  filtered_weight_lbs double precision,
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
    l.weight_lbs,
    l.filtered_weight_lbs,
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
  weight_lbs double precision,
  filtered_weight_lbs double precision,
  raw_scale_counts double precision,
  raw_scale_error_samples integer,
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
      avg(weight_lbs) as weight_lbs,
      avg(filtered_weight_lbs) as filtered_weight_lbs,
      avg(case
        when raw_scale_counts is null then null
        when abs(raw_scale_counts::double precision - (-2147483000)::double precision) <= 1000 then null
        else raw_scale_counts::double precision
      end) as raw_scale_counts,
      count(*) filter (
        where raw_scale_counts is not null
          and abs(raw_scale_counts::double precision - (-2147483000)::double precision) <= 1000
      )::int as raw_scale_error_samples,
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
    weight_lbs,
    filtered_weight_lbs,
    raw_scale_counts,
    raw_scale_error_samples,
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
