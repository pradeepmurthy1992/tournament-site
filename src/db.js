// src/db.js
const BIN_ID = "YOUR_BIN_ID";
const API_KEY = "YOUR_JSONBIN_API_KEY";
const BASE = "https://api.jsonbin.io/v3/b";

export async function loadStoreOnce() {
  const res = await fetch(`${BASE}/${BIN_ID}/latest`, {
    headers: { "X-Master-Key": API_KEY }
  });
  if (!res.ok) return { tournaments: [], deleted: [] };
  const json = await res.json();
  return json?.record ?? { tournaments: [], deleted: [] };
}

export async function saveStore(payload) {
  const res = await fetch(`${BASE}/${BIN_ID}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": API_KEY
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("Save failed");
}

// No realtime on JSONBin; provide a no-op
export function subscribeStore() {
  return () => {};
}
