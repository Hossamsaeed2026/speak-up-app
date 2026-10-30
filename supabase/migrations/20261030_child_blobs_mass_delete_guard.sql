-- (لسه ماتطبقتش: بتتشغل من SQL Editor)
-- حماية من المسح الجماعي بالغلط في su_child_blobs (الصور، الكراسات، الأنشطة…):
-- يوم 2026-10-30 جهاز إدارة بعت قايمة صور فاضية (avatars = []) فالـ trigger مسح الـ 17 صورة (اترجعوا من su_backups).
-- دلوقتي: لو الكتابة هتمسح أكتر من نص الصفوف اللي الكاتب شايفها في المفتاح ده (ولما يكون فيه 4 صفوف أو أكتر)،
-- الكتابة بتتجاهل والبيانات بتفضل زي ما هي. المسح العادي (صف أو كام صف) شغال زي الأول.
-- السيرفر نفسه (edge functions، من غير مستخدم) مش متأثر.
create or replace function public.su_split_child_blobs()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare want text; have int; gone int;
begin
  if not (new.key = any (public.su_child_keys())) then return new; end if;
  if new.data = '"split"'::jsonb then return new; end if;
  want := case when new.key in ('avatars', 'evaluations') then 'array' else 'object' end;
  if jsonb_typeof(new.data) is distinct from want or not public.su_child_key_ok(new.key) then
    if tg_op = 'UPDATE' then new.data := old.data; new.updated_at := old.updated_at; return new; end if;
    return null;
  end if;

  -- المسح الجماعي: الصفوف اللي الكاتب شايفها وهتتمسح
  if auth.uid() is not null then
    select count(*), count(*) filter (where not exists (select 1 from public.su_child_parse(new.key, new.data) p where p.subkey = c.subkey))
      into have, gone
    from public.su_child_blobs c
    where c.key = new.key and public.su_child_visible(c.client_id);
    if have >= 4 and gone * 2 > have then
      raise warning 'su_split_child_blobs: ignored write to % that would delete % of % rows', new.key, gone, have;
      if tg_op = 'UPDATE' then new.data := old.data; new.updated_at := old.updated_at; return new; end if;
      return null;
    end if;
  end if;

  delete from public.su_child_blobs c
  where c.key = new.key and public.su_child_visible(c.client_id)
    and not exists (select 1 from public.su_child_parse(new.key, new.data) p where p.subkey = c.subkey);

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
