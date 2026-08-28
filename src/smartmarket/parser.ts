import type { PackageUnit, TicketLineDraft } from "./types";
import { parseNumber, uid } from "./utils";

export interface OcrLineDraft extends TicketLineDraft {
  rawLine: string;
  confidence: "alta" | "media" | "baja";
}

export interface OcrResult {
  supermarket: string | null;
  date: string | null;
  total: number | null;
  lines: OcrLineDraft[];
  rawText: string;
}

/** Reglas por supermercado. Ampliable con formatos concretos de cada cadena. */
export interface StoreRule {
  name: string;
  match: RegExp;
  /** Devuelve una línea si la regla específica de la cadena la reconoce. */
  parseLine?: (line: string) => Partial<OcrLineDraft> | null;
}

export const STORE_RULES: StoreRule[] = [
  { name: "Mercadona", match: /mercadona|hacendado/i },
  { name: "Eroski", match: /eroski/i },
  { name: "Lidl", match: /\blidl\b/i },
  { name: "Aldi", match: /\baldi\b/i },
  { name: "Carrefour", match: /carrefour/i },
  { name: "Alcampo", match: /alcampo|auchan/i },
  { name: "DIA", match: /\bd[ií]a\s*%|supermercados dia|\bdia\b/i },
  { name: "BM", match: /\bbm\b|uvesco/i },
  { name: "Consum", match: /consum/i },
  { name: "Gadis", match: /gadis/i },
  { name: "Makro", match: /makro/i },
];

const UNIT_RE = /(\d+[.,]?\d*)\s*(kg|kilos?|g|gr|gramos|ml|cl|l|litros?|ud|uds|unidades)\b/i;
const MULTI_RE = /(\d+)\s*[x×]\s*(\d+[.,]?\d*)\s*(kg|g|gr|ml|cl|l)\b/i;
const PRICE_RE = /(-?\d+[.,]\d{2})\s*(?:€|eur)?\s*$/i;
const DATE_RE = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/;
const IGNORE_RE =
  /(total|tarjeta|efectivo|cambio|iva|base imponible|cuota|factura|ticket|gracias|cajero|caja|n\.?\s*op|importe|tel[ée]fono|c\.?i\.?f|nif|entrega|devoluci|descuento total|pago)/i;

function normalizeUnit(raw: string): PackageUnit {
  const u = raw.toLowerCase();
  if (u.startsWith("kg") || u.startsWith("kilo")) return "kg";
  if (u === "g" || u === "gr" || u.startsWith("gram")) return "g";
  if (u === "ml") return "ml";
  if (u === "cl") return "ml";
  if (u === "l" || u.startsWith("litr")) return "l";
  return "ud";
}

function cleanName(line: string) {
  return line
    .replace(PRICE_RE, "")
    .replace(/^\s*\d+\s+/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[|*_]+/g, "")
    .trim();
}

/** Nombre genérico provisional: quita marca, formato y palabras de envase. */
export function guessGenericName(name: string, brand: string) {
  let g = name.toLowerCase();
  if (brand) g = g.replace(brand.toLowerCase(), "");
  g = g
    .replace(MULTI_RE, "")
    .replace(UNIT_RE, "")
    .replace(/\b(pack|bolsa|bote|lata|brick|botella|tarrina|bandeja|caja|envase|paquete)\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return g ? g.charAt(0).toUpperCase() + g.slice(1) : name;
}

const KNOWN_BRANDS = [
  "Hacendado",
  "Eroski",
  "Deluxe",
  "Milbona",
  "Carrefour",
  "Auchan",
  "Dia",
  "Central Lechera",
  "Pascual",
  "Danone",
  "Puleva",
  "Calvo",
  "Isabel",
  "Campofrío",
  "Gallo",
  "Bimbo",
  "Nestlé",
  "Coca-Cola",
  "Font Vella",
];

function guessBrand(name: string) {
  const found = KNOWN_BRANDS.find((b) => new RegExp(`\\b${b}\\b`, "i").test(name));
  return found ?? "";
}

export function detectSupermarket(text: string): string | null {
  for (const rule of STORE_RULES) if (rule.match.test(text)) return rule.name;
  return null;
}

export function detectDate(text: string): string | null {
  const m = text.match(DATE_RE);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = Number(y!.length === 2 ? `20${y}` : y);
  const month = String(Number(mo)).padStart(2, "0");
  const day = String(Number(d)).padStart(2, "0");
  if (Number(month) > 12 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

export function detectTotal(text: string): number | null {
  const m = text.match(/total\s*(?:a pagar|compra|importe)?\s*:?\s*(\d+[.,]\d{2})/i);
  return m ? parseNumber(m[1]!) : null;
}

/** Convierte el texto OCR en líneas editables. Todo es corregible después. */
export function parseReceiptText(
  text: string,
  equivalences: Record<string, string> = {},
): OcrResult {
  const store = detectSupermarket(text);
  const rule = STORE_RULES.find((r) => r.name === store);
  const lines: OcrLineDraft[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 4 || IGNORE_RE.test(line)) continue;
    const priceMatch = line.match(PRICE_RE);
    if (!priceMatch) continue;
    const price = parseNumber(priceMatch[1]!);
    if (price <= 0) continue;

    const name = cleanName(line);
    if (!name || name.length < 3) continue;

    let quantityPurchased = 1;
    let packageAmount = 1;
    let packageUnit: PackageUnit = "ud";

    const multi = line.match(MULTI_RE);
    const single = line.match(UNIT_RE);
    if (multi) {
      quantityPurchased = parseNumber(multi[1]!) || 1;
      packageAmount = parseNumber(multi[2]!) || 1;
      packageUnit = normalizeUnit(multi[3]!);
    } else if (single) {
      packageAmount = parseNumber(single[1]!) || 1;
      packageUnit = normalizeUnit(single[2]!);
    }
    if (single && /cl\b/i.test(single[2]!)) packageAmount *= 10;

    const leadingQty = line.match(/^\s*(\d{1,2})\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]/);
    if (leadingQty && !multi) quantityPurchased = Number(leadingQty[1]);

    const brand = guessBrand(name);
    const key = name.toLowerCase();
    const genericName = equivalences[key] ?? guessGenericName(name, brand);

    let draft: OcrLineDraft = {
      id: uid(),
      productName: name,
      genericName,
      brand,
      category: "Alimentación",
      quantityPurchased: quantityPurchased || 1,
      packageAmount: packageAmount || 1,
      packageUnit,
      price,
      discount: 0,
      rawLine: line,
      confidence: multi || single ? "alta" : equivalences[key] ? "alta" : "media",
    };

    const specific = rule?.parseLine?.(line);
    if (specific) draft = { ...draft, ...specific };

    lines.push(draft);
  }

  return {
    supermarket: store,
    date: detectDate(text),
    total: detectTotal(text),
    lines,
    rawText: text,
  };
}
