// Shared HMAC session-token helpers used by admin-login.js and tournaments.js.
// No JWT library needed: token = base64url(payload) + "." + hex(HMAC-SHA256(payload, SESSION_SECRET))

import crypto from "crypto";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function base64url(input) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function sign(payloadObj) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Missing env var SESSION_SECRET");
  const payload = base64url(JSON.stringify(payloadObj));
  const mac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

export function issueToken(name) {
  const exp = Date.now() + TOKEN_TTL_MS;
  return sign({ name, exp });
}

// Returns the decoded payload if the token is valid and unexpired, otherwise null.
export function verifyToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  const expectedMac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expectedMac, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded.exp !== "number" || Date.now() > decoded.exp) return null;
  return decoded;
}

export function requireAdmin(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifyToken(token);
}

// Parses env var ADMIN_CODES="code1:Alice,code2:Bob" into [{code, name}]
export function parseAdminCodes() {
  const raw = process.env.ADMIN_CODES || "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx === -1) return { code: entry, name: "Admin" };
      return { code: entry.slice(0, idx).trim(), name: entry.slice(idx + 1).trim() || "Admin" };
    });
}
