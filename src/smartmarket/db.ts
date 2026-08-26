import Dexie, { type Table } from 'dexie';
import type { Equivalence, Product, Purchase, Supermarket, Ticket } from './types';

class SmartMarketDB extends Dexie {
  supermarkets!: Table<Supermarket, number>;
  tickets!: Table<Ticket, number>;
  products!: Table<Product, number>;
  purchases!: Table<Purchase, number>;
  equivalences!: Table<Equivalence, number>;

  constructor() {
    super('smartmarket-local-db');
    this.version(1).stores({
      supermarkets: '++id, &name',
      tickets: '++id, supermarketId, date, createdAt',
      products: '++id, name, brand, genericName, category, barcode',
      purchases: '++id, ticketId, productId, supermarketId, date, normalizedUnitPrice',
    });
    this.version(2).stores({
      equivalences: '++id, &rawName, genericName',
    });
  }
}

export const db = new SmartMarketDB();

export const DEFAULT_SUPERMARKETS = [
  'Mercadona',
  'Eroski',
  'Lidl',
  'Aldi',
  'Carrefour',
  'Alcampo',
  'DIA',
  'BM',
  'Consum',
  'Gadis',
  'Makro',
  'Otro',
];

export async function ensureDefaults() {
  if ((await db.supermarkets.count()) === 0) {
    await db.supermarkets.bulkAdd(DEFAULT_SUPERMARKETS.map((name) => ({ name })));
  }
}
