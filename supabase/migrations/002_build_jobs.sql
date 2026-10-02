-- 002_build_jobs.sql — background (fire-and-forget) song builds.
--
-- Flow: POST /api/jobs creates a row and returns the id immediately; a
-- server-side worker picks it up, transcribes in the background, and writes
-- progress + the finished song back to the row. The client polls
-- GET /api/jobs. The phone can sleep or the tab can close mid-build.
--
-- APPLY VIA: Supabase dashboard -> SQL editor -> paste and run. (Do not
-- commit secrets; this file has none.)

-- ---------------------------------------------------------------- table ---
create table if not exists public.build_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('youtube', 'audio')),
  title text not null default '',
  source_url text,
  audio_path text,
  sections jsonb not null default '[]'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'failed')),
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  current_step text,
  song_data jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.build_jobs enable row level security;

drop policy if exists "Users manage their own build jobs" on public.build_jobs;
create policy "Users manage their own build jobs"
  on public.build_jobs for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists build_jobs_user_id_idx
  on public.build_jobs (user_id, created_at desc);

-- Keep updated_at fresh so stale-job recovery (processing older than
-- 20 minutes -> requeue) works without client bookkeeping.
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists build_jobs_touch on public.build_jobs;
create trigger build_jobs_touch
  before update on public.build_jobs
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------- storage bucket ---
-- Uploaded audio waits here until the background worker picks it up.
-- Keys are namespaced <user_id>/<job_id>/<filename> so RLS can scope
-- access per user.
insert into storage.buckets (id, name, public)
values ('build-audio', 'build-audio', false)
on conflict (id) do nothing;

drop policy if exists "Users upload their own build audio" on storage.objects;
create policy "Users upload their own build audio"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'build-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users read their own build audio" on storage.objects;
create policy "Users read their own build audio"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'build-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users delete their own build audio" on storage.objects;
create policy "Users delete their own build audio"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'build-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
