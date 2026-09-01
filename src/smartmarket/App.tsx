import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import type { User } from "@supabase/supabase-js";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Check,
  CircleHelp,
  Database,
  FileDown,
  FileUp,
  FolderOpen,
  Globe2,
  History,
  Home,
  ImagePlus,
  Inbox,
  ListChecks,
  Mail,
  ExternalLink,
  MapPin,
  PackageSearch,
  Pencil,
  Plus,
  ReceiptText,
  Save,
  Scale,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  ShoppingBasket,
  Star,
  Store,
  Trash2,
  ScanText,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { db, ensureDefaults, MEDINA_SUPERMARKETS } from "./db";
import { supabase } from "@/integrations/supabase/client";
import { extractText } from "./ocr";
import { parseReceiptText, type OcrLineDraft, type OcrResult } from "./parser";
import type {
  PackageUnit,
  Product,
  Purchase,
  ShoppingListItem,
  Supermarket,
  Ticket,
  TicketLineDraft,
} from "./types";
import {
  formatUnitPrice,
  money,
  normalizeUnitPrice,
  parseNumber,
  pct,
  todayISO,
  uid,
} from "./utils";

// dexie-react-hooks is intentionally imported as a separate package to keep all persistence local.
// See package.json; Lovable can safely edit this file without requiring a backend.

type View =
  | "dashboard"
  | "products"
  | "public-catalog"
  | "supermarkets"
  | "shopping-list"
  | "compare"
  | "history"
  | "medina"
  | "settings"
  | "info";

type EnrichedPurchase = Purchase & {
  product: Product | undefined;
  supermarket: Supermarket | undefined;
};
type ImportedTicket = Omit<Ticket, "fileBlob"> & { fileBlob?: unknown };
type ImportedProduct = Omit<Product, "photoBlob"> & { photoBlob?: unknown };
type BackupPayload = {
  version: number;
  exportedAt?: string;
  supermarkets: Supermarket[];
  tickets: ImportedTicket[];
  products: ImportedProduct[];
  purchases: Purchase[];
  shoppingList?: ShoppingListItem[];
};

type AutoBackupReason = "startup" | "hourly" | "page-hidden";
type AutoBackupStatus = {
  at: string;
  reason: AutoBackupReason;
  destination: "folder" | "internal";
  folderName?: string;
  warning?: string;
};

type SharedListPayload = {
  kind: "smartmarket-shared-list";
  version: 1;
  exportedAt: string;
  products: ImportedProduct[];
  supermarkets: Supermarket[];
  purchases: Purchase[];
  shoppingList: ShoppingListItem[];
};

type SharedListPreview = {
  data: SharedListPayload;
  matches: Record<number, "exact" | "similar">;
};

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
  promotion?: string;
};
type PublicOffersResponse = {
  query: string;
  checkedAt: string;
  location: string;
  searchArea: {
    center: string;
    radiusKm: number;
    municipalities: string[];
  };
  offers: PublicOffer[];
  warnings: string[];
  sources: { supermarket: string; label: string; url: string }[];
};

type PublicCatalogProduct = {
  id: string;
  owner_id: string;
  source_product_id: number;
  name: string;
  brand: string;
  generic_name: string;
  category: string;
  purchase_url: string | null;
  photo_data_url: string | null;
  rating: number;
  notes: string;
  updated_at: string;
};

type ProductSubmission = {
  id: string;
  batch_id: string;
  source_product_id: number;
  sender_name: string;
  sender_email: string;
  name: string;
  brand: string;
  generic_name: string;
  category: string;
  purchase_url: string | null;
  photo_data_url: string | null;
  rating: number;
  notes: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

const PRODUCT_CATEGORIES = [
  "Frutas y verduras",
  "Carnes y pescados",
  "Charcutería y embutidos",
  "Lácteos y huevos",
  "Panadería",
  "Despensa",
  "Congelados",
  "Bebidas",
  "Dulces y postres",
  "Limpieza",
  "Higiene y cuidado personal",
  "Otros",
] as const;

const PUBLIC_CATALOG_ADMIN_EMAIL = "promociones7819@gmail.com";
const AUTO_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const BACKUP_FOLDER_SETTING = "backup-folder";
const INTERNAL_BACKUP_SETTING = "automatic-backup";
const LAST_BACKUP_STATUS_SETTING = "automatic-backup-status";
const AUTOMATIC_BACKUP_FILENAME = "smartmarket-backup-ultima.json";
let automaticBackupInFlight: Promise<AutoBackupStatus> | null = null;

function purchaseStoreName(value?: string | null) {
  if (!value) return "";
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    if (
      hostname === "amzn.to" ||
      hostname === "link.amazon" ||
      hostname.startsWith("amazon.") ||
      hostname.includes(".amazon.")
    )
      return "Amazon";
    if (hostname.includes("mercadona")) return "Mercadona";
    if (hostname.includes("eroski")) return "Eroski";
    if (hostname.includes("carrefour")) return "Carrefour";
    return hostname.split(".")[0]?.replace(/^./, (letter) => letter.toUpperCase()) || "tienda";
  } catch {
    return "tienda";
  }
}

const emptyLine = (): TicketLineDraft => ({
  id: uid(),
  productName: "",
  genericName: "",
  brand: "",
  category: "Alimentación",
  quantityPurchased: 1,
  packageAmount: 1,
  packageUnit: "ud",
  price: 0,
  discount: 0,
});

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setBootError("");
    setReady(false);

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("La base de datos local no respondió a tiempo.")),
        10_000,
      );
    });

    Promise.race([ensureDefaults(), timeout])
      .then(() => {
        if (active) setReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const detail = error instanceof Error ? error.message : "Error desconocido";
        setBootError(detail);
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [bootAttempt]);

  useEffect(() => {
    if (!ready) return;

    const save = (reason: AutoBackupReason) => {
      void runAutomaticBackup(reason).catch(() => undefined);
    };
    const saveIfDue = async () => {
      const previous = await db.appSettings.get(LAST_BACKUP_STATUS_SETTING);
      const previousStatus = previous?.value as AutoBackupStatus | undefined;
      const previousTime = previousStatus?.at ? Date.parse(previousStatus.at) : 0;
      if (!previousTime || Date.now() - previousTime >= AUTO_BACKUP_INTERVAL_MS)
        save("startup");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") save("page-hidden");
    };
    const onPageHide = () => save("page-hidden");

    void saveIfDue();
    const interval = window.setInterval(() => save("hourly"), AUTO_BACKUP_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [ready]);

  function retryBoot() {
    db.close();
    setBootAttempt((attempt) => attempt + 1);
  }

  if (!ready)
    return (
      <div className={bootError ? "boot boot-error" : "boot"}>
        {bootError ? (
          <>
            <AlertTriangle size={28} />
            <div>
              <strong>Safari no ha podido abrir los datos locales</strong>
              <p>
                Cierra otras pestañas de SmartMarket y vuelve a intentarlo. Tus datos no se
                borrarán.
              </p>
              <small>{bootError}</small>
              <button className="primary" onClick={retryBoot}>
                Reintentar
              </button>
            </div>
          </>
        ) : (
          "Preparando la base de datos local…"
        )}
      </div>
    );

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} />
      <main className={`main-content view-${view}`}>
        <Topbar />
        {view === "dashboard" && <Dashboard onGo={setView} />}
        {view === "products" && <ProductsView />}
        {view === "public-catalog" && <PublicCatalogView />}
        {view === "supermarkets" && <SupermarketsView />}
        {view === "shopping-list" && <ShoppingListView />}
        {view === "compare" && <CompareView />}
        {view === "history" && <HistoryView />}
        {view === "medina" && <MedinaView />}
        {view === "settings" && <SettingsView />}
        {view === "info" && <InfoView onGo={setView} />}
      </main>
    </div>
  );
}

function ModalPortal({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => setContainer(document.body), []);
  return container ? createPortal(children, container) : null;
}

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const items: Array<{ id: View; label: string; icon: typeof Home }> = [
    { id: "dashboard", label: "Inicio", icon: Home },
    { id: "products", label: "Productos", icon: ShoppingBasket },
    { id: "public-catalog", label: "Catálogo público", icon: Globe2 },
    { id: "supermarkets", label: "Supermercados", icon: Store },
    { id: "shopping-list", label: "Lista de la compra", icon: ListChecks },
    { id: "compare", label: "Comparador", icon: Scale },
    { id: "history", label: "Histórico", icon: History },
    { id: "medina", label: "Medina de Pomar", icon: MapPin },
    { id: "settings", label: "Ajustes", icon: Settings },
    { id: "info", label: "Información y ayuda", icon: CircleHelp },
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <ShoppingBasket size={22} />
        </div>
        <div>
          <strong>SmartMarket</strong>
          <span>Local</span>
        </div>
      </div>
      <nav>
        {items.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={view === id ? "nav-item active" : "nav-item"}
            onClick={() => setView(id)}
          >
            <Icon size={19} /> {label}
          </button>
        ))}
      </nav>
      <div className="privacy-card">
        <Database size={18} />
        <div>
          <strong>100 % local</strong>
          <span>Los productos y precios se guardan en este dispositivo.</span>
        </div>
      </div>
    </aside>
  );
}

function Topbar() {
  return (
    <header className="topbar">
      <div>
        <h1>Comparador de supermercado</h1>
        <p>Guarda tus compras, compara formatos y detecta subidas reales.</p>
      </div>
      <span className="local-pill">● Datos locales</span>
    </header>
  );
}

