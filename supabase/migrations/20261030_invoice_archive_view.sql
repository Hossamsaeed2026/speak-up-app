-- (اتطبّق على المشروع في 2026-10-30)
-- عرض مقروء لأرشيف الفواتير (بيظهر في Table Editor زي أي جدول): صف لكل فاتورة محفوظة، والأعمدة بالعربي.
-- security_invoker: بيطبّق صلاحيات su_invoice_archive نفسها (الإدارة والسكرتارية بس)، فمش بيفتح أي بيانات زيادة.
create or replace view public."فواتير_الأرشيف" with (security_invoker = true) as
select month                                                   as "الشهر",
       client_id                                               as "رقم_الحالة",
       data->'client'->>'name'                                 as "الاسم",
       (data->>'currentSessionsCount')::int                    as "عدد_الجلسات",
       coalesce((data->>'canceledCount')::int, 0)              as "جلسات_ملغية",
       (data->>'currentGrossDue')::numeric                     as "إجمالي_الجلسات",
       (data->>'totalPreviousCredit')::numeric                 as "خصم_الشهر_السابق",
       (data->>'totalNetDue')::numeric                         as "المطلوب",
       (data->>'totalPaid')::numeric                           as "المدفوع",
       greatest((data->>'remainingBalance')::numeric, 0)       as "الباقي",
       (data->>'isFullyPaid')::boolean                         as "مسددة",
       (created_at at time zone 'Africa/Cairo')                as "تاريخ_الحفظ"
from public.su_invoice_archive;

revoke all on public."فواتير_الأرشيف" from public, anon, authenticated;
grant select on public."فواتير_الأرشيف" to authenticated, service_role;
