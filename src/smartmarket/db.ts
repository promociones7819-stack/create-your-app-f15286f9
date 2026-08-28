import Dexie, { type Table } from "dexie";
import type {
  Equivalence,
  Product,
  Purchase,
  ShoppingListItem,
  Supermarket,
  Ticket,
} from "./types";

class SmartMarketDB extends Dexie {
  supermarkets!: Table<Supermarket, number>;
  tickets!: Table<Ticket, number>;
  products!: Table<Product, number>;
  purchases!: Table<Purchase, number>;
  equivalences!: Table<Equivalence, number>;
  shoppingList!: Table<ShoppingListItem, number>;

  constructor() {
    super("smartmarket-local-db");
    this.version(1).stores({
      supermarkets: "++id, &name",
      tickets: "++id, supermarketId, date, createdAt",
      products: "++id, name, brand, genericName, category, barcode",
      purchases: "++id, ticketId, productId, supermarketId, date, normalizedUnitPrice",
    });
    this.version(2).stores({
      equivalences: "++id, &rawName, genericName",
    });
    this.version(3).stores({
      supermarkets: "++id, name, locality, [name+locality]",
    });
    this.version(4).stores({
      shoppingList: "++id, productId, checked, createdAt",
    });
  }
}

export const db = new SmartMarketDB();

export const DEFAULT_SUPERMARKETS = [
  "Mercadona",
  "Eroski",
  "Lidl",
  "Aldi",
  "Carrefour",
  "Alcampo",
  "DIA",
  "BM",
  "Consum",
  "Gadis",
  "Lupa",
  "SPAR",
  "Makro",
  "Otro",
];

export const MEDINA_SUPERMARKETS = [
  {
    name: "Mercadona",
    locality: "Medina de Pomar",
    address: "C/ Infanta Leonor, 2",
    website: "https://www.mercadona.es/",
  },
  {
    name: "DIA",
    locality: "Medina de Pomar",
    address: "Ctra. Bilbao, km 24,5",
    website: "https://www.dia.es/tiendas/buscador-tiendas/burgos/medina-de-pomar",
  },
  {
    name: "Lupa",
    locality: "Medina de Pomar",
    address: "C/ Doctor Fleming, 13",
    website: "https://www.lupa.com/",
  },
  {
    name: "Eroski City",
    locality: "Medina de Pomar",
    address: "Avda. Burgos, 11",
    website:
      "https://www.eroski.es/localizador-de-tiendas/supermercado/burgos/medina-de-pomar/eroskicity-medina/",
  },
  {
    name: "Alcampo",
    locality: "Medina de Pomar",
    address: "Avda. Santander, 10–12",
    website: "https://www.compraonline.alcampo.es/content/tiendas",
  },
  {
    name: "SPAR",
    locality: "Medina de Pomar",
    address: "Avda. La Ronda, 2–4",
    website: "https://www.spar.es/",
  },
] as const;

export async function ensureDefaults() {
  const existing = await db.supermarkets.toArray();
  const genericMissing = DEFAULT_SUPERMARKETS.filter(
    (name) => !existing.some((store) => store.name === name && !store.locality),
  ).map((name) => ({ name }));
  const medinaMissing = MEDINA_SUPERMARKETS.filter(
    (candidate) =>
      !existing.some(
        (store) => store.name === candidate.name && store.locality === candidate.locality,
      ),
  ).map(({ name, locality, address }) => ({ name, locality, address }));
  if (genericMissing.length || medinaMissing.length)
    await db.supermarkets.bulkAdd([...genericMissing, ...medinaMissing]);
}
