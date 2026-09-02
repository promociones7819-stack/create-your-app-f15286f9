import type { PackageUnit, Product } from "./types";

export function money(value: number) {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value || 0);
}

export function pct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} %`;
}

export function normalizeUnitPrice(
  price: number,
  discount: number,
  qty: number,
  amount: number,
  unit: PackageUnit,
): { value: number; unit: "kg" | "l" | "ud" } {
  const net = Math.max(0, price - discount);
  const packages = Math.max(0.000001, qty || 1);
  const size = Math.max(0.000001, amount || 1);

  if (unit === "g") return { value: net / ((packages * size) / 1000), unit: "kg" };
  if (unit === "kg") return { value: net / (packages * size), unit: "kg" };
  if (unit === "ml") return { value: net / ((packages * size) / 1000), unit: "l" };
  if (unit === "l") return { value: net / (packages * size), unit: "l" };
  return { value: net / (packages * size), unit: "ud" };
}

export function formatUnitPrice(value: number, unit: string) {
  return `${money(value)}/${unit}`;
}

export function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Date-only observations still have a deterministic order within the same day.
export function newestFirst(a: { date: string; id?: number }, b: { date: string; id?: number }) {
  return b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0);
}

export function equivalenceKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es-ES")
    .replace(/\s+/g, " ");
}

export function canonicalProducts(products: Product[]) {
  const labels = new Map<string, string>();
  return products.map((product) => {
    const label = product.genericName.trim().replace(/\s+/g, " ");
    const key = equivalenceKey(label);
    if (!labels.has(key)) labels.set(key, label);
    return { ...product, genericName: labels.get(key)! };
  });
}

export function productCategory(name: string, category: string) {
  // Repair only broad/unknown categories, never a deliberate specific category.
  if (!["", "alimentacion", "sin categoria", "otros"].includes(equivalenceKey(category)))
    return category;
  if (
    /\b(detergente|suavizante|lavavajillas|desengrasante|lejia|kh\s*-?\s*7)\b/.test(
      equivalenceKey(name),
    )
  )
    return "Limpieza";
  return category || "Otros";
}

export function parseNumber(value: string | number) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function starsLabel(rating: number) {
  return rating ? `${rating}/5` : "Sin valorar";
}
