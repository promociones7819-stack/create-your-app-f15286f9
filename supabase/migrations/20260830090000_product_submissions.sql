create table if not exists public.product_submissions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  source_product_id bigint not null,
  sender_name text not null default '' check (char_length(sender_name) <= 100),
  sender_email text not null default '' check (char_length(sender_email) <= 180),
  name text not null check (char_length(name) between 1 and 180),
  brand text not null default '' check (char_length(brand) <= 180),
  generic_name text not null default '' check (char_length(generic_name) <= 180),
  category text not null default 'Otros' check (char_length(category) <= 100),
  purchase_url text,
  rating smallint not null default 0 check (rating between 0 and 5),
  notes text not null default '' check (char_length(notes) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  unique (batch_id, source_product_id),
  constraint product_submissions_purchase_url check (
    purchase_url is null or purchase_url = '' or purchase_url ~ '^https?://'
  )
);

alter table public.product_submissions enable row level security;

revoke all on table public.product_submissions from anon, authenticated;
grant insert on table public.product_submissions to anon, authenticated;
grant select, update, delete on table public.product_submissions to authenticated;

drop policy if exists "Cualquiera puede proponer productos" on public.product_submissions;
create policy "Cualquiera puede proponer productos"
on public.product_submissions for insert
to anon, authenticated
with check (
  status = 'pending'
  and reviewed_at is null
  and reviewed_by is null
);

drop policy if exists "El administrador revisa propuestas" on public.product_submissions;
create policy "El administrador revisa propuestas"
on public.product_submissions for select
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com');

drop policy if exists "El administrador resuelve propuestas" on public.product_submissions;
create policy "El administrador resuelve propuestas"
on public.product_submissions for update
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com')
with check (
  lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com'
  and status in ('approved', 'rejected')
  and reviewed_by = auth.uid()
  and reviewed_at is not null
);

drop policy if exists "El administrador elimina propuestas" on public.product_submissions;
create policy "El administrador elimina propuestas"
on public.product_submissions for delete
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com');

create index if not exists product_submissions_pending_idx
on public.product_submissions (status, created_at desc);

create index if not exists product_submissions_batch_idx
on public.product_submissions (batch_id);
