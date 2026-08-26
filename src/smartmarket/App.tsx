import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Database,
  FileDown,
  FileUp,
  History,
  Home,
  ImagePlus,
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
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { db, ensureDefaults } from './db';
import { extractText } from './ocr';
import { parseReceiptText, type OcrLineDraft, type OcrResult } from './parser';
import type { PackageUnit, Product, Purchase, Supermarket, Ticket, TicketLineDraft } from './types';
import { formatUnitPrice, money, normalizeUnitPrice, parseNumber, pct, todayISO, uid } from './utils';

// dexie-react-hooks is intentionally imported as a separate package to keep all persistence local.
// See package.json; Lovable can safely edit this file without requiring a backend.

type View = 'dashboard' | 'tickets' | 'products' | 'compare' | 'history' | 'settings';

type EnrichedPurchase = Purchase & { product: Product | undefined; supermarket: Supermarket | undefined };

const emptyLine = (): TicketLineDraft => ({
  id: uid(),
  productName: '',
  genericName: '',
  brand: '',
  category: 'Alimentación',
  quantityPurchased: 1,
  packageAmount: 1,
  packageUnit: 'ud',
  price: 0,
  discount: 0,
});

function App() {
  const [view, setView] = useState<View>('dashboard');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureDefaults().then(() => setReady(true));
  }, []);

  if (!ready) return <div className="boot">Preparando la base de datos local…</div>;

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} />
      <main className="main-content">
        <Topbar />
        {view === 'dashboard' && <Dashboard onGo={setView} />}
        {view === 'tickets' && <TicketsView />}
        {view === 'products' && <ProductsView />}
        {view === 'compare' && <CompareView />}
        {view === 'history' && <HistoryView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const items: Array<{ id: View; label: string; icon: typeof Home }> = [
    { id: 'dashboard', label: 'Inicio', icon: Home },
    { id: 'tickets', label: 'Tickets', icon: ReceiptText },
    { id: 'products', label: 'Productos', icon: ShoppingBasket },
    { id: 'compare', label: 'Comparador', icon: Scale },
    { id: 'history', label: 'Histórico', icon: History },
    { id: 'settings', label: 'Ajustes', icon: Settings },
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><ShoppingBasket size={22} /></div>
        <div><strong>SmartMarket</strong><span>Local</span></div>
      </div>
      <nav>
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)}>
            <Icon size={19} /> {label}
          </button>
        ))}
      </nav>
      <div className="privacy-card">
        <Database size={18} />
        <div><strong>100 % local</strong><span>Los tickets y precios se guardan en este dispositivo.</span></div>
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
  const monthSpend = tickets.filter((t) => t.date.startsWith(thisMonth)).reduce((a, b) => a + b.total, 0);
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
            <p>Compara por €/kg, €/L o unidad, incluso entre marcas distintas, y ten en cuenta tus favoritos.</p>
          </div>
          <button className="primary" onClick={() => onGo('tickets')}><Upload size={18} /> Añadir ticket</button>
        </div>
        <div className="metric-feature">
          <span>Gasto este mes</span><strong>{money(monthSpend)}</strong>
          <small>{tickets.filter((t) => t.date.startsWith(thisMonth)).length} tickets registrados</small>
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
          <div className="panel-title"><div><h3>Cambios detectados</h3><p>Comparando tus últimas compras.</p></div><AlertTriangle size={20} /></div>
          {alerts.length === 0 ? <Empty text="Todavía no hay suficiente histórico para detectar cambios." /> : (
            <div className="alert-list">
              {alerts.slice(0, 6).map((a) => (
                <div className="alert-row" key={a.key}>
                  <div className={a.kind === 'up' ? 'trend up' : 'trend down'}>{a.kind === 'up' ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}</div>
                  <div><strong>{a.title}</strong><span>{a.detail}</span></div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="panel-title"><div><h3>Qué puede hacer ya</h3><p>Primera versión funcional.</p></div><BarChart3 size={20} /></div>
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
  return <div className="metric"><Icon size={20} /><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function TicketsView() {
  const supermarkets = useLiveQuery(() => db.supermarkets.toArray(), []) ?? [];
  const tickets = useLiveQuery(() => db.tickets.orderBy('date').reverse().toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchases.toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const openNew = () => { setEditingId(null); setShowEditor(true); };
  const openEdit = (id: number) => { setEditingId(id); setShowEditor(true); };

  async function removeTicket(ticket: Ticket) {
    if (!ticket.id || !confirm('¿Eliminar este ticket y sus líneas de compra?')) return;
    await db.transaction('rw', db.tickets, db.purchases, async () => {
      await db.purchases.where('ticketId').equals(ticket.id!).delete();
      await db.tickets.delete(ticket.id!);
    });
  }

  function openOriginal(ticket: Ticket) {
    if (!ticket.fileBlob) return;
    const url = URL.createObjectURL(ticket.fileBlob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div><span className="eyebrow">RECIBOS</span><h2>Tickets de compra</h2><p>El archivo original se guarda en tu navegador; las líneas son siempre editables.</p></div>
        <button className="primary" onClick={openNew}><Plus size={18} /> Nuevo ticket</button>
      </div>

      {tickets.length === 0 ? (
        <div className="panel empty-large"><ReceiptText size={36} /><h3>Aún no has añadido tickets</h3><p>Empieza con uno: puedes leerlo con el OCR local o registrar los productos a mano.</p><button className="primary" onClick={openNew}>Añadir primer ticket</button></div>
      ) : (
        <div className="ticket-grid">
          {tickets.map((ticket) => {
            const market = supermarkets.find((s) => s.id === ticket.supermarketId)?.name ?? 'Supermercado';
            const count = purchases.filter((p) => p.ticketId === ticket.id).length;
            return (
              <article className="ticket-card" key={ticket.id}>
                <div className="ticket-head"><div className="store-icon"><Store size={20} /></div><div><strong>{market}</strong><span>{new Date(`${ticket.date}T00:00:00`).toLocaleDateString('es-ES')}</span></div></div>
                <div className="ticket-total"><span>Total</span><strong>{money(ticket.total)}</strong></div>
                <div className="ticket-meta"><span>{count} productos</span><span>{ticket.filename || 'Sin archivo adjunto'}</span></div>
                <div className="ticket-actions">
                  {ticket.fileBlob && <button className="ghost" onClick={() => openOriginal(ticket)}>Ver original</button>}
                  <button className="ghost" onClick={() => openEdit(ticket.id!)}>Editar</button>
                  <button className="icon-btn danger" aria-label="Eliminar ticket" onClick={() => removeTicket(ticket)}><Trash2 size={17} /></button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {showEditor && <TicketEditor ticketId={editingId} supermarkets={supermarkets} products={products} purchases={purchases} onClose={() => setShowEditor(false)} />}
    </section>
  );
}

function TicketEditor({ ticketId, supermarkets, products, purchases, onClose }: {
  ticketId: number | null;
  supermarkets: Supermarket[];
  products: Product[];
  purchases: Purchase[];
  onClose: () => void;
}) {
  const existingTicket = useLiveQuery(async (): Promise<Ticket | undefined> => (ticketId ? db.tickets.get(ticketId) : undefined), [ticketId]);
  const [supermarketId, setSupermarketId] = useState<number>(supermarkets[0]?.id ?? 0);
  const [date, setDate] = useState(todayISO());
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<TicketLineDraft[]>([emptyLine()]);
  const [loaded, setLoaded] = useState(ticketId === null);
  const [error, setError] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStage, setOcrStage] = useState('');
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrReview, setOcrReview] = useState<OcrResult | null>(null);
  const [ocrError, setOcrError] = useState('');

  async function runOcr() {
    if (!file) { setOcrError('Selecciona antes la imagen o el PDF del ticket.'); return; }
    setOcrError(''); setOcrBusy(true); setOcrProgress(0); setOcrStage('Iniciando OCR local');
    try {
      const eqs = await db.equivalences.toArray();
      const map = Object.fromEntries(eqs.map((e) => [e.rawName, e.genericName]));
      const text = await extractText(file, (stage, progress) => { setOcrStage(stage); setOcrProgress(progress); });
      const parsed = parseReceiptText(text, map);
      setOcrReview(parsed);
      if (parsed.date) setDate(parsed.date);
      if (parsed.supermarket) {
        const match = supermarkets.find((s) => s.name.toLowerCase() === parsed.supermarket!.toLowerCase());
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
    const sourceLines = purchases.filter((p) => p.ticketId === ticketId).map((p) => {
      const product = products.find((x) => x.id === p.productId);
      return {
        id: uid(),
        productName: product?.name ?? p.rawName,
        genericName: product?.genericName ?? product?.name ?? p.rawName,
        brand: product?.brand ?? '',
        category: product?.category ?? 'Alimentación',
        quantityPurchased: p.quantityPurchased,
        packageAmount: p.packageAmount,
        packageUnit: p.packageUnit,
        price: p.price,
        discount: p.discount,
        ...(product?.photoBlob ? { photoName: product.photoName ?? 'producto', photoType: product.photoType ?? product.photoBlob.type, photoBlob: product.photoBlob } : {}),
      } satisfies TicketLineDraft;
    });
    setSupermarketId(existingTicket.supermarketId);
    setDate(existingTicket.date);
    setLines(sourceLines.length ? sourceLines : [emptyLine()]);
    setLoaded(true);
  }, [ticketId, existingTicket, loaded, purchases, products]);

  const computedTotal = lines.reduce((sum, l) => sum + Math.max(0, l.price - l.discount), 0);

  function updateLine(id: string, patch: Partial<TicketLineDraft>) {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, ...patch } : l));
  }

  async function save() {
    setError('');
    const valid = lines.filter((l) => l.productName.trim() && l.price >= 0 && l.packageAmount > 0 && l.quantityPurchased > 0);
    if (!supermarketId) return setError('Selecciona un supermercado.');
    if (!valid.length) return setError('Añade al menos un producto con nombre, formato y precio.');

    await db.transaction('rw', db.tickets, db.products, db.purchases, db.equivalences, async () => {
      let currentId = ticketId;
      if (currentId) {
        const old = await db.tickets.get(currentId);
        await db.tickets.update(currentId, {
          supermarketId,
          date,
          total: computedTotal,
          ...(file ? { filename: file.name, fileType: file.type, fileBlob: file } : old ? { filename: old.filename, fileType: old.fileType, fileBlob: old.fileBlob } : {}),
        });
        await db.purchases.where('ticketId').equals(currentId).delete();
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
        let product = await db.products.filter((p) => p.name.toLowerCase() === name.toLowerCase() && p.brand.toLowerCase() === brand.toLowerCase()).first();
        if (!product) {
          const productId = await db.products.add({
            name, brand, genericName, category: line.category.trim() || 'Sin categoría', rating: 0, notes: '',
            ...(line.photoBlob ? { photoName: line.photoName, photoType: line.photoType, photoBlob: line.photoBlob } : {}),
          });
          product = await db.products.get(productId);
        } else if (product.genericName !== genericName || product.category !== line.category || line.photoBlob) {
          const updates = {
            genericName,
            category: line.category.trim() || 'Sin categoría',
            ...(line.photoBlob ? { photoName: line.photoName, photoType: line.photoType, photoBlob: line.photoBlob } : {}),
          };
          await db.products.update(product.id!, updates);
          product = { ...product, ...updates };
        }
        const rawKey = line.productName.trim().toLowerCase();
        const existingEq = await db.equivalences.where('rawName').equals(rawKey).first();
        if (existingEq?.id) await db.equivalences.update(existingEq.id, { genericName, brand, productName: name });
        else await db.equivalences.add({ rawName: rawKey, genericName, brand, productName: name });

        const normalized = normalizeUnitPrice(line.price, line.discount, line.quantityPurchased, line.packageAmount, line.packageUnit);
        await db.purchases.add({
          ticketId: currentId!, productId: product!.id!, supermarketId, date,
          rawName: name, quantityPurchased: line.quantityPurchased, packageAmount: line.packageAmount,
          packageUnit: line.packageUnit, price: line.price, discount: line.discount,
          normalizedUnitPrice: normalized.value, normalizedUnit: normalized.unit,
        });
      }
    });
    onClose();
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={ticketId ? 'Editar ticket' : 'Nuevo ticket'}>
        <div className="modal-head"><div><span className="eyebrow">{ticketId ? 'EDITAR' : 'NUEVO'}</span><h2>{ticketId ? 'Editar ticket' : 'Registrar ticket'}</h2></div><button className="icon-btn" onClick={onClose}><X size={20} /></button></div>
        <div className="form-grid three">
          <label>Supermercado<select value={supermarketId} onChange={(e) => setSupermarketId(Number(e.target.value))}>{supermarkets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Fecha<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Ticket (imagen/PDF)<input type="file" accept="image/*,.pdf,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        </div>
        <div className="ocr-note">
          <ScanText size={17} />
          <div className="ocr-note-body">
            <div>
              <strong>OCR 100 % local</strong>
              <span>La imagen o el PDF nunca salen de este dispositivo: el reconocimiento se ejecuta en tu navegador. Revisarás cada línea antes de guardar.</span>
              {ocrBusy && <span className="ocr-progress">{ocrStage} · {Math.round(ocrProgress * 100)} %</span>}
              {ocrError && <span className="error">{ocrError}</span>}
            </div>
            <button className="primary" type="button" onClick={runOcr} disabled={ocrBusy}>
              <Wand2 size={17} /> {ocrBusy ? 'Leyendo…' : 'Leer ticket con OCR'}
            </button>
          </div>
        </div>
        {ocrReview && <OcrReview result={ocrReview} onCancel={() => setOcrReview(null)} onApply={applyOcrLines} />}
        <div className="line-table-wrap">
          <table className="line-table">
            <thead><tr><th>Foto</th><th>Producto</th><th>Producto genérico</th><th>Marca</th><th>Formato</th><th>Uds.</th><th>Precio</th><th>Dto.</th><th></th></tr></thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <label className="product-photo-picker" title="Subir foto del producto">
                      {line.photoBlob ? <ProductPhoto blob={line.photoBlob} alt={line.productName || 'Producto'} /> : <ImagePlus size={18} />}
                      <input type="file" accept="image/*" capture="environment" onChange={(e) => {
                        const photo = e.target.files?.[0];
                        if (!photo) return;
                        if (photo.size > 8 * 1024 * 1024) { setError('La foto del producto no puede superar 8 MB.'); return; }
                        setError('');
                        updateLine(line.id, { photoName: photo.name, photoType: photo.type, photoBlob: photo });
                      }} />
                    </label>
                  </td>
                  <td><input value={line.productName} onChange={(e) => updateLine(line.id, { productName: e.target.value })} placeholder="Atún Hacendado" /></td>
                  <td><input value={line.genericName} onChange={(e) => updateLine(line.id, { genericName: e.target.value })} placeholder="Atún en aceite de oliva" /></td>
                  <td><input value={line.brand} onChange={(e) => updateLine(line.id, { brand: e.target.value })} placeholder="Hacendado" /></td>
                  <td><div className="format-input"><input type="number" min="0.001" step="0.001" value={line.packageAmount} onChange={(e) => updateLine(line.id, { packageAmount: parseNumber(e.target.value) })} /><select value={line.packageUnit} onChange={(e) => updateLine(line.id, { packageUnit: e.target.value as PackageUnit })}><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="l">L</option><option value="ud">ud</option></select></div></td>
                  <td><input type="number" min="0.01" step="1" value={line.quantityPurchased} onChange={(e) => updateLine(line.id, { quantityPurchased: parseNumber(e.target.value) })} /></td>
                  <td><input type="number" min="0" step="0.01" value={line.price} onChange={(e) => updateLine(line.id, { price: parseNumber(e.target.value) })} /></td>
                  <td><input type="number" min="0" step="0.01" value={line.discount} onChange={(e) => updateLine(line.id, { discount: parseNumber(e.target.value) })} /></td>
                  <td><button className="icon-btn danger" onClick={() => setLines((p) => p.filter((x) => x.id !== line.id))}><Trash2 size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="ghost add-line" onClick={() => setLines((p) => [...p, emptyLine()])}><Plus size={17} /> Añadir producto</button>
        <div className="modal-footer"><div><span>Total calculado</span><strong>{money(computedTotal)}</strong></div><div>{error && <span className="error">{error}</span>}<button className="ghost" onClick={onClose}>Cancelar</button><button className="primary" onClick={save}><Save size={17} /> Guardar ticket</button></div></div>
      </div>
    </div>
  );
}

function OcrReview({ result, onCancel, onApply }: {
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
            {result.supermarket ? `Supermercado: ${result.supermarket}` : 'Supermercado no detectado'} ·{' '}
            {result.date ? `Fecha: ${result.date}` : 'Fecha no detectada'} ·{' '}
            {result.total !== null ? `Total del ticket: ${money(result.total)}` : 'Total no detectado'}
          </p>
        </div>
        <button className="ghost" type="button" onClick={() => setShowText((v) => !v)}>
          {showText ? 'Ocultar texto' : 'Ver texto reconocido'}
        </button>
      </div>

      {showText && <pre className="ocr-raw">{result.rawText}</pre>}

      {draft.length === 0 ? (
        <Empty text="No se han reconocido líneas con precio. Puedes añadirlas manualmente en la tabla inferior." />
      ) : (
        <div className="line-table-wrap">
          <table className="line-table">
            <thead>
              <tr><th>Usar</th><th>Nombre en ticket</th><th>Nombre normalizado</th><th>Producto genérico</th><th>Marca</th><th>Formato</th><th>Uds.</th><th>Precio</th><th>Dto.</th><th>Fiab.</th></tr>
            </thead>
            <tbody>
              {draft.map((line) => (
                <tr key={line.id} className={skipped[line.id] ? 'skipped' : ''}>
                  <td><input type="checkbox" checked={!skipped[line.id]} onChange={(e) => setSkipped((p) => ({ ...p, [line.id]: !e.target.checked }))} /></td>
                  <td className="raw-cell">{line.rawLine}</td>
                  <td><input value={line.productName} onChange={(e) => update(line.id, { productName: e.target.value })} /></td>
                  <td><input value={line.genericName} onChange={(e) => update(line.id, { genericName: e.target.value })} /></td>
                  <td><input value={line.brand} onChange={(e) => update(line.id, { brand: e.target.value })} /></td>
                  <td>
                    <div className="format-input">
                      <input type="number" step="0.001" value={line.packageAmount} onChange={(e) => update(line.id, { packageAmount: parseNumber(e.target.value) })} />
                      <select value={line.packageUnit} onChange={(e) => update(line.id, { packageUnit: e.target.value as PackageUnit })}>
                        <option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="l">L</option><option value="ud">ud</option>
                      </select>
                    </div>
                  </td>
                  <td><input type="number" step="1" value={line.quantityPurchased} onChange={(e) => update(line.id, { quantityPurchased: parseNumber(e.target.value) })} /></td>
                  <td><input type="number" step="0.01" value={line.price} onChange={(e) => update(line.id, { price: parseNumber(e.target.value) })} /></td>
                  <td><input type="number" step="0.01" value={line.discount} onChange={(e) => update(line.id, { discount: parseNumber(e.target.value) })} /></td>
                  <td><span className={`conf ${line.confidence}`}>{line.confidence}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="ocr-review-actions">
        <span>Tus correcciones se guardan como equivalencias locales y se reutilizarán en próximos tickets.</span>
        <div>
          <button className="ghost" type="button" onClick={onCancel}>Descartar</button>
          <button className="primary" type="button" disabled={!selected.length} onClick={() => onApply(selected)}>
            <Save size={17} /> Pasar {selected.length} líneas al ticket
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductsView() {
  const products = useLiveQuery(() => db.products.orderBy('genericName').toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchases.toArray(), []) ?? [];
  const supermarkets = useLiveQuery(() => db.supermarkets.toArray(), []) ?? [];
  const [query, setQuery] = useState('');
  const filtered = products.filter((p) => `${p.name} ${p.brand} ${p.genericName}`.toLowerCase().includes(query.toLowerCase()));

  async function setRating(product: Product, rating: number) { if (product.id) await db.products.update(product.id, { rating }); }
  async function updateGenericName(product: Product, value: string) { if (product.id) await db.products.update(product.id, { genericName: value }); }
  async function deleteProduct(product: Product) {
    if (!product.id || purchases.some((p) => p.productId === product.id)) return alert('Este producto tiene compras asociadas. Edita o elimina primero los tickets correspondientes.');
    await db.products.delete(product.id);
  }

  return (
    <section className="page">
      <div className="page-heading"><div><span className="eyebrow">CATÁLOGO PERSONAL</span><h2>Productos y equivalencias</h2><p>El campo “Producto genérico” une marcas diferentes para poder compararlas.</p></div><input className="search" placeholder="Buscar producto…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      {filtered.length === 0 ? <div className="panel"><Empty text="Añade un ticket para empezar a construir tu catálogo." /></div> : (
        <div className="product-list">
          {filtered.map((product) => {
            const pp = purchases.filter((p) => p.productId === product.id).sort((a, b) => b.date.localeCompare(a.date));
            const latest = pp[0];
            const market = supermarkets.find((s) => s.id === latest?.supermarketId)?.name;
            return (
              <article className="product-row" key={product.id}>
                <div className="product-main"><div className="product-icon">{product.photoBlob ? <ProductPhoto blob={product.photoBlob} alt={product.name} /> : <ShoppingBasket size={19} />}</div><div><strong>{product.name}</strong><span>{product.brand || 'Sin marca'} · {product.category}</span></div></div>
                <label className="inline-field">Equivalente a<input value={product.genericName} onChange={(e) => updateGenericName(product, e.target.value)} /></label>
                <div className="rating" aria-label={`Valoración ${product.rating} de 5`}>{[1,2,3,4,5].map((n) => <button key={n} aria-label={`${n} estrellas`} onClick={() => setRating(product, n)} className={n <= product.rating ? 'star active' : 'star'}><Star size={19} fill={n <= product.rating ? 'currentColor' : 'none'} /></button>)}</div>
                <div className="latest-price"><span>{market ? `Último: ${market}` : 'Sin compras'}</span><strong>{latest ? formatUnitPrice(latest.normalizedUnitPrice, latest.normalizedUnit) : '—'}</strong></div>
                <button className="icon-btn danger" onClick={() => deleteProduct(product)}><Trash2 size={16} /></button>
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

function CompareView() {
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchases.toArray(), []) ?? [];
  const supermarkets = useLiveQuery(() => db.supermarkets.toArray(), []) ?? [];
  const genericNames = Array.from(new Set(products.map((p) => p.genericName).filter(Boolean))).sort();
  const [selected, setSelected] = useState('');
  useEffect(() => { if (!selected && genericNames[0]) setSelected(genericNames[0]); }, [selected, genericNames]);

  const candidates = useMemo(() => {
    if (!selected) return [];
    const targetProducts = products.filter((p) => p.genericName === selected);
    const rows: EnrichedPurchase[] = [];
    for (const product of targetProducts) {
      const byStore = new Map<number, Purchase>();
      purchases.filter((p) => p.productId === product.id).sort((a,b) => b.date.localeCompare(a.date)).forEach((p) => { if (!byStore.has(p.supermarketId)) byStore.set(p.supermarketId, p); });
      for (const purchase of byStore.values()) rows.push({ ...purchase, product, supermarket: supermarkets.find((s) => s.id === purchase.supermarketId) });
    }
    return rows.sort((a,b) => a.normalizedUnitPrice - b.normalizedUnitPrice);
  }, [selected, products, purchases, supermarkets]);

  const cheapest = candidates[0];
  const favorite = [...candidates].sort((a,b) => (b.product?.rating ?? 0) - (a.product?.rating ?? 0) || a.normalizedUnitPrice - b.normalizedUnitPrice)[0];

  return (
    <section className="page">
      <div className="page-heading"><div><span className="eyebrow">COMPARAR</span><h2>Mismo producto, distinta marca</h2><p>Se compara el precio normalizado, no solo el precio del envase.</p></div><label className="select-label">Producto genérico<select value={selected} onChange={(e) => setSelected(e.target.value)}>{genericNames.map((g) => <option key={g} value={g}>{g}</option>)}</select></label></div>
      {!selected ? <div className="panel"><Empty text="Necesitas productos con un nombre genérico para compararlos." /></div> : (candidates.length === 0 || !cheapest || !favorite) ? <div className="panel"><Empty text="No hay compras suficientes para este producto." /></div> : (
        <>
          <div className="content-grid two">
            <div className="recommendation best"><span>💰 MÁS BARATO</span><h3>{cheapest.product?.name}</h3><p>{cheapest.supermarket?.name} · {formatUnitPrice(cheapest.normalizedUnitPrice, cheapest.normalizedUnit)}</p></div>
            <div className="recommendation favorite"><span>⭐ MEJOR SEGÚN TU VALORACIÓN</span><h3>{favorite.product?.name}</h3><p>{favorite.supermarket?.name} · {favorite.product?.rating || 0}/5 · {formatUnitPrice(favorite.normalizedUnitPrice, favorite.normalizedUnit)}</p></div>
          </div>
          <div className="panel table-panel">
            <table className="data-table"><thead><tr><th>Producto</th><th>Supermercado</th><th>Formato</th><th>Precio envase</th><th>Precio comparable</th><th>Tu nota</th><th>Fecha</th></tr></thead><tbody>
              {candidates.map((c) => <tr key={`${c.productId}-${c.supermarketId}-${c.id}`}><td><strong>{c.product?.name}</strong><span>{c.product?.brand || 'Sin marca'}</span></td><td>{c.supermarket?.name}</td><td>{c.packageAmount} {c.packageUnit} × {c.quantityPurchased}</td><td>{money(c.price - c.discount)}</td><td className="strong-cell">{formatUnitPrice(c.normalizedUnitPrice, c.normalizedUnit)}</td><td>{'★'.repeat(c.product?.rating || 0)}{'☆'.repeat(5-(c.product?.rating || 0))}</td><td>{new Date(`${c.date}T00:00:00`).toLocaleDateString('es-ES')}</td></tr>)}
            </tbody></table>
          </div>
        </>
      )}
    </section>
  );
}

function HistoryView() {
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchases.toArray(), []) ?? [];
  const supermarkets = useLiveQuery(() => db.supermarkets.toArray(), []) ?? [];
  const genericNames = Array.from(new Set(products.map((p) => p.genericName).filter(Boolean))).sort();
  const [selected, setSelected] = useState('');
  useEffect(() => { if (!selected && genericNames[0]) setSelected(genericNames[0]); }, [selected, genericNames]);

  const relevant = enrichPurchases(purchases, products, supermarkets).filter((p) => p.product?.genericName === selected).sort((a,b) => a.date.localeCompare(b.date));
  const markets = Array.from(new Set(relevant.map((p) => p.supermarket?.name).filter(Boolean))) as string[];
  const chartData = relevant.map((p, i) => ({ index: i + 1, date: p.date, label: new Date(`${p.date}T00:00:00`).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' }), [p.supermarket?.name ?? 'Otro']: Number(p.normalizedUnitPrice.toFixed(2)) }));
  const latest = relevant.length ? relevant[relevant.length - 1] : undefined;
  const first = relevant[0];
  const variation = latest && first && first.normalizedUnitPrice ? ((latest.normalizedUnitPrice / first.normalizedUnitPrice) - 1) * 100 : 0;

  return (
    <section className="page">
      <div className="page-heading"><div><span className="eyebrow">EVOLUCIÓN</span><h2>Histórico de precios</h2><p>Observa la evolución del precio comparable y los cambios de formato.</p></div><label className="select-label">Producto<select value={selected} onChange={(e) => setSelected(e.target.value)}>{genericNames.map((g) => <option key={g}>{g}</option>)}</select></label></div>
      {relevant.length === 0 ? <div className="panel"><Empty text="Necesitas varias compras para crear un histórico." /></div> : (
        <>
          <div className="metrics-grid">
            <Metric icon={History} label="Registros" value={String(relevant.length)} />
            <Metric icon={Scale} label="Último precio" value={latest ? formatUnitPrice(latest.normalizedUnitPrice, latest.normalizedUnit) : '—'} />
            <Metric icon={ArrowUpRight} label="Variación total" value={pct(variation)} />
            <Metric icon={Store} label="Supermercados" value={String(markets.length)} />
          </div>
          <div className="panel chart-panel"><div className="chart-height"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" /><YAxis /><Tooltip formatter={(value) => money(Number(value))} /><Legend />{markets.map((m, i) => <Line key={m} type="monotone" dataKey={m} connectNulls strokeWidth={2.5} dot={{ r: 4 }} stroke={['#2d6a4f','#d97706','#2563eb','#7c3aed','#dc2626','#0891b2'][i % 6] ?? '#2d6a4f'} />)}</LineChart></ResponsiveContainer></div></div>
          <div className="panel table-panel"><table className="data-table"><thead><tr><th>Fecha</th><th>Producto</th><th>Supermercado</th><th>Formato</th><th>Precio</th><th>Comparable</th></tr></thead><tbody>{[...relevant].reverse().map((p) => <tr key={p.id}><td>{new Date(`${p.date}T00:00:00`).toLocaleDateString('es-ES')}</td><td>{p.product?.name}</td><td>{p.supermarket?.name}</td><td>{p.packageAmount} {p.packageUnit}</td><td>{money(p.price-p.discount)}</td><td className="strong-cell">{formatUnitPrice(p.normalizedUnitPrice,p.normalizedUnit)}</td></tr>)}</tbody></table></div>
        </>
      )}
    </section>
  );
}

function SettingsView() {
  const [status, setStatus] = useState('');

  async function exportData() {
    const [supermarkets, tickets, products, purchases] = await Promise.all([db.supermarkets.toArray(), db.tickets.toArray(), db.products.toArray(), db.purchases.toArray()]);
    const serializedTickets = await Promise.all(tickets.map(async (t) => ({ ...t, fileBlob: t.fileBlob ? await blobToDataUrl(t.fileBlob) : undefined })));
    const serializedProducts = await Promise.all(products.map(async (p) => ({ ...p, photoBlob: p.photoBlob ? await blobToDataUrl(p.photoBlob) : undefined })));
    const payload = { version: 1, exportedAt: new Date().toISOString(), supermarkets, tickets: serializedTickets, products: serializedProducts, purchases };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `smartmarket-backup-${todayISO()}.json`; a.click(); URL.revokeObjectURL(url);
    setStatus('Copia de seguridad exportada correctamente.');
  }

  async function importData(file: File) {
    try {
      const data = JSON.parse(await file.text());
      if (data.version !== 1 || !Array.isArray(data.tickets) || !Array.isArray(data.products)) throw new Error('Formato no válido');
      const restoredTickets = await Promise.all(data.tickets.map(async (t: any) => ({ ...t, fileBlob: typeof t.fileBlob === 'string' ? dataUrlToBlob(t.fileBlob) : undefined })));
      const restoredProducts = await Promise.all(data.products.map(async (p: any) => ({ ...p, photoBlob: typeof p.photoBlob === 'string' ? dataUrlToBlob(p.photoBlob) : undefined })));
      await db.transaction('rw', db.supermarkets, db.tickets, db.products, db.purchases, async () => {
        await Promise.all([db.supermarkets.clear(), db.tickets.clear(), db.products.clear(), db.purchases.clear()]);
        await db.supermarkets.bulkAdd(data.supermarkets); await db.products.bulkAdd(restoredProducts); await db.tickets.bulkAdd(restoredTickets); await db.purchases.bulkAdd(data.purchases);
      });
      setStatus('Copia restaurada. Recarga la página si algún contador tarda en actualizarse.');
    } catch { setStatus('No se pudo importar el archivo: no parece una copia válida de SmartMarket.'); }
  }

  async function wipe() {
    if (!confirm('Esto eliminará tickets, productos, históricos y archivos guardados localmente. ¿Continuar?')) return;
    await db.transaction('rw', db.tickets, db.products, db.purchases, async () => { await db.tickets.clear(); await db.products.clear(); await db.purchases.clear(); });
    setStatus('Datos de compra eliminados.');
  }

  return (
    <section className="page">
      <div className="page-heading"><div><span className="eyebrow">LOCAL Y PORTABLE</span><h2>Ajustes y copia de seguridad</h2><p>No necesitas una cuenta. Exporta un único archivo para llevarte todo tu histórico.</p></div></div>
      <div className="settings-grid">
        <div className="panel setting-card"><FileDown size={24} /><h3>Exportar copia</h3><p>Incluye base de datos y archivos originales de tickets.</p><button className="primary" onClick={exportData}><FileDown size={17}/> Exportar JSON</button></div>
        <div className="panel setting-card"><FileUp size={24} /><h3>Restaurar copia</h3><p>Sustituye los datos locales actuales por una copia previa.</p><label className="file-button"><FileUp size={17}/> Elegir copia<input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])} /></label></div>
        <div className="panel setting-card danger-zone"><Trash2 size={24} /><h3>Borrar datos</h3><p>Elimina compras e histórico de este navegador.</p><button className="danger-button" onClick={wipe}>Borrar todo</button></div>
      </div>
      {status && <div className="status-banner">{status}</div>}
      <div className="panel roadmap"><h3>Siguientes módulos previstos</h3><div className="roadmap-grid"><RoadmapItem n="01" title="OCR local ✓" text="Ya disponible: imagen y PDF, reglas por cadena y pantalla de revisión previa." /><RoadmapItem n="02" title="Conectores" text="Mercadona, Eroski, Lidl, Aldi, DIA, Alcampo… con precio actual." /><RoadmapItem n="03" title="Cesta inteligente" text="Lista de compra y reparto óptimo entre supermercados." /><RoadmapItem n="04" title="Aprendizaje" text="Recordar abreviaturas de ticket, equivalencias y correcciones." /></div></div>
    </section>
  );
}

function RoadmapItem({ n, title, text }: { n: string; title: string; text: string }) { return <div className="roadmap-item"><span>{n}</span><div><strong>{title}</strong><p>{text}</p></div></div>; }
function Empty({ text }: { text: string }) { return <div className="empty"><PackageSearch size={28}/><span>{text}</span></div>; }

function enrichPurchases(purchases: Purchase[], products: Product[], supermarkets: Supermarket[]): EnrichedPurchase[] {
  return purchases.map((p) => ({ ...p, product: products.find((x) => x.id === p.productId), supermarket: supermarkets.find((x) => x.id === p.supermarketId) }));
}

function detectAlerts(purchases: EnrichedPurchase[]) {
  const map = new Map<number, EnrichedPurchase[]>();
  for (const p of purchases) { const list = map.get(p.productId) ?? []; list.push(p); map.set(p.productId, list); }
  const alerts: Array<{ key: string; kind: 'up' | 'down'; title: string; detail: string }> = [];
  for (const [productId, list] of map) {
    const sorted = list.sort((a,b) => b.date.localeCompare(a.date)); if (sorted.length < 2) continue;
    const latest = sorted[0]!; const prev = sorted[1]!; const product = latest.product; if (!product) continue;
    const delta = prev.normalizedUnitPrice ? ((latest.normalizedUnitPrice / prev.normalizedUnitPrice) - 1) * 100 : 0;
    if (Math.abs(delta) >= 3) alerts.push({ key: `${productId}-price`, kind: delta > 0 ? 'up' : 'down', title: `${product.name}: ${delta > 0 ? 'sube' : 'baja'} ${Math.abs(delta).toFixed(1)} %`, detail: `${formatUnitPrice(prev.normalizedUnitPrice, prev.normalizedUnit)} → ${formatUnitPrice(latest.normalizedUnitPrice, latest.normalizedUnit)}` });
    if (latest.packageUnit === prev.packageUnit && latest.packageAmount < prev.packageAmount * 0.99) alerts.push({ key: `${productId}-size`, kind: 'up', title: `${product.name}: envase más pequeño`, detail: `${prev.packageAmount} ${prev.packageUnit} → ${latest.packageAmount} ${latest.packageUnit}` });
  }
  return alerts;
}

function blobToDataUrl(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob); }); }
function dataUrlToBlob(dataUrl: string) { const [meta = '', b64 = ''] = dataUrl.split(','); const mime = meta.match(/data:(.*?);base64/)?.[1] ?? 'application/octet-stream'; const binary = atob(b64); const bytes = new Uint8Array(binary.length); for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i); return new Blob([bytes], { type: mime }); }

export default App;
