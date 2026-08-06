// src/db.js
// Reads go straight to JSONBin (public-read bin, no secret needed).
// Writes go through the Vercel serverless proxy (api/tournaments.js), which
// holds the JSONBin master key server-side and requires a valid admin token.

import { API_BASE } from "./config";

const BIN_ID = "68b15f2fd0ea881f4069feab";
const JSONBIN_API_BASE = "https://api.jsonbin.io/v3";

function withBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}`;
}

export async function loadStoreOnce() {
  const url = withBust(`${JSONBIN_API_BASE}/b/${BIN_ID}/latest`);
  const res = await fetch(url, { method: "GET", cache: "no-store" });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Load failed (${res.status}) ${text}`);
  }

  const json = await res.json();
  const record = json && json.record ? json.record : {};
  return {
    tournaments: Array.isArray(record.tournaments) ? record.tournaments : [],
    deleted: Array.isArray(record.deleted) ? record.deleted : [],
  };
}

export async function adminLogin(code) {
  const res = await fetch(`${API_BASE}/api/admin-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Login failed (${res.status})`);
  return json; // { token, name }
}

export async function saveStore(data, token) {
  const payload = {
    tournaments: Array.isArray(data.tournaments) ? data.tournaments : [],
    deleted: Array.isArray(data.deleted) ? data.deleted : [],
  };

  const res = await fetch(`${API_BASE}/api/tournaments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`);
  return json;
}

// Optional: no-op live subscribe placeholder so the app can call it safely.
export function subscribeStore(_cb) {
  // JSONBin doesn't support realtime; return an unsubscribe no-op
  return () => {};
}
