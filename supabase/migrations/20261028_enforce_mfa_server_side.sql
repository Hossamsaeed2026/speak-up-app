-- التحقق بخطوتين على السيرفر: اللي مفعّل التحقق بخطوتين لازم يكون داخل بيه (aal2) عشان صلاحياته تشتغل.
-- اللي مش مفعّله: مفيش أي تغيير. كل الـ policies بتعدّي على my_role() أو su_role()، فالشرط بيتطبّق على كل الجداول.
-- (اتطبّق على المشروع في 2026-10-28)
create or replace function public.su_mfa_ok()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public', 'auth'
as $function$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
$function$;
revoke all on function public.su_mfa_ok() from public, anon, authenticated;

create or replace function public.my_role()
 returns text
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select role::text from public.profiles where id = auth.uid() and public.su_mfa_ok()
$function$;

create or replace function public.su_role()
 returns text
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select role::text from public.profiles where id = auth.uid() and public.su_mfa_ok()
$function$;

-- دوال triggers: مالهاش لازمة تتنادي من الـ API
revoke execute on function public.su_guard_users_blob() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
