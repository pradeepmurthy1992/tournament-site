// POST /api/tournaments   body: { tournaments: [...], deleted: [...] }
// Writes a full snapshot to JSONBin. The JSONBin master key lives only here
// (server-side env var), never in client JS. Requires a valid admin session
// token (see admin-login.js) in the Authorization header.
//
// Reads are NOT proxied here on purpose: the JSONBin bin is public-read, so
// the frontend fetches it directly (see src/db.js) — one less hop, and no
// secret is needed for reads.
//
// Env vars to set in Vercel (Project Settings -> Environment Variables):
//  - JSONBIN_BIN_ID
//  - JSONBIN_MASTER_KEY
//  - ADMIN_CODES      (see admin-login.js)
//  - SESSION_SECRET   (see _auth.js)

import { requireAdmin } from "./_auth.js";

const JSONBIN_API_BASE = "https://api.jsonbin.io/v3";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { JSONBIN_BIN_ID, JSONBIN_MASTER_KEY } = process.env;
  if (!JSONBIN_BIN_ID || !JSONBIN_MASTER_KEY) {
    return res.status(500).json({ error: "Missing env vars: JSONBIN_BIN_ID, JSONBIN_MASTER_KEY" });
  }

  const admin = requireAdmin(req);
  if (!admin) return res.status(401).json({ error: "Unauthorized. Log in as admin first." });

  try {
    const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const payload = {
      tournaments: Array.isArray(body.tournaments) ? body.tournaments : [],
      deleted: Array.isArray(body.deleted) ? body.deleted : [],
      updatedAt: Date.now(),
      updatedBy: admin.name,
    };

    const r = await fetch(`${JSONBIN_API_BASE}/b/${JSONBIN_BIN_ID}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": JSONBIN_MASTER_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "JSONBin write failed", detail: t });
    }

    return res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
  } catch (e) {
    return res.status(500).json({ error: "API error", detail: String(e?.message || e) });
  }
}
