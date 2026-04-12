-- Add raw_scale_counts support and expose bucketed raw-count diagnostics in get_series.

alter table if exists public.telemetry_raw
  add column if not exists raw_scale_counts double precision;

-- Existing RPC function signature changes, so drop and recreate.
drop function if exists public.get_series(text, integer, integer);

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
