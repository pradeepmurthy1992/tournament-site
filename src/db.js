// src/db.js
// Persistence backed by Supabase Postgres. Row-Level Security (see
// supabase/migrations/0001_init.sql) scopes every query automatically:
// a normal user's select/update/delete only ever reaches their own rows;
// the super admin's reaches everyone's. This file just translates between
// that row shape and the in-memory tournament shape app.jsx already uses.

import { supabase } from "./lib/supabase";

function rowToTournament(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    sport: row.sport,
    format: row.format,
    status: row.status,
    shareSlug: row.share_slug,
    registrationDeadline: row.registration_deadline,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    ...(row.data || {}), // teams, matches, groups, groupStage, championId, seed*Id
  };
}

function tournamentToRow(tn, fallbackOwnerId) {
  const {
    id, ownerId, name, sport, format, status, shareSlug,
    registrationDeadline, deletedAt, createdAt, ...rest
  } = tn;
  return {
    id,
    owner_id: ownerId || fallbackOwnerId,
    name,
    sport: sport || "generic",
    format: format || "knockout",
    status: status || "active",
    registration_deadline: registrationDeadline || null,
    deleted_at: deletedAt ? new Date(deletedAt).toISOString() : null,
    data: rest,
  };
}

// Fetches every tournament row visible to the caller. RLS does the
// scoping: a normal user gets only rows they own, the super admin gets
// every organizer's rows (see is_super_admin() in the migration).
export async function loadStoreOnce() {
  const [activeRes, deletedRes] = await Promise.all([
    supabase.from("tournaments").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
    supabase.from("tournaments").select("*").not("deleted_at", "is", null).order("deleted_at", { ascending: false }),
  ]);
  if (activeRes.error) throw new Error(activeRes.error.message);
  if (deletedRes.error) throw new Error(deletedRes.error.message);

  return {
    tournaments: (activeRes.data || []).map(rowToTournament),
    deleted: (deletedRes.data || []).map(rowToTournament),
  };
}

// Persists the full in-memory tournaments/deleted arrays: upserts every
// row, then hard-deletes any row that's no longer present in either array
// (this is how "Delete Permanently" actually removes data). ownerId is a
// fallback for tournaments that don't already carry one (shouldn't happen
// in practice — createTournament always stamps it — but keeps this
// function safe either way).
export async function saveStore({ tournaments, deleted }, ownerId) {
  const all = [...tournaments, ...deleted];
  const rows = all.map((tn) => tournamentToRow(tn, ownerId));

  if (rows.length) {
    const { error } = await supabase.from("tournaments").upsert(rows, { onConflict: "id" });
    if (error) throw new Error(error.message);
  }

  const { data: existingRows, error: listErr } = await supabase.from("tournaments").select("id");
  if (listErr) throw new Error(listErr.message);
  const keepIds = new Set(all.map((t) => t.id));
  const staleIds = (existingRows || []).map((r) => r.id).filter((id) => !keepIds.has(id));
  if (staleIds.length) {
    const { error: delErr } = await supabase.from("tournaments").delete().in("id", staleIds);
    if (delErr) throw new Error(delErr.message);
  }
}

// Super-admin-only: flips a user's tier via the admin_set_tier() RPC
// (see migration) — the RPC itself re-checks the caller is actually the
// super admin, this isn't a client-side-only gate.
export async function adminSetTier(userId, tier) {
  const { error } = await supabase.rpc("admin_set_tier", { target_user_id: userId, new_tier: tier });
  if (error) throw new Error(error.message);
}

// Super-admin-only: list every profile, for the Admin tab's user list.
export async function adminListProfiles() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}
