-- بيانات كل طفل لوحدها — المرحلة 2: تقسيم الكراسات والصور والتسجيلات على الأطفال. (اتطبّق على المشروع في 2026-10-29)
-- بعد دي:
--   * صف app_state للمفاتيح دي قيمته "split"، والبيانات الحقيقية في su_child_blobs (صف لكل طفل/عنصر).
--   * القراية من app_state_v بتجمّع الصفوف المسموحة للي بيقرا بس (RLS: su_can_see_client).
--   * الكتابة على app_state زي ما هي: الـ trigger بيقسّمها، ومش بيلمس غير الصفوف اللي الكاتب يقدر يشوفها
--     (الأخصائي المقيّد مايقدرش يمسح ولا يعدّل بيانات طفل مش بتاعه، حتى لو بعت الصندوق ناقص).
--   * السيرفر (parent-data / push-*) بيقرا من app_state_full ويكتب الصندوق كامل.

-- شكل كل مفتاح: object متفهرس برقم الطفل، إلا avatars/evaluations (قوايم) و notebookTicks (متفهرس بـ "entry:item")
create or replace function public.su_child_keys()
 returns text[] language sql immutable
as $function$
  select array['notebooks','clientActivities','feedingResponses','commResponses','parentNotes','notebookTicks','avatars','evaluations']
$function$;

create or replace function public.su_child_parse(p_key text, p_data jsonb)
 returns table(subkey text, client_id text, data jsonb, ord int)
 language sql immutable
as $function$
  select o.ok, case when p_key = 'notebookTicks' then o.ov ->> 'client_id' else o.ok end, o.ov, 0
  from jsonb_each(case when jsonb_typeof(p_data) = 'object' and p_key not in ('avatars', 'evaluations') then p_data else '{}'::jsonb end) o(ok, ov)
  union all
  select coalesce(a.av ->> 'id', 'idx:' || a.ai),
         case when p_key = 'avatars' then case when lower(a.av ->> 'id') like 'client:%' then substr(a.av ->> 'id', 8) end
              else a.av ->> 'clientId' end,
         a.av, a.ai::int
  from jsonb_array_elements(case when jsonb_typeof(p_data) = 'array' and p_key in ('avatars', 'evaluations') then p_data else '[]'::jsonb end)
       with ordinality a(av, ai)
$function$;

-- الكاتب يقدر يلمس الصف ده؟ السيرفر (من غير مستخدم) آه؛ الموظف حسب su_can_see_client؛ والصفوف العامة (client_id null) لكل الموظفين
create or replace function public.su_child_visible(cid text)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select auth.uid() is null or (public.su_is_staff() and (cid is null or public.su_can_see_client(cid)))
$function$;
revoke all on function public.su_child_visible(text) from public, anon, authenticated;

create or replace function public.su_split_child_blobs()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare want text;
begin
  if not (new.key = any (public.su_child_keys())) then return new; end if;
  if new.data = '"split"'::jsonb then return new; end if;
  want := case when new.key in ('avatars', 'evaluations') then 'array' else 'object' end;
  if jsonb_typeof(new.data) is distinct from want then
    -- شكل غلط (نسخة تطبيق قديمة؟): نتجاهل الكتابة بدل ما نبوّظ البيانات
    if tg_op = 'UPDATE' then new.data := old.data; new.updated_at := old.updated_at; return new; end if;
    return null;
  end if;

  -- المسح: الصفوف اللي الكاتب شايفها ومش موجودة في اللي بعته
  delete from public.su_child_blobs c
  where c.key = new.key and public.su_child_visible(c.client_id)
    and not exists (select 1 from public.su_child_parse(new.key, new.data) p where p.subkey = c.subkey);

  -- الإضافة/التعديل: بس للصفوف اللي الكاتب شايفها (ولو الصف موجود لطفل تاني بنفس المفتاح، مايتلمسش)
  insert into public.su_child_blobs (key, subkey, client_id, data, ord)
  select new.key, p.subkey, p.client_id, p.data, p.ord
  from public.su_child_parse(new.key, new.data) p
  where public.su_child_visible(p.client_id)
  on conflict (key, subkey) do update
    set client_id = excluded.client_id, data = excluded.data, ord = excluded.ord
    where public.su_child_visible(su_child_blobs.client_id);

  new.data := '"split"'::jsonb;
  return new;
end $function$;
revoke execute on function public.su_split_child_blobs() from public, anon, authenticated;

-- نقل البيانات الموجودة (قبل الـ trigger، عشان التقسيم يحصل مرة واحدة بصلاحية كاملة)
insert into public.su_child_blobs (key, subkey, client_id, data, ord)
select a.key, p.subkey, p.client_id, p.data, p.ord
from public.app_state a, lateral public.su_child_parse(a.key, a.data) p
where a.key = any (public.su_child_keys()) and a.data <> '"split"'::jsonb
on conflict (key, subkey) do update set client_id = excluded.client_id, data = excluded.data, ord = excluded.ord;

-- updated_at بيتغيّر عشان كل الأجهزة تعيد التحميل من app_state_v (والأخصائي المقيّد ياخد نسخته المفلترة)
update public.app_state set data = '"split"'::jsonb, updated_at = now()
where key = any (public.su_child_keys()) and data <> '"split"'::jsonb;

drop trigger if exists su_split_child_blobs on public.app_state;
create trigger su_split_child_blobs
  before insert or update on public.app_state
  for each row execute function public.su_split_child_blobs();
