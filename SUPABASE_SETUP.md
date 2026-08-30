# Activar el catálogo público

La aplicación está configurada para el proyecto Supabase `SmartMarket`.

1. Abre el proyecto en Supabase.
2. Entra en **SQL Editor** y pulsa **New query**.
3. Copia todo el contenido de
   `supabase/migrations/20260829184500_public_catalog.sql`.
4. Pégalo en el editor y pulsa **Run**.
5. Vuelve a SmartMarket y abre **Catálogo público**.

Para activar la bandeja donde los usuarios envían productos para revisión, ejecuta después el
contenido de `supabase/migrations/20260830090000_product_submissions.sql` en una consulta nueva.
Los visitantes solo pueden enviar propuestas: no pueden leer la bandeja ni aprobar productos.

La migración crea la tabla y activa Row Level Security. Cualquier visitante puede leer el catálogo,
pero solo la cuenta `promociones7819@gmail.com` puede publicar, modificar o retirar productos.

La aplicación usa exclusivamente la clave pública del navegador. No necesita ni debe configurarse
una clave `sb_secret_`.
