// src/db.js
// JSONBin v3 helpers

// ✅ FILL THESE
const BIN_ID = "68b15f2fd0ea881f4069feab";
const MASTER_KEY = "$2a$10$.quJq36pp2YHNa/NusCAWeH6b0x3NDiApfkB4fnth7SqLYmH5s6PK"; // starts with "•••" in JSONBin UI

// If your bin is Public READ, set this to true to omit keys on GET:
const PUBLIC_READ = true;

const API_BASE = "https://api.jsonbin.io/v3";

// Small helper to add a cache-buster
function withBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}`;
}

export async function loadStoreOnce() {
  const url = withBust(`${API_BASE}/b/${BIN_ID}/latest`);
  const headers = {};
  if (!PUBLIC_READ) headers["X-Master-Key"] = MASTER_KEY;

  const res = await fetch(url, {
    method: "GET",
    headers,
    cache: "no-store",        // 🚫 avoid CDN/browser cache
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Load failed (${res.status}) ${text}`);
  }

  const json = await res.json();
  // json => {record: {...}, metadata: {...}}
  const record = json && json.record ? json.record : {};
  // Normalize shape to what app expects:
  return {
    tournaments: Array.isArray(record.tournaments) ? record.tournaments : [],
    deleted: Array.isArray(record.deleted) ? record.deleted : [],
  };
}

export async function saveStore(data) {
  // Ensure we always send the expected shape
  const payload = {
    tournaments: Array.isArray(data.tournaments) ? data.tournaments : [],
    deleted: Array.isArray(data.deleted) ? data.deleted : [],
  };

  const url = withBust(`${API_BASE}/b/${BIN_ID}`);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": MASTER_KEY,   // write always needs master key
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Save failed (${res.status}) ${text}`);
  }

  // Optional: you can read the response to confirm version
  return await res.json();
}

// Optional: no-op live subscribe placeholder so the app can call it safely.
export function subscribeStore(_cb) {
  // JSONBin doesn’t support realtime; return an unsubscribe no-op
  return () => {};
}
