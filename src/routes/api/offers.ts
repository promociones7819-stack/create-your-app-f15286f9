import { createFileRoute } from "@tanstack/react-router";

type PublicOffer = {
  name: string;
  supermarket: string;
  price: number;
  url: string;
  location: string;
  onlinePrice: true;
  comparablePrice: number | null;
  comparableUnit: "kg" | "l" | "ud" | null;
  format: string | null;
  promotion?: string | undefined;
};

type MercadonaCategory = {
  id: number;
  name: string;
  categories?: { id: number; name: string }[];
};
type MercadonaProduct = {
  display_name?: string;
  share_url?: string;
  packaging?: string;
  price_instructions?: {
    unit_price?: string;
    previous_unit_price?: string | null;
    reference_price?: string;
    reference_format?: string;
    unit_size?: number;
    size_format?: string;
    total_units?: number;
    price_decreased?: boolean;
  };
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
const MERCADONA_API = "https://tienda.mercadona.es/api/categories/";
const MERCADONA_CACHE_MS = 30 * 60 * 1000;
let mercadonaCategoryCache:
  | { expiresAt: number; categories: MercadonaCategory[] }
  | undefined;
const mercadonaProductCache = new Map<
  number,
  { expiresAt: number; products: MercadonaProduct[] }
>();

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizedWords(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !["del", "con", "sin", "para"].includes(word));
}

