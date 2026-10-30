-- (اتطبّق على المشروع في 2026-10-30)
-- نسخة احتياطية يومية جوه قاعدة البيانات نفسها: كل يوم الساعة 3:17 الفجر (القاهرة) بيتحفظ نسخة من كل الجداول المهمة
-- في su_backups (صف لكل جدول في اليوم)، وبيتمسح اللي أقدم من 30 يوم.
--   * بتحمي من المسح أو التعديل بالغلط (نقدر نرجّع جدول أو صف من أي يوم في آخر 30 يوم).
--   * مابتحميش لو المشروع نفسه اتقفل أو اتمسح — لده لازم نسخة بره Supabase (الخطة المدفوعة أو تنزيل نسخة من التطبيق).
--   * الجدول مقفول على السيرفر بس: مفيش أي مستخدم في التطبيق يقدر يقراه أو يكتب فيه.
create table if not exists public.su_backups (
  day date not null,
  tbl text not null,
  row_count int not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (day, tbl)
);
alter table public.su_backups enable row level security;
revoke all on public.su_backups from public, anon, authenticated;
grant all on public.su_backups to service_role;

create or replace function public.su_daily_backup()
 returns int language plpgsql security definer set search_path to 'public'
as $function$
declare
  t text;
  d date := (now() at time zone 'Africa/Cairo')::date;
  n int := 0;
  tables text[] := array['su_clients','su_sessions','su_payments','su_purchases','su_staff','su_branches',
                         'su_child_blobs','su_user_clients','su_invoice_archive','su_reports','profiles','app_state'];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then continue; end if;
    -- app_state: الصفوف اللي فيها بيانات بس (اللي قيمتها [] أو "split" مكانها الحقيقي في الجداول التانية)
    execute format(
      'insert into public.su_backups (day, tbl, row_count, data)
       select $1, %L, count(*), coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x %s
       on conflict (day, tbl) do update set row_count = excluded.row_count, data = excluded.data, created_at = now()',
      t, t, case when t = 'app_state' then 'where x.data not in (''[]''::jsonb, ''"split"''::jsonb)' else '' end)
    using d;
    n := n + 1;
  end loop;
  delete from public.su_backups where day < d - 30;
  return n;
end $function$;
revoke all on function public.su_daily_backup() from public, anon, authenticated;

select cron.unschedule('su-daily-backup') where exists (select 1 from cron.job where jobname = 'su-daily-backup');
select cron.schedule('su-daily-backup', '17 1 * * *', 'select public.su_daily_backup()');

-- أول نسخة دلوقتي
select public.su_daily_backup();

-- لعرض النسخ الموجودة:
--   select day, tbl, row_count, pg_size_pretty(pg_column_size(data)::bigint) from su_backups order by day desc, tbl;
-- لاسترجاع صف واحد (مثلاً جلسة اتمسحت أو اتعدلت بالغلط) من نسخة يوم معين:
--   select r from su_backups b, jsonb_array_elements(b.data) r where b.day = 'YYYY-MM-DD' and b.tbl = 'su_sessions' and r->>'id' = '...';
