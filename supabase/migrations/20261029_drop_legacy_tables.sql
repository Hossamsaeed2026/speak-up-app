-- (اتطبّق على المشروع في 2026-10-29)
-- تنظيف: مسح الجداول القديمة اللي التطبيق مابقاش بيستخدمها، والنسخ الاحتياطية المؤقتة من أكتوبر.
-- التطبيق بيستخدم بس: app_state (+ app_state_v / app_state_full)، su_*، su_blobs، su_child_blobs،
-- su_user_clients، su_reports، profiles، logs، push_*.
-- اتأكدنا قبلها: مفيش view ولا trigger ولا كود في التطبيق أو الـ edge functions بيقرا الجداول دي،
-- والدوال اللي فيها الأسماء دي بتستخدمها كمفاتيح JSON بس (زي 'clients') مش كجداول.
-- من غير CASCADE: لو أي حاجة لسه معتمدة على جدول منهم، المسح هيفشل ومش هيتمسح حاجة.
begin;

drop table
  -- جداول النسخة الأولى من التطبيق (البيانات دلوقتي في su_*)
  public.weekly_schedule,
  public.sessions,
  public.payments,
  public.purchases,
  public.clients,
  public.staff,
  public.branches,
  public.feeding_skill_logs,
  public.feeding_skills,
  -- نسخ احتياطية مؤقتة اتعملت وقت نقل البيانات
  public.app_state_backup_20261020,
  public.app_state_backup_20261020_b,
  public.app_state_bk_remap,
  public.profiles_bk_remap,
  public.su_clients_backup_20261020,
  public.su_clients_backup_20261020_b,
  public.su_orphan_backup;

commit;

-- للتأكد بعد التشغيل (المفروض يرجّع 0):
-- select count(*) from pg_tables where schemaname = 'public'
--   and tablename in ('weekly_schedule','sessions','payments','purchases','clients','staff','branches',
--     'feeding_skill_logs','feeding_skills','app_state_backup_20261020','app_state_backup_20261020_b',
--     'app_state_bk_remap','profiles_bk_remap','su_clients_backup_20261020','su_clients_backup_20261020_b','su_orphan_backup');
