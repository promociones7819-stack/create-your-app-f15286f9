export type PackageUnit = 'g' | 'kg' | 'ml' | 'l' | 'ud';

export interface Supermarket {
  id?: number;
  name: string;
}

export interface Ticket {
  id?: number;
  supermarketId: number;
  date: string;
  total: number;
  filename?: string;
  fileType?: string;
  fileBlob?: Blob;
  createdAt: string;
}

export interface Product {
  id?: number;
  name: string;
  brand: string;
  genericName: string;
  category: string;
  barcode?: string;
  rating: number;
  notes: string;
}

export interface Purchase {
  id?: number;
  ticketId: number;
  productId: number;
  supermarketId: number;
  date: string;
  rawName: string;
  quantityPurchased: number;
  packageAmount: number;
  packageUnit: PackageUnit;
  price: number;
  discount: number;
  normalizedUnitPrice: number;
  normalizedUnit: 'kg' | 'l' | 'ud';
}

export interface TicketLineDraft {
  id: string;
  productName: string;
  genericName: string;
  brand: string;
  category: string;
  quantityPurchased: number;
  packageAmount: number;
  packageUnit: PackageUnit;
  price: number;
  discount: number;
}
