import { createFileRoute } from "@tanstack/react-router";

type PublicOffer = {
  name: string;
  supermarket: string;
  price: number;
  url: string;
  location: string;
  onlinePrice: true;
};

const SEARCH_AREA = {
  center: "Getxo",
  radiusKm: 25,
  municipalities: [
    "Getxo",
    "Leioa",
    "Erandio",
    "Berango",
    "Sopela",
    "Barakaldo",
    "Portugalete",
    "Santurtzi",
    "Sestao",
    "Bilbao",
  ],
};

const EROSKI_SEARCH = "https://supermercado.eroski.es/es/search/results/";

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseEroskiOffers(html: string): PublicOffer[] {
  const pattern =
    /data-metrics="\{&quot;event&quot;:&quot;select_item&quot;.*?&quot;price&quot;:([0-9.]+).*?&quot;item_name&quot;:&quot;([^&]*?)&quot;.*?href="([^"]*productdetail[^"]*)"/g;
  const seen = new Set<string>();
  const offers: PublicOffer[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) && offers.length < 8) {
    const name = decodeHtml(match[2] ?? "").trim();
    const price = Number(match[1]);
    const rawUrl = match[3] ?? "";
    if (!name || !Number.isFinite(price) || price <= 0 || seen.has(name)) continue;
    seen.add(name);
    offers.push({
      name,
      supermarket: "EROSKI",
      price,
      url: rawUrl.replace("https://supermercado.eroski.es:443", "https://supermercado.eroski.es"),
      location: "Catálogo online para el área de Bizkaia",
      onlinePrice: true,
    });
  }

  return offers.sort((a, b) => a.price - b.price);
}

async function searchEroski(query: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = new URL(EROSKI_SEARCH);
    url.searchParams.set("q", query);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "SmartMarket/1.0 (public price comparison)",
      },
    });
    if (!response.ok) throw new Error(`EROSKI respondió ${response.status}`);
    return parseEroskiOffers(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

export const Route = createFileRoute("/api/offers")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
        if (query.length < 2 || query.length > 80) {
          return Response.json({ error: "El producto debe tener entre 2 y 80 caracteres." }, { status: 400 });
        }

        let offers: PublicOffer[] = [];
        const warnings: string[] = [];
        try {
          offers = await searchEroski(query);
        } catch {
          warnings.push("EROSKI no ha respondido en esta consulta.");
        }

        return Response.json(
          {
            query,
            checkedAt: new Date().toISOString(),
            location: `Radio de ${SEARCH_AREA.radiusKm} km desde ${SEARCH_AREA.center}`,
            searchArea: SEARCH_AREA,
            offers,
            warnings,
            sources: [
              {
                supermarket: "Carrefour Express Getxo",
                label: "Ver ofertas de la tienda",
                url: "https://www.carrefour.es/tiendas-carrefour/supermercados/carrefour-express/getxo_-_s.aspx",
              },
              {
                supermarket: "DIA",
                label: "Consultar con código postal",
                url: "https://www.dia.es/compra-online/",
              },
            ],
          },
          { headers: { "Cache-Control": "public, max-age=600" } },
        );
      },
    },
  },
});
