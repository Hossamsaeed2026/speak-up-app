-- بيانات كل طفل لوحدها — المرحلة 1 (آمنة: مفيش أي تغيير في اللي حد شايفه)
-- المشكلة: الكراسات والصور وتسجيلات الأكل/التواصل… متخزنة صندوق واحد لكل نوع في app_state،
-- فالأخصائي اللي عليه limit_clients كان يقدر يقرا بيانات كل الأطفال.
-- الحل: كل طفل له صف في su_child_blobs، والـ RLS بتدّي كل واحد الصفوف المسموحله بيها بس،
-- والتطبيق بيقرا من app_state_v اللي بتجمّع الصفوف دي تاني لنفس الشكل القديم.
-- لحد المرحلة 2 مفيش صف في app_state قيمته "split"، فالـ view بترجّع app_state زي ما هو بالظبط.
create table if not exists public.su_child_blobs (
  key text not null,          -- notebooks / clientActivities / feedingResponses / commResponses / parentNotes / notebookTicks / avatars
  subkey text not null,       -- رقم الطفل، أو مفتاح العلامة، أو id الصورة
  client_id text,             -- null = مش خاص بطفل (صور الموظفين)
  data jsonb not null,
  ord int not null default 0,
  primary key (key, subkey)
);
alter table public.su_child_blobs enable row level security;
revoke all on public.su_child_blobs from anon, authenticated;
grant select on public.su_child_blobs to authenticated;
grant all on public.su_child_blobs to service_role;
drop policy if exists child_blobs_read on public.su_child_blobs;
create policy child_blobs_read on public.su_child_blobs for select to authenticated
  using (public.su_is_staff() and (client_id is null or public.su_can_see_client(client_id)));

create or replace view public.app_state_v with (security_invoker = true) as
select a.key,
  case when a.data = '"split"'::jsonb then
    case when a.key = 'avatars'
      then coalesce((select jsonb_agg(c.data order by c.ord, c.subkey) from public.su_child_blobs c where c.key = a.key), '[]'::jsonb)
      else coalesce((select jsonb_object_agg(c.subkey, c.data) from public.su_child_blobs c where c.key = a.key), '{}'::jsonb)
    end
  else a.data end as data,
  a.updated_at, a.updated_by
from public.app_state a;
revoke all on public.app_state_v from anon;
grant select on public.app_state_v to authenticated, service_role;

-- app_state_full (للسيرفر بس): نفس التجميع من غير فلترة، ومعاه نسخ su_blobs
create or replace view public.app_state_full with (security_invoker = true) as
select a.key,
  coalesce(b.data,
    case when a.data = '"split"'::jsonb then
      case when a.key = 'avatars'
        then coalesce((select jsonb_agg(c.data order by c.ord, c.subkey) from public.su_child_blobs c where c.key = a.key), '[]'::jsonb)
        else coalesce((select jsonb_object_agg(c.subkey, c.data) from public.su_child_blobs c where c.key = a.key), '{}'::jsonb)
      end
    else a.data end) as data,
  a.updated_at, a.updated_by
from public.app_state a
left join public.su_blobs b using (key);
revoke all on public.app_state_full from anon, authenticated;
grant select on public.app_state_full to service_role;
