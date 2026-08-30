create extension if not exists pgcrypto;

create table if not exists talli_users (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists telegram_links (
  telegram_user_id bigint primary key,
  user_id text not null references talli_users(id) on delete cascade,
  telegram_username text,
  linked_at timestamptz not null default now()
);

create table if not exists ledger_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references talli_users(id) on delete cascade,
  ledger_id text not null,
  event_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists ledger_events_user_id_created_at_idx
  on ledger_events (user_id, created_at);

create table if not exists conversation_sessions (
  user_id text primary key references talli_users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists conversation_turns (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references talli_users(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists conversation_turns_user_id_created_at_idx
  on conversation_turns (user_id, created_at);

create table if not exists user_preferences (
  user_id text primary key references talli_users(id) on delete cascade,
  preferred_currency text not null default 'NGN',
  updated_at timestamptz not null default now()
);

create table if not exists web_sessions (
  token text primary key,
  user_id text not null references talli_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table if not exists link_tokens (
  token text primary key,
  user_id text not null references talli_users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  telegram_user_id bigint,
  telegram_username text,
  web_session_token text
);

create index if not exists link_tokens_user_id_idx on link_tokens (user_id);
create index if not exists web_sessions_user_id_idx on web_sessions (user_id);

alter table talli_users enable row level security;
alter table telegram_links enable row level security;
alter table ledger_events enable row level security;
alter table conversation_sessions enable row level security;
alter table conversation_turns enable row level security;
alter table user_preferences enable row level security;
alter table web_sessions enable row level security;
alter table link_tokens enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'talli_users' and policyname = 'talli_users_isolation'
  ) then
    create policy talli_users_isolation on talli_users
      using (id = auth.uid()::text)
      with check (id = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'telegram_links' and policyname = 'telegram_links_isolation'
  ) then
    create policy telegram_links_isolation on telegram_links
      using (user_id = auth.uid()::text)
      with check (user_id = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ledger_events' and policyname = 'ledger_events_isolation'
  ) then
    create policy ledger_events_isolation on ledger_events
      using (user_id = auth.uid()::text)
      with check (user_id = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'conversation_sessions' and policyname = 'conversation_sessions_isolation'
  ) then
    create policy conversation_sessions_isolation on conversation_sessions
      using (user_id = auth.uid()::text)
      with check (user_id = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'conversation_turns' and policyname = 'conversation_turns_isolation'
  ) then
    create policy conversation_turns_isolation on conversation_turns
      using (user_id = auth.uid()::text)
      with check (user_id = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_preferences' and policyname = 'user_preferences_isolation'
  ) then
    create policy user_preferences_isolation on user_preferences
      using (user_id = auth.uid()::text)
      with check (user_id = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'web_sessions' and policyname = 'web_sessions_isolation'
  ) then
    create policy web_sessions_isolation on web_sessions
      using (user_id = auth.uid()::text)
      with check (user_id = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'link_tokens' and policyname = 'link_tokens_isolation'
  ) then
    create policy link_tokens_isolation on link_tokens
      using (user_id = auth.uid()::text)
      with check (user_id = auth.uid()::text);
  end if;
end
$$;
