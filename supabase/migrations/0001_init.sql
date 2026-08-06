-- FixtureForge v2 schema: profiles, tournaments, isolation (RLS), and
-- free-tier limits (DB trigger, not just UI). Apply via the Supabase
-- SQL Editor or `supabase db push` — see README.md "Backend setup".

-- ============================================================
-- profiles: one row per auth user. role/tier drive access control.
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'user' check (role in ('user','super_admin')),
  tier text not null default 'free' check (tier in ('free','paid')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Central "is this caller the super admin" check, reused by every policy
-- below. security definer + a fixed search_path so it can read profiles
-- even though the caller's own RLS on profiles would otherwise apply.
create function public.is_super_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'super_admin'
  );
$$;

create policy "profiles_select_own_or_admin" on public.profiles
  for select using (id = auth.uid() or public.is_super_admin());

create policy "profiles_update_own_or_admin" on public.profiles
  for update using (id = auth.uid() or public.is_super_admin());

-- Regular users may only ever change their own display_name via direct
-- UPDATE — role/tier changes must go through admin_set_tier() below.
-- (The above USING clause governs *which rows* are reachable; this
-- column-level grant governs *which columns* a plain UPDATE may touch.)
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Super-admin-only RPC to grant/revoke paid tier. Runs as definer so it
-- can bypass the column-level grant above in a controlled, audited way.
create function public.admin_set_tier(target_user_id uuid, new_tier text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only the super admin can change a user''s tier.';
  end if;
  if new_tier not in ('free', 'paid') then
    raise exception 'Invalid tier: %', new_tier;
  end if;
  update public.profiles set tier = new_tier where id = target_user_id;
end;
$$;

-- ============================================================
-- tournaments: one row per tournament. `data` jsonb holds teams/matches/
-- groups/groupStage in exactly the shape src/app.jsx already produces.
-- ============================================================
create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  sport text not null default 'generic',
  format text not null default 'knockout' check (format in ('knockout', 'groups')),
  status text not null default 'active' check (status in ('active', 'completed')),
  share_slug text unique not null default replace(gen_random_uuid()::text, '-', ''),
  registration_deadline timestamptz,
  data jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tournaments_owner_id_idx on public.tournaments (owner_id);

alter table public.tournaments enable row level security;

create policy "tournaments_select_own_or_admin" on public.tournaments
  for select using (owner_id = auth.uid() or public.is_super_admin());

create policy "tournaments_insert_own" on public.tournaments
  for insert with check (owner_id = auth.uid());

create policy "tournaments_update_own_or_admin" on public.tournaments
  for update using (owner_id = auth.uid() or public.is_super_admin());

create policy "tournaments_delete_own_or_admin" on public.tournaments
  for delete using (owner_id = auth.uid() or public.is_super_admin());

-- Free-tier limits, enforced in the database so they can't be bypassed by
-- editing client code: max 8 participants, single round-robin group, no
-- knockout stage. Applies to every INSERT/UPDATE regardless of who wrote
-- the row, so it also blocks a free user from later editing their way
-- around the limit (e.g. clicking "Generate Knockout Bracket").
create function public.enforce_tier_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_tier text;
  owner_role text;
  team_count int;
  group_count int;
  has_knockout boolean;
begin
  select tier, role into owner_tier, owner_role
  from public.profiles where id = new.owner_id;

  if owner_tier = 'free' and owner_role <> 'super_admin' then
    team_count := coalesce(jsonb_array_length(new.data->'teams'), 0);
    if team_count > 8 then
      raise exception 'Free tier is limited to 8 participants per tournament.';
    end if;

    if new.format <> 'groups' then
      raise exception 'Free tier tournaments must use the round-robin format.';
    end if;

    group_count := coalesce(jsonb_array_length(new.data->'groups'), 0);
    if group_count > 1 then
      raise exception 'Free tier tournaments are limited to a single round-robin group.';
    end if;

    select exists (
      select 1 from jsonb_array_elements(coalesce(new.data->'matches', '[]'::jsonb)) m
      where m->>'stage' = 'knockout'
    ) into has_knockout;
    if has_knockout then
      raise exception 'Free tier tournaments cannot include a knockout stage. Upgrade to unlock brackets.';
    end if;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

create trigger tournaments_enforce_tier_limits
  before insert or update on public.tournaments
  for each row execute function public.enforce_tier_limits();
