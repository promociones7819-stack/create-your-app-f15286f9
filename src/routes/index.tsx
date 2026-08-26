import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import smartmarketCss from "../smartmarket/smartmarket.css?url";

const App = lazy(() => import("../smartmarket/App"));

const title = "SmartMarket Local — Compara precios de supermercado";
const description =
  "Guarda tus tickets, normaliza precios a €/kg, €/L o unidad y compara marcas entre supermercados. Todo se queda en tu dispositivo.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "stylesheet", href: smartmarketCss }],
  }),
  component: Index,
});

function Index() {
  // La app es local-first (IndexedDB/Dexie): solo puede montarse en el navegador.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="boot">Preparando la base de datos local…</div>;

  return (
    <Suspense fallback={<div className="boot">Cargando SmartMarket…</div>}>
      <App />
    </Suspense>
  );
}
