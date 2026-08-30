import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import smartmarketCss from "../smartmarket/smartmarket.css?url";

const App = lazy(() => import("../smartmarket/App"));

const title = "SmartMarket Local — Compara precios de supermercado";
const description =
  "Guarda tus productos y precios, compara por €/kg, €/L o unidad y detecta cambios entre supermercados. Todo se queda en tu dispositivo.";

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
  const [showWelcome, setShowWelcome] = useState(true);
  useEffect(() => {
    setMounted(true);
    const timer = window.setTimeout(() => setShowWelcome(false), 4_500);
    return () => window.clearTimeout(timer);
  }, []);

  if (showWelcome)
    return (
      <section className="welcome-screen" aria-label="Bienvenida a SuperComparador">
        <img
          className="welcome-image"
          src="/smartmarket-welcome.jpg"
          alt="SuperComparador, comparación de precios entre supermercados"
        />
        <div className="welcome-overlay" />
        <div className="welcome-content">
          <span>SMARTMARKET LOCAL</span>
          <h1>Compara tu cesta. Compra mejor.</h1>
          <p>Tus precios, tus supermercados y todo tu histórico en un solo lugar.</p>
          <button type="button" onClick={() => setShowWelcome(false)}>
            Entrar al comparador
          </button>
          <div className="welcome-progress" aria-hidden="true">
            <i />
          </div>
        </div>
      </section>
    );

  if (!mounted) return <div className="boot">Preparando la base de datos local…</div>;

  return (
    <Suspense fallback={<div className="boot">Cargando SmartMarket…</div>}>
      <App />
    </Suspense>
  );
}
