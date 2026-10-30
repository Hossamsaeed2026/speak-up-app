-- الإعدادات (الألوان، اللوجو، الخطوط، مصفوفة الصلاحيات…) للأدمن بس.
-- السكرتارية كانت تقدر تكتب blob الـ settings كله، ومنه مصفوفة الصلاحيات نفسها.
-- دلوقتي أي كتابة من غير الأدمن بتتجاهل بهدوء (زي users)، ما عدا invoiceConfig
-- (إعدادات شكل الفاتورة والتوقيع من صفحة الفواتير) عشان شغل السكرتارية مايقفش.
-- الـ edge functions (service role، auth.uid() فاضي) مش متأثرة.
create or replace function public.su_guard_users_blob()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is not null and not public.su_is_admin() then
    if new.key = 'users' then
      if tg_op = 'INSERT' then return null; end if;
      new.data := old.data;
      new.updated_at := old.updated_at;
    elsif new.key = 'settings' then
      if tg_op = 'INSERT' then return null; end if;
      if jsonb_typeof(old.data) = 'object' and jsonb_typeof(new.data) = 'object'
         and new.data ? 'invoiceConfig'
         and new.data->'invoiceConfig' is distinct from old.data->'invoiceConfig' then
        new.data := old.data || jsonb_build_object('invoiceConfig', new.data->'invoiceConfig');
      else
        new.data := old.data;
        new.updated_at := old.updated_at;
      end if;
    end if;
  end if;
  return new;
end $function$;
