-- ملفات الشكل (صورة/GIF/فيديو شاشة البداية) في bucket عام اسمه brand.
-- القراية للكل (بتظهر قبل تسجيل الدخول)، والرفع والمسح للأدمن بس.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand', 'brand', true, 5242880,
        array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists brand_admin_insert on storage.objects;
create policy brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'brand' and public.su_is_admin());

drop policy if exists brand_admin_update on storage.objects;
create policy brand_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'brand' and public.su_is_admin())
  with check (bucket_id = 'brand' and public.su_is_admin());

drop policy if exists brand_admin_delete on storage.objects;
create policy brand_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'brand' and public.su_is_admin());
