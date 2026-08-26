import type { PackageUnit } from './types';

export function money(value: number) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value || 0);
}

export function pct(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} %`;
}

export function normalizeUnitPrice(
  price: number,
  discount: number,
  qty: number,
  amount: number,
  unit: PackageUnit,
): { value: number; unit: 'kg' | 'l' | 'ud' } {
  const net = Math.max(0, price - discount);
  const packages = Math.max(0.000001, qty || 1);
  const size = Math.max(0.000001, amount || 1);

  if (unit === 'g') return { value: net / ((packages * size) / 1000), unit: 'kg' };
  if (unit === 'kg') return { value: net / (packages * size), unit: 'kg' };
  if (unit === 'ml') return { value: net / ((packages * size) / 1000), unit: 'l' };
  if (unit === 'l') return { value: net / (packages * size), unit: 'l' };
  return { value: net / (packages * size), unit: 'ud' };
}

export function formatUnitPrice(value: number, unit: string) {
  return `${money(value)}/${unit}`;
}

export function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function parseNumber(value: string | number) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function starsLabel(rating: number) {
  return rating ? `${rating}/5` : 'Sin valorar';
}
