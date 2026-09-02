import { useEffect, useRef, useState } from "react";
import { liveQuery } from "dexie";
import type { User } from "@supabase/supabase-js";
import { db } from "./db";
import { supabase } from "@/integrations/supabase/client";
import { createSyncQueue, type SyncState } from "./sync-queue";

export const CATALOG_ADMIN_EMAIL = "promociones7819@gmail.com";
export const catalogDeletionsKey = (userId: string) => `catalog-deletions:${userId}`;

export function CatalogSync({
  publish,
}: {
  publish: (userId: string) => Promise<{ count: number; error?: string }>;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<SyncState>("pending");
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const retry = useRef<() => void>(() => undefined);
  useEffect(() => {
    let active = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setUser(data.session?.user ?? null);
      })
      .catch(() => undefined);
    const { data } = supabase.auth.onAuthStateChange((_event, session) =>
      setUser(session?.user ?? null),
    );
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);
  const adminId = user?.email?.toLowerCase() === CATALOG_ADMIN_EMAIL ? user.id : undefined;
  useEffect(() => {
    if (!adminId) return;
    let active = true;
    const queue = createSyncQueue(
      async () => {
        if (!navigator.onLine)
          throw new Error("Sin conexión. Tus productos siguen guardados en este dispositivo.");
        const result = await publish(adminId);
        if (result.error) throw new Error(result.error);
        if (active) setCount(result.count);
        window.dispatchEvent(new Event("smartmarket-catalog-published"));
      },
      (next, detail = "") => {
        if (active) {
          setState(next);
          setError(detail);
        }
      },
    );
    // The durable outbox is the local catalog + persisted deletion IDs. Reconcile
    // on every app start/sign-in, not just while the Products screen is open.
    const subscription = liveQuery(async () => [
      await db.products.toArray(),
      await db.appSettings.get(catalogDeletionsKey(adminId)),
    ]).subscribe({
      next: () => queue.schedule(),
      error: () => {
        setState("error");
        setError("No se pudieron leer los productos locales.");
      },
    });
    const wake = () => queue.schedule(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    retry.current = wake;
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      queue.dispose();
      subscription.unsubscribe();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [adminId, publish]);
  if (!adminId) return null;
  return (
    <div className={`catalog-sync-banner sync-${state}`} role="status" aria-live="polite">
      <span>
        <strong>Administrador · </strong>
        {state === "synced"
          ? `Publicado · ${count} productos`
          : state === "syncing"
            ? "Guardado local · publicando…"
            : "Guardado local · pendiente de publicar"}
        {error && <small>{error} Se reintentará automáticamente.</small>}
      </span>
      {state === "error" && (
        <button className="ghost" onClick={() => retry.current()}>
          Reintentar ahora
        </button>
      )}
    </div>
  );
}
