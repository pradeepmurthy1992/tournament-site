// src/db.js — JSONBin persistence (frontend-only)
// Docs: https://jsonbin.io/api-reference

// ====== CONFIG ======
// 1) Put your JSONBin Bin ID and API key here.
//    Example BIN_ID: "66d0f3b1e4b0b123abcd1234"
//    Example API_KEY starts with "eyJhbGciOi..." (JWT-ish)
const BIN_ID = "68b1437543b1c97be92ef960";
const API_KEY = "$2a$10$RC2if/M3lzxRmG99URwANurHm2vnuMXSexYjzak7.10/muiGpovD2";

// Optional: simple throttle to avoid hammering JSONBin if you add auto-save later.
const MIN_SAVE_GAP_MS = 1500;

// ====== CONSTANTS ======
const BASE = "https://api.jsonbin.io/v3/b";
const HEADERS_AUTH = { "X-Master-Key": API_KEY };
const HEADERS_JSON = {
  "Content-Type": "application/json",
  ...HEADERS_AUTH,
};

// ====== API your app expects ======

/**
 * Load once from JSONBin. Returns { tournaments: [], deleted: [] } shape.
 */
export async function loadStoreOnce() {
  try {
    const res = await fetch(`${BASE}/${BIN_ID}/latest`, { headers: HEADERS_AUTH });
    if (!res.ok) {
      console.warn("JSONBin load failed:", res.status, await res.text());
      return { tournaments: [], deleted: [] };
    }
    const json = await res.json();
    // JSONBin v3 returns { record, metadata }
    return json?.record ?? { tournaments: [], deleted: [] };
  } catch (err) {
    console.warn("JSONBin load error:", err);
    return { tournaments: [], deleted: [] };
  }
}

/**
 * Save whole store to JSONBin (manual Save button in your UI).
 * Overwrites the bin with the provided payload.
 */
let lastSaveAt = 0;
export async function saveStore(payload) {
  const now = Date.now();
  if (now - lastSaveAt < MIN_SAVE_GAP_MS) {
    // Avoid accidental double-clicks; not strictly necessary
    await new Promise((r) => setTimeout(r, MIN_SAVE_GAP_MS - (now - lastSaveAt)));
  }
  lastSaveAt = Date.now();

  const res = await fetch(`${BASE}/${BIN_ID}`, {
    method: "PUT",
    headers: HEADERS_JSON,
    body: JSON.stringify(payload ?? { tournaments: [], deleted: [] }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`JSONBin save failed: ${res.status} ${t}`);
  }
  return true;
}

/**
 * No realtime on JSONBin. We expose a no-op subscription that you can
 * later replace with polling if you want “auto refresh”.
 *
 * Usage in your component:
 *   const unsub = subscribeStore((next) => setState(next));
 *   return () => unsub();
 */
export function subscribeStore(/* cb */) {
  // If you ever want polling:
  // const iv = setInterval(async () => {
  //   const data = await loadStoreOnce();
  //   cb?.(data);
  // }, 10000);
  // return () => clearInterval(iv);
  return () => {};
}
