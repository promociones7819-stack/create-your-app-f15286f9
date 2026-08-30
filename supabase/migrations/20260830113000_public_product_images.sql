alter table public.public_products
  add column if not exists photo_data_url text;

alter table public.product_submissions
  add column if not exists photo_data_url text;

alter table public.public_products
  drop constraint if exists public_products_photo_data_url_check;

alter table public.public_products
  add constraint public_products_photo_data_url_check
  check (
    photo_data_url is null
    or (
      char_length(photo_data_url) <= 700000
      and photo_data_url ~ '^data:image/(webp|png|jpeg);base64,'
    )
  );

alter table public.product_submissions
  drop constraint if exists product_submissions_photo_data_url_check;

alter table public.product_submissions
  add constraint product_submissions_photo_data_url_check
  check (
    photo_data_url is null
    or (
      char_length(photo_data_url) <= 700000
      and photo_data_url ~ '^data:image/(webp|png|jpeg);base64,'
    )
  );
