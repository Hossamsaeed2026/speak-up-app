-- (لسه ماتطبقتش: بتتشغل من SQL Editor)
-- السكرتارية مالهاش دخول على كراسة المتابعة والأنشطة (لا قراية ولا كتابة).
-- القراية: سياسة su_child_blobs بتخفي المفاتيح دي عن السكرتارية، فـ app_state_v بيرجّعلها {}.
-- الكتابة: الـ trigger بيتجاهل أي كتابة منها على المفاتيح دي (عشان لو جهازها بعت صندوق فاضي مايمسحش حاجة).
-- السيرفر (edge functions، من غير مستخدم) والإدارة والأخصائيين زي ما هم.
create or replace function public.su_child_key_ok(p_key text)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select auth.uid() is null
      or public.su_role() is distinct from 'secretary'
      or not (p_key = any (array['notebooks', 'notebookTicks', 'clientActivities']))
$function$;
revoke all on function public.su_child_key_ok(text) from public, anon;
grant execute on function public.su_child_key_ok(text) to authenticated;

drop policy if exists child_blobs_read on public.su_child_blobs;
create policy child_blobs_read on public.su_child_blobs for select to authenticated
  using (public.su_is_staff() and public.su_child_key_ok(key) and (client_id is null or public.su_can_see_client(client_id)));

create or replace function public.su_split_child_blobs()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare want text;
begin
  if not (new.key = any (public.su_child_keys())) then return new; end if;
  if new.data = '"split"'::jsonb then return new; end if;
  want := case when new.key in ('avatars', 'evaluations') then 'array' else 'object' end;
  if jsonb_typeof(new.data) is distinct from want or not public.su_child_key_ok(new.key) then
    -- شكل غلط (نسخة تطبيق قديمة؟) أو كاتب مالوش صلاحية على المفتاح ده: نتجاهل الكتابة بدل ما نبوّظ البيانات
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
