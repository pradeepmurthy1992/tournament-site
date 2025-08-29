// src/db.js
// Minimal JSONBin v3 adapter for GitHub Pages (no runtime secrets)
// Make sure your bin is set to Public. Paste your BIN_ID and X-Master-Key.

const BIN_ID = "68b1437543b1c97be92ef960";
const MASTER_KEY = "$2a$10$.quJq36pp2YHNa/NusCAWeH6b0x3NDiApfkB4fnth7SqLYmH5s6PK"; // starts with "•••" in JSONBin UI
const BASE = "https://api.jsonbin.io/v3";

function hdr(json = false) {
  const h = {
    "X-Master-Key": MASTER_KEY,
    "X-Bin-Meta": "false",
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

export async function loadStoreOnce() {
  // GET latest record
  const res = await fetch(`${BASE}/b/${BIN_ID}/latest`, { headers: hdr(false) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`JSONBin load failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  // we store the raw record at root
  return data?.record || { tournaments: [], deleted: [] };
}

export async function saveStore(payload) {
  // PUT replaces the entire record in the bin
  const res = await fetch(`${BASE}/b/${BIN_ID}`, {
    method: "PUT",
    headers: hdr(true),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`JSONBin save failed: ${res.status} ${txt}`);
  }
  return res.json();
}

// JSONBin has no realtime; return a no-op unsubscriber to keep API consistent
export function subscribeStore(/* cb */) {
  return () => {};
}