async function fetchJson(url: string, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "SmartMarket/1.0" },
    });
    if (!response.ok) throw new Error(`El catálogo respondió ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function getMercadonaCategories() {
  if (mercadonaCategoryCache && mercadonaCategoryCache.expiresAt > Date.now())
    return mercadonaCategoryCache.categories;
  const payload = (await fetchJson(MERCADONA_API)) as { results?: MercadonaCategory[] };
  const categories = payload.results ?? [];
  mercadonaCategoryCache = { expiresAt: Date.now() + MERCADONA_CACHE_MS, categories };
  return categories;
}

function collectMercadonaProducts(value: unknown, products: MercadonaProduct[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMercadonaProducts(item, products));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["display_name"] === "string" && record["price_instructions"])
      products.push(record as MercadonaProduct);
    else Object.values(record).forEach((item) => collectMercadonaProducts(item, products));
  }
  return products;
}

async function getMercadonaProducts(categoryId: number) {
  const cached = mercadonaProductCache.get(categoryId);
  if (cached && cached.expiresAt > Date.now()) return cached.products;
  const payload = await fetchJson(`${MERCADONA_API}${categoryId}/`);
  const products = collectMercadonaProducts(payload);
  mercadonaProductCache.set(categoryId, {
    expiresAt: Date.now() + MERCADONA_CACHE_MS,
    products,
  });
  return products;
}

function mercadonaFormat(product: MercadonaProduct) {
  const price = product.price_instructions;
  if (!price) return null;
  const size = price.unit_size;
  const unit = price.size_format;
  const total = price.total_units;
  if (total && total > 1 && size && unit)
    return `${total} uds. · ${String(size).replace(".", ",")} ${unit}`;
  if (size && unit) return `${String(size).replace(".", ",")} ${unit}`;
  if (total) return `${total} uds.`;
  return product.packaging ?? null;
}

async function searchMercadona(query: string) {
  const words = normalizedWords(query);
  const categories = await getMercadonaCategories();
  const searchableCategories = categories.flatMap((category) =>
    (category.categories ?? []).map((subcategory) => ({
      id: subcategory.id,
      label: `${category.name} ${subcategory.name}`,
    })),
  );
  const ranked = searchableCategories
    .map((category) => ({
      category,
      score: words.filter((word) => normalizedWords(category.label).includes(word)).length,
    }))
    .sort((a, b) => b.score - a.score);
  const categoryIds = ranked[0]?.score
    ? ranked.filter((entry) => entry.score === ranked[0]!.score).slice(0, 4).map((entry) => entry.category.id)
    : [];
  if (!categoryIds.length) return [];
  const productGroups = await Promise.all(categoryIds.map((id) => getMercadonaProducts(id)));
  const candidates = productGroups.flat().filter((product) => {
    const nameWords = normalizedWords(product.display_name ?? "");
    return words.length > 0 && words.every((word) => nameWords.some((nameWord) => nameWord.includes(word)));
  });

  return candidates
    .flatMap((product): PublicOffer[] => {
      const instructions = product.price_instructions;
      const price = Number(instructions?.unit_price);
      const comparablePrice = Number(instructions?.reference_price);
      const referenceUnit = instructions?.reference_format?.toLocaleLowerCase("es-ES");
      const comparableUnit = referenceUnit === "kg" || referenceUnit === "l" || referenceUnit === "ud"
        ? referenceUnit
        : null;
      if (!product.display_name || !product.share_url || !Number.isFinite(price) || price <= 0)
        return [];
      return [{
        name: product.display_name,
        supermarket: "Mercadona",
        price,
        url: product.share_url,
        location: "Precio publicado en la tienda online de Mercadona",
        onlinePrice: true,
        comparablePrice:
          Number.isFinite(comparablePrice) && comparablePrice > 0 ? comparablePrice : null,
        comparableUnit,
        format: mercadonaFormat(product),
        promotion: instructions?.price_decreased
          ? `Precio bajado${instructions.previous_unit_price ? ` desde ${instructions.previous_unit_price} €` : ""}`
          : undefined,
      }];
    })
    .sort(
      (a, b) =>
        (a.comparablePrice ?? Number.POSITIVE_INFINITY) -
          (b.comparablePrice ?? Number.POSITIVE_INFINITY) || a.price - b.price,
    )
    .slice(0, 8);
}

function comparablePriceFromName(name: string, price: number) {
  const normalized = name.toLocaleLowerCase("es-ES").replace(/,/g, ".");
  const unitPattern = "kg|kilos?|g|gramos?|l|litros?|ml|mililitros?|cl|centilitros?|uds?|unidades?";
  const multipack = normalized.match(
    new RegExp(`(\\d+)\\s*(?:x|×)\\s*(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})\\b`),
  );
  let packages = 1;
  let amount = 0;
  let rawUnit = "";

  if (multipack) {
    packages = Number(multipack[1]);
    amount = Number(multipack[2]);
    rawUnit = multipack[3] ?? "";
  } else {
    const matches = [
      ...normalized.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})\\b`, "g")),
    ];
    const size = matches.at(-1);
    if (!size) return { comparablePrice: null, comparableUnit: null, format: null } as const;
    amount = Number(size[1]);
    rawUnit = size[2] ?? "";
  }

  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(packages) || packages <= 0)
    return { comparablePrice: null, comparableUnit: null, format: null } as const;

  let baseAmount = amount * packages;
  let comparableUnit: "kg" | "l" | "ud";
  if (/^(g|gramo)/.test(rawUnit)) {
    baseAmount /= 1000;
    comparableUnit = "kg";
  } else if (/^(kg|kilo)/.test(rawUnit)) {
    comparableUnit = "kg";
  } else if (/^(ml|mililitro)/.test(rawUnit)) {
    baseAmount /= 1000;
    comparableUnit = "l";
  } else if (/^(cl|centilitro)/.test(rawUnit)) {
    baseAmount /= 100;
    comparableUnit = "l";
  } else if (/^(l|litro)/.test(rawUnit)) {
    comparableUnit = "l";
  } else {
    comparableUnit = "ud";
  }

  return {
    comparablePrice: price / baseAmount,
    comparableUnit,
    format: multipack
      ? `${packages} × ${String(amount).replace(".", ",")} ${rawUnit}`
      : `${String(amount).replace(".", ",")} ${rawUnit}`,
  };
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
      ...comparablePriceFromName(name, price),
    });
  }

  return offers.sort(
    (a, b) =>
      (a.comparablePrice ?? Number.POSITIVE_INFINITY) -
        (b.comparablePrice ?? Number.POSITIVE_INFINITY) || a.price - b.price,
  );
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
        const [eroskiResult, mercadonaResult] = await Promise.allSettled([
          searchEroski(query),
          searchMercadona(query),
        ]);
        if (eroskiResult.status === "fulfilled") offers.push(...eroskiResult.value);
        else warnings.push("EROSKI no ha respondido en esta consulta.");
        if (mercadonaResult.status === "fulfilled") offers.push(...mercadonaResult.value);
        else warnings.push("Mercadona no ha respondido en esta consulta.");
        offers.sort(
          (a, b) =>
            (a.comparablePrice ?? Number.POSITIVE_INFINITY) -
              (b.comparablePrice ?? Number.POSITIVE_INFINITY) || a.price - b.price,
        );

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
