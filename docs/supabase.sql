-- Run once in the Supabase SQL editor if you use SUPABASE_URL + SUPABASE_SERVICE_KEY for storage.
create table if not exists ls_records (
  id uuid primary key default gen_random_uuid(),
  collection text not null,
  ts bigint not null,
  data jsonb not null default '{}'::jsonb
);
create index if not exists ls_records_collection_ts on ls_records (collection, ts);
alter table ls_records enable row level security;  -- no policies: only the service key (server-side) can access it
