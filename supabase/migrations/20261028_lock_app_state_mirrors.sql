-- قفل ثغرة: الأخصائي كان يقدر يقرا كل العملاء والجلسات من نسخ app_state
-- (su_rebuild كان بيكتب نسخة كاملة من جداول su_* في app_state، وصلاحية القراءة هناك مش بتطبّق limit_clients)
--
-- الحل:
--   1) النسخ الكاملة بتتخزن في جدول جديد su_blobs (للسيرفر بس، مفيش أي صلاحية للمستخدمين).
--   2) صفوف app_state للمفاتيح دي بتفضل موجودة (التطبيق محتاج updated_at بس عشان يعرف إن في تحديث)، لكن data = [].
--   3) الـ edge functions بتقرا من الـ view app_state_full (نفس شكل app_state بالبيانات الكاملة، للسيرفر بس).
--   4) غير المدير ما يقدرش يغيّر مفتاح users (هو اللي بيتحكم في ربط أولياء الأمور بالأطفال وفي limit_clients).
--
-- ترتيب النشر: الجزء A + انشر الـ edge functions الجديدة، وبعدين الجزء B. (اتطبّق على المشروع في 2026-10-28)

-- ===== الجزء A: جدول النسخ الكاملة + view للسيرفر =====
create table if not exists public.su_blobs (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.su_blobs enable row level security;
revoke all on public.su_blobs from anon, authenticated;
grant all on public.su_blobs to service_role;

insert into public.su_blobs (key, data, updated_at)
select key, data, updated_at from public.app_state
where key in ('clients', 'sessions', 'payments', 'purchases', 'staff', 'branches')
on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at;

create or replace view public.app_state_full with (security_invoker = true) as
select a.key, coalesce(b.data, a.data) as data, a.updated_at, a.updated_by
from public.app_state a
left join public.su_blobs b using (key);
revoke all on public.app_state_full from anon, authenticated;
grant select on public.app_state_full to service_role;

-- ===== الجزء B: su_rebuild يكتب في su_blobs، و app_state ياخد بصمة الوقت بس =====
create or replace function public.su_rebuild(k text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('su_sync:' || k));
  v := public.su_build(k);
  if exists (select 1 from public.su_blobs where key = k and data = v) then return; end if;
  insert into public.su_blobs (key, data, updated_at) values (k, v, now())
  on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at;
  perform set_config('su.sync', 'on', true);
  update public.app_state set data = '[]'::jsonb, updated_at = now() where key = k;
  perform set_config('su.sync', 'off', true);
end $function$;

-- su_arr بتستخدمها su_resync_from_app_state (أداة استرجاع): تقرا النسخة الكاملة من su_blobs
create or replace function public.su_arr(k text)
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(
    (select data from public.su_blobs where key = k and jsonb_typeof(data) = 'array'),
    (select data from public.app_state where key = k and jsonb_typeof(data) = 'array'),
    '[]'::jsonb)
$function$;

-- تفريغ النسخ القديمة من app_state (من غير ما نغيّر updated_at عشان الأجهزة ما تعيدش التحميل)
select set_config('su.sync', 'on', true);
update public.app_state set data = '[]'::jsonb
where key in ('clients', 'sessions', 'payments', 'purchases', 'staff', 'branches') and data <> '[]'::jsonb;
select set_config('su.sync', 'off', true);

-- مفتاح users: المدير بس يغيّره. غير المدير: التعديل بيتجاهل بهدوء (من غير error)
-- عشان باقي المفاتيح اللي في نفس الرفعة (زي الكراسات) ما تفشلش معاه.
create or replace function public.su_guard_users_blob()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.key = 'users' and auth.uid() is not null and not public.su_is_admin() then
    if tg_op = 'INSERT' then return null; end if;
    new.data := old.data;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $function$;

drop trigger if exists su_guard_users_blob on public.app_state;
create trigger su_guard_users_blob
  before insert or update on public.app_state
  for each row execute function public.su_guard_users_blob();