function Dashboard({ onGo }: { onGo: (v: View) => void }) {
  const tickets = useLiveQuery(() => db.tickets.toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchases.toArray(), []) ?? [];
  const supermarkets = useLiveQuery(() => db.supermarkets.toArray(), []) ?? [];

  const thisMonth = todayISO().slice(0, 7);
  const monthSpend = tickets
    .filter((t) => t.date.startsWith(thisMonth))
    .reduce((a, b) => a + b.total, 0);
  const enriched = enrichPurchases(purchases, products, supermarkets);
  const alerts = detectAlerts(enriched);
  const rated = products.filter((p) => p.rating > 0).length;

  return (
    <section className="page">
      <div className="hero-grid">
        <div className="hero-card">
          <div>
            <span className="eyebrow">TU CESTA, CON MEMORIA</span>
            <h2>Descubre dónde te conviene comprar de verdad.</h2>
            <p>
              Compara por €/kg, €/L o unidad, incluso entre marcas distintas, y ten en cuenta tus
              favoritos.
            </p>
          </div>
          <button className="primary" onClick={() => onGo("products")}>
            <Upload size={18} /> Añadir productos y precios
          </button>
        </div>
        <div className="metric-feature">
          <span>Gasto este mes</span>
          <strong>{money(monthSpend)}</strong>
          <small>
            {tickets.filter((t) => t.date.startsWith(thisMonth)).length} compras registradas
          </small>
        </div>
      </div>

      <div className="metrics-grid">
        <Metric icon={ReceiptText} label="Precios" value={String(purchases.length)} />
        <Metric icon={PackageSearch} label="Productos" value={String(products.length)} />
        <Metric icon={Star} label="Valorados" value={String(rated)} />
        <Metric icon={AlertTriangle} label="Alertas" value={String(alerts.length)} />
      </div>

      <div className="content-grid two">
        <div className="panel">
          <div className="panel-title">
            <div>
              <h3>Cambios detectados</h3>
              <p>Comparando tus últimas compras.</p>
            </div>
            <AlertTriangle size={20} />
          </div>
          {alerts.length === 0 ? (
            <Empty text="Todavía no hay suficiente histórico para detectar cambios." />
          ) : (
            <div className="alert-list">
              {alerts.slice(0, 6).map((a) => (
                <div className="alert-row" key={a.key}>
                  <div className={a.kind === "up" ? "trend up" : "trend down"}>
                    {a.kind === "up" ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}
                  </div>
                  <div>
                    <strong>{a.title}</strong>
                    <span>{a.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="panel-title">
            <div>
              <h3>Qué puede hacer ya</h3>
              <p>Primera versión funcional.</p>
            </div>
            <BarChart3 size={20} />
          </div>
          <ul className="feature-list">
            <li>Guardar compras, precios e imagen/PDF original en el dispositivo.</li>
            <li>Editar productos, marcas, formatos, cantidades y descuentos.</li>
            <li>Agrupar marcas diferentes como el mismo producto genérico.</li>
            <li>Comparar automáticamente por €/kg, €/L o unidad.</li>
            <li>Valorar productos con 1–5 estrellas.</li>
            <li>Detectar subida de precio unitario y reducción de envase.</li>
            <li>Leer recibos en imagen o PDF con OCR local y revisión previa.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Home; label: string; value: string }) {
  return (
    <div className="metric">
      <Icon size={20} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function ProductPriceWorkspace() {
  const supermarkets = useLiveQuery(() => db.supermarkets.toArray(), []) ?? [];
  const tickets = useLiveQuery(() => db.tickets.orderBy("date").reverse().toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchases.toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const ticketSpend = tickets.reduce((sum, ticket) => sum + ticket.total, 0);
  const currentMonth = todayISO().slice(0, 7);
  const monthTickets = tickets.filter((ticket) => ticket.date.startsWith(currentMonth));

  const openNew = () => {
    setEditingId(null);
    setShowEditor(true);
  };
  const openEdit = (id: number) => {
    setEditingId(id);
    setShowEditor(true);
  };

  async function removeTicket(ticket: Ticket) {
    if (!ticket.id || !confirm("¿Eliminar esta compra y todos sus precios?")) return;
    await db.transaction("rw", db.tickets, db.purchases, async () => {
      await db.purchases.where("ticketId").equals(ticket.id!).delete();
      await db.tickets.delete(ticket.id!);
    });
  }

  function openOriginal(ticket: Ticket) {
    if (!ticket.fileBlob) return;
    const url = URL.createObjectURL(ticket.fileBlob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return (
    <div className="product-price-workspace">
      <div className="panel product-price-heading">
        <div>
          <span className="eyebrow">PRECIOS Y COMPRAS</span>
          <h3>Registrar productos con todos sus datos</h3>
          <p>
            Añade supermercado, fecha, formato, unidades, precio, descuento, foto y recibo. Todos
            los datos siguen siendo editables.
          </p>
        </div>
        <button className="primary" onClick={openNew}>
          <Plus size={18} /> Añadir productos y precios
        </button>
      </div>

      <div className="metrics-grid ticket-metrics">
        <Metric icon={ReceiptText} label="Compras este mes" value={String(monthTickets.length)} />
        <Metric icon={ShoppingBasket} label="Precios guardados" value={String(purchases.length)} />
        <Metric
          icon={Store}
          label="Supermercados"
          value={String(new Set(tickets.map((ticket) => ticket.supermarketId)).size)}
        />
        <Metric icon={BarChart3} label="Gasto registrado" value={money(ticketSpend)} />
      </div>

      {tickets.length === 0 ? (
        <div className="panel empty-large">
          <ReceiptText size={36} />
          <h3>Aún no has registrado precios</h3>
          <p>Puedes leer un recibo con OCR local o introducir los productos directamente.</p>
          <button className="primary" onClick={openNew}>
            Añadir primeros productos
          </button>
        </div>
      ) : (
        <div className="ticket-grid">
          {tickets.map((ticket) => {
            const market =
              supermarkets.find((s) => s.id === ticket.supermarketId)?.name ?? "Supermercado";
            const count = purchases.filter((p) => p.ticketId === ticket.id).length;
            return (
              <article className="ticket-card" key={ticket.id}>
                <div className="ticket-head">
                  <div className="store-icon">
                    <Store size={20} />
                  </div>
                  <div>
                    <strong>{market}</strong>
                    <span>{new Date(`${ticket.date}T00:00:00`).toLocaleDateString("es-ES")}</span>
                  </div>
                </div>
                <div className="ticket-total">
                  <span>Total</span>
                  <strong>{money(ticket.total)}</strong>
                </div>
                <div className="ticket-meta">
                  <span>{count} productos</span>
                  <span>{ticket.filename || "Sin archivo adjunto"}</span>
                </div>
                <div className="ticket-actions">
                  {ticket.fileBlob && (
                    <button className="ghost" onClick={() => openOriginal(ticket)}>
                      Ver original
                    </button>
                  )}
                  <button className="ghost" onClick={() => openEdit(ticket.id!)}>
                    Editar
                  </button>
                  <button
                    className="icon-btn danger"
                    aria-label="Eliminar compra"
                    onClick={() => removeTicket(ticket)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {showEditor && (
        <TicketEditor
          ticketId={editingId}
          supermarkets={supermarkets}
          products={products}
          purchases={purchases}
          onClose={() => setShowEditor(false)}
        />
      )}
    </div>
  );
}

function TicketEditor({
  ticketId,
  supermarkets,
  products,
  purchases,
  onClose,
}: {
  ticketId: number | null;
  supermarkets: Supermarket[];
  products: Product[];
  purchases: Purchase[];
  onClose: () => void;
}) {
  const existingTicket = useLiveQuery(
    async (): Promise<Ticket | undefined> => (ticketId ? db.tickets.get(ticketId) : undefined),
    [ticketId],
  );
  const [supermarketId, setSupermarketId] = useState<number>(supermarkets[0]?.id ?? 0);
  const [date, setDate] = useState(todayISO());
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<TicketLineDraft[]>([emptyLine()]);
  const [loaded, setLoaded] = useState(ticketId === null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStage, setOcrStage] = useState("");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrReview, setOcrReview] = useState<OcrResult | null>(null);
  const [ocrError, setOcrError] = useState("");

  async function runOcr() {
    if (!file) {
      setOcrError("Selecciona antes la imagen o el PDF del recibo.");
      return;
    }
    setOcrError("");
    setOcrBusy(true);
    setOcrProgress(0);
    setOcrStage("Iniciando OCR local");
    try {
      const eqs = await db.equivalences.toArray();
      const map = Object.fromEntries(eqs.map((e) => [e.rawName, e.genericName]));
      const text = await extractText(file, (stage, progress) => {
        setOcrStage(stage);
        setOcrProgress(progress);
      });
      const parsed = parseReceiptText(text, map);
      setOcrReview(parsed);
      if (parsed.date) setDate(parsed.date);
      if (parsed.supermarket) {
        const match = supermarkets.find(
          (s) => s.name.toLowerCase() === parsed.supermarket!.toLowerCase(),
        );
        if (match?.id) setSupermarketId(match.id);
      }
    } catch (e) {
      setOcrError(`No se pudo leer el recibo en este dispositivo: ${(e as Error).message}`);
    } finally {
      setOcrBusy(false);
    }
  }

  function applyOcrLines(selected: OcrLineDraft[]) {
    setLines((prev) => {
      const base = prev.filter((l) => l.productName.trim());
      const cleaned = selected.map(({ rawLine: _r, confidence: _c, ...rest }) => rest);
      return [...base, ...cleaned];
    });
    setOcrReview(null);
  }

  useEffect(() => {
    if (!ticketId || !existingTicket || loaded) return;
    const sourceLines = purchases
      .filter((p) => p.ticketId === ticketId)
      .map((p) => {
        const product = products.find((x) => x.id === p.productId);
        return {
          id: uid(),
          productName: product?.name ?? p.rawName,
          genericName: product?.genericName ?? product?.name ?? p.rawName,
          brand: product?.brand ?? "",
          category: product?.category ?? "Alimentación",
          quantityPurchased: p.quantityPurchased,
          packageAmount: p.packageAmount,
          packageUnit: p.packageUnit,
          price: p.price,
          discount: p.discount,
          ...(product?.photoBlob
            ? {
                photoName: product.photoName ?? "producto",
                photoType: product.photoType ?? product.photoBlob.type,
                photoBlob: product.photoBlob,
              }
            : {}),
        } satisfies TicketLineDraft;
      });
    setSupermarketId(existingTicket.supermarketId);
    setDate(existingTicket.date);
    setLines(sourceLines.length ? sourceLines : [emptyLine()]);
    setLoaded(true);
  }, [ticketId, existingTicket, loaded, purchases, products]);

  const computedTotal = lines.reduce((sum, l) => sum + Math.max(0, l.price - l.discount), 0);

  function updateLine(id: string, patch: Partial<TicketLineDraft>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  async function save() {
    setError("");
    const candidates = lines.filter(
      (line) =>
        line.productName.trim() ||
        line.genericName.trim() ||
        line.brand.trim() ||
        line.price !== 0 ||
        line.discount !== 0 ||
        line.packageAmount !== 1 ||
        line.quantityPurchased !== 1 ||
        line.photoBlob,
    );
    const invalid = candidates.flatMap((line, index) => {
      const missing: string[] = [];
      if (!line.productName.trim()) missing.push("nombre");
      if (line.price < 0) missing.push("precio");
      if (line.packageAmount <= 0) missing.push("formato");
      if (line.quantityPurchased <= 0) missing.push("unidades");
      return missing.length ? [`Producto ${index + 1}: ${missing.join(", ")}`] : [];
    });
    if (!supermarketId) return setError("Selecciona un supermercado.");
    if (!candidates.length) return setError("Añade al menos un producto con nombre, formato y precio.");
    if (invalid.length) return setError(`No se ha guardado nada. Revisa ${invalid.join(" · ")}.`);

    setSaving(true);
    try {
      await db.transaction("rw", db.tickets, db.products, db.purchases, db.equivalences, async () => {
      let currentId = ticketId;
      if (currentId) {
        const old = await db.tickets.get(currentId);
        await db.tickets.update(currentId, {
          supermarketId,
          date,
          total: computedTotal,
          ...(file
            ? { filename: file.name, fileType: file.type, fileBlob: file }
            : old
              ? { filename: old.filename, fileType: old.fileType, fileBlob: old.fileBlob }
              : {}),
        });
        await db.purchases.where("ticketId").equals(currentId).delete();
      } else {
        currentId = await db.tickets.add({
          supermarketId,
          date,
          total: computedTotal,
          createdAt: new Date().toISOString(),
          ...(file ? { filename: file.name, fileType: file.type, fileBlob: file } : {}),
        });
      }

      for (const line of candidates) {
        const name = line.productName.trim();
        const brand = line.brand.trim();
        const genericName = line.genericName.trim() || name;
        let product = await db.products
          .filter(
            (p) =>
              p.name.toLowerCase() === name.toLowerCase() &&
              p.brand.toLowerCase() === brand.toLowerCase(),
          )
          .first();
        if (!product) {
          const productId = await db.products.add({
            name,
            brand,
            genericName,
            category: line.category.trim() || "Sin categoría",
            rating: 0,
            notes: "",
            ...(line.photoBlob
              ? { photoName: line.photoName, photoType: line.photoType, photoBlob: line.photoBlob }
              : {}),
          });
          product = await db.products.get(productId);
        } else if (
          product.genericName !== genericName ||
          product.category !== line.category ||
          line.photoBlob
        ) {
          const updates = {
            genericName,
            category: line.category.trim() || "Sin categoría",
            ...(line.photoBlob
              ? { photoName: line.photoName, photoType: line.photoType, photoBlob: line.photoBlob }
              : {}),
          };
          await db.products.update(product.id!, updates);
          product = { ...product, ...updates };
        }
        const rawKey = line.productName.trim().toLowerCase();
        const existingEq = await db.equivalences.where("rawName").equals(rawKey).first();
        if (existingEq?.id)
          await db.equivalences.update(existingEq.id, { genericName, brand, productName: name });
        else await db.equivalences.add({ rawName: rawKey, genericName, brand, productName: name });

        const normalized = normalizeUnitPrice(
          line.price,
          line.discount,
          line.quantityPurchased,
          line.packageAmount,
          line.packageUnit,
        );
        await db.purchases.add({
          ticketId: currentId!,
          productId: product!.id!,
          supermarketId,
          date,
          rawName: name,
          quantityPurchased: line.quantityPurchased,
          packageAmount: line.packageAmount,
          packageUnit: line.packageUnit,
          price: line.price,
          discount: line.discount,
          normalizedUnitPrice: normalized.value,
          normalizedUnit: normalized.unit,
        });
      }
      });
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? `No se pudieron guardar los productos: ${saveError.message}`
          : "No se pudieron guardar los productos. Inténtalo de nuevo.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalPortal>
      <div className="modal-backdrop" role="presentation">
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label={ticketId ? "Editar compra" : "Añadir productos y precios"}
        >
        <div className="modal-head">
          <div>
            <span className="eyebrow">{ticketId ? "EDITAR COMPRA" : "NUEVO REGISTRO"}</span>
            <h2>{ticketId ? "Editar productos y precios" : "Añadir productos y precios"}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="form-grid three">
          <label>
            Supermercado
            <select
              value={supermarketId}
              onChange={(e) => setSupermarketId(Number(e.target.value))}
            >
              {supermarkets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.locality ? ` · ${s.locality}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Recibo (imagen/PDF)
            <input
              type="file"
              accept="image/*,.pdf,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        <div className="ocr-note">
          <ScanText size={17} />
          <div className="ocr-note-body">
            <div>
              <strong>OCR 100 % local</strong>
              <span>
                La imagen o el PDF nunca salen de este dispositivo: el reconocimiento se ejecuta en
                tu navegador. Revisarás cada línea antes de guardar.
              </span>
              {ocrBusy && (
                <span className="ocr-progress">
                  {ocrStage} · {Math.round(ocrProgress * 100)} %
                </span>
              )}
              {ocrError && <span className="error">{ocrError}</span>}
            </div>
            <button className="primary" type="button" onClick={runOcr} disabled={ocrBusy}>
              <Wand2 size={17} /> {ocrBusy ? "Leyendo…" : "Leer recibo con OCR"}
            </button>
          </div>
        </div>
        {ocrReview && (
          <OcrReview
            result={ocrReview}
            onCancel={() => setOcrReview(null)}
            onApply={applyOcrLines}
          />
        )}
        <div className="line-table-wrap">
          <table className="line-table">
            <thead>
              <tr>
                <th>Foto</th>
                <th>Producto</th>
                <th>Producto genérico</th>
                <th>Marca</th>
                <th>Formato</th>
                <th>Uds.</th>
                <th>Precio</th>
                <th>Dto.</th>
                <th>Precio comparable</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <label className="product-photo-picker" title="Subir foto del producto">
                      {line.photoBlob ? (
                        <ProductPhoto blob={line.photoBlob} alt={line.productName || "Producto"} />
                      ) : (
                        <ImagePlus size={18} />
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        aria-label={`${line.photoBlob ? "Cambiar" : "Añadir"} imagen de ${line.productName || "producto"}`}
                        onChange={async (e) => {
                          const photo = e.target.files?.[0];
                          if (!photo) return;
                          if (photo.size > 8 * 1024 * 1024) {
                            setError("La foto del producto no puede superar 8 MB.");
                            e.target.value = "";
                            return;
                          }
                          try {
                            const optimized = await optimizeProductPhoto(photo);
                            setError("");
                            updateLine(line.id, optimized);
                          } catch {
                            setError(
                              "No se pudo preparar la imagen. Prueba con una foto JPG, PNG o WebP.",
                            );
                          } finally {
                            e.target.value = "";
                          }
                        }}
                      />
                    </label>
                  </td>
                  <td>
                    <input
                      value={line.productName}
                      onChange={(e) => updateLine(line.id, { productName: e.target.value })}
                      placeholder="Atún Hacendado"
                    />
                  </td>
                  <td>
                    <input
                      value={line.genericName}
                      onChange={(e) => updateLine(line.id, { genericName: e.target.value })}
                      placeholder="Atún en aceite de oliva"
                    />
                  </td>
                  <td>
                    <input
                      value={line.brand}
                      onChange={(e) => updateLine(line.id, { brand: e.target.value })}
                      placeholder="Hacendado"
                    />
                  </td>
                  <td>
                    <div className="format-input">
                      <input
                        type="number"
                        min="0.001"
                        step="0.001"
                        value={line.packageAmount}
                        onChange={(e) =>
                          updateLine(line.id, { packageAmount: parseNumber(e.target.value) })
                        }
                      />
                      <select
                        value={line.packageUnit}
                        onChange={(e) =>
                          updateLine(line.id, { packageUnit: e.target.value as PackageUnit })
                        }
                      >
                        <option value="g">g</option>
                        <option value="kg">kg</option>
                        <option value="ml">ml</option>
                        <option value="l">L</option>
                        <option value="ud">ud</option>
                      </select>
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0.01"
                      step="1"
                      value={line.quantityPurchased}
                      onChange={(e) =>
                        updateLine(line.id, { quantityPurchased: parseNumber(e.target.value) })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.price}
                      onChange={(e) => updateLine(line.id, { price: parseNumber(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.discount}
                      onChange={(e) =>
                        updateLine(line.id, { discount: parseNumber(e.target.value) })
                      }
                    />
                  </td>
                  <td>
                    <span className="calculated-unit-price">{formatDraftUnitPrice(line)}</span>
                  </td>
                  <td>
                    <button
                      className="icon-btn danger"
                      onClick={() => setLines((p) => p.filter((x) => x.id !== line.id))}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="ghost add-line" onClick={() => setLines((p) => [...p, emptyLine()])}>
          <Plus size={17} /> Añadir producto
        </button>
        <div className="modal-footer">
          <div>
            <span>Total calculado</span>
            <strong>{money(computedTotal)}</strong>
          </div>
          <div>
            {error && <span className="error">{error}</span>}
            <button className="ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="primary" onClick={save} disabled={saving}>
              <Save size={17} /> {saving ? "Guardando…" : "Guardar productos y precios"}
            </button>
          </div>
        </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function OcrReview({
  result,
  onCancel,
  onApply,
}: {
  result: OcrResult;
  onCancel: () => void;
  onApply: (lines: OcrLineDraft[]) => void;
}) {
  const [draft, setDraft] = useState<OcrLineDraft[]>(result.lines);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [showText, setShowText] = useState(false);

  function update(id: string, patch: Partial<OcrLineDraft>) {
    setDraft((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  const selected = draft.filter((l) => !skipped[l.id] && l.productName.trim());

  return (
    <div className="ocr-review">
      <div className="ocr-review-head">
        <div>
          <span className="eyebrow">REVISIÓN OCR</span>
          <h3>{draft.length} líneas detectadas</h3>
          <p>
            {result.supermarket
              ? `Supermercado: ${result.supermarket}`
              : "Supermercado no detectado"}{" "}
            · {result.date ? `Fecha: ${result.date}` : "Fecha no detectada"} ·{" "}
            {result.total !== null
              ? `Total del recibo: ${money(result.total)}`
              : "Total no detectado"}
          </p>
        </div>
        <button className="ghost" type="button" onClick={() => setShowText((v) => !v)}>
          {showText ? "Ocultar texto" : "Ver texto reconocido"}
        </button>
      </div>

      {showText && <pre className="ocr-raw">{result.rawText}</pre>}

      {draft.length === 0 ? (
        <Empty text="No se han reconocido líneas con precio. Puedes añadirlas manualmente en la tabla inferior." />
      ) : (
        <div className="line-table-wrap">
          <table className="line-table">
            <thead>
              <tr>
                <th>Usar</th>
                <th>Nombre en recibo</th>
                <th>Nombre normalizado</th>
                <th>Producto genérico</th>
                <th>Marca</th>
                <th>Formato</th>
                <th>Uds.</th>
                <th>Precio</th>
                <th>Dto.</th>
                <th>Precio comparable</th>
                <th>Fiab.</th>
              </tr>
            </thead>
            <tbody>
              {draft.map((line) => (
                <tr key={line.id} className={skipped[line.id] ? "skipped" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      checked={!skipped[line.id]}
                      onChange={(e) => setSkipped((p) => ({ ...p, [line.id]: !e.target.checked }))}
                    />
                  </td>
                  <td className="raw-cell">{line.rawLine}</td>
                  <td>
                    <input
                      value={line.productName}
                      onChange={(e) => update(line.id, { productName: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={line.genericName}
                      onChange={(e) => update(line.id, { genericName: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={line.brand}
                      onChange={(e) => update(line.id, { brand: e.target.value })}
                    />
                  </td>
                  <td>
                    <div className="format-input">
                      <input
                        type="number"
                        step="0.001"
                        value={line.packageAmount}
                        onChange={(e) =>
                          update(line.id, { packageAmount: parseNumber(e.target.value) })
                        }
                      />
                      <select
                        value={line.packageUnit}
                        onChange={(e) =>
                          update(line.id, { packageUnit: e.target.value as PackageUnit })
                        }
                      >
                        <option value="g">g</option>
                        <option value="kg">kg</option>
                        <option value="ml">ml</option>
                        <option value="l">L</option>
                        <option value="ud">ud</option>
                      </select>
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      step="1"
                      value={line.quantityPurchased}
                      onChange={(e) =>
                        update(line.id, { quantityPurchased: parseNumber(e.target.value) })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      value={line.price}
                      onChange={(e) => update(line.id, { price: parseNumber(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      value={line.discount}
                      onChange={(e) => update(line.id, { discount: parseNumber(e.target.value) })}
                    />
                  </td>
                  <td>
                    <span className="calculated-unit-price">{formatDraftUnitPrice(line)}</span>
                  </td>
                  <td>
                    <span className={`conf ${line.confidence}`}>{line.confidence}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="ocr-review-actions">
        <span>
          Tus correcciones se guardan como equivalencias locales y se reutilizarán en próximos
          recibos.
        </span>
        <div>
          <button className="ghost" type="button" onClick={onCancel}>
            Descartar
          </button>
          <button
            className="primary"
            type="button"
            disabled={!selected.length}
            onClick={() => onApply(selected)}
          >
            <Save size={17} /> Añadir {selected.length} productos
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductsView() {
  const productRecords = useLiveQuery(() => db.products.orderBy("genericName").toArray(), []);
  const purchaseRecords = useLiveQuery(() => db.purchases.toArray(), []);
  const supermarketRecords = useLiveQuery(() => db.supermarkets.toArray(), []);
  const products = useMemo(() => productRecords ?? [], [productRecords]);
  const purchases = useMemo(() => purchaseRecords ?? [], [purchaseRecords]);
  const supermarkets = useMemo(() => supermarketRecords ?? [], [supermarketRecords]);
  const [catalogUser, setCatalogUser] = useState<User | null>(null);
  const [query, setQuery] = useState("");
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [newGenericName, setNewGenericName] = useState("");
  const [newCategory, setNewCategory] = useState<string>(PRODUCT_CATEGORIES[5]);
  const [newPurchaseUrl, setNewPurchaseUrl] = useState("");
  const [productError, setProductError] = useState("");
  const [editingOffersProduct, setEditingOffersProduct] = useState<Product | null>(null);
  const [catalogSyncStatus, setCatalogSyncStatus] = useState("");
  const lastCatalogSyncSignature = useRef("");
  const isCatalogAdmin =
    catalogUser?.email?.toLocaleLowerCase("es-ES") === PUBLIC_CATALOG_ADMIN_EMAIL;
  const catalogSignature = useMemo(
    () =>
      JSON.stringify(
        products.map((product) => ({
          id: product.id,
          name: product.name,
          brand: product.brand,
          genericName: product.genericName,
          category: product.category,
          purchaseUrl: product.purchaseUrl,
          rating: product.rating,
          notes: product.notes,
          photoSize: product.photoBlob?.size ?? 0,
          photoType: product.photoBlob?.type ?? "",
        })),
      ),
    [products],
  );
  const filtered = products.filter((p) =>
    `${p.name} ${p.brand} ${p.genericName}`.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setCatalogUser(data.user));
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      setCatalogUser(session?.user ?? null),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!isCatalogAdmin || !catalogUser?.id || !products.some((product) => product.id)) return;
    if (catalogSignature === lastCatalogSyncSignature.current) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (active) setCatalogSyncStatus("Sincronizando productos con el catálogo público…");
      void publishProductsToPublicCatalog(products, catalogUser.id).then((result) => {
        if (result.error) {
          if (active) setCatalogSyncStatus(result.error);
          return;
        }
        lastCatalogSyncSignature.current = catalogSignature;
        if (active)
          setCatalogSyncStatus(
            `Catálogo público actualizado automáticamente · ${result.count} productos.`,
          );
      });
    }, 500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [catalogSignature, catalogUser?.id, isCatalogAdmin, products]);

  async function setRating(product: Product, rating: number) {
    if (product.id) await db.products.update(product.id, { rating });
  }
  async function updateGenericName(product: Product, value: string) {
    if (product.id) await db.products.update(product.id, { genericName: value });
  }
  async function updateProductIdentity(
    product: Product,
    field: "name" | "brand",
    value: string,
  ) {
    if (!product.id) return;
    const clean = value.trim();
    if (field === "name" && !clean) {
      alert("El nombre del producto no puede quedar vacío.");
      return;
    }
    await db.products.update(product.id, { [field]: clean });
  }
  async function updateCategory(product: Product, category: string) {
    if (product.id) await db.products.update(product.id, { category });
  }
  function cleanPurchaseUrl(value: string) {
    const clean = value.trim();
    if (!clean) return "";
    return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
  }
  function isValidPurchaseUrl(value: string) {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }
  async function updatePurchaseUrl(product: Product, value: string) {
    if (!isCatalogAdmin) return;
    if (!product.id) return;
    const purchaseUrl = cleanPurchaseUrl(value);
    if (!isValidPurchaseUrl(purchaseUrl)) {
      alert("El enlace no es válido. Debe ser una dirección web como https://link.amazon/…");
      return;
    }
    await db.products.update(product.id, { purchaseUrl });
  }
  async function createProduct() {
    setProductError("");
    if (!isCatalogAdmin)
      return setProductError("Solo el administrador puede crear productos manuales.");
    const name = newName.trim();
    const brand = newBrand.trim();
    const genericName = newGenericName.trim() || name;
    const purchaseUrl = cleanPurchaseUrl(newPurchaseUrl);
    if (!name) return setProductError("Escribe el nombre del producto.");
    if (!isValidPurchaseUrl(purchaseUrl))
      return setProductError("El enlace no es válido. Usa una dirección que empiece por https://");
    const duplicate = products.some(
      (product) =>
        comparableText(product.name) === comparableText(name) &&
        comparableText(product.brand) === comparableText(brand),
    );
    if (duplicate) return setProductError("Ese producto y marca ya están guardados.");
    try {
      await db.products.add({
        name,
        brand,
        genericName,
        category: newCategory,
        rating: 0,
        notes: "",
        ...(purchaseUrl ? { purchaseUrl } : {}),
      });
      setNewName("");
      setNewBrand("");
      setNewGenericName("");
      setNewCategory(PRODUCT_CATEGORIES[5]);
      setNewPurchaseUrl("");
      setShowNewProduct(false);
    } catch (createError) {
      setProductError(
        createError instanceof Error
          ? `No se pudo guardar el producto: ${createError.message}`
          : "No se pudo guardar el producto.",
      );
    }
  }
  async function updatePhoto(product: Product, photo?: File) {
    if (!product.id) return;
    if (!photo) {
      await db.products.update(product.id, (stored) => {
        delete stored.photoName;
        delete stored.photoType;
        delete stored.photoBlob;
      });
      return;
    }
    if (photo.size > 8 * 1024 * 1024) return alert("La foto del producto no puede superar 8 MB.");
    try {
      await db.products.update(product.id, await optimizeProductPhoto(photo));
    } catch {
      alert("No se pudo preparar la imagen. Prueba con una foto JPG, PNG o WebP.");
    }
  }
  async function deleteProduct(product: Product) {
    if (!product.id || purchases.some((p) => p.productId === product.id))
      return alert(
        "Este producto tiene precios asociados. Edita o elimina primero sus compras registradas.",
      );
    if (isCatalogAdmin && catalogUser?.id) {
      const { error } = await supabase
        .from("public_products")
        .delete()
        .eq("owner_id", catalogUser.id)
        .eq("source_product_id", product.id);
      if (error) return alert(`No se pudo retirar del catálogo público: ${error.message}`);
    }
    await db.products.delete(product.id);
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CATÁLOGO PERSONAL</span>
          <h2>Productos y precios</h2>
          <p>
            Registra cada compra y consulta en un solo lugar el producto, su formato, precio y
            supermercado. “Producto genérico” permite comparar marcas diferentes.
          </p>
        </div>
        <div className="product-heading-actions">
          <input
            className="search"
            placeholder="Buscar producto…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {isCatalogAdmin && (
            <button
              className="primary"
              type="button"
              onClick={() => setShowNewProduct((open) => !open)}
            >
              <Plus size={17} /> {showNewProduct ? "Cerrar" : "Nuevo producto manual"}
            </button>
          )}
        </div>
      </div>
      {isCatalogAdmin && catalogSyncStatus && (
        <div className="catalog-status auto-catalog-status">{catalogSyncStatus}</div>
      )}
      <ProductPriceWorkspace />
      {isCatalogAdmin && showNewProduct && (
        <div className="panel new-product-panel">
          <div>
            <span className="eyebrow">ALTA MANUAL</span>
            <h3>Añadir producto recomendado</h3>
            <p>
              Pega el enlace de afiliado al crear el producto. Podrás cambiar todos estos datos
              más adelante.
            </p>
          </div>
          <div className="form-grid product-create-grid">
            <label>
              Nombre *
              <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Cápsulas de café avellana" />
            </label>
            <label>
              Marca
              <input value={newBrand} onChange={(event) => setNewBrand(event.target.value)} placeholder="by Amazon" />
            </label>
            <label>
              Producto genérico
              <input value={newGenericName} onChange={(event) => setNewGenericName(event.target.value)} placeholder="Cápsulas de café" />
            </label>
            <label>
              Categoría
              <select value={newCategory} onChange={(event) => setNewCategory(event.target.value)}>
                {PRODUCT_CATEGORIES.map((category) => <option key={category}>{category}</option>)}
              </select>
            </label>
            <label className="product-url-field">
              Enlace de afiliado o compra
              <input
                type="url"
                value={newPurchaseUrl}
                onChange={(event) => setNewPurchaseUrl(event.target.value)}
                placeholder="https://amzn.to/…"
              />
              <small>Si es de Amazon, aparecerá automáticamente como recomendado en Amazon.</small>
            </label>
          </div>
          <div className="new-product-footer">
            <span className="error">{productError}</span>
            <button className="primary" type="button" onClick={() => void createProduct()}>
              <Save size={17} /> Guardar producto
            </button>
          </div>
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="panel">
          <Empty
            text={
              isCatalogAdmin
                ? "Crea un producto recomendado o registra una compra para construir tu catálogo."
                : "Registra una compra o incorpora productos del catálogo público para construir tu catálogo."
            }
          />
        </div>
      ) : (
        <div className="product-list">
          {filtered.map((product) => {
            const pp = purchases
              .filter((p) => p.productId === product.id)
              .sort((a, b) => b.date.localeCompare(a.date));
            const latest = pp[0];
            const latestByMarket = Array.from(
              pp.reduce((offers, purchase) => {
                if (!offers.has(purchase.supermarketId)) offers.set(purchase.supermarketId, purchase);
                return offers;
              }, new Map<number, Purchase>()),
            );
            return (
              <article className="product-row" key={product.id}>
                <div className="product-main">
                  <div className="product-photo-actions">
                    <label
                      className="product-icon product-photo-edit"
                      title={product.photoBlob ? "Cambiar imagen" : "Añadir imagen"}
                    >
                      {product.photoBlob ? (
                        <ProductPhoto blob={product.photoBlob} alt={product.name} />
                      ) : (
                        <>
                          <ShoppingBasket size={19} />
                          <span>
                            <ImagePlus size={14} />
                          </span>
                        </>
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        aria-label={`${product.photoBlob ? "Cambiar" : "Añadir"} imagen de ${product.name}`}
                        onChange={(e) => {
                          const photo = e.target.files?.[0];
                          if (photo) void updatePhoto(product, photo);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {product.photoBlob && (
                      <button
                        className="remove-photo"
                        aria-label={`Quitar imagen de ${product.name}`}
                        title="Quitar imagen"
                        onClick={() => void updatePhoto(product)}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                  <div className="product-identity-fields">
                    <label className="inline-field">
                      Producto
                      <input
                        key={`${product.id}-name-${product.name}`}
                        defaultValue={product.name}
                        onBlur={(event) =>
                          void updateProductIdentity(product, "name", event.target.value)
                        }
                      />
                    </label>
                    <label className="inline-field">
                      Marca
                      <input
                        key={`${product.id}-brand-${product.brand}`}
                        defaultValue={product.brand}
                        placeholder="Sin marca"
                        onBlur={(event) =>
                          void updateProductIdentity(product, "brand", event.target.value)
                        }
                      />
                    </label>
                    {product.purchaseUrl && (
                      <span className="recommendation-badge">
                        Recomendado en {purchaseStoreName(product.purchaseUrl)}
                      </span>
                    )}
                  </div>
                </div>
                <label className="inline-field">
                  Equivalente a
                  <input
                    value={product.genericName}
                    onChange={(e) => updateGenericName(product, e.target.value)}
                  />
                </label>
                <label className="inline-field">
                  Categoría
                  <select
                    value={product.category}
                    onChange={(e) => void updateCategory(product, e.target.value)}
                  >
                    {!PRODUCT_CATEGORIES.includes(
                      product.category as (typeof PRODUCT_CATEGORIES)[number],
                    ) && <option value={product.category}>{product.category}</option>}
                    {PRODUCT_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="rating" aria-label={`Valoración ${product.rating} de 5`}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      aria-label={`${n} estrellas`}
                      onClick={() => setRating(product, n)}
                      className={n <= product.rating ? "star active" : "star"}
                    >
                      <Star size={19} fill={n <= product.rating ? "currentColor" : "none"} />
                    </button>
                  ))}
                </div>
                <div className="latest-price product-offer-summary">
                  <span>{latestByMarket.length ? `${latestByMarket.length} supermercados` : "Sin precios"}</span>
                  {latestByMarket.slice(0, 3).map(([supermarketId, offer]) => (
                    <small key={supermarketId}>
                      <b>{supermarkets.find((store) => store.id === supermarketId)?.name ?? "Supermercado"}</b>{" "}
                      {money(Math.max(0, offer.price - offer.discount))} · {offer.packageAmount} {offer.packageUnit}
                    </small>
                  ))}
                  {latestByMarket.length > 3 && <small>+ {latestByMarket.length - 3} más</small>}
                  <button className="ghost compact" type="button" onClick={() => setEditingOffersProduct(product)}>
                    <Pencil size={14} /> Editar precios y formatos
                  </button>
                </div>
                <div className="product-purchase-link">
                  {isCatalogAdmin && (
                    <label className="inline-field">
                      Enlace de afiliado o compra
                      <input
                        type="url"
                        defaultValue={product.purchaseUrl ?? ""}
                        key={`${product.id}-${product.purchaseUrl ?? ""}`}
                        placeholder="Pegar enlace…"
                        onBlur={(event) => void updatePurchaseUrl(product, event.target.value)}
                      />
                      <small>Se guarda al salir del campo.</small>
                    </label>
                  )}
                  {product.purchaseUrl && (
                    <a
                      className="buy-link"
                      href={product.purchaseUrl}
                      target="_blank"
                      rel="noopener noreferrer sponsored"
                      aria-label={`Comprar ${product.name} en la tienda externa`}
                    >
                      Comprar <ExternalLink size={14} />
                    </a>
                  )}
                </div>
                <button className="icon-btn danger" onClick={() => deleteProduct(product)}>
                  <Trash2 size={16} />
                </button>
                <ProductPriceEditor
                  product={product}
                  latest={latest}
                  supermarkets={supermarkets}
                />
              </article>
            );
          })}
        </div>
      )}
      <p className="affiliate-note">
        {isCatalogAdmin
          ? "Como administrador puedes crear productos manuales y editar sus enlaces de afiliado."
          : "Los productos manuales y sus enlaces de compra solo puede gestionarlos el administrador."}
      </p>
      {editingOffersProduct && (
        <ProductOffersEditor
          product={editingOffersProduct}
          supermarkets={supermarkets}
          purchases={purchases}
          onClose={() => setEditingOffersProduct(null)}
        />
      )}
    </section>
  );
}

type ProductOfferDraft = {
  key: string;
  purchaseId?: number;
  supermarketId: number;
  price: number;
  packageAmount: number;
  packageUnit: PackageUnit;
  quantityPurchased: number;
  date: string;
  removed?: boolean;
};

function ProductOffersEditor({
  product,
  supermarkets,
  purchases,
  onClose,
}: {
  product: Product;
  supermarkets: Supermarket[];
  purchases: Purchase[];
  onClose: () => void;
}) {
  const latestOffers = Array.from(
    purchases
      .filter((purchase) => purchase.productId === product.id)
      .sort((a, b) => b.date.localeCompare(a.date))
      .reduce((offers, purchase) => {
        if (!offers.has(purchase.supermarketId)) offers.set(purchase.supermarketId, purchase);
        return offers;
      }, new Map<number, Purchase>())
      .values(),
  );
  const [rows, setRows] = useState<ProductOfferDraft[]>(() =>
    latestOffers.map((offer) => ({
      key: uid(),
      ...(offer.id ? { purchaseId: offer.id } : {}),
      supermarketId: offer.supermarketId,
      price: offer.price,
      packageAmount: offer.packageAmount,
      packageUnit: offer.packageUnit,
      quantityPurchased: offer.quantityPurchased,
      date: offer.date,
    })),
  );
  const [error, setError] = useState("");

  function addStore() {
    const used = new Set(rows.filter((row) => !row.removed).map((row) => row.supermarketId));
    const supermarket = supermarkets.find((store) => store.id && !used.has(store.id));
    if (!supermarket?.id) return setError("Ya has añadido todos los supermercados disponibles.");
    setRows((current) => [
      ...current,
      {
        key: uid(),
        supermarketId: supermarket.id!,
        price: 0,
        packageAmount: 1,
        packageUnit: "ud",
        quantityPurchased: 1,
        date: todayISO(),
      },
    ]);
  }

  function updateRow(key: string, patch: Partial<ProductOfferDraft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function saveOffers() {
    if (!product.id) return;
    setError("");
    const active = rows.filter((row) => !row.removed);
    if (active.some((row) => !row.supermarketId || row.price < 0 || row.packageAmount <= 0 || row.quantityPurchased <= 0))
      return setError("Revisa el supermercado, el precio y el formato de cada fila.");
    if (new Set(active.map((row) => row.supermarketId)).size !== active.length)
      return setError("Cada supermercado solo puede aparecer una vez por producto.");

    await db.transaction("rw", db.tickets, db.purchases, async () => {
      const affectedTickets = new Set<number>();
      for (const row of rows) {
        if (row.removed) {
          if (row.purchaseId) {
            const stored = await db.purchases.get(row.purchaseId);
            if (stored) affectedTickets.add(stored.ticketId);
            await db.purchases.delete(row.purchaseId);
          }
          continue;
        }
        const normalized = normalizeUnitPrice(
          row.price,
          0,
          row.quantityPurchased,
          row.packageAmount,
          row.packageUnit,
        );
        if (row.purchaseId) {
          const stored = await db.purchases.get(row.purchaseId);
          if (stored) affectedTickets.add(stored.ticketId);
          await db.purchases.update(row.purchaseId, {
            supermarketId: row.supermarketId,
            date: row.date,
            price: row.price,
            discount: 0,
            quantityPurchased: row.quantityPurchased,
            packageAmount: row.packageAmount,
            packageUnit: row.packageUnit,
            normalizedUnitPrice: normalized.value,
            normalizedUnit: normalized.unit,
          });
        } else {
          const ticketId = await db.tickets.add({
            supermarketId: row.supermarketId,
            date: row.date,
            total: row.price,
            createdAt: new Date().toISOString(),
          });
          affectedTickets.add(ticketId);
          await db.purchases.add({
            ticketId,
            productId: product.id!,
            supermarketId: row.supermarketId,
            date: row.date,
            rawName: product.name,
            quantityPurchased: row.quantityPurchased,
            packageAmount: row.packageAmount,
            packageUnit: row.packageUnit,
            price: row.price,
            discount: 0,
            normalizedUnitPrice: normalized.value,
            normalizedUnit: normalized.unit,
          });
        }
      }
      for (const ticketId of affectedTickets) {
        const remaining = await db.purchases.where("ticketId").equals(ticketId).toArray();
        if (!remaining.length) await db.tickets.delete(ticketId);
        else
          await db.tickets.update(ticketId, {
            total: remaining.reduce((sum, purchase) => sum + Math.max(0, purchase.price - purchase.discount), 0),
          });
      }
    });
    onClose();
  }

  return (
    <ModalPortal>
      <div className="modal-backdrop" role="presentation">
        <div className="modal product-offers-modal" role="dialog" aria-modal="true" aria-label={`Editar precios de ${product.name}`}>
          <div className="modal-head">
            <div>
              <span className="eyebrow">UN PRODUCTO, VARIOS SUPERMERCADOS</span>
              <h2>{product.name}</h2>
              <p>Cada supermercado conserva su propio precio y formato sin duplicar el producto.</p>
            </div>
            <button className="icon-btn" type="button" onClick={onClose}><X size={20} /></button>
          </div>
          <div className="offer-editor-list">
            {rows.filter((row) => !row.removed).map((row) => (
              <div className="offer-editor-row" key={row.key}>
                <label>Supermercado
                  <select disabled={Boolean(row.purchaseId)} value={row.supermarketId} onChange={(event) => updateRow(row.key, { supermarketId: Number(event.target.value) })}>
                    {supermarkets.map((store) => <option key={store.id} value={store.id}>{store.name}{store.locality ? ` · ${store.locality}` : ""}</option>)}
                  </select>
                </label>
                <label>Precio total
                  <input type="number" min="0" step="0.01" value={row.price} onChange={(event) => updateRow(row.key, { price: parseNumber(event.target.value) })} />
                </label>
                <label>Cantidad
                  <input type="number" min="0.01" step="0.01" value={row.packageAmount} onChange={(event) => updateRow(row.key, { packageAmount: parseNumber(event.target.value) })} />
                </label>
                <label>Formato
                  <select value={row.packageUnit} onChange={(event) => updateRow(row.key, { packageUnit: event.target.value as PackageUnit })}>
                    <option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="l">l</option><option value="ud">ud</option>
                  </select>
                </label>
                <label>Unidades
                  <input type="number" min="1" step="1" value={row.quantityPurchased} onChange={(event) => updateRow(row.key, { quantityPurchased: parseNumber(event.target.value) })} />
                </label>
                <label>Fecha
                  <input type="date" value={row.date} onChange={(event) => updateRow(row.key, { date: event.target.value })} />
                </label>
                <button className="icon-btn danger" type="button" title="Eliminar precio de este supermercado" onClick={() => updateRow(row.key, { removed: true })}><Trash2 size={16} /></button>
              </div>
            ))}
            {!rows.some((row) => !row.removed) && <Empty text="Añade un supermercado para registrar su precio." />}
          </div>
          <button className="ghost add-offer-button" type="button" onClick={addStore}><Plus size={16} /> Añadir otro supermercado</button>
          <div className="modal-footer">
            <span className="error">{error}</span>
            <div><button className="ghost" type="button" onClick={onClose}>Cancelar</button><button className="primary" type="button" onClick={() => void saveOffers()}><Save size={17} /> Guardar cambios</button></div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function ProductPriceEditor({
  product,
  latest,
  supermarkets,
}: {
  product: Product;
  latest?: Purchase;
  supermarkets: Supermarket[];
}) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(0);
  const [date, setDate] = useState(todayISO());
  const [supermarketId, setSupermarketId] = useState(0);
  const [packageAmount, setPackageAmount] = useState(1);
  const [packageUnit, setPackageUnit] = useState<PackageUnit>("ud");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  function openEditor() {
    setPrice(latest ? Math.max(0, latest.price - latest.discount) : 0);
    setDate(todayISO());
    setSupermarketId(latest?.supermarketId ?? supermarkets[0]?.id ?? 0);
    setPackageAmount(latest?.packageAmount ?? 1);
    setPackageUnit(latest?.packageUnit ?? "ud");
    setStatus("");
    setOpen(true);
  }

  async function saveHistoricalPrice() {
    if (!product.id) return;
    if (!supermarketId) return setStatus("Selecciona un supermercado.");
    if (!date) return setStatus("Selecciona la fecha del precio.");
    if (price < 0) return setStatus("El precio no puede ser negativo.");
    if (packageAmount <= 0) return setStatus("El formato debe ser mayor que cero.");

    setSaving(true);
    setStatus("");
    try {
      const normalized = normalizeUnitPrice(price, 0, 1, packageAmount, packageUnit);
      await db.transaction("rw", db.tickets, db.purchases, async () => {
        const ticketId = await db.tickets.add({
          supermarketId,
          date,
          total: price,
          filename: "Actualización manual de precio",
          fileType: "text/plain",
          createdAt: new Date().toISOString(),
        });
        await db.purchases.add({
          ticketId,
          productId: product.id!,
          supermarketId,
          date,
          rawName: product.name,
          quantityPurchased: 1,
          packageAmount,
          packageUnit,
          price,
          discount: 0,
          normalizedUnitPrice: normalized.value,
          normalizedUnit: normalized.unit,
        });
      });
      setOpen(false);
      setStatus(
        `Precio del ${new Date(`${date}T00:00:00`).toLocaleDateString("es-ES")} añadido al histórico.`,
      );
    } catch (priceError) {
      setStatus(
        priceError instanceof Error
          ? `No se pudo guardar el precio: ${priceError.message}`
          : "No se pudo guardar el precio.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={open ? "price-history-editor open" : "price-history-editor"}>
      <div className="price-history-editor-head">
        <div>
          <strong>Evolución del precio</strong>
          <span>Añade un precio con su fecha. Los anteriores se conservan para mostrar la evolución.</span>
        </div>
        <button
          className={open ? "ghost" : "primary"}
          type="button"
          onClick={() => (open ? setOpen(false) : openEditor())}
        >
          {open ? <X size={16} /> : <History size={16} />}
          {open ? "Cerrar" : "Actualizar precio"}
        </button>
      </div>
      {open && (
        <div className="price-history-form">
          <label>
            Precio del envase
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(event) => setPrice(parseNumber(event.target.value))}
            />
          </label>
          <label>
            Fecha
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            Supermercado
            <select
              value={supermarketId}
              onChange={(event) => setSupermarketId(Number(event.target.value))}
            >
              <option value={0}>Seleccionar…</option>
              {supermarkets.map((supermarket) => (
                <option key={supermarket.id} value={supermarket.id}>
                  {supermarket.name}{supermarket.locality ? ` · ${supermarket.locality}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Formato
            <div className="format-input">
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={packageAmount}
                onChange={(event) => setPackageAmount(parseNumber(event.target.value))}
              />
              <select
                value={packageUnit}
                onChange={(event) => setPackageUnit(event.target.value as PackageUnit)}
              >
                <option value="g">g</option>
                <option value="kg">kg</option>
                <option value="ml">ml</option>
                <option value="l">L</option>
                <option value="ud">ud</option>
              </select>
            </div>
          </label>
          <div className="price-history-save">
            <span className={status ? "error" : ""}>{status}</span>
            <button
              className="primary"
              type="button"
              disabled={saving}
              onClick={() => void saveHistoricalPrice()}
            >
              <Save size={16} /> {saving ? "Guardando…" : "Añadir al histórico"}
            </button>
          </div>
        </div>
      )}
      {!open && status && <span className="price-history-success">{status}</span>}
    </div>
  );
}

function ProductPhoto({ blob, alt }: { blob: Blob; alt: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="product-photo" src={url} alt={alt} />;
}

function importedPhotoFields(
  dataUrl: string | null | undefined,
  name: string,
): Pick<Product, "photoName" | "photoType" | "photoBlob"> | undefined {
  if (!dataUrl?.startsWith("data:image/")) return undefined;
  try {
    const photoBlob = dataUrlToBlob(dataUrl);
    return {
      photoName: `${name || "producto"}.webp`,
      photoType: photoBlob.type,
      photoBlob,
    };
  } catch {
    return undefined;
  }
}

async function publicPhotoDataUrl(product: Product) {
  if (!product.photoBlob) return null;
  const value = await blobToDataUrl(product.photoBlob);
  return value.length <= 700_000 ? value : null;
}

function missingPublicPhotoColumn(error: { message?: string }) {
  return error.message?.includes("photo_data_url") ?? false;
}

async function publishProductsToPublicCatalog(products: Product[], userId: string) {
  const publishable = products.filter(
    (product): product is Product & { id: number } => Boolean(product.id),
  );
  if (!publishable.length) return { count: 0 };
  const rows = await Promise.all(
    publishable.map(async (product) => ({
      owner_id: userId,
      source_product_id: product.id,
      name: product.name,
      brand: product.brand,
      generic_name: product.genericName,
      category: product.category,
      purchase_url: product.purchaseUrl || null,
      photo_data_url: await publicPhotoDataUrl(product),
      rating: product.rating,
      notes: product.notes,
    })),
  );
  const { error } = await supabase
    .from("public_products")
    .upsert(rows, { onConflict: "owner_id,source_product_id" });
  if (!error) return { count: rows.length };
  return {
    count: 0,
    error: missingPublicPhotoColumn(error)
      ? "No se pudo sincronizar: falta activar el campo de imágenes del catálogo en Supabase."
      : `No se pudo sincronizar el catálogo público: ${error.message}`,
  };
}

function publicProductForMatching(product: PublicCatalogProduct): ImportedProduct {
  return {
    name: product.name,
    brand: product.brand,
    genericName: product.generic_name,
    category: product.category,
    rating: product.rating,
    notes: product.notes,
    purchaseUrl: product.purchase_url ?? undefined,
    ...importedPhotoFields(product.photo_data_url, product.name),
  };
}

function submissionForMatching(product: ProductSubmission): ImportedProduct {
  return {
    name: product.name,
    brand: product.brand,
    genericName: product.generic_name,
    category: product.category,
    rating: product.rating,
    notes: product.notes,
    purchaseUrl: product.purchase_url ?? undefined,
    ...importedPhotoFields(product.photo_data_url, product.name),
  };
}

function PublicCatalogView() {
  const localProductRecords = useLiveQuery(() => db.products.toArray(), []);
  const localProducts = useMemo(() => localProductRecords ?? [], [localProductRecords]);
  const [products, setProducts] = useState<PublicCatalogProduct[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [submissions, setSubmissions] = useState<ProductSubmission[]>([]);
  const [showSubmissionForm, setShowSubmissionForm] = useState(false);
  const [selectedForSubmission, setSelectedForSubmission] = useState<number[]>([]);
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [submittingProducts, setSubmittingProducts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const isCatalogAdmin = user?.email?.toLocaleLowerCase("es-ES") === PUBLIC_CATALOG_ADMIN_EMAIL;

  async function loadPublicProducts() {
    setLoading(true);
    const { data, error } = await supabase
      .from("public_products")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) setStatus(`No se pudo abrir el catálogo: ${error.message}`);
    else setProducts((data ?? []) as PublicCatalogProduct[]);
    setLoading(false);
  }

  async function loadSubmissions() {
    const { data, error } = await supabase
      .from("product_submissions")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205")
        setStatus("La bandeja de productos enviados necesita activarse una sola vez en Supabase.");
      else setStatus(`No se pudieron cargar los envíos: ${error.message}`);
      setSubmissions([]);
    } else setSubmissions((data ?? []) as ProductSubmission[]);
  }

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setUser(data.user));
    void loadPublicProducts();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (isCatalogAdmin) void loadSubmissions();
    else setSubmissions([]);
  }, [isCatalogAdmin]);

  const matches = useMemo(() => {
    const result: Record<string, "exact" | "similar"> = {};
    products.forEach((product) => {
      const incoming = publicProductForMatching(product);
      if (localProducts.some((local) => productsMatchExactly(local, incoming)))
        result[product.id] = "exact";
      else if (localProducts.some((local) => productsLookSimilar(local, incoming)))
        result[product.id] = "similar";
    });
    return result;
  }, [localProducts, products]);

  useEffect(() => {
    setSelected(products.flatMap((product) => (matches[product.id] ? [] : [product.id])));
  }, [products, matches]);

  const filtered = products.filter((product) =>
    `${product.name} ${product.brand} ${product.generic_name} ${product.category}`
      .toLocaleLowerCase("es-ES")
      .includes(query.toLocaleLowerCase("es-ES")),
  );

  const localPublicationMatches = useMemo(() => {
    const result: Record<number, "exact" | "similar"> = {};
    localProducts.forEach((local) => {
      if (!local.id) return;
      if (products.some((product) => productsMatchExactly(local, publicProductForMatching(product))))
        result[local.id] = "exact";
      else if (products.some((product) => productsLookSimilar(local, publicProductForMatching(product))))
        result[local.id] = "similar";
    });
    return result;
  }, [localProducts, products]);

  const submissionMatches = useMemo(() => {
    const result: Record<string, "exact" | "similar"> = {};
    submissions.forEach((submission) => {
      const incoming = submissionForMatching(submission);
      const exactPublic = products.some((product) =>
        productsMatchExactly(publicProductForMatching(product), incoming),
      );
      const exactLocal = localProducts.some((product) => productsMatchExactly(product, incoming));
      if (exactPublic || exactLocal) result[submission.id] = "exact";
      else {
        const similarPublic = products.some((product) =>
          productsLookSimilar(publicProductForMatching(product), incoming),
        );
        const similarLocal = localProducts.some((product) => productsLookSimilar(product, incoming));
        if (similarPublic || similarLocal) result[submission.id] = "similar";
      }
    });
    return result;
  }, [localProducts, products, submissions]);

  function openSubmissionForm() {
    setSelectedForSubmission(
      localProducts.flatMap((product) =>
        product.id && !localPublicationMatches[product.id] ? [product.id] : [],
      ),
    );
    setShowSubmissionForm(true);
    setStatus("");
  }

  function toggleSubmissionProduct(productId: number) {
    setSelectedForSubmission((current) =>
      current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId],
    );
  }

  async function sendProductsForReview() {
    const chosen = localProducts.filter(
      (product): product is Product & { id: number } =>
        Boolean(product.id && selectedForSubmission.includes(product.id)),
    );
    if (!chosen.length) return setStatus("Selecciona al menos un producto para enviarlo.");
    if (chosen.length > 25)
      return setStatus("Puedes enviar un máximo de 25 productos cada vez.");
    const cleanEmail = senderEmail.trim();
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
      return setStatus("Revisa el correo de contacto o déjalo vacío.");

    setSubmittingProducts(true);
    const batchId = crypto.randomUUID();
    const rows = await Promise.all(
      chosen.map(async (product) => ({
        batch_id: batchId,
        source_product_id: product.id,
        sender_name: senderName.trim().slice(0, 100),
        sender_email: cleanEmail.slice(0, 180),
        name: product.name.slice(0, 180),
        brand: product.brand.slice(0, 180),
        generic_name: product.genericName.slice(0, 180),
        category: product.category.slice(0, 100),
        purchase_url: product.purchaseUrl || null,
        photo_data_url: await publicPhotoDataUrl(product),
        rating: product.rating,
        notes: product.notes.slice(0, 1000),
      })),
    );
    const { error } = await supabase.from("product_submissions").insert(rows);
    setSubmittingProducts(false);
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205")
        setStatus("La bandeja de envíos todavía no está activada por el administrador.");
      else if (missingPublicPhotoColumn(error))
        setStatus("Falta activar el campo de imágenes del catálogo en Supabase.");
      else setStatus(`No se pudieron enviar los productos: ${error.message}`);
      return;
    }
    setShowSubmissionForm(false);
    setSelectedForSubmission([]);
    setStatus(`${rows.length} productos enviados. El administrador los revisará antes de publicarlos.`);
  }

  async function resolveSubmission(
    submission: ProductSubmission,
    decision: "approved" | "rejected",
  ) {
    if (!user || !isCatalogAdmin) return;
    if (decision === "rejected") {
      if (!confirm(`¿Rechazar la propuesta “${submission.name}”?`)) return;
    } else if (
      submissionMatches[submission.id] === "similar" &&
      !confirm(`“${submission.name}” parece similar a un producto existente. ¿Publicarlo igualmente?`)
    )
      return;

    const incoming = submissionForMatching(submission);
    const alreadyPublic = products.some((product) =>
      productsMatchExactly(publicProductForMatching(product), incoming),
    );
    if (decision === "approved" && !alreadyPublic) {
      const exactLocal = localProducts.find((product) => productsMatchExactly(product, incoming));
      const submissionPhoto = importedPhotoFields(submission.photo_data_url, incoming.name);
      const productId =
        exactLocal?.id ??
        (await db.products.add({
          name: incoming.name,
          brand: incoming.brand,
          genericName: incoming.genericName || incoming.name,
          category: incoming.category || "Otros",
          rating: incoming.rating,
          notes: incoming.notes,
          purchaseUrl: incoming.purchaseUrl,
          ...submissionPhoto,
        }));
      const photoDataUrl = exactLocal
        ? await publicPhotoDataUrl(exactLocal)
        : submission.photo_data_url;
      const { error: publishError } = await supabase.from("public_products").upsert(
        {
          owner_id: user.id,
          source_product_id: productId,
          name: incoming.name,
          brand: incoming.brand,
          generic_name: incoming.genericName,
          category: incoming.category,
          purchase_url: incoming.purchaseUrl || null,
          photo_data_url: photoDataUrl || null,
          rating: incoming.rating,
          notes: incoming.notes,
        },
        { onConflict: "owner_id,source_product_id" },
      );
      if (publishError)
        return setStatus(
          missingPublicPhotoColumn(publishError)
            ? "Falta activar el campo de imágenes del catálogo en Supabase."
            : `No se pudo aprobar: ${publishError.message}`,
        );
    }

    const { error } = await supabase
      .from("product_submissions")
      .update({
        status: decision,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id,
      })
      .eq("id", submission.id);
    if (error) return setStatus(`No se pudo completar la revisión: ${error.message}`);
    setStatus(
      decision === "approved"
        ? `“${submission.name}” ha sido aprobado y ya aparece en el catálogo.`
        : `“${submission.name}” ha sido rechazado.`,
    );
    await Promise.all([loadPublicProducts(), loadSubmissions()]);
  }

  async function signIn() {
    setStatus("");
    if (!email.trim() || password.length < 6)
      return setStatus("Escribe tu correo y una contraseña de al menos 6 caracteres.");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setStatus(error ? error.message : "Sesión iniciada. Ya puedes publicar tus productos.");
  }

  async function signUp() {
    setStatus("");
    if (!email.trim() || password.length < 6)
      return setStatus("Escribe tu correo y una contraseña de al menos 6 caracteres.");
    const { error } = await supabase.auth.signUp({ email: email.trim(), password });
    setStatus(
      error
        ? error.message
        : "Cuenta creada. Si Supabase te envía un correo, confírmalo antes de iniciar sesión.",
    );
  }

  async function publishAll() {
    if (!user) return setStatus("Inicia sesión como administrador para publicar productos.");
    if (!isCatalogAdmin) return setStatus("Esta cuenta no tiene permiso para publicar productos.");
    const result = await publishProductsToPublicCatalog(localProducts, user.id);
    if (result.error) return setStatus(result.error);
    if (!result.count) return setStatus("No tienes productos locales para publicar.");
    setStatus(`${result.count} productos publicados o actualizados.`);
    await loadPublicProducts();
  }

  async function importSelected() {
    const chosen = products.filter((product) => selected.includes(product.id));
    if (!chosen.length) return;
    let added = 0;
    let skipped = 0;
    const knownProducts = [...localProducts];
    for (const product of chosen) {
      const incoming = publicProductForMatching(product);
      if (knownProducts.some((local) => productsMatchExactly(local, incoming))) {
        skipped += 1;
        continue;
      }
      const newProduct: Product = {
        name: product.name,
        brand: product.brand,
        genericName: product.generic_name || product.name,
        category: product.category || "Otros",
        rating: product.rating,
        notes: product.notes,
        purchaseUrl: product.purchase_url ?? undefined,
        ...importedPhotoFields(product.photo_data_url, product.name),
      };
      const id = await db.products.add(newProduct);
      knownProducts.push({ ...newProduct, id });
      added += 1;
    }
    setStatus(`${added} productos añadidos a tu catálogo${skipped ? `; ${skipped} repetidos omitidos` : ""}.`);
    setSelected([]);
  }

  async function removePublished(product: PublicCatalogProduct) {
    if (!user || product.owner_id !== user.id) return;
    if (!confirm(`¿Retirar “${product.name}” del catálogo público?`)) return;
    const { error } = await supabase.from("public_products").delete().eq("id", product.id);
    if (error) setStatus(error.message);
    else await loadPublicProducts();
  }

  return (
    <section className="page public-catalog-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">COMPARTIDO EN LA NUBE</span>
          <h2>Catálogo público</h2>
          <p>Productos visibles para cualquiera que abra SmartMarket. Tus compras siguen siendo privadas.</p>
        </div>
        <input
          className="search"
          placeholder="Buscar en el catálogo…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="panel public-account-panel">
        {user ? (
          <>
            <div>
              <strong>{isCatalogAdmin ? `Administrador: ${user.email}` : `Sesión: ${user.email}`}</strong>
              <span>
                {isCatalogAdmin
                  ? "Solo esta cuenta puede publicar, actualizar o retirar productos."
                  : "Esta cuenta puede consultar e incorporar productos, pero no publicarlos."}
              </span>
            </div>
            <div className="public-account-actions">
              {isCatalogAdmin && (
                <button className="primary" type="button" onClick={() => void publishAll()}>
                  <Globe2 size={17} /> Publicar todos mis productos
                </button>
              )}
              <button className="ghost" type="button" onClick={() => void supabase.auth.signOut()}>
                Cerrar sesión
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              <strong>Acceso del administrador</strong>
              <span>Para mirar o incorporar productos no necesitas iniciar sesión.</span>
            </div>
            <div className="public-login-fields">
              <input type="email" placeholder="Correo" value={email} onChange={(event) => setEmail(event.target.value)} />
              <input type="password" placeholder="Contraseña" value={password} onChange={(event) => setPassword(event.target.value)} />
              <button className="primary" type="button" onClick={() => void signIn()}>Entrar</button>
              <button className="ghost" type="button" onClick={() => void signUp()}>Crear cuenta de administrador</button>
            </div>
          </>
        )}
      </div>

      {status && <div className="catalog-status">{status}</div>}

      {!isCatalogAdmin && (
        <div className="panel contribution-panel">
          <div className="contribution-heading">
            <div className="contribution-icon"><Send size={21} /></div>
            <div>
              <strong>Comparte tus productos con la comunidad</strong>
              <span>
                Elige productos de tu catálogo y envíalos al administrador. No se comparten
                compras, listas ni precios privados.
              </span>
            </div>
          </div>
          {!showSubmissionForm ? (
            <button
              className="primary"
              type="button"
              disabled={!localProducts.length}
              onClick={openSubmissionForm}
            >
              <Send size={16} /> Enviar productos para revisión
            </button>
          ) : (
            <div className="contribution-form">
              <div className="contribution-contact-fields">
                <label>
                  Tu nombre (opcional)
                  <input
                    value={senderName}
                    maxLength={100}
                    onChange={(event) => setSenderName(event.target.value)}
                    placeholder="Nombre"
                  />
                </label>
                <label>
                  Tu correo (opcional)
                  <input
                    type="email"
                    value={senderEmail}
                    maxLength={180}
                    onChange={(event) => setSenderEmail(event.target.value)}
                    placeholder="correo@ejemplo.com"
                  />
                </label>
              </div>
              <div className="contribution-selection-head">
                <strong>{selectedForSubmission.length} seleccionados</strong>
                <button
                  className="text-button"
                  type="button"
                  onClick={() =>
                    setSelectedForSubmission(
                      localProducts.flatMap((product) =>
                        product.id && !localPublicationMatches[product.id] ? [product.id] : [],
                      ),
                    )
                  }
                >
                  Seleccionar no publicados
                </button>
              </div>
              <div className="contribution-product-list">
                {localProducts.map((product) => {
                  if (!product.id) return null;
                  const match = localPublicationMatches[product.id];
                  return (
                    <label
                      className={
                        selectedForSubmission.includes(product.id)
                          ? "contribution-product selected"
                          : "contribution-product"
                      }
                      key={product.id}
                    >
                      <input
                        type="checkbox"
                        checked={selectedForSubmission.includes(product.id)}
                        disabled={match === "exact"}
                        onChange={() => toggleSubmissionProduct(product.id!)}
                      />
                      <span>
                        <strong>{product.name}</strong>
                        <small>{product.brand || "Sin marca"} · {product.category}</small>
                      </span>
                      {match === "exact" ? (
                        <em>YA PUBLICADO</em>
                      ) : match === "similar" ? (
                        <em className="similar">SIMILAR</em>
                      ) : (
                        <em className="new">NUEVO</em>
                      )}
                    </label>
                  );
                })}
              </div>
              <div className="contribution-actions">
                <button className="ghost" type="button" onClick={() => setShowSubmissionForm(false)}>
                  Cancelar
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={!selectedForSubmission.length || submittingProducts}
                  onClick={() => void sendProductsForReview()}
                >
                  <Send size={16} />
                  {submittingProducts ? "Enviando…" : "Enviar al administrador"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {isCatalogAdmin && (
        <div className="panel moderation-panel">
          <div className="moderation-heading">
            <div>
              <span className="eyebrow">BANDEJA DEL ADMINISTRADOR</span>
              <h3><Inbox size={20} /> Productos pendientes de validar</h3>
            </div>
            <strong>{submissions.length}</strong>
          </div>
          {submissions.length === 0 ? (
            <p className="moderation-empty">No hay propuestas pendientes.</p>
          ) : (
            <div className="moderation-list">
              {submissions.map((submission) => {
                const match = submissionMatches[submission.id];
                const sender = submission.sender_name || submission.sender_email || "Usuario anónimo";
                return (
                  <article className="moderation-product" key={submission.id}>
                    {submission.photo_data_url && (
                      <img
                        className="moderation-product-photo"
                        src={submission.photo_data_url}
                        alt={submission.name}
                      />
                    )}
                    <div className="moderation-product-main">
                      <span className="eyebrow">{submission.category}</span>
                      <strong>{submission.name}</strong>
                      <small>
                        {submission.brand || "Sin marca"} · Enviado por {sender} · {new Date(submission.created_at).toLocaleDateString("es-ES")}
                      </small>
                    </div>
                    <div className="moderation-product-flags">
                      {match === "exact" ? (
                        <em>POSIBLE DUPLICADO</em>
                      ) : match === "similar" ? (
                        <em className="similar">PRODUCTO SIMILAR</em>
                      ) : (
                        <em className="new">NUEVO</em>
                      )}
                      {submission.purchase_url && (
                        <a href={submission.purchase_url} target="_blank" rel="noopener noreferrer sponsored">
                          Revisar enlace <ExternalLink size={13} />
                        </a>
                      )}
                    </div>
                    <div className="moderation-actions">
                      <button className="ghost danger" type="button" onClick={() => void resolveSubmission(submission, "rejected")}>
                        <X size={15} /> Rechazar
                      </button>
                      <button className="primary" type="button" onClick={() => void resolveSubmission(submission, "approved")}>
                        <Check size={15} /> Aprobar y publicar
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="public-catalog-tools">
        <span>{filtered.length} productos · {selected.length} seleccionados</span>
        <div>
          <button className="ghost" type="button" onClick={() => setSelected(filtered.flatMap((product) => (matches[product.id] ? [] : [product.id])))}>
            Seleccionar nuevos
          </button>
          <button className="primary" type="button" disabled={!selected.length} onClick={() => void importSelected()}>
            <Plus size={17} /> Añadir seleccionados
          </button>
        </div>
      </div>

      {loading ? (
        <div className="panel"><Empty text="Cargando el catálogo público…" /></div>
      ) : filtered.length === 0 ? (
        <div className="panel"><Empty text="Todavía no hay productos públicos que coincidan." /></div>
      ) : (
        <div className="public-product-grid">
          {filtered.map((product) => {
            const match = matches[product.id];
            const checked = selected.includes(product.id);
            return (
              <article className={checked ? "public-product-card selected" : "public-product-card"} key={product.id}>
                <label className="public-product-select">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setSelected((current) => current.includes(product.id) ? current.filter((id) => id !== product.id) : [...current, product.id])}
                  />
                  {match === "exact" ? <em>Ya lo tienes</em> : match === "similar" ? <em className="similar">Producto similar</em> : <em className="new">Nuevo</em>}
                </label>
                {product.photo_data_url && (
                  <img
                    className="public-product-photo"
                    src={product.photo_data_url}
                    alt={product.name}
                  />
                )}
                <div>
                  <span className="eyebrow">{product.category}</span>
                  {product.purchase_url && (
                    <span className="recommendation-badge public-recommendation-badge">
                      Recomendado en {purchaseStoreName(product.purchase_url)}
                    </span>
                  )}
                  <h3>{product.name}</h3>
                  <p>{product.brand || "Sin marca"} · Equivale a {product.generic_name || product.name}</p>
                </div>
                <div className="public-product-actions">
                  {product.purchase_url && (
                    <a className="buy-link" href={product.purchase_url} target="_blank" rel="noopener noreferrer sponsored">
                      Ver en {purchaseStoreName(product.purchase_url)} <ExternalLink size={14} />
                    </a>
                  )}
                  {isCatalogAdmin && user?.id === product.owner_id && (
                    <button className="icon-btn danger" type="button" title="Retirar del catálogo" onClick={() => void removePublished(product)}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="affiliate-support-note" role="note">
        <strong>Gracias por apoyar SmartMarket</strong>
        <span>
          Esta página se mantiene gracias a las compras que realizas desde nuestros enlaces de
          Amazon. El precio para ti no cambia. Gracias por tu colaboración.
        </span>
      </div>
      <p className="affiliate-note">Los enlaces de compra abren tiendas externas y algunos pueden ser enlaces de afiliado.</p>
    </section>
  );
}

function SupermarketsView() {
  const productRecords = useLiveQuery(() => db.products.toArray(), []);
  const purchaseRecords = useLiveQuery(() => db.purchases.toArray(), []);
  const supermarketRecords = useLiveQuery(() => db.supermarkets.toArray(), []);
  const products = useMemo(() => productRecords ?? [], [productRecords]);
  const purchases = useMemo(() => purchaseRecords ?? [], [purchaseRecords]);
  const supermarkets = useMemo(() => supermarketRecords ?? [], [supermarketRecords]);
  const storesWithPurchases = new Set(purchases.map((purchase) => purchase.supermarketId)).size;
  const [editingId, setEditingId] = useState<number>();
  const [name, setName] = useState("");
  const [locality, setLocality] = useState("");
  const [address, setAddress] = useState("");
  const [storeError, setStoreError] = useState("");

  function clearStoreForm() {
    setEditingId(undefined);
    setName("");
    setLocality("");
    setAddress("");
    setStoreError("");
  }

  function editStore(supermarket: Supermarket) {
    setEditingId(supermarket.id);
    setName(supermarket.name);
    setLocality(supermarket.locality ?? "");
    setAddress(supermarket.address ?? "");
    setStoreError("");
  }

  async function saveStore() {
    const cleanName = name.trim();
    const cleanLocality = locality.trim();
    const cleanAddress = address.trim();
    if (!cleanName) return setStoreError("Escribe el nombre del supermercado.");
    const duplicate = supermarkets.some(
      (store) =>
        store.id !== editingId &&
        store.name.trim().toLocaleLowerCase("es-ES") ===
          cleanName.toLocaleLowerCase("es-ES") &&
        (store.locality ?? "").trim().toLocaleLowerCase("es-ES") ===
          cleanLocality.toLocaleLowerCase("es-ES"),
    );
    if (duplicate) return setStoreError("Ese supermercado y localidad ya están guardados.");

    const record: Omit<Supermarket, "id"> = {
      name: cleanName,
      ...(cleanLocality ? { locality: cleanLocality } : {}),
      ...(cleanAddress ? { address: cleanAddress } : {}),
    };
    if (editingId) await db.supermarkets.update(editingId, record);
    else await db.supermarkets.add(record);
    clearStoreForm();
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">TUS TIENDAS</span>
          <h2>Supermercados y productos comprados</h2>
          <p>
            Consulta todos los productos distintos registrados en cada supermercado y su último
            precio conocido.
          </p>
        </div>
        <div className="directory-count">
          <Store size={19} />
          <strong>{storesWithPurchases}</strong>
          <span>con compras</span>
        </div>
      </div>
      <div className="panel supermarket-manager">
        <div className="panel-title">
          <div>
            <h3>{editingId ? "Editar supermercado" : "Añadir supermercado"}</h3>
            <p>Crea cada establecimiento con su localidad para identificar mejor tus compras.</p>
          </div>
          <Store size={20} />
        </div>
        <div className="supermarket-form">
          <label>
            Nombre
            <input
              value={name}
              placeholder="Ej. BM Urban"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Localidad
            <input
              value={locality}
              placeholder="Ej. Getxo"
              onChange={(event) => setLocality(event.target.value)}
            />
          </label>
          <label>
            Dirección (opcional)
            <input
              value={address}
              placeholder="Calle y número"
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <button className="primary" type="button" onClick={() => void saveStore()}>
            <Save size={17} /> {editingId ? "Guardar cambios" : "Añadir"}
          </button>
          {editingId && (
            <button className="ghost" type="button" onClick={clearStoreForm}>
              <X size={17} /> Cancelar
            </button>
          )}
        </div>
        {storeError && <p className="form-error">{storeError}</p>}
        <div className="supermarket-admin-list">
          {supermarkets
            .slice()
            .sort(
              (a, b) =>
                a.name.localeCompare(b.name, "es") ||
                (a.locality ?? "").localeCompare(b.locality ?? "", "es"),
            )
            .map((supermarket) => (
              <div className={editingId === supermarket.id ? "supermarket-admin-row editing" : "supermarket-admin-row"} key={supermarket.id}>
                <div className="store-icon"><Store size={17} /></div>
                <div>
                  <strong>{supermarket.name}</strong>
                  <span>
                    {[supermarket.locality, supermarket.address].filter(Boolean).join(" · ") ||
                      "Sin localidad"}
                  </span>
                </div>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={`Editar ${supermarket.name}`}
                  onClick={() => editStore(supermarket)}
                >
                  <Pencil size={16} />
                </button>
              </div>
            ))}
        </div>
      </div>
      <StoreProductDirectory
        products={products}
        purchases={purchases}
        supermarkets={supermarkets}
        standalone
      />
    </section>
  );
}

function StoreProductDirectory({
  products,
  purchases,
  supermarkets,
  standalone = false,
}: {
  products: Product[];
  purchases: Purchase[];
  supermarkets: Supermarket[];
  standalone?: boolean;
}) {
  const stores = supermarkets
    .map((supermarket) => {
      const latestByProduct = new Map<number, Purchase>();
      purchases
        .filter((purchase) => purchase.supermarketId === supermarket.id)
        .sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0))
        .forEach((purchase) => {
          if (!latestByProduct.has(purchase.productId))
            latestByProduct.set(purchase.productId, purchase);
        });
      const rows = [...latestByProduct.values()].flatMap((purchase) => {
        const product = products.find((candidate) => candidate.id === purchase.productId);
        return product ? [{ product, purchase }] : [];
      });
      return { supermarket, rows };
    })
    .filter((store) => store.rows.length > 0)
    .sort((a, b) => b.rows.length - a.rows.length);

  if (!stores.length)
    return (
      <div className="panel">
        <Empty text="Registra precios para ver qué productos has comprado en cada supermercado." />
      </div>
    );
  return (
    <div className={standalone ? "store-directory standalone" : "store-directory"}>
      {!standalone && (
        <div className="page-heading compact-heading">
          <div>
            <span className="eyebrow">POR SUPERMERCADO</span>
            <h2>Productos comprados en cada tienda</h2>
            <p>Se muestra el último precio conocido de cada producto.</p>
          </div>
        </div>
      )}
      <div className="store-product-grid">
        {stores.map(({ supermarket, rows }) => (
          <article className="panel store-product-card" key={supermarket.id}>
            <div className="panel-title">
              <div>
                <h3>{supermarket.name}</h3>
                <p>{supermarket.locality || `${rows.length} productos distintos`}</p>
              </div>
              <Store size={20} />
            </div>
            <div className="store-product-list">
              {rows
                .sort((a, b) => a.product.name.localeCompare(b.product.name, "es"))
                .map(({ product, purchase }) => (
                  <div className="store-product-row" key={product.id}>
                    <ProductThumbnail product={product} />
                    <div>
                      <strong>{product.name}</strong>
                      <span>{product.category || "Otros"}</span>
                    </div>
                    <strong>
                      {formatUnitPrice(purchase.normalizedUnitPrice, purchase.normalizedUnit)}
                    </strong>
                  </div>
                ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function PublicOffersPanel({ query }: { query: string }) {
  const [result, setResult] = useState<PublicOffersResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (query.trim().length < 2) {
      setResult(undefined);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/offers?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("No se han podido consultar las ofertas.");
        setResult((await response.json()) as PublicOffersResponse);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setResult(undefined);
        setError(fetchError instanceof Error ? fetchError.message : "Consulta no disponible.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 450);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  if (!query) return null;
  const comparableOffers = result?.offers.filter((offer) => offer.comparablePrice !== null) ?? [];
  const lowestComparablePrice = comparableOffers.length
    ? Math.min(...comparableOffers.map((offer) => offer.comparablePrice as number))
    : undefined;

  return (
    <section className="panel public-offers" aria-live="polite">
      <div className="panel-title public-offers-head">
        <div>
          <span className="eyebrow">PRECIOS EN LA RED</span>
          <h3>Ofertas públicas a 25 km de Getxo</h3>
          <p>
            Buscando “{query}” en catálogos públicos. El precio online puede variar en tienda.
          </p>
        </div>
        <Globe2 size={22} />
      </div>

      {loading ? (
        <div className="public-offers-status">Consultando precios públicos…</div>
      ) : error ? (
        <div className="public-offers-status error">{error}</div>
      ) : result ? (
        <>
          {result.offers.length ? (
            <div className="public-offer-grid">
              {result.offers.slice(0, 6).map((offer) => (
                <a
                  className={
                    offer.comparablePrice === lowestComparablePrice
                      ? "public-offer cheapest"
                      : "public-offer"
                  }
                  href={offer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  key={`${offer.supermarket}-${offer.name}`}
                >
                  <div>
                    <span>{offer.supermarket}</span>
                    {offer.comparablePrice === lowestComparablePrice && (
                      <small>MEJOR PRECIO COMPARABLE</small>
                    )}
                  </div>
                  <div className="public-offer-prices">
                    <strong>{money(offer.price)}</strong>
                    <span>envase</span>
                  </div>
                  <h4>{offer.name}</h4>
                  <p className="public-unit-price">
                    {offer.comparablePrice !== null && offer.comparableUnit
                      ? formatUnitPrice(offer.comparablePrice, offer.comparableUnit)
                      : "Precio por unidad no disponible"}
                    {offer.format ? <span>Formato: {offer.format}</span> : null}
                  </p>
                  {offer.promotion && <p className="public-promotion">{offer.promotion}</p>}
                  <p>{offer.location}</p>
                  <em>
                    Ver fuente <ExternalLink size={13} />
                  </em>
                </a>
              ))}
            </div>
          ) : (
            <div className="public-offers-status">
              No se han encontrado precios públicos para este nombre. Prueba con uno más genérico.
            </div>
          )}
          <div className="public-source-links">
            <span>
              Consultado {new Date(result.checkedAt).toLocaleString("es-ES", { timeStyle: "short", dateStyle: "short" })}
            </span>
            {result.sources.map((source) => (
              <a href={source.url} target="_blank" rel="noopener noreferrer" key={source.supermarket}>
                {source.supermarket}: {source.label} <ExternalLink size={12} />
              </a>
            ))}
          </div>
          <p className="public-search-area">
            <MapPin size={13} /> Radio de {result.searchArea.radiusKm} km desde {result.searchArea.center}:
            {" "}{result.searchArea.municipalities.join(", ")} y municipios próximos.
          </p>
        </>
      ) : null}
    </section>
  );
}

function ShoppingListView() {
  const itemRecords = useLiveQuery(() => db.shoppingList.orderBy("createdAt").toArray(), []);
  const productRecords = useLiveQuery(() => db.products.toArray(), []);
  const purchaseRecords = useLiveQuery(() => db.purchases.toArray(), []);
  const supermarketRecords = useLiveQuery(() => db.supermarkets.toArray(), []);
  const items = useMemo(() => itemRecords ?? [], [itemRecords]);
  const products = useMemo(() => productRecords ?? [], [productRecords]);
  const purchases = useMemo(() => purchaseRecords ?? [], [purchaseRecords]);
  const supermarkets = useMemo(() => supermarketRecords ?? [], [supermarketRecords]);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const selectedProduct = products.find((product) => String(product.id) === productId);
  const publicOfferQuery = selectedProduct?.genericName || selectedProduct?.name || "";

  const availableProducts = useMemo(
    () =>
      products
        .filter((product) => product.id && !items.some((item) => item.productId === product.id))
        .sort((a, b) => (a.genericName || a.name).localeCompare(b.genericName || b.name, "es")),
    [items, products],
  );

  useEffect(() => {
    if (!availableProducts.some((product) => String(product.id) === productId))
      setProductId(availableProducts[0]?.id ? String(availableProducts[0].id) : "");
  }, [availableProducts, productId]);

  const activeItems = items.filter((item) => !item.checked);


  const priceOptions = useMemo(() => {
    return activeItems.map((item) => {
      const selectedProduct = products.find((product) => product.id === item.productId);
      if (!selectedProduct)
        return { item, product: undefined, byStore: new Map<number, Purchase>() };
      const equivalents = products.filter(
        (product) =>
          product.id === selectedProduct.id ||
          (selectedProduct.genericName && product.genericName === selectedProduct.genericName),
      );
      const equivalentIds = new Set(equivalents.map((product) => product.id));
      const byStore = new Map<number, Purchase>();
      purchases
        .filter((purchase) => equivalentIds.has(purchase.productId))
        .sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0))
        .forEach((purchase) => {
          if (!byStore.has(purchase.supermarketId)) byStore.set(purchase.supermarketId, purchase);
        });
      return { item, product: selectedProduct, byStore };
    });
  }, [activeItems, products, purchases]);

  const storePlans = useMemo(
    () =>
      supermarkets
        .map((supermarket) => {
          const priced = priceOptions.flatMap(({ item, byStore }) => {
            const purchase = supermarket.id ? byStore.get(supermarket.id) : undefined;
            if (!purchase) return [];
            return [{ item, purchase, cost: packagePrice(purchase) * item.quantity }];
          });
          return {
            supermarket,
            coverage: priced.length,
            total: priced.reduce((sum, row) => sum + row.cost, 0),
          };
        })
        .filter((plan) => plan.coverage > 0)
        .sort((a, b) => b.coverage - a.coverage || a.total - b.total),
    [priceOptions, supermarkets],
  );

  const bestStore = storePlans[0];
  const splitPlan = priceOptions.flatMap(({ item, product, byStore }) => {
    const cheapest = [...byStore.values()].sort((a, b) => packagePrice(a) - packagePrice(b))[0];
    if (!cheapest || !product) return [];
    return [
      {
        item,
        product,
        purchase: cheapest,
        supermarket: supermarkets.find((store) => store.id === cheapest.supermarketId),
        cost: packagePrice(cheapest) * item.quantity,
      },
    ];
  });
  const splitTotal = splitPlan.reduce((sum, row) => sum + row.cost, 0);

  async function addItem() {
    const selectedId = Number(productId);
    if (!selectedId || quantity < 1) return;
    await db.shoppingList.add({
      productId: selectedId,
      quantity: Math.max(1, Math.round(quantity)),
      checked: false,
      createdAt: new Date().toISOString(),
    });
    setQuantity(1);
  }

  async function updateItem(item: ShoppingListItem, patch: Partial<ShoppingListItem>) {
    if (item.id) await db.shoppingList.update(item.id, patch);
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">PLANIFICA Y AHORRA</span>
          <h2>Lista de la compra</h2>
          <p>
            Marca lo que ya tienes y descubre dónde sale mejor tu cesta con tus últimos precios.
          </p>
        </div>
      </div>

      <div className="shopping-layout">
        <div className="panel shopping-list-panel">
          <div className="shopping-add">
            <label>
              Producto
              <select value={productId} onChange={(event) => setProductId(event.target.value)}>
                {availableProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.genericName || product.name}
                    {product.brand ? ` · ${product.brand}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Cantidad
              <input
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value))}
              />
            </label>
            <button className="primary" disabled={!productId} onClick={() => void addItem()}>
              <Plus size={18} /> Añadir
            </button>
          </div>

          {items.length === 0 ? (
            <Empty text="Tu lista está vacía. Añade productos de tu catálogo." />
          ) : (
            <div className="shopping-items">
              {items.map((item) => {
                const product = products.find((candidate) => candidate.id === item.productId);
                return (
                  <div
                    className={item.checked ? "shopping-item checked" : "shopping-item"}
                    key={item.id}
                  >
                    <input
                      className="shopping-check"
                      type="checkbox"
                      checked={item.checked}
                      aria-label={`Marcar ${product?.name ?? "producto"} como comprado`}
                      onChange={(event) => void updateItem(item, { checked: event.target.checked })}
                    />
                    {product && <ProductThumbnail product={product} />}
                    <div className="shopping-item-name">
                      <strong>
                        {product?.genericName || product?.name || "Producto eliminado"}
                      </strong>
                      <span>{product?.brand || product?.name}</span>
                    </div>
                    <label className="shopping-quantity">
                      <span>Uds.</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={item.quantity}
                        onChange={(event) =>
                          void updateItem(item, {
                            quantity: Math.max(1, Number(event.target.value)),
                          })
                        }
                      />
                    </label>
                    <button
                      className="icon-btn danger"
                      aria-label={`Borrar ${product?.name ?? "producto"}`}
                      onClick={() => item.id && void db.shoppingList.delete(item.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <aside className="shopping-recommendations">
          <div className="recommendation best shopping-best">
            <Sparkles size={22} />
            <span>MEJOR SUPERMERCADO</span>
            {activeItems.length === 0 ? (
              <p>Añade o desmarca productos para calcular tu cesta.</p>
            ) : bestStore ? (
              <>
                <h3>{bestStore.supermarket.name}</h3>
                <strong>{money(bestStore.total)}</strong>
                <p>
                  Precio conocido para {bestStore.coverage} de {activeItems.length} productos
                  {bestStore.coverage < activeItems.length
                    ? ". Faltan precios en esta tienda."
                    : "."}
                </p>
              </>
            ) : (
              <p>Aún no hay precios guardados para estos productos.</p>
            )}
          </div>

          {splitPlan.length > 0 && (
            <div className="panel split-plan">
              <div className="panel-title">
                <div>
                  <h3>Compra más barata</h3>
                  <p>Repartiendo productos entre tiendas.</p>
                </div>
                <strong>{money(splitTotal)}</strong>
              </div>
              {splitPlan.map((row) => (
                <div className="split-row" key={row.item.id}>
                  <div>
                    <strong>{row.product.genericName || row.product.name}</strong>
                    <span>
                      {row.item.quantity} × {money(packagePrice(row.purchase))}
                    </span>
                  </div>
                  <div>
                    <strong>{row.supermarket?.name || "Supermercado"}</strong>
                    <span>{money(row.cost)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
      <PublicOffersPanel query={publicOfferQuery} />
    </section>
  );
}

function packagePrice(purchase: Purchase) {
  return Math.max(0, purchase.price - purchase.discount) / Math.max(1, purchase.quantityPurchased);
}

function ProductMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  function toggle(option: string) {
    onChange(
      selected.includes(option)
        ? selected.filter((candidate) => candidate !== option)
        : [...selected, option],
    );
  }

  return (
    <div className="multi-select" aria-label="Seleccionar productos">
      <div className="multi-select-head">
        <span>Productos</span>
        <button className="ghost" type="button" onClick={() => onChange(options)}>
          Todos
        </button>
        <button className="ghost" type="button" onClick={() => onChange([])}>
          Limpiar
        </button>
      </div>
      <div className="multi-select-options">
        {options.length ? (
          options.map((option) => (
            <label key={option} className={selected.includes(option) ? "selected" : ""}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() => toggle(option)}
              />
              {option}
            </label>
          ))
        ) : (
          <span className="multi-select-empty">No hay productos que coincidan.</span>
        )}
      </div>
    </div>
  );
}

function CompareView() {
  const productRecords = useLiveQuery(() => db.products.toArray(), []);
  const purchaseRecords = useLiveQuery(() => db.purchases.toArray(), []);
  const supermarketRecords = useLiveQuery(() => db.supermarkets.toArray(), []);
  const products = useMemo(() => productRecords ?? [], [productRecords]);
  const purchases = useMemo(() => purchaseRecords ?? [], [purchaseRecords]);
  const supermarkets = useMemo(() => supermarketRecords ?? [], [supermarketRecords]);
  const genericNames = useMemo(
    () => Array.from(new Set(products.map((p) => p.genericName).filter(Boolean))).sort(),
    [products],
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionReady, setSelectionReady] = useState(false);
  useEffect(() => {
    if (!selectionReady && genericNames[0]) {
      setSelected([genericNames[0]]);
      setSelectionReady(true);
    }
  }, [selectionReady, genericNames]);
  const filteredGenericNames = useMemo(() => {
    const normalizedQuery = comparableText(query);
    if (!normalizedQuery) return genericNames;
    return genericNames.filter((genericName) =>
      products.some(
        (product) =>
          product.genericName === genericName &&
          comparableText(`${product.name} ${product.brand} ${product.genericName}`).includes(
            normalizedQuery,
          ),
      ),
    );
  }, [genericNames, products, query]);

  const candidates = useMemo(() => {
    if (!selected.length) return [];
    const targetProducts = products.filter((p) => selected.includes(p.genericName));
    const rows: EnrichedPurchase[] = [];
    for (const product of targetProducts) {
      const byStore = new Map<number, Purchase>();
      purchases
        .filter((p) => p.productId === product.id)
        .sort((a, b) => b.date.localeCompare(a.date))
        .forEach((p) => {
          if (!byStore.has(p.supermarketId)) byStore.set(p.supermarketId, p);
        });
      for (const purchase of byStore.values())
        rows.push({
          ...purchase,
          product,
          supermarket: supermarkets.find((s) => s.id === purchase.supermarketId),
        });
    }
    return rows.sort((a, b) => a.normalizedUnitPrice - b.normalizedUnitPrice);
  }, [selected, products, purchases, supermarkets]);

  const cheapest = candidates[0];
  const favorite = [...candidates].sort(
    (a, b) =>
      (b.product?.rating ?? 0) - (a.product?.rating ?? 0) ||
      a.normalizedUnitPrice - b.normalizedUnitPrice,
  )[0];
  const storeComparisons = supermarkets
    .flatMap((supermarket) => {
      const rows = candidates.filter((candidate) => candidate.supermarketId === supermarket.id);
      if (!rows.length) return [];
      const bestByGeneric = new Map<string, EnrichedPurchase>();
      for (const row of rows) {
        const genericName = row.product?.genericName;
        if (!genericName) continue;
        const current = bestByGeneric.get(genericName);
        if (!current || row.normalizedUnitPrice < current.normalizedUnitPrice)
          bestByGeneric.set(genericName, row);
      }
      const chosen = [...bestByGeneric.values()];
      return [
        {
          supermarket,
          coverage: chosen.length,
          total: chosen.reduce((sum, row) => sum + packagePrice(row), 0),
          rows: chosen,
        },
      ];
    })
    .sort((a, b) => b.coverage - a.coverage || a.total - b.total);
  const bestStoreComparison = storeComparisons[0];

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">COMPARAR</span>
          <h2>Mismo producto, distinta marca</h2>
          <p>Se compara el precio normalizado, no solo el precio del envase.</p>
        </div>
        <div className="compare-product-picker">
          <input
            className="search"
            type="search"
            placeholder="Buscar producto, marca…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ProductMultiSelect
            options={filteredGenericNames}
            selected={selected}
            onChange={setSelected}
          />
        </div>
      </div>
      {!selected.length ? (
        <div className="panel">
          <Empty text="Necesitas productos con un nombre genérico para compararlos." />
        </div>
      ) : candidates.length === 0 || !cheapest || !favorite ? (
        <div className="panel">
          <Empty text="No hay compras suficientes para este producto." />
        </div>
      ) : (
        <>
          <div className="comparison-store-grid">
            {storeComparisons.slice(0, 4).map((comparison) => (
              <article
                className={
                  comparison === bestStoreComparison
                    ? "panel comparison-store-card best-store"
                    : "panel comparison-store-card"
                }
                key={comparison.supermarket.id}
              >
                {comparison === bestStoreComparison && (
                  <span className="best-ribbon">★ MEJOR OPCIÓN</span>
                )}
                <div className="comparison-store-head">
                  <div className="store-icon">
                    <Store size={19} />
                  </div>
                  <div>
                    <h3>{comparison.supermarket.name}</h3>
                    <span>{comparison.supermarket.locality || "Tus precios guardados"}</span>
                  </div>
                </div>
                <div className="comparison-store-total">
                  <span>Cesta estimada</span>
                  <strong>{money(comparison.total)}</strong>
                  <small>
                    Cobertura {comparison.coverage}/{selected.length}
                  </small>
                </div>
                <div className="comparison-price-bars">
                  {comparison.rows.slice(0, 6).map((row) => (
                    <div key={`${comparison.supermarket.id}-${row.product?.genericName}`}>
                      <span>{row.product?.genericName}</span>
                      <i
                        style={{
                          width: `${Math.min(100, Math.max(24, row.normalizedUnitPrice * 12))}%`,
                        }}
                      />
                      <strong>
                        {formatUnitPrice(row.normalizedUnitPrice, row.normalizedUnit)}
                      </strong>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <div className="content-grid two">
            <div className="recommendation best">
              <div className="recommendation-product">
                {cheapest.product && <ProductThumbnail product={cheapest.product} />}
                <div>
                  <span>💰 PRECIO MÁS BAJO DE LA SELECCIÓN</span>
                  <h3>{cheapest.product?.name}</h3>
                  <p>
                    {cheapest.supermarket?.name} ·{" "}
                    {formatUnitPrice(cheapest.normalizedUnitPrice, cheapest.normalizedUnit)}
                  </p>
                </div>
              </div>
            </div>
            <div className="recommendation favorite">
              <div className="recommendation-product">
                {favorite.product && <ProductThumbnail product={favorite.product} />}
                <div>
                  <span>⭐ MEJOR VALORADO DE LA SELECCIÓN</span>
                  <h3>{favorite.product?.name}</h3>
                  <p>
                    {favorite.supermarket?.name} · {favorite.product?.rating || 0}/5 ·{" "}
                    {formatUnitPrice(favorite.normalizedUnitPrice, favorite.normalizedUnit)}
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="panel table-panel">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Supermercado</th>
                  <th>Formato</th>
                  <th>Precio envase</th>
                  <th>Precio comparable</th>
                  <th>Tu nota</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={`${c.productId}-${c.supermarketId}-${c.id}`}>
                    <td>
                      <div className="table-product">
                        {c.product && <ProductThumbnail product={c.product} />}
                        <div>
                          <strong>{c.product?.name}</strong>
                          <span>{c.product?.brand || "Sin marca"}</span>
                        </div>
                      </div>
                    </td>
                    <td>{c.supermarket?.name}</td>
                    <td>
                      {c.packageAmount} {c.packageUnit} × {c.quantityPurchased}
                    </td>
                    <td>{money(c.price - c.discount)}</td>
                    <td className="strong-cell">
                      {formatUnitPrice(c.normalizedUnitPrice, c.normalizedUnit)}
                    </td>
                    <td>
                      {"★".repeat(c.product?.rating || 0)}
                      {"☆".repeat(5 - (c.product?.rating || 0))}
                    </td>
                    <td>{new Date(`${c.date}T00:00:00`).toLocaleDateString("es-ES")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {selected.length === 1 && <PublicOffersPanel query={selected[0] ?? ""} />}
    </section>
  );
}

function ProductThumbnail({ product }: { product: Product }) {
  return (
    <div className="product-thumbnail">
      {product.photoBlob ? (
        <ProductPhoto blob={product.photoBlob} alt={product.name} />
      ) : (
        <ShoppingBasket size={17} />
      )}
    </div>
  );
}

function HistoryView() {
  const productRecords = useLiveQuery(() => db.products.toArray(), []);
  const purchaseRecords = useLiveQuery(() => db.purchases.toArray(), []);
  const supermarketRecords = useLiveQuery(() => db.supermarkets.toArray(), []);
  const products = useMemo(() => productRecords ?? [], [productRecords]);
  const purchases = useMemo(() => purchaseRecords ?? [], [purchaseRecords]);
  const supermarkets = useMemo(() => supermarketRecords ?? [], [supermarketRecords]);
  const genericNames = useMemo(
    () => Array.from(new Set(products.map((p) => p.genericName).filter(Boolean))).sort(),
    [products],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionReady, setSelectionReady] = useState(false);
  useEffect(() => {
    if (!selectionReady && genericNames[0]) {
      setSelected([genericNames[0]]);
      setSelectionReady(true);
    }
  }, [selectionReady, genericNames]);

  const relevant = enrichPurchases(purchases, products, supermarkets)
    .filter((p) => p.product?.genericName && selected.includes(p.product.genericName))
    .sort((a, b) => a.date.localeCompare(b.date));
  const markets = Array.from(
    new Set(relevant.map((p) => p.supermarket?.name).filter(Boolean)),
  ) as string[];
  const months = Array.from(new Set(relevant.map((purchase) => purchase.date.slice(0, 7)))).sort();
  const dates = Array.from(new Set(relevant.map((purchase) => purchase.date))).sort();
  const monthlyRows = months.flatMap((month) =>
    selected.flatMap((genericName) => {
      const rows = relevant.filter(
        (purchase) =>
          purchase.date.startsWith(month) && purchase.product?.genericName === genericName,
      );
      if (!rows.length) return [];
      const prices = rows.map((row) => row.normalizedUnitPrice);
      return [
        {
          month,
          genericName,
          unit: rows[0]!.normalizedUnit,
          average: prices.reduce((sum, price) => sum + price, 0) / prices.length,
          minimum: Math.min(...prices),
          maximum: Math.max(...prices),
          stores: new Set(rows.map((row) => row.supermarketId)).size,
          records: rows.length,
        },
      ];
    }),
  );
  const chartData = dates.map((date) => {
    const point: Record<string, string | number> = {
      date,
      label: new Date(`${date}T00:00:00`).toLocaleDateString("es-ES", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
      }),
    };
    for (const genericName of selected) {
      const rows = relevant.filter(
        (purchase) => purchase.date === date && purchase.product?.genericName === genericName,
      );
      if (rows.length)
        point[genericName] = Number(
          (rows.reduce((sum, purchase) => sum + purchase.normalizedUnitPrice, 0) / rows.length).toFixed(2),
        );
    }
    return point;
  });
  const supermarketAverages = selected.flatMap((genericName) =>
    markets.flatMap((market) => {
      const rows = relevant.filter(
        (purchase) =>
          purchase.product?.genericName === genericName && purchase.supermarket?.name === market,
      );
      if (!rows.length) return [];
      return [
        {
          genericName,
          market,
          unit: rows[0]!.normalizedUnit,
          average:
            rows.reduce((sum, purchase) => sum + purchase.normalizedUnitPrice, 0) / rows.length,
          latest: rows[rows.length - 1]!,
          records: rows.length,
        },
      ];
    }),
  );
  const years = Array.from(new Set(relevant.map((purchase) => purchase.date.slice(0, 4)))).sort(
    (a, b) => b.localeCompare(a),
  );
  const annualRows = years.flatMap((year) =>
    selected.flatMap((genericName) => {
      const rows = relevant.filter(
        (purchase) =>
          purchase.date.startsWith(year) && purchase.product?.genericName === genericName,
      );
      if (!rows.length) return [];
      const prices = rows.map((row) => row.normalizedUnitPrice);
      const first = rows[0]!.normalizedUnitPrice;
      const last = rows[rows.length - 1]!.normalizedUnitPrice;
      return [
        {
          year,
          genericName,
          unit: rows[0]!.normalizedUnit,
          average: prices.reduce((sum, price) => sum + price, 0) / prices.length,
          minimum: Math.min(...prices),
          maximum: Math.max(...prices),
          variation: first ? (last / first - 1) * 100 : 0,
          months: new Set(rows.map((row) => row.date.slice(0, 7))).size,
          stores: new Set(rows.map((row) => row.supermarketId)).size,
        },
      ];
    }),
  );

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">EVOLUCIÓN</span>
          <h2>Histórico de precios</h2>
          <p>Observa la evolución del precio comparable y los cambios de formato.</p>
        </div>
        <ProductMultiSelect options={genericNames} selected={selected} onChange={setSelected} />
      </div>
      {relevant.length === 0 ? (
        <div className="panel">
          <Empty text="Necesitas varias compras para crear un histórico." />
        </div>
      ) : (
        <>
          <div className="metrics-grid">
            <Metric icon={History} label="Registros" value={String(relevant.length)} />
            <Metric icon={ShoppingBasket} label="Productos" value={String(selected.length)} />
            <Metric icon={Store} label="Supermercados" value={String(markets.length)} />
            <Metric icon={BarChart3} label="Fechas registradas" value={String(dates.length)} />
          </div>
          <div className="panel chart-panel">
            <div className="panel-title">
              <div>
                <h3>Evolución por fecha</h3>
                <p>Cada actualización de precio aparece en la fecha en que la registraste.</p>
              </div>
              <BarChart3 size={20} />
            </div>
            <div className="chart-height">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" />
                  <YAxis />
                  <Tooltip formatter={(value) => money(Number(value))} />
                  <Legend />
                  {selected.map((seriesName, i) => (
                    <Line
                      key={seriesName}
                      type="monotone"
                      dataKey={seriesName}
                      connectNulls
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                      stroke={
                        ["#2d6a4f", "#d97706", "#2563eb", "#7c3aed", "#dc2626", "#0891b2"][i % 6] ??
                        "#2d6a4f"
                      }
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="history-summary-grid">
            <div className="panel table-panel">
              <div className="panel-title">
                <div>
                  <h3>Media por supermercado</h3>
                  <p>Media histórica y último precio registrado.</p>
                </div>
                <Store size={20} />
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Supermercado</th>
                    <th>Media</th>
                    <th>Último</th>
                    <th>Registros</th>
                  </tr>
                </thead>
                <tbody>
                  {supermarketAverages
                    .sort(
                      (a, b) => a.genericName.localeCompare(b.genericName) || a.average - b.average,
                    )
                    .map((row) => (
                      <tr key={`${row.genericName}-${row.market}`}>
                        <td>
                          <strong>{row.genericName}</strong>
                        </td>
                        <td>{row.market}</td>
                        <td className="strong-cell">{formatUnitPrice(row.average, row.unit)}</td>
                        <td>
                          {formatUnitPrice(
                            row.latest.normalizedUnitPrice,
                            row.latest.normalizedUnit,
                          )}
                        </td>
                        <td>{row.records}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="panel table-panel annual-summary">
              <div className="panel-title">
                <div>
                  <h3>Resumen anual</h3>
                  <p>Media, rango y evolución dentro de cada año.</p>
                </div>
                <History size={20} />
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Año</th>
                    <th>Producto</th>
                    <th>Media</th>
                    <th>Mín.–Máx.</th>
                    <th>Variación</th>
                    <th>Cobertura</th>
                  </tr>
                </thead>
                <tbody>
                  {annualRows.map((row) => (
                    <tr key={`${row.year}-${row.genericName}`}>
                      <td>
                        <strong>{row.year}</strong>
                      </td>
                      <td>{row.genericName}</td>
                      <td className="strong-cell">{formatUnitPrice(row.average, row.unit)}</td>
                      <td>
                        {money(row.minimum)}–{money(row.maximum)}
                      </td>
                      <td>
                        <span
                          className={
                            row.variation > 0 ? "price-difference up" : "price-difference down"
                          }
                        >
                          {pct(row.variation)}
                        </span>
                      </td>
                      <td>
                        {row.months} meses · {row.stores} tiendas
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel table-panel monthly-detail">
            <div className="panel-title">
              <div>
                <h3>Detalle mensual</h3>
                <p>Media y rango observado durante cada mes.</p>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Mes</th>
                  <th>Producto</th>
                  <th>Media</th>
                  <th>Mínimo</th>
                  <th>Máximo</th>
                  <th>Supermercados</th>
                  <th>Registros</th>
                </tr>
              </thead>
              <tbody>
                {[...monthlyRows].reverse().map((row) => (
                  <tr key={`${row.month}-${row.genericName}`}>
                    <td>
                      {new Date(`${row.month}-01T00:00:00`).toLocaleDateString("es-ES", {
                        month: "long",
                        year: "numeric",
                      })}
                    </td>
                    <td>
                      <strong>{row.genericName}</strong>
                    </td>
                    <td className="strong-cell">{formatUnitPrice(row.average, row.unit)}</td>
                    <td>{formatUnitPrice(row.minimum, row.unit)}</td>
                    <td>{formatUnitPrice(row.maximum, row.unit)}</td>
                    <td>{row.stores}</td>
                    <td>{row.records}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function MedinaView() {
  const supermarketRecords = useLiveQuery(() => db.supermarkets.toArray(), []);
  const ticketRecords = useLiveQuery(() => db.tickets.toArray(), []);
  const purchaseRecords = useLiveQuery(() => db.purchases.toArray(), []);
  const productRecords = useLiveQuery(() => db.products.toArray(), []);
  const supermarkets = useMemo(() => supermarketRecords ?? [], [supermarketRecords]);
  const tickets = useMemo(() => ticketRecords ?? [], [ticketRecords]);
  const purchases = useMemo(() => purchaseRecords ?? [], [purchaseRecords]);
  const products = useMemo(() => productRecords ?? [], [productRecords]);
  const medinaStores = useMemo(
    () => supermarkets.filter((store) => store.locality === "Medina de Pomar"),
    [supermarkets],
  );
  const medinaIds = useMemo(
    () => new Set(medinaStores.flatMap((store) => (store.id ? [store.id] : []))),
    [medinaStores],
  );
  const medinaTickets = useMemo(
    () => tickets.filter((ticket) => medinaIds.has(ticket.supermarketId)),
    [tickets, medinaIds],
  );
  const medinaPurchases = useMemo(
    () => purchases.filter((purchase) => medinaIds.has(purchase.supermarketId)),
    [purchases, medinaIds],
  );
  const medinaSpend = medinaTickets.reduce((sum, ticket) => sum + ticket.total, 0);

  const comparisons = useMemo(() => {
    const productById = new Map(
      products.flatMap((product) => (product.id ? [[product.id, product] as const] : [])),
    );
    const rows: Array<{
      genericName: string;
      medina: EnrichedPurchase;
      outside: EnrichedPurchase;
      difference: number;
    }> = [];
    const genericNames = Array.from(
      new Set(
        medinaPurchases
          .map((purchase) => productById.get(purchase.productId)?.genericName)
          .filter(Boolean),
      ),
    ) as string[];
    for (const genericName of genericNames) {
      const ids = new Set(
        products
          .filter((product) => product.genericName === genericName)
          .flatMap((product) => (product.id ? [product.id] : [])),
      );
      const local = medinaPurchases
        .filter((purchase) => ids.has(purchase.productId))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const outside = purchases
        .filter(
          (purchase) =>
            ids.has(purchase.productId) &&
            !medinaIds.has(purchase.supermarketId) &&
            purchase.normalizedUnit === local?.normalizedUnit,
        )
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!local || !outside || outside.normalizedUnitPrice <= 0) continue;
      rows.push({
        genericName,
        medina: {
          ...local,
          product: productById.get(local.productId),
          supermarket: supermarkets.find((store) => store.id === local.supermarketId),
        },
        outside: {
          ...outside,
          product: productById.get(outside.productId),
          supermarket: supermarkets.find((store) => store.id === outside.supermarketId),
        },
        difference: (local.normalizedUnitPrice / outside.normalizedUnitPrice - 1) * 100,
      });
    }
    return rows.sort((a, b) => b.difference - a.difference);
  }, [medinaPurchases, medinaIds, products, purchases, supermarkets]);

  const averageDifference = comparisons.length
    ? comparisons.reduce((sum, row) => sum + row.difference, 0) / comparisons.length
    : null;

  return (
    <section className="page">
      <div className="medina-hero">
        <div>
          <span className="eyebrow">OBSERVATORIO DE VERANO</span>
          <h2>Supermercados de Medina de Pomar</h2>
          <p>
            Registra tus compras con la ubicación de Medina y comprobaremos con tus propios datos si
            el veraneo encarece la cesta.
          </p>
        </div>
        <div className="medina-pin">
          <MapPin size={28} />
          <span>Las Merindades</span>
          <strong>09500</strong>
        </div>
      </div>

      <div className="metrics-grid medina-metrics">
        <Metric
          icon={Store}
          label="Supermercados localizados"
          value={String(MEDINA_SUPERMARKETS.length)}
        />
        <Metric icon={ReceiptText} label="Compras en Medina" value={String(medinaTickets.length)} />
        <Metric icon={ShoppingBasket} label="Gasto registrado" value={money(medinaSpend)} />
        <Metric
          icon={Scale}
          label="Diferencia media"
          value={averageDifference === null ? "Sin datos" : pct(averageDifference)}
        />
      </div>

      <div className="medina-note">
        <AlertTriangle size={19} />
        <div>
          <strong>La subida no se presupone: se mide.</strong>
          <span>
            La diferencia compara el último precio normalizado de cada producto en Medina con el
            último registrado fuera de Medina. Necesitamos compras del mismo producto en ambos
            lugares.
          </span>
        </div>
      </div>

      <div className="medina-store-grid">
        {MEDINA_SUPERMARKETS.map((directoryStore, index) => {
          const store = medinaStores.find((candidate) => candidate.name === directoryStore.name);
          const storeTickets = store?.id
            ? medinaTickets.filter((ticket) => ticket.supermarketId === store.id)
            : [];
          const spend = storeTickets.reduce((sum, ticket) => sum + ticket.total, 0);
          const latest = [...storeTickets].sort((a, b) => b.date.localeCompare(a.date))[0];
          const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${directoryStore.name}, ${directoryStore.address}, Medina de Pomar`)}`;
          return (
            <article className="medina-store-card" key={directoryStore.name}>
              <div className={`store-brand store-brand-${index + 1}`}>
                {directoryStore.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="medina-store-copy">
                <h3>{directoryStore.name}</h3>
                <p>
                  <MapPin size={14} /> {directoryStore.address}
                </p>
              </div>
              <div className="medina-store-stats">
                <div>
                  <span>Compras</span>
                  <strong>{storeTickets.length}</strong>
                </div>
                <div>
                  <span>Gasto</span>
                  <strong>{money(spend)}</strong>
                </div>
                <div>
                  <span>Última compra</span>
                  <strong>
                    {latest ? new Date(`${latest.date}T00:00:00`).toLocaleDateString("es-ES") : "—"}
                  </strong>
                </div>
              </div>
              <div className="medina-store-links">
                <a href={mapUrl} target="_blank" rel="noreferrer">
                  <MapPin size={15} /> Ver mapa
                </a>
                <a href={directoryStore.website} target="_blank" rel="noreferrer">
                  Web oficial <ExternalLink size={14} />
                </a>
              </div>
            </article>
          );
        })}
      </div>

      <div className="panel medina-comparison">
        <div className="panel-title">
          <div>
            <h3>Termómetro de precios de Medina</h3>
            <p>
              Productos comparables ordenados por mayor diferencia frente a tus compras fuera de
              Medina.
            </p>
          </div>
          <Scale size={20} />
        </div>
        {comparisons.length === 0 ? (
          <Empty text="Aún faltan productos comprados tanto en Medina como fuera para calcular la diferencia." />
        ) : (
          <div className="table-panel">
            <table className="data-table medina-table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Medina de Pomar</th>
                  <th>Fuera de Medina</th>
                  <th>Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((row) => (
                  <tr key={row.genericName}>
                    <td>
                      <div className="table-product">
                        {(row.medina.product ?? row.outside.product) && (
                          <ProductThumbnail
                            product={(row.medina.product ?? row.outside.product)!}
                          />
                        )}
                        <strong>{row.genericName}</strong>
                      </div>
                    </td>
                    <td>
                      <strong>
                        {formatUnitPrice(row.medina.normalizedUnitPrice, row.medina.normalizedUnit)}
                      </strong>
                      <span>{row.medina.supermarket?.name}</span>
                    </td>
                    <td>
                      <strong>
                        {formatUnitPrice(
                          row.outside.normalizedUnitPrice,
                          row.outside.normalizedUnit,
                        )}
                      </strong>
                      <span>{row.outside.supermarket?.name}</span>
                    </td>
                    <td>
                      <span
                        className={
                          row.difference > 0 ? "price-difference up" : "price-difference down"
                        }
                      >
                        {pct(row.difference)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

async function exportSharedProducts() {
  const [allProducts, allPurchases, allSupermarkets] = await Promise.all([
    db.products.toArray(),
    db.purchases.toArray(),
    db.supermarkets.toArray(),
  ]);
  if (!allProducts.length) throw new Error("No hay productos guardados para compartir.");
  const productIds = new Set(allProducts.flatMap((product) => (product.id ? [product.id] : [])));
  const products = allProducts
    .map(({ photoBlob: _photoBlob, ...product }) => product);
  const latestByProductAndStore = new Map<string, Purchase>();
  allPurchases
    .filter((purchase) => productIds.has(purchase.productId))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0))
    .forEach((purchase) => {
      const key = `${purchase.productId}-${purchase.supermarketId}`;
      if (!latestByProductAndStore.has(key)) latestByProductAndStore.set(key, purchase);
    });
  const purchases = [...latestByProductAndStore.values()];
  const supermarketIds = new Set(purchases.map((purchase) => purchase.supermarketId));
  const supermarkets = allSupermarkets.filter(
    (supermarket) => supermarket.id && supermarketIds.has(supermarket.id),
  );
  const payload: SharedListPayload = {
    kind: "smartmarket-shared-list",
    version: 1,
    exportedAt: new Date().toISOString(),
    products,
    supermarkets,
    purchases,
    shoppingList: [],
  };
  const filename = `smartmarket-productos-${todayISO()}.json`;
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    filename,
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function comparableText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es-ES");
}

function productsMatchExactly(existing: Product, incoming: ImportedProduct) {
  if (existing.barcode && incoming.barcode && existing.barcode === incoming.barcode) return true;
  return (
    comparableText(existing.brand ?? "") === comparableText(incoming.brand ?? "") &&
    comparableText(existing.name) === comparableText(incoming.name)
  );
}

function productsLookSimilar(existing: Product, incoming: ImportedProduct) {
  if (
    existing.genericName &&
    incoming.genericName &&
    comparableText(existing.genericName) === comparableText(incoming.genericName)
  )
    return true;
  const words = (value: string) =>
    new Set(comparableText(value).split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const existingWords = words(existing.name);
  const incomingWords = words(incoming.name);
  if (!existingWords.size || !incomingWords.size) return false;
  const overlap = [...incomingWords].filter((word) => existingWords.has(word)).length;
  return overlap / Math.min(existingWords.size, incomingWords.size) >= 0.75;
}

function InfoView({ onGo }: { onGo: (view: View) => void }) {
  const modules: Array<{
    view: View;
    title: string;
    description: string;
    icon: typeof Home;
  }> = [
    {
      view: "products",
      title: "Productos y precios",
      description:
        "Añade productos a mano o leyendo un recibo. Guarda supermercado, fecha, formato, unidades, descuentos, precios, fotos y enlaces de compra.",
      icon: ShoppingBasket,
    },
    {
      view: "public-catalog",
      title: "Catálogo público",
      description:
        "Cualquiera puede ver, incorporar o enviar productos para revisión. Solo el administrador puede aprobarlos o retirarlos.",
      icon: Globe2,
    },
    {
      view: "supermarkets",
      title: "Supermercados",
      description:
        "Añade y edita tiendas manualmente, y consulta qué productos y precios has guardado en cada una.",
      icon: Store,
    },
    {
      view: "shopping-list",
      title: "Lista de la compra",
      description:
        "Marca lo que necesitas y deja que SmartMarket recomiende dónde comprar según tus precios guardados.",
      icon: ListChecks,
    },
    {
      view: "compare",
      title: "Comparador",
      description:
        "Selecciona varios productos y compara por €/kg, €/L o unidad. También puedes consultar ofertas públicas online.",
      icon: Scale,
    },
    {
      view: "history",
      title: "Histórico",
      description:
        "Elige uno o varios productos para ver la evolución mensual, la media por supermercado y el resumen anual.",
      icon: History,
    },
    {
      view: "settings",
      title: "Ajustes y copias",
      description:
        "Autoguarda cada hora, exporta o restaura tus datos y comparte productos sin borrar los del receptor.",
      icon: Settings,
    },
  ];

  return (
    <section className="page info-page">
      <div className="info-hero panel">
        <div>
          <span className="eyebrow">GUÍA DE SMARTMARKET</span>
          <h2>Compra mejor, paso a paso</h2>
          <p>
            Guarda precios reales, compara formatos y prepara tu compra. No necesitas una cuenta
            para utilizar las funciones locales.
          </p>
        </div>
        <a className="info-contact" href="mailto:promociones7819@gmail.com">
          <Mail size={21} />
          <span>
            <small>Contacto y ayuda</small>
            <strong>promociones7819@gmail.com</strong>
          </span>
        </a>
      </div>

      <div className="info-section-heading">
        <span className="eyebrow">PRIMEROS PASOS</span>
        <h3>Cómo empezar</h3>
      </div>
      <div className="info-steps">
        <div className="panel info-step"><em>01</em><strong>Añade tus tiendas</strong><span>Crea los supermercados que utilizas habitualmente.</span></div>
        <div className="panel info-step"><em>02</em><strong>Guarda precios</strong><span>Registra productos o incorpóralos desde el catálogo público.</span></div>
        <div className="panel info-step"><em>03</em><strong>Revisa los formatos</strong><span>Indica gramos, litros o unidades para comparar correctamente.</span></div>
        <div className="panel info-step"><em>04</em><strong>Compara y compra</strong><span>Prepara la lista y consulta la tienda más conveniente.</span></div>
      </div>

      <div className="info-section-heading">
        <span className="eyebrow">TODAS LAS FUNCIONES</span>
        <h3>Qué encontrarás en cada pestaña</h3>
      </div>
      <div className="info-module-grid">
        {modules.map(({ view, title, description, icon: Icon }) => (
          <button className="panel info-module-card" type="button" key={view} onClick={() => onGo(view)}>
            <Icon size={22} />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <span className="info-open">Abrir →</span>
          </button>
        ))}
      </div>

      <div className="info-notes-grid">
        <div className="panel info-note-card">
          <ShieldCheck size={26} />
          <div>
            <h3>Tus compras siguen siendo privadas</h3>
            <p>
              Las compras, precios y listas se guardan en este navegador. Para llevarlos a otro
              dispositivo, crea una copia en Ajustes. El catálogo público solo contiene los
              productos que el administrador decide publicar.
            </p>
          </div>
        </div>
        <div className="panel info-note-card affiliate-info-card">
          <ExternalLink size={26} />
          <div>
            <h3>Enlaces de compra</h3>
            <p>
              Algunos productos recomendados contienen enlaces de afiliado. Las compras hechas
              desde ellos ayudan a mantener SmartMarket y no aumentan el precio para ti.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

async function createBackupPayload(): Promise<BackupPayload> {
  const [supermarkets, tickets, products, purchases, shoppingList] = await Promise.all([
    db.supermarkets.toArray(),
    db.tickets.toArray(),
    db.products.toArray(),
    db.purchases.toArray(),
    db.shoppingList.toArray(),
  ]);
  const serializedTickets = await Promise.all(
    tickets.map(async (ticket) => ({
      ...ticket,
      fileBlob: ticket.fileBlob ? await blobToDataUrl(ticket.fileBlob) : undefined,
    })),
  );
  const serializedProducts = await Promise.all(
    products.map(async (product) => ({
      ...product,
      photoBlob: product.photoBlob ? await blobToDataUrl(product.photoBlob) : undefined,
    })),
  );
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    supermarkets,
    tickets: serializedTickets,
    products: serializedProducts,
    purchases,
    shoppingList,
  };
}

function backupBlob(payload: BackupPayload) {
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
}

async function hasFolderWritePermission(folder: LocalDirectoryHandle, request: boolean) {
  if (!folder.queryPermission) return true;
  const options = { mode: "readwrite" } as const;
  if ((await folder.queryPermission(options)) === "granted") return true;
  if (request && folder.requestPermission)
    return (await folder.requestPermission(options)) === "granted";
  return false;
}

async function writeBackupFile(
  folder: LocalDirectoryHandle,
  payload: BackupPayload,
  filename: string,
) {
  const file = await folder.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(backupBlob(payload));
  await writable.close();
}

async function performAutomaticBackup(reason: AutoBackupReason): Promise<AutoBackupStatus> {
  const payload = await createBackupPayload();
  const at = new Date().toISOString();
  await db.appSettings.put({ key: INTERNAL_BACKUP_SETTING, value: payload, updatedAt: at });

  const storedFolder = await db.appSettings.get(BACKUP_FOLDER_SETTING);
  const folder = storedFolder?.value as LocalDirectoryHandle | undefined;
  let status: AutoBackupStatus = { at, reason, destination: "internal" };

  if (folder?.getFileHandle) {
    try {
      if (await hasFolderWritePermission(folder, false)) {
        await writeBackupFile(folder, payload, AUTOMATIC_BACKUP_FILENAME);
        status = { at, reason, destination: "folder", folderName: folder.name };
      } else {
        status.warning = "Vuelve a seleccionar la carpeta para reactivar el acceso de escritura.";
      }
    } catch {
      status.warning = "La copia interna se guardó, pero no se pudo escribir en la carpeta.";
    }
  }

  await db.appSettings.put({
    key: LAST_BACKUP_STATUS_SETTING,
    value: status,
    updatedAt: at,
  });
  return status;
}

function runAutomaticBackup(reason: AutoBackupReason) {
  if (automaticBackupInFlight) return automaticBackupInFlight;
  automaticBackupInFlight = performAutomaticBackup(reason).finally(() => {
    automaticBackupInFlight = null;
  });
  return automaticBackupInFlight;
}

function isBackupPayload(value: unknown): value is BackupPayload {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    Array.isArray(value["supermarkets"]) &&
    Array.isArray(value["tickets"]) &&
    Array.isArray(value["products"]) &&
    Array.isArray(value["purchases"])
  );
}

function SettingsView() {
  const [status, setStatus] = useState("");
  const [backupFolder, setBackupFolder] = useState<LocalDirectoryHandle | null>(null);
  const [sharedPreview, setSharedPreview] = useState<SharedListPreview>();
  const [selectedSharedProducts, setSelectedSharedProducts] = useState<number[]>([]);
  const canChooseFolder = typeof window !== "undefined" && "showDirectoryPicker" in window;
  const automaticBackup = useLiveQuery(
    () => db.appSettings.get(INTERNAL_BACKUP_SETTING),
    [],
  );
  const automaticBackupStatus = useLiveQuery(
    () => db.appSettings.get(LAST_BACKUP_STATUS_SETTING),
    [],
  )?.value as AutoBackupStatus | undefined;

  useEffect(() => {
    void db.appSettings.get(BACKUP_FOLDER_SETTING).then((setting) => {
      const folder = setting?.value as LocalDirectoryHandle | undefined;
      if (folder?.getFileHandle) setBackupFolder(folder);
    });
  }, []);

  async function shareProducts() {
    try {
      await exportSharedProducts();
      setStatus("Archivo de productos descargado. Ya puedes enviarlo a otra persona.");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : "No se pudo crear el archivo compartido.");
    }
  }

  async function previewSharedList(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !isRecord(parsed) ||
        parsed["kind"] !== "smartmarket-shared-list" ||
        parsed["version"] !== 1 ||
        !Array.isArray(parsed["products"]) ||
        !Array.isArray(parsed["supermarkets"]) ||
        !Array.isArray(parsed["purchases"]) ||
        !Array.isArray(parsed["shoppingList"])
      )
        throw new Error("Formato compartido no válido");
      const data = parsed as SharedListPayload;
      const existingProducts = await db.products.toArray();
      const matches: Record<number, "exact" | "similar"> = {};
      data.products.forEach((product, index) => {
        if (existingProducts.some((existing) => productsMatchExactly(existing, product)))
          matches[index] = "exact";
        else if (existingProducts.some((existing) => productsLookSimilar(existing, product)))
          matches[index] = "similar";
      });
      setSharedPreview({ data, matches });
      setSelectedSharedProducts(
        data.products.flatMap((_, index) => (matches[index] ? [] : [index])),
      );
      setStatus("");
    } catch {
      setStatus("No se pudo abrir el archivo: no parece una lista compartida de SmartMarket.");
    }
  }

  function toggleSharedProduct(index: number) {
    setSelectedSharedProducts((selected) =>
      selected.includes(index) ? selected.filter((item) => item !== index) : [...selected, index],
    );
  }

  async function mergeSharedList() {
    if (!sharedPreview || !selectedSharedProducts.length) return;
    const { data } = sharedPreview;
    const chosenIndexes = new Set(selectedSharedProducts);
    const chosenProducts = data.products.filter((_, index) => chosenIndexes.has(index));
    const chosenForeignIds = new Set(
      chosenProducts.flatMap((product) => (product.id ? [product.id] : [])),
    );
    const [existingProducts, existingStores, existingPurchases] = await Promise.all([
      db.products.toArray(),
      db.supermarkets.toArray(),
      db.purchases.toArray(),
    ]);
    const productIdMap = new Map<number, number>();
    const storeIdMap = new Map<number, number>();
    let addedProducts = 0;
    let reusedProducts = 0;
    let addedPrices = 0;

    await db.transaction(
      "rw",
      db.supermarkets,
      db.tickets,
      db.products,
      db.purchases,
      async () => {
        for (const incoming of chosenProducts) {
          if (!incoming.id) continue;
          const match = existingProducts.find((product) => productsMatchExactly(product, incoming));
          if (match?.id) {
            productIdMap.set(incoming.id, match.id);
            reusedProducts += 1;
            continue;
          }
          const { id: _id, photoBlob: _photoBlob, ...newProduct } = incoming;
          const id = await db.products.add(newProduct);
          productIdMap.set(incoming.id, id);
          addedProducts += 1;
        }

        const relevantPurchases = data.purchases.filter((purchase) =>
          chosenForeignIds.has(purchase.productId),
        );
        const relevantStoreIds = new Set(relevantPurchases.map((purchase) => purchase.supermarketId));
        for (const incoming of data.supermarkets.filter(
          (store) => store.id && relevantStoreIds.has(store.id),
        )) {
          if (!incoming.id) continue;
          const match = existingStores.find(
            (store) =>
              comparableText(store.name) === comparableText(incoming.name) &&
              comparableText(store.locality ?? "") === comparableText(incoming.locality ?? ""),
          );
          if (match?.id) storeIdMap.set(incoming.id, match.id);
          else {
            const { id: _id, ...newStore } = incoming;
            storeIdMap.set(incoming.id, await db.supermarkets.add(newStore));
          }
        }

        const importedPriceKeys = new Set<string>();
        const grouped = new Map<string, Purchase[]>();
        for (const purchase of relevantPurchases) {
          const productId = productIdMap.get(purchase.productId);
          const supermarketId = storeIdMap.get(purchase.supermarketId);
          if (!productId || !supermarketId) continue;
          const priceKey = [
            productId,
            supermarketId,
            purchase.date,
            purchase.normalizedUnit,
            purchase.normalizedUnitPrice.toFixed(4),
          ].join("|");
          const alreadyExists = existingPurchases.some(
            (existing) =>
              existing.productId === productId &&
              existing.supermarketId === supermarketId &&
              existing.date === purchase.date &&
              existing.normalizedUnit === purchase.normalizedUnit &&
              Math.abs(existing.normalizedUnitPrice - purchase.normalizedUnitPrice) < 0.0001,
          );
          if (alreadyExists || importedPriceKeys.has(priceKey)) continue;
          importedPriceKeys.add(priceKey);
          const groupKey = `${supermarketId}|${purchase.date}`;
          const rows = grouped.get(groupKey) ?? [];
          rows.push({ ...purchase, productId, supermarketId });
          grouped.set(groupKey, rows);
        }

        for (const rows of grouped.values()) {
          const first = rows[0]!;
          const ticketId = await db.tickets.add({
            supermarketId: first.supermarketId,
            date: first.date,
            total: rows.reduce((sum, row) => sum + Math.max(0, row.price - row.discount), 0),
            filename: "Lista compartida",
            fileType: "application/json",
            createdAt: new Date().toISOString(),
          });
          for (const row of rows) {
            const { id: _id, ticketId: _ticketId, ...purchase } = row;
            await db.purchases.add({ ...purchase, ticketId });
            addedPrices += 1;
          }
        }

      },
    );
    setSharedPreview(undefined);
    setStatus(
      `Importación fusionada: ${addedProducts} productos nuevos, ${reusedProducts} coincidentes y ${addedPrices} precios añadidos. Tus datos anteriores se han conservado.`,
    );
  }

  async function chooseBackupFolder() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      setStatus(
        "Safari no permite elegir una carpeta de escritura. Las copias se guardarán mediante Descargas.",
      );
      return;
    }
    try {
      const folder = await picker({ mode: "readwrite" });
      setBackupFolder(folder);
      await db.appSettings.put({
        key: BACKUP_FOLDER_SETTING,
        value: folder,
        updatedAt: new Date().toISOString(),
      });
      const backup = await runAutomaticBackup("startup");
      setStatus(
        backup.destination === "folder"
          ? `Carpeta seleccionada y primera copia guardada en ${folder.name}/${AUTOMATIC_BACKUP_FILENAME}.`
          : `Carpeta seleccionada: ${folder.name}. ${backup.warning ?? "La copia interna está activa."}`,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("No se pudo acceder a la carpeta seleccionada.");
    }
  }

  async function exportData() {
    const payload = await createBackupPayload();
    const blob = backupBlob(payload);
    const filename = `smartmarket-backup-${todayISO()}.json`;
    if (backupFolder) {
      try {
        if (!(await hasFolderWritePermission(backupFolder, true)))
          throw new Error("Permiso de escritura denegado");
        await writeBackupFile(backupFolder, payload, filename);
        setStatus(`Copia guardada en ${backupFolder.name}/${filename}.`);
        return;
      } catch {
        setStatus("No se pudo escribir en la carpeta. Se descargará la copia normalmente.");
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Copia de seguridad exportada correctamente.");
  }

  async function restoreBackup(data: BackupPayload) {
    const restoredTickets = data.tickets.map((ticket): Ticket => {
      const { fileBlob, ...rest } = ticket;
      return typeof fileBlob === "string" ? { ...rest, fileBlob: dataUrlToBlob(fileBlob) } : rest;
    });
    const restoredProducts = data.products.map((product): Product => {
      const { photoBlob, ...rest } = product;
      return typeof photoBlob === "string"
        ? { ...rest, photoBlob: dataUrlToBlob(photoBlob) }
        : rest;
    });
    await db.transaction(
      "rw",
      db.supermarkets,
      db.tickets,
      db.products,
      db.purchases,
      db.shoppingList,
      async () => {
        await Promise.all([
          db.supermarkets.clear(),
          db.tickets.clear(),
          db.products.clear(),
          db.purchases.clear(),
          db.shoppingList.clear(),
        ]);
        await db.supermarkets.bulkAdd(data.supermarkets);
        await db.products.bulkAdd(restoredProducts);
        await db.tickets.bulkAdd(restoredTickets);
        await db.purchases.bulkAdd(data.purchases);
        if (data.shoppingList?.length) await db.shoppingList.bulkAdd(data.shoppingList);
      },
    );
  }

  async function importData(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isBackupPayload(parsed)) throw new Error("Formato no válido");
      await restoreBackup(parsed);
      setStatus("Copia restaurada. Recarga la página si algún contador tarda en actualizarse.");
    } catch {
      setStatus("No se pudo importar el archivo: no parece una copia válida de SmartMarket.");
    }
  }

  async function restoreAutomaticBackup() {
    const payload = automaticBackup?.value;
    if (!isBackupPayload(payload)) {
      setStatus("Todavía no hay un autoguardado interno disponible.");
      return;
    }
    if (!confirm("Se sustituirán los datos actuales por el último autoguardado. ¿Continuar?"))
      return;
    try {
      await restoreBackup(payload);
      setStatus("Último autoguardado restaurado correctamente.");
    } catch {
      setStatus("No se pudo restaurar el autoguardado interno.");
    }
  }

  async function wipe() {
    if (
      !confirm(
        "Esto eliminará compras, productos, históricos y archivos guardados localmente. ¿Continuar?",
      )
    )
      return;
    await db.transaction("rw", db.tickets, db.products, db.purchases, db.shoppingList, async () => {
      await db.tickets.clear();
      await db.products.clear();
      await db.purchases.clear();
      await db.shoppingList.clear();
    });
    setStatus("Datos de compra eliminados.");
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">LOCAL Y PORTABLE</span>
          <h2>Ajustes y copia de seguridad</h2>
          <p>No necesitas una cuenta. Exporta un único archivo para llevarte todo tu histórico.</p>
        </div>
      </div>
      <div className="settings-grid">
        <div className="panel setting-card">
          <FolderOpen size={24} />
          <h3>Carpeta de copias</h3>
          <p>
            {backupFolder
              ? `Autoguardado cada hora y al cerrar en “${backupFolder.name}”.`
              : canChooseFolder
                ? "Elige una carpeta para guardar automáticamente una copia cada hora y al cerrar."
                : "Safari no permite escribir automáticamente en una carpeta. Se mantendrá una copia interna recuperable."}
          </p>
          <span className="backup-status">
            <Save size={14} />
            {automaticBackupStatus
              ? `Último autoguardado: ${new Date(automaticBackupStatus.at).toLocaleString("es-ES")}${automaticBackupStatus.destination === "folder" ? ` · ${automaticBackupStatus.folderName}` : " · copia interna"}`
              : "El primer autoguardado se creará al iniciar."}
          </span>
          {automaticBackupStatus?.warning && (
            <small className="backup-warning">{automaticBackupStatus.warning}</small>
          )}
          <button className="ghost" onClick={() => void chooseBackupFolder()}>
            <FolderOpen size={17} />
            {backupFolder ? "Cambiar carpeta" : "Seleccionar carpeta"}
          </button>
        </div>
        <div className="panel setting-card">
          <FileDown size={24} />
          <h3>Exportar copia</h3>
          <p>Incluye productos, precios y archivos originales de las compras.</p>
          <button className="primary" onClick={exportData}>
            <FileDown size={17} /> Exportar JSON
          </button>
          <button
            className="ghost"
            type="button"
            disabled={!automaticBackup}
            onClick={() => void restoreAutomaticBackup()}
          >
            <Database size={17} /> Restaurar último autoguardado
          </button>
        </div>
        <div className="panel setting-card">
          <Share2 size={24} />
          <h3>Compartir productos</h3>
          <p>Descarga tus productos guardados, supermercados y últimos precios para enviarlos.</p>
          <button className="primary" type="button" onClick={() => void shareProducts()}>
            <Share2 size={17} /> Descargar archivo
          </button>
        </div>
        <div className="panel setting-card">
          <FileUp size={24} />
          <h3>Incorporar productos compartidos</h3>
          <p>Selecciona y fusiona productos, supermercados y precios sin borrar tus datos.</p>
          <label className="file-button">
            <FileUp size={17} /> Abrir lista
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void previewSharedList(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
        <div className="panel setting-card">
          <FileUp size={24} />
          <h3>Restaurar copia</h3>
          <p>Sustituye los datos locales actuales por una copia previa.</p>
          <label className="file-button">
            <FileUp size={17} /> Elegir copia
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])}
            />
          </label>
        </div>
        <div className="panel setting-card danger-zone">
          <Trash2 size={24} />
          <h3>Borrar datos</h3>
          <p>Elimina compras e histórico de este navegador.</p>
          <button className="danger-button" onClick={wipe}>
            Borrar todo
          </button>
        </div>
      </div>
      {status && <div className="status-banner">{status}</div>}
      {sharedPreview && (
        <ModalPortal>
          <div className="modal-backdrop">
            <div className="modal shared-list-modal" role="dialog" aria-modal="true" aria-label="Revisar lista compartida">
            <div className="modal-head">
              <div>
                <span className="eyebrow">IMPORTACIÓN SIN BORRADO</span>
                <h2>Selecciona qué productos incorporar</h2>
                <p>
                  Los productos coincidentes usarán tu ficha actual. Solo se añadirán precios que no estén ya guardados.
                </p>
              </div>
              <button className="icon-btn" type="button" aria-label="Cerrar" onClick={() => setSharedPreview(undefined)}>
                <X size={18} />
              </button>
            </div>
            <div className="shared-list-tools">
              <strong>{selectedSharedProducts.length} de {sharedPreview.data.products.length} seleccionados</strong>
              <button className="ghost" type="button" onClick={() => setSelectedSharedProducts(sharedPreview.data.products.map((_, index) => index))}>
                Seleccionar todos
              </button>
              <button className="ghost" type="button" onClick={() => setSelectedSharedProducts([])}>
                Ninguno
              </button>
            </div>
            <div className="shared-product-list">
              {sharedPreview.data.products.map((product, index) => {
                const prices = product.id
                  ? sharedPreview.data.purchases.filter((purchase) => purchase.productId === product.id)
                  : [];
                const match = sharedPreview.matches[index];
                return (
                  <label className={selectedSharedProducts.includes(index) ? "shared-product selected" : "shared-product"} key={`${product.id ?? index}-${product.name}`}>
                    <input
                      type="checkbox"
                      checked={selectedSharedProducts.includes(index)}
                      onChange={() => toggleSharedProduct(index)}
                    />
                    <div>
                      <strong>{product.genericName || product.name}</strong>
                      <span>{product.brand || product.name} · {prices.length} precios compartidos</span>
                    </div>
                    {match === "exact" ? (
                      <em>YA EXISTE</em>
                    ) : match === "similar" ? (
                      <em className="similar">PRODUCTO SIMILAR</em>
                    ) : (
                      <em className="new">NUEVO</em>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="modal-footer shared-list-footer">
              <button className="ghost" type="button" onClick={() => setSharedPreview(undefined)}>Cancelar</button>
              <button className="primary" type="button" disabled={!selectedSharedProducts.length} onClick={() => void mergeSharedList()}>
                <Plus size={17} /> Incorporar seleccionados
              </button>
            </div>
            </div>
          </div>
        </ModalPortal>
      )}
      <div className="panel roadmap">
        <h3>Siguientes módulos previstos</h3>
        <div className="roadmap-grid">
          <RoadmapItem
            n="01"
            title="OCR local ✓"
            text="Ya disponible: imagen y PDF, reglas por cadena y pantalla de revisión previa."
          />
          <RoadmapItem
            n="02"
            title="Conectores"
            text="Mercadona, Eroski, Lidl, Aldi, DIA, Alcampo… con precio actual."
          />
          <RoadmapItem
            n="03"
            title="Cesta inteligente"
            text="Lista de compra y reparto óptimo entre supermercados."
          />
          <RoadmapItem
            n="04"
            title="Aprendizaje"
            text="Recordar abreviaturas de recibos, equivalencias y correcciones."
          />
        </div>
      </div>
    </section>
  );
}

type LocalWritableFile = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

type LocalFileHandle = {
  createWritable(): Promise<LocalWritableFile>;
};

type LocalDirectoryHandle = {
  name: string;
  getFileHandle(name: string, options: { create: boolean }): Promise<LocalFileHandle>;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<LocalDirectoryHandle>;
};

function RoadmapItem({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div className="roadmap-item">
      <span>{n}</span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <PackageSearch size={28} />
      <span>{text}</span>
    </div>
  );
}

function enrichPurchases(
  purchases: Purchase[],
  products: Product[],
  supermarkets: Supermarket[],
): EnrichedPurchase[] {
  return purchases.map((p) => ({
    ...p,
    product: products.find((x) => x.id === p.productId),
    supermarket: supermarkets.find((x) => x.id === p.supermarketId),
  }));
}

function detectAlerts(purchases: EnrichedPurchase[]) {
  const map = new Map<number, EnrichedPurchase[]>();
  for (const p of purchases) {
    const list = map.get(p.productId) ?? [];
    list.push(p);
    map.set(p.productId, list);
  }
  const alerts: Array<{ key: string; kind: "up" | "down"; title: string; detail: string }> = [];
  for (const [productId, list] of map) {
    const sorted = list.sort((a, b) => b.date.localeCompare(a.date));
    if (sorted.length < 2) continue;
    const latest = sorted[0]!;
    const prev = sorted[1]!;
    const product = latest.product;
    if (!product) continue;
    const delta = prev.normalizedUnitPrice
      ? (latest.normalizedUnitPrice / prev.normalizedUnitPrice - 1) * 100
      : 0;
    if (Math.abs(delta) >= 3)
      alerts.push({
        key: `${productId}-price`,
        kind: delta > 0 ? "up" : "down",
        title: `${product.name}: ${delta > 0 ? "sube" : "baja"} ${Math.abs(delta).toFixed(1)} %`,
        detail: `${formatUnitPrice(prev.normalizedUnitPrice, prev.normalizedUnit)} → ${formatUnitPrice(latest.normalizedUnitPrice, latest.normalizedUnit)}`,
      });
    if (latest.packageUnit === prev.packageUnit && latest.packageAmount < prev.packageAmount * 0.99)
      alerts.push({
        key: `${productId}-size`,
        kind: "up",
        title: `${product.name}: envase más pequeño`,
        detail: `${prev.packageAmount} ${prev.packageUnit} → ${latest.packageAmount} ${latest.packageUnit}`,
      });
  }
  return alerts;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
function dataUrlToBlob(dataUrl: string) {
  const [meta = "", b64 = ""] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);base64/)?.[1] ?? "application/octet-stream";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatDraftUnitPrice(
  line: Pick<
    TicketLineDraft,
    "price" | "discount" | "quantityPurchased" | "packageAmount" | "packageUnit"
  >,
) {
  if (line.price <= 0 || line.quantityPurchased <= 0 || line.packageAmount <= 0) return "—";
  const normalized = normalizeUnitPrice(
    line.price,
    line.discount,
    line.quantityPurchased,
    line.packageAmount,
    line.packageUnit,
  );
  return formatUnitPrice(normalized.value, normalized.unit);
}

async function optimizeProductPhoto(
  photo: File,
): Promise<Pick<Product, "photoName" | "photoType" | "photoBlob">> {
  const bitmap = await createImageBitmap(photo);
  try {
    const maxSide = 512;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas no disponible");
    context.drawImage(bitmap, 0, 0, width, height);
    const photoBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("No se pudo convertir la imagen"))),
        "image/webp",
        0.82,
      );
    });
    const baseName = photo.name.replace(/\.[^.]+$/, "") || "producto";
    return { photoName: `${baseName}.webp`, photoType: photoBlob.type, photoBlob };
  } finally {
    bitmap.close();
  }
}

export default App;
