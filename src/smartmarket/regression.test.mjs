import test from "node:test";
import assert from "node:assert/strict";
import {
  newestFirst,
  equivalenceKey,
  canonicalProducts,
  productCategory,
  normalizeUnitPrice,
  todayISO,
} from "./utils.ts";
import { createSyncQueue } from "./sync-queue.ts";

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

test("the last price saved on the same day wins, without overriding a newer date", () => {
  const rows = [
    { id: 1, date: "2026-09-02", price: 2 },
    { id: 2, date: "2026-09-02", price: 2.5 },
    { id: 3, date: "2026-09-01", price: 1 },
  ];
  assert.deepEqual(
    rows.sort(newestFirst).map((row) => row.id),
    [2, 1, 3],
  );
});

test("equivalent labels ignore accents, case and spacing, not product differences", () => {
  assert.equal(equivalenceKey("  ATÚN   en aceite "), equivalenceKey("Atun en aceite"));
  assert.notEqual(equivalenceKey("atún en aceite"), equivalenceKey("atún al natural"));
  const products = [
    { genericName: "Zumo exprimido", name: "A" },
    { genericName: "zumo  Exprimido", name: "B" },
  ];
  const canonical = canonicalProducts(products);
  assert.equal(canonical[0].genericName, canonical[1].genericName);
  assert.equal(products[1].genericName, "zumo  Exprimido");
});

test("cleaning products are classified safely, without rewriting specific categories", () => {
  for (const name of [
    "Suavizante",
    "Detergente lavadora Marsella",
    "KH7",
    "KH-7",
    "Lavavajillas Todo en 1",
  ])
    assert.equal(productCategory(name, "Alimentación"), "Limpieza");
  assert.equal(productCategory("Leche desnatada", "Lácteos y huevos"), "Lácteos y huevos");
  assert.equal(productCategory("Producto nuevo", ""), "Otros");
  assert.equal(productCategory("Detergente", "Mi categoría"), "Mi categoría");
});

test("price comparison includes package count and discounts", () => {
  assert.deepEqual(normalizeUnitPrice(6, 1, 2, 500, "g"), { value: 5, unit: "kg" });
});

test("today follows the local calendar, including near midnight", () => {
  const NativeDate = Date;
  class LocalDate extends NativeDate {
    constructor() {
      super("2026-09-01T23:30:00-02:00");
    }
    getFullYear() {
      return 2026;
    }
    getMonth() {
      return 8;
    }
    getDate() {
      return 1;
    }
  }
  globalThis.Date = LocalDate;
  try {
    assert.equal(todayISO(), "2026-09-01");
  } finally {
    globalThis.Date = NativeDate;
  }
});

test("sync coalesces edits and serializes changes arriving during publication", async () => {
  let calls = 0;
  let release;
  const states = [];
  const queue = createSyncQueue(
    async () => {
      calls += 1;
      if (calls === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
    },
    (state) => states.push(state),
    1,
    1,
  );
  try {
    queue.schedule();
    queue.schedule();
    queue.schedule();
    await tick();
    assert.equal(calls, 1);
    queue.schedule();
    queue.schedule();
    await tick();
    assert.equal(calls, 1);
    release();
    await tick();
    assert.equal(calls, 2);
    assert.equal(states.at(-1), "synced");
  } finally {
    queue.dispose();
  }
});

test("a failed publication retries and does not claim success before confirmation", async () => {
  let calls = 0;
  const states = [];
  const queue = createSyncQueue(
    async () => {
      if (++calls === 1) throw new Error("offline");
    },
    (state) => states.push(state),
    1,
    1,
  );
  try {
    queue.schedule();
    await tick(40);
    assert.equal(calls, 2);
    assert.ok(states.includes("error"));
    assert.equal(states.at(-1), "synced");
  } finally {
    queue.dispose();
  }
});

test("disposing sync cancels a pending publication", async () => {
  let calls = 0;
  const queue = createSyncQueue(
    async () => {
      calls += 1;
    },
    () => {},
    10,
  );
  queue.schedule();
  queue.dispose();
  await tick(25);
  assert.equal(calls, 0);
});
