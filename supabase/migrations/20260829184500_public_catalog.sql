create table if not exists public.public_products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_product_id bigint not null,
  name text not null check (char_length(name) between 1 and 180),
  brand text not null default '',
  generic_name text not null default '',
  category text not null default 'Otros',
  purchase_url text,
  rating smallint not null default 0 check (rating between 0 and 5),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source_product_id),
  constraint public_products_purchase_url check (
    purchase_url is null or purchase_url = '' or purchase_url ~ '^https?://'
  )
);

alter table public.public_products enable row level security;

drop policy if exists "El catálogo es visible para todos" on public.public_products;
create policy "El catálogo es visible para todos"
on public.public_products for select
using (true);

drop policy if exists "Cada usuario publica sus productos" on public.public_products;
create policy "Cada usuario publica sus productos"
on public.public_products for insert
to authenticated
with check (
  auth.uid() = owner_id
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com'
);

drop policy if exists "Cada usuario edita sus productos" on public.public_products;
create policy "Cada usuario edita sus productos"
on public.public_products for update
to authenticated
using (
  auth.uid() = owner_id
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com'
)
with check (
  auth.uid() = owner_id
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com'
);

drop policy if exists "Cada usuario retira sus productos" on public.public_products;
create policy "Cada usuario retira sus productos"
on public.public_products for delete
to authenticated
using (
  auth.uid() = owner_id
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'promociones7819@gmail.com'
);

create index if not exists public_products_generic_name_idx
on public.public_products (generic_name);

create or replace function public.touch_public_product_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_public_product_updated_at on public.public_products;
create trigger touch_public_product_updated_at
before update on public.public_products
for each row execute function public.touch_public_product_updated_at();
