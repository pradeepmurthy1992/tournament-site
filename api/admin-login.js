// POST /api/admin-login   body: { code }
// Validates an access code against ADMIN_CODES and issues a signed session token.
// To onboard a new paying admin: add "newcode:Name" to ADMIN_CODES in the Vercel
// dashboard (Project Settings -> Environment Variables) and redeploy.

import { issueToken, parseAdminCodes } from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.ADMIN_CODES || !process.env.SESSION_SECRET) {
    return res.status(500).json({ error: "Missing env vars: ADMIN_CODES, SESSION_SECRET" });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const code = String(body.code || "").trim();
    if (!code) return res.status(400).json({ error: "Missing code" });

    const entry = parseAdminCodes().find((e) => e.code === code);
    if (!entry) return res.status(401).json({ error: "Invalid access code" });

    const token = issueToken(entry.name);
    return res.status(200).json({ token, name: entry.name });
  } catch (e) {
    return res.status(500).json({ error: "API error", detail: String(e?.message || e) });
  }
}
