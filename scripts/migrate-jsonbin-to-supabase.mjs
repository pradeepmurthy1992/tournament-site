// One-time migration: pulls the live tournament data out of the old
// JSONBin store and inserts it into Supabase, owned by whichever account
// you designate as the site owner. Run this once, after you've created
// your Supabase project, applied supabase/migrations/0001_init.sql, and
// signed up (and bootstrapped yourself as super_admin — see README.md).
//
// Usage:
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=xxxx \
//   OWNER_EMAIL=you@example.com \
//   node scripts/migrate-jsonbin-to-supabase.mjs
//
// SUPABASE_SERVICE_ROLE_KEY is the *service_role* key from Supabase
// Settings -> API — NOT the anon key. It bypasses RLS, which this script
// needs (it's inserting rows on another user's behalf, something the
// normal app never does). Never commit it or put it in src/config.js —
// pass it as an env var and only run this from your own machine.

import { createClient } from "@supabase/supabase-js";

const JSONBIN_BIN_ID = "68b15f2fd0ea881f4069feab";
const JSONBIN_API_BASE = "https://api.jsonbin.io/v3";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_EMAIL } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OWNER_EMAIL) {
  console.error("Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_EMAIL");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function tournamentToRow(tn, ownerId) {
  const { id, name, sport, format, status, deletedAt, createdAt, ...rest } = tn;
  return {
    // A new UUID, not the old short JSONBin id — Postgres' id column is a
    // real uuid and the old ids ("a1b2c3d") aren't valid ones.
    owner_id: ownerId,
    name,
    sport: sport || "generic",
    format: format || "knockout",
    status: status || "active",
    deleted_at: deletedAt ? new Date(deletedAt).toISOString() : null,
    data: rest, // teams, matches, groups, groupStage, championId, seed*Id
  };
}

async function main() {
  console.log("Fetching live data from JSONBin…");
  const res = await fetch(`${JSONBIN_API_BASE}/b/${JSONBIN_BIN_ID}/latest`, { cache: "no-store" });
  if (!res.ok) throw new Error(`JSONBin fetch failed: ${res.status}`);
  const json = await res.json();
  const record = json.record || {};
  const tournaments = Array.isArray(record.tournaments) ? record.tournaments : [];
  const deleted = Array.isArray(record.deleted) ? record.deleted : [];
  console.log(`Found ${tournaments.length} active and ${deleted.length} deleted tournament(s).`);

  const { data: owner, error: ownerErr } = await supabase
    .from("profiles").select("id, email").eq("email", OWNER_EMAIL).single();
  if (ownerErr || !owner) {
    throw new Error(
      `Couldn't find a profile for ${OWNER_EMAIL}. Sign up with that email in the app first (it auto-creates the profile row), then re-run this script.`
    );
  }
  console.log(`Owner resolved: ${owner.email} (${owner.id})`);

  const rows = [...tournaments, ...deleted].map((tn) => tournamentToRow(tn, owner.id));
  if (rows.length === 0) { console.log("Nothing to migrate."); return; }

  const { data: inserted, error: insertErr } = await supabase.from("tournaments").insert(rows).select("id, name");
  if (insertErr) throw new Error(`Insert failed: ${insertErr.message}`);

  console.log(`Migrated ${inserted.length} tournament(s):`);
  for (const t of inserted) console.log(`  - ${t.name} (${t.id})`);
  console.log("Done. Verify in the app under Fixtures/Deleted, then you can retire the JSONBin bin.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
