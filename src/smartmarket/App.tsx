import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Database,
  FileDown,
  FileUp,
  FolderOpen,
  History,
  Home,
  ImagePlus,
  ListChecks,
  ExternalLink,
  MapPin,
  PackageSearch,
  Plus,
  ReceiptText,
  Save,
  Scale,
  Settings,
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
  | "tickets"
  | "products"
  | "supermarkets"
  | "shopping-list"
  | "compare"
  | "history"
  | "medina"
  | "settings";

type EnrichedPurchase = Purchase & {
  product: Product | undefined;
  supermarket: Supermarket | undefined;
};
type ImportedTicket = Omit<Ticket, "fileBlob"> & { fileBlob?: unknown };
type ImportedProduct = Omit<Product, "photoBlob"> & { photoBlob?: unknown };
type BackupPayload = {
  version: number;
  supermarkets: Supermarket[];
  tickets: ImportedTicket[];
  products: ImportedProduct[];
  purchases: Purchase[];
  shoppingList?: ShoppingListItem[];
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
                Cierra otras pestañas de SmartMarket y vuelve a intentarlo. Tus tickets no se
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
        {view === "tickets" && <TicketsView />}
        {view === "products" && <ProductsView />}
        {view === "supermarkets" && <SupermarketsView />}
        {view === "shopping-list" && <ShoppingListView />}
        {view === "compare" && <CompareView />}
        {view === "history" && <HistoryView />}
        {view === "medina" && <MedinaView />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const items: Array<{ id: View; label: string; icon: typeof Home }> = [
    { id: "dashboard", label: "Inicio", icon: Home },
    { id: "tickets", label: "Tickets", icon: ReceiptText },
    { id: "products", label: "Productos", icon: ShoppingBasket },
    { id: "supermarkets", label: "Supermercados", icon: Store },
    { id: "shopping-list", label: "Lista de la compra", icon: ListChecks },
    { id: "compare", label: "Comparador", icon: Scale },
    { id: "history", label: "Histórico", icon: History },
    { id: "medina", label: "Medina de Pomar", icon: MapPin },
    { id: "settings", label: "Ajustes", icon: Settings },
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
          <span>Los tickets y precios se guardan en este dispositivo.</span>
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
          <button className="primary" onClick={() => onGo("tickets")}>
            <Upload size={18} /> Añadir ticket
          </button>
        </div>
        <div className="metric-feature">
          <span>Gasto este mes</span>
          <strong>{money(monthSpend)}</strong>
          <small>
            {tickets.filter((t) => t.date.startsWith(thisMonth)).length} tickets registrados
          </small>
        </div>
      </div>

      <div className="metrics-grid">
        <Metric icon={ReceiptText} label="Tickets" value={String(tickets.length)} />
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
            <li>Guardar tickets e imagen/PDF original en IndexedDB.</li>
            <li>Editar productos, marcas, formatos, cantidades y descuentos.</li>
            <li>Agrupar marcas diferentes como el mismo producto genérico.</li>
            <li>Comparar automáticamente por €/kg, €/L o unidad.</li>
            <li>Valorar productos con 1–5 estrellas.</li>
            <li>Detectar subida de precio unitario y reducción de envase.</li>
            <li>Leer tickets en imagen o PDF con OCR local y revisión previa.</li>
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

function TicketsView() {
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
    if (!ticket.id || !confirm("¿Eliminar este ticket y sus líneas de compra?")) return;
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
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">RECIBOS</span>
          <h2>Tickets de compra</h2>
          <p>El archivo original se guarda en tu navegador; las líneas son siempre editables.</p>
        </div>
        <button className="primary" onClick={openNew}>
          <Plus size={18} /> Nuevo ticket
        </button>
      </div>

      <div className="metrics-grid ticket-metrics">
        <Metric icon={ReceiptText} label="Tickets este mes" value={String(monthTickets.length)} />
        <Metric icon={ShoppingBasket} label="Líneas guardadas" value={String(purchases.length)} />
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
          <h3>Aún no has añadido tickets</h3>
          <p>Empieza con uno: puedes leerlo con el OCR local o registrar los productos a mano.</p>
          <button className="primary" onClick={openNew}>
            Añadir primer ticket
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
                    aria-label="Eliminar ticket"
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
    </section>
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
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStage, setOcrStage] = useState("");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrReview, setOcrReview] = useState<OcrResult | null>(null);
  const [ocrError, setOcrError] = useState("");

  async function runOcr() {
    if (!file) {
      setOcrError("Selecciona antes la imagen o el PDF del ticket.");
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
      setOcrError(`No se pudo leer el ticket en este dispositivo: ${(e as Error).message}`);
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
    const valid = lines.filter(
      (l) => l.productName.trim() && l.price >= 0 && l.packageAmount > 0 && l.quantityPurchased > 0,
    );
    if (!supermarketId) return setError("Selecciona un supermercado.");
    if (!valid.length) return setError("Añade al menos un producto con nombre, formato y precio.");

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

      for (const line of valid) {
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
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={ticketId ? "Editar ticket" : "Nuevo ticket"}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">{ticketId ? "EDITAR" : "NUEVO"}</span>
            <h2>{ticketId ? "Editar ticket" : "Registrar ticket"}</h2>
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
            Ticket (imagen/PDF)
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
              <Wand2 size={17} /> {ocrBusy ? "Leyendo…" : "Leer ticket con OCR"}
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
            <button className="primary" onClick={save}>
              <Save size={17} /> Guardar ticket
            </button>
          </div>
        </div>
      </div>
    </div>
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
              ? `Total del ticket: ${money(result.total)}`
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
                <th>Nombre en ticket</th>
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
          tickets.
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
            <Save size={17} /> Pasar {selected.length} líneas al ticket
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductsView() {
  const products = useLiveQuery(() => db.products.orderBy("genericName").toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchases.toArray(), []) ?? [];
  const supermarkets = useLiveQuery(() => db.supermarkets.toArray(), []) ?? [];
  const [query, setQuery] = useState("");
  const filtered = products.filter((p) =>
    `${p.name} ${p.brand} ${p.genericName}`.toLowerCase().includes(query.toLowerCase()),
  );

  async function setRating(product: Product, rating: number) {
    if (product.id) await db.products.update(product.id, { rating });
  }
  async function updateGenericName(product: Product, value: string) {
    if (product.id) await db.products.update(product.id, { genericName: value });
  }
  async function updateCategory(product: Product, category: string) {
    if (product.id) await db.products.update(product.id, { category });
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
        "Este producto tiene compras asociadas. Edita o elimina primero los tickets correspondientes.",
      );
    await db.products.delete(product.id);
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CATÁLOGO PERSONAL</span>
          <h2>Productos y equivalencias</h2>
          <p>El campo “Producto genérico” une marcas diferentes para poder compararlas.</p>
        </div>
        <input
          className="search"
          placeholder="Buscar producto…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <div className="panel">
          <Empty text="Añade un ticket para empezar a construir tu catálogo." />
        </div>
      ) : (
        <div className="product-list">
          {filtered.map((product) => {
            const pp = purchases
              .filter((p) => p.productId === product.id)
              .sort((a, b) => b.date.localeCompare(a.date));
            const latest = pp[0];
            const market = supermarkets.find((s) => s.id === latest?.supermarketId)?.name;
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
                  <div>
                    <strong>{product.name}</strong>
                    <span>
                      {product.brand || "Sin marca"} · {product.category}
                    </span>
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
                <div className="latest-price">
                  <span>{market ? `Último: ${market}` : "Sin compras"}</span>
                  <strong>
                    {latest
                      ? formatUnitPrice(latest.normalizedUnitPrice, latest.normalizedUnit)
                      : "—"}
                  </strong>
                </div>
                <button className="icon-btn danger" onClick={() => deleteProduct(product)}>
                  <Trash2 size={16} />
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProductPhoto({ blob, alt }: { blob: Blob; alt: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="product-photo" src={url} alt={alt} />;
}

function SupermarketsView() {
  const productRecords = useLiveQuery(() => db.products.toArray(), []);
  const purchaseRecords = useLiveQuery(() => db.purchases.toArray(), []);
  const supermarketRecords = useLiveQuery(() => db.supermarkets.toArray(), []);
  const products = useMemo(() => productRecords ?? [], [productRecords]);
  const purchases = useMemo(() => purchaseRecords ?? [], [purchaseRecords]);
  const supermarkets = useMemo(() => supermarketRecords ?? [], [supermarketRecords]);
  const storesWithPurchases = new Set(purchases.map((purchase) => purchase.supermarketId)).size;

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
        <Empty text="Añade tickets para ver qué productos has comprado en cada supermercado." />
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
        {options.map((option) => (
          <label key={option} className={selected.includes(option) ? "selected" : ""}>
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => toggle(option)}
            />
            {option}
          </label>
        ))}
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
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionReady, setSelectionReady] = useState(false);
  useEffect(() => {
    if (!selectionReady && genericNames[0]) {
      setSelected([genericNames[0]]);
      setSelectionReady(true);
    }
  }, [selectionReady, genericNames]);

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
        <ProductMultiSelect options={genericNames} selected={selected} onChange={setSelected} />
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
  const chartData = months.map((month) => {
    const point: Record<string, string | number> = {
      month,
      label: new Date(`${month}-01T00:00:00`).toLocaleDateString("es-ES", {
        month: "short",
        year: "2-digit",
      }),
    };
    for (const row of monthlyRows.filter((candidate) => candidate.month === month))
      point[row.genericName] = Number(row.average.toFixed(2));
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
            <Metric icon={BarChart3} label="Meses analizados" value={String(months.length)} />
          </div>
          <div className="panel chart-panel">
            <div className="panel-title">
              <div>
                <h3>Evolución mensual</h3>
                <p>Precio medio comparable de todos los supermercados en cada mes.</p>
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
            Registra los tickets con la ubicación de Medina y comprobaremos con tus propios datos si
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
        <Metric icon={ReceiptText} label="Tickets de Medina" value={String(medinaTickets.length)} />
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
                  <span>Tickets</span>
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

function SettingsView() {
  const [status, setStatus] = useState("");
  const [backupFolder, setBackupFolder] = useState<LocalDirectoryHandle | null>(null);
  const canChooseFolder = typeof window !== "undefined" && "showDirectoryPicker" in window;

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
      setStatus(`Carpeta seleccionada: ${folder.name}.`);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("No se pudo acceder a la carpeta seleccionada.");
    }
  }

  async function exportData() {
    const [supermarkets, tickets, products, purchases, shoppingList] = await Promise.all([
      db.supermarkets.toArray(),
      db.tickets.toArray(),
      db.products.toArray(),
      db.purchases.toArray(),
      db.shoppingList.toArray(),
    ]);
    const serializedTickets = await Promise.all(
      tickets.map(async (t) => ({
        ...t,
        fileBlob: t.fileBlob ? await blobToDataUrl(t.fileBlob) : undefined,
      })),
    );
    const serializedProducts = await Promise.all(
      products.map(async (p) => ({
        ...p,
        photoBlob: p.photoBlob ? await blobToDataUrl(p.photoBlob) : undefined,
      })),
    );
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      supermarkets,
      tickets: serializedTickets,
      products: serializedProducts,
      purchases,
      shoppingList,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const filename = `smartmarket-backup-${todayISO()}.json`;
    if (backupFolder) {
      try {
        const file = await backupFolder.getFileHandle(filename, { create: true });
        const writable = await file.createWritable();
        await writable.write(blob);
        await writable.close();
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

  async function importData(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !isRecord(parsed) ||
        parsed["version"] !== 1 ||
        !Array.isArray(parsed["supermarkets"]) ||
        !Array.isArray(parsed["tickets"]) ||
        !Array.isArray(parsed["products"]) ||
        !Array.isArray(parsed["purchases"])
      )
        throw new Error("Formato no válido");
      const data = parsed as BackupPayload;
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
      setStatus("Copia restaurada. Recarga la página si algún contador tarda en actualizarse.");
    } catch {
      setStatus("No se pudo importar el archivo: no parece una copia válida de SmartMarket.");
    }
  }

  async function wipe() {
    if (
      !confirm(
        "Esto eliminará tickets, productos, históricos y archivos guardados localmente. ¿Continuar?",
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
              ? `Las próximas copias se guardarán en “${backupFolder.name}”.`
              : canChooseFolder
                ? "Elige dónde guardar directamente las próximas copias JSON."
                : "Safari guardará las copias en la carpeta de Descargas configurada."}
          </p>
          <button className="ghost" onClick={() => void chooseBackupFolder()}>
            <FolderOpen size={17} />
            {backupFolder ? "Cambiar carpeta" : "Seleccionar carpeta"}
          </button>
        </div>
        <div className="panel setting-card">
          <FileDown size={24} />
          <h3>Exportar copia</h3>
          <p>Incluye base de datos y archivos originales de tickets.</p>
          <button className="primary" onClick={exportData}>
            <FileDown size={17} /> Exportar JSON
          </button>
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
            text="Recordar abreviaturas de ticket, equivalencias y correcciones."
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
