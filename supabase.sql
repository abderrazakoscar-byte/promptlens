-- PromptLens: users' credits. Paste ALL of this in Supabase -> SQL Editor -> New query -> Run.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',            -- 'free' or 'pro'
  day date not null default current_date,
  used_today int not null default 0,
  month text not null default to_char(current_date, 'YYYY-MM'),
  used_month int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- Create a profile automatically when someone signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Limits: free = 5 per day, pro = 300 per month (change the numbers here if you want)
create or replace function public.consume_credit(uid uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  p public.profiles;
  lim int;
  used int;
begin
  insert into public.profiles (id) values (uid) on conflict do nothing;
  select * into p from public.profiles where id = uid for update;

  if p.day <> current_date then p.day := current_date; p.used_today := 0; end if;
  if p.month <> to_char(current_date, 'YYYY-MM') then
    p.month := to_char(current_date, 'YYYY-MM'); p.used_month := 0;
  end if;

  if p.plan = 'pro' then lim := 300; used := p.used_month;
  else lim := 5; used := p.used_today; end if;

  if used >= lim then
    update public.profiles
      set day = p.day, used_today = p.used_today, month = p.month, used_month = p.used_month
      where id = uid;
    return json_build_object('ok', false, 'plan', p.plan, 'limit', lim, 'remaining', 0);
  end if;

  p.used_today := p.used_today + 1;
  p.used_month := p.used_month + 1;
  update public.profiles
    set day = p.day, used_today = p.used_today, month = p.month, used_month = p.used_month
    where id = uid;
  return json_build_object('ok', true, 'plan', p.plan, 'limit', lim, 'remaining', lim - (used + 1));
end; $$;

create or replace function public.refund_credit(uid uuid)
returns void language sql security definer set search_path = public as $$
  update public.profiles
    set used_today = greatest(used_today - 1, 0), used_month = greatest(used_month - 1, 0)
    where id = uid;
$$;

create or replace function public.get_credits(uid uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  p public.profiles;
  lim int;
  used int;
begin
  select * into p from public.profiles where id = uid;
  if not found then
    return json_build_object('plan', 'free', 'limit', 5, 'remaining', 5);
  end if;
  if p.plan = 'pro' then
    lim := 300;
    used := case when p.month = to_char(current_date, 'YYYY-MM') then p.used_month else 0 end;
  else
    lim := 5;
    used := case when p.day = current_date then p.used_today else 0 end;
  end if;
  return json_build_object('plan', p.plan, 'limit', lim, 'remaining', greatest(lim - used, 0));
end; $$;

-- IMPORTANT: only the server (service_role key) may call these functions, never visitors.
revoke execute on function public.consume_credit(uuid) from public, anon, authenticated;
revoke execute on function public.refund_credit(uuid) from public, anon, authenticated;
revoke execute on function public.get_credits(uuid) from public, anon, authenticated;
grant execute on function public.consume_credit(uuid) to service_role;
grant execute on function public.refund_credit(uuid) to service_role;
grant execute on function public.get_credits(uuid) to service_role;
