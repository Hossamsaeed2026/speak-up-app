-- (اتطبّق على المشروع في 2026-10-29)
-- أرشيف الفواتير: نسخة ثابتة من فاتورة كل حالة عن كل شهر، بتتحفظ تلقائي أول الشهر للشهر اللي فات
-- (أول ما حد من المكتب يفتح التطبيق). النسخة مابتتغيرش بعد كده حتى لو الجلسات أو المدفوعات اتعدلت.
--   * الإدارة والسكرتارية: يقروا ويضيفوا. مفيش تعديل لحد. المسح للإدارة بس.
--   * الأخصائيين والأهل: مالهمش دخول.
create table if not exists public.su_invoice_archive (
  id text primary key,               -- 'YYYY-MM:رقم الحالة'
  month text not null,               -- 'YYYY-MM'
  client_id text not null,
  data jsonb not null,               -- الفاتورة زي ما كانت وقت الحفظ
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index if not exists su_invoice_archive_month on public.su_invoice_archive (month);

alter table public.su_invoice_archive enable row level security;
revoke all on public.su_invoice_archive from anon, authenticated;
grant select, insert, delete on public.su_invoice_archive to authenticated;
grant all on public.su_invoice_archive to service_role;

drop policy if exists inv_archive_read on public.su_invoice_archive;
create policy inv_archive_read on public.su_invoice_archive for select to authenticated
  using (public.su_is_office());
drop policy if exists inv_archive_add on public.su_invoice_archive;
create policy inv_archive_add on public.su_invoice_archive for insert to authenticated
  with check (public.su_is_office() and created_by = auth.uid() and id = month || ':' || client_id);
drop policy if exists inv_archive_del on public.su_invoice_archive;
create policy inv_archive_del on public.su_invoice_archive for delete to authenticated
  using (public.su_is_admin());
