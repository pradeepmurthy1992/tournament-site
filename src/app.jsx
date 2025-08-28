import React, { useEffect, useMemo, useState, useRef } from "react";
import * as XLSX from "xlsx";

/**
 * Tournament Maker — Multiple Concurrent Tournaments (TT & Badminton)
 * Dark UI • Tabs: SCHEDULE (admin only), FIXTURES, STANDINGS, WINNERS
 *
 * New (Viewer/Admin split):
 * - Viewers (default) can see FIXTURES, STANDINGS, WINNERS only.
 * - Admin can log in (ID + Password) to access SCHEDULE tab and match-edit actions
 *   (create tournament, add entries, pick winners, generate next round, delete, save).
 * - Admin status persists in localStorage until Logout.
 */

// ----------------------------- Theme -----------------------------
const TM_BLUE = "#0f4aa1"; // Tata Motors blue
const TM_CYAN = "#00b1e7"; // Accent

// ----------------------------- Constants & Helpers -----------------------------
const STORAGE_KEY = "tourney_multi_dark_v1"; // localStorage key
const NEW_TOURNEY_SENTINEL = "__NEW__"; // dropdown option value for creating a brand-new tournament
const uid = () => Math.random().toString(36).slice(2, 9);

// ⚠️ Set your admin credentials here (change before sharing):
const ADMIN_USERNAME = "admin"; // e.g., "cv_admin"
const ADMIN_PASSWORD = "gameport123"; // e.g., "<your-strong-password>"

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}

function uniqueNames(arr) {
  const seen = new Set();
  const out = [];
  for (const n of arr.map((s) => String(s || "").trim()).filter(Boolean)) {
    const k = n.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(n);
    }
  }
  return out;
}

// CSV: supports comma / tab / semicolon
function parseCSVPlayers(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const sep = /,|\t|;/;
  const headers = lines[0].split(sep).map((s) => s.trim());
  const idx = headers.findIndex((h) => normalizeHeader(h) === "players");
  if (idx === -1) return [];
  const names = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep);
    names.push((cols[idx] || "").trim());
  }
  return uniqueNames(names);
}

async function parseExcelPlayers(arrayBuffer) {
  try {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (!rows || rows.length === 0) return [];
    const keys = Object.keys(rows[0] || {});
    const key = keys.find((k) => normalizeHeader(k) === "players");
    if (!key) return [];
    const names = rows.map((r) => r[key]).filter(Boolean);
    return uniqueNames(names);
  } catch (e) {
    console.error(e);
    return [];
  }
}

function stageLabelByCount(count) {
  if (count === 1) return "Finals";
  if (count === 2) return "Semi Finals";
  if (count === 4) return "Quarter Finals";
  if (count === 8) return "Pre quarters";
  return null; // unknown → fall back to Round N
}

// ----------------------------- UI Subcomponents -----------------------------
function TabButton({ id, label, tab, setTab }) {
  const active = tab === id;
  const baseStyle = {
    borderColor: TM_BLUE,
    backgroundColor: active ? TM_BLUE : "transparent",
    color: "white",
  };
  return (
    <button
      onClick={() => setTab(id)}
      className="px-3 py-2 rounded-xl border transition hover:opacity-90"
      style={baseStyle}
    >
      {label}
    </button>
  );
}

function Collapsible({ title, subtitle, right, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-zinc-700 rounded-2xl mb-3 overflow-hidden">
      <div
        className="flex items-center justify-between px-3 py-2 glass-header"
        style={{ borderColor: TM_BLUE }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-6 h-6 border border-white rounded text-xs hover:bg-white hover:text-black"
          >
            {open ? "−" : "+"}
          </button>
          <div>
            <div className="font-semibold">{title}</div>
            {subtitle && <div className="text-xs text-zinc-400">{subtitle}</div>}
          </div>
        </div>
        {right}
      </div>
      {open && <div className="p-3">{children}</div>}
    </div>
  );
}

function MatchRow({ idx, m, teamMap, onPickWinner, stageText, canEdit }) {
  const aName = teamMap[m.aId] || (m.aId ? "Unknown" : "BYE/TBD");
  const bName = teamMap[m.bId] || (m.bId ? "Unknown" : "BYE/TBD");
  const bothEmpty = !m.aId && !m.bId;
  const singleBye = (!!m.aId && !m.bId) || (!m.aId && !!m.bId);

  return (
    <div className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span className="w-40 text-zinc-400">
        {stageText}
        {stageText === "Finals" ? "" : (
          <>
            {" "}
            • M{idx}
          </>
        )}
      </span>

      <span className="flex-1">{aName}</span>
      {!bothEmpty && !singleBye && <span>vs</span>}
      <span className="flex-1">{bName}</span>

      {/* Actions / Result */}
      {!canEdit ? (
        <span className="text-xs">
          {bothEmpty ? (
            <span className="text-white/60">(empty pairing)</span>
          ) : singleBye ? (
            <span className="text-white/70">Auto-advance available</span>
          ) : m.winnerId ? (
            <>
              Winner: <b>{teamMap[m.winnerId] || "TBD"}</b>
            </>
          ) : (
            <span className="text-white/60">Winner: TBD</span>
          )}
        </span>
      ) : bothEmpty ? (
        <span className="text-xs text-white/60">(empty pairing)</span>
      ) : singleBye ? (
        <button
          className={`px-2 py-1 rounded border ${
            m.winnerId
              ? "border-emerald-400 text-emerald-300"
              : "border-white hover:bg-white hover:text-black"
          }`}
          onClick={() => {
            const winnerId = m.aId || m.bId || null;
            if (winnerId) onPickWinner(m.id, winnerId);
          }}
        >
          {m.winnerId ? "Advanced" : "Auto-advance"}
        </button>
      ) : (
        <select
          className="field border rounded p-1 focus:border-white outline-none"
          style={{ borderColor: TM_BLUE }}
          value={m.winnerId || ""}
          onChange={(e) => onPickWinner(m.id, e.target.value || null)}
        >
          <option value="">Winner — pick</option>
          {m.aId && <option value={m.aId}>{aName}</option>}
          {m.bId && <option value={m.bId}>{bName}</option>}
        </select>
      )}
    </div>
  );
}

// ----------------------------- Main Component -----------------------------
export default function TournamentMaker() {
  // Default landing tab for public viewers = FIXTURES
  const [tab, setTab] = useState("fixtures");

  // Admin auth state
  const [isAdmin, setIsAdmin] = useState(
    () => localStorage.getItem("gp_is_admin") === "1"
  );
  const [showLogin, setShowLogin] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");

  // Builder state (for creating or applying entries)
  const [tName, setTName] = useState("");
  const [targetTournamentId, setTargetTournamentId] = useState(
    NEW_TOURNEY_SENTINEL
  ); // dropdown selection
  const [namesText, setNamesText] = useState("");
  const [seed1, setSeed1] = useState("");
  const [seed2, setSeed2] = useState("");
  const [builderTeams, setBuilderTeams] = useState([]); // [{id,name}]

  // file upload ref
  const uploadRef = useRef(null);

  // All tournaments (active + completed)
  const [tournaments, setTournaments] = useState(() => []);

  // Load from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (Array.isArray(data)) setTournaments(data);
      } catch {}
    }
  }, []);

  const saveAll = () => {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tournaments));
    alert("Saved.");
  };

  // ------- Admin handlers -------
  function handleLogin(e) {
    e?.preventDefault?.();
    if (loginId === ADMIN_USERNAME && loginPw === ADMIN_PASSWORD) {
      setIsAdmin(true);
      localStorage.setItem("gp_is_admin", "1");
      setShowLogin(false);
      setLoginId("");
      setLoginPw("");
    } else {
      alert("Invalid credentials");
    }
  }

  function handleLogout() {
    setIsAdmin(false);
    localStorage.removeItem("gp_is_admin");
    if (tab === "schedule") setTab("fixtures");
  }

  // ------- Builder helpers -------
  const builderTeamMap = useMemo(
    () => Object.fromEntries(builderTeams.map((tm) => [tm.name, tm.id])),
    [builderTeams]
  );

  function loadTeamsFromText() {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    const lines = namesText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const uniq = Array.from(new Set(lines));
    const teams = uniq.map((n) => ({ id: uid(), name: n }));
    setBuilderTeams(teams);
    if (targetTournamentId === NEW_TOURNEY_SENTINEL) {
      setSeed1(uniq[0] || "");
      setSeed2(uniq[1] || "");
    }
  }

  // Local (component) handler so we can read targetTournamentId async
  async function handlePlayersUpload(file) {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    let names = [];
    if (ext === "csv") {
      const text = await file.text();
      names = parseCSVPlayers(text);
    } else if (ext === "xlsx" || ext === "xls") {
      const buf = await file.arrayBuffer();
      names = await parseExcelPlayers(buf);
    } else {
      alert("Unsupported file type. Please upload .csv, .xlsx, or .xls");
      return;
    }
    if (names.length === 0) {
      alert("Could not find a 'Players' column in the file.");
      return;
    }
    const teams = names.map((n) => ({ id: uid(), name: n }));
    setBuilderTeams(teams);
    if (targetTournamentId === NEW_TOURNEY_SENTINEL) {
      setSeed1(names[0] || "");
      setSeed2(names[1] || "");
    }
  }

  function generateRound1Matches(teams, seedTopName, seedBottomName) {
    const names = teams.map((x) => x.name);
    // determine bracket size (next power of 2)
    let size = 1;
    while (size < names.length) size *= 2;

    const slots = Array(size).fill(null);
    slots[0] = seedTopName;
    slots[size - 1] = seedBottomName;

    const others = names.filter((n) => n !== seedTopName && n !== seedBottomName);
    const shuffled = (() => {
      const a = others.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    })();

    // alternate fill top/bottom; leave seed-adjacent (1, size-2) last → BYEs to seeds first
    const half = size / 2;
    const topAvail = [];
    const botAvail = [];
    for (let i = 0; i < half; i++) {
      if (i !== 0 && i !== 1) topAvail.push(i);
    }
    for (let i = half; i < size; i++) {
      if (i !== size - 1 && i !== size - 2) botAvail.push(i);
    }
    const order = [];
    const L = Math.max(topAvail.length, botAvail.length);
    for (let i = 0; i < L; i++) {
      if (i < topAvail.length) order.push(topAvail[i]);
      if (i < botAvail.length) order.push(botAvail[i]);
    }
    order.push(1, size - 2);

    let oi = 0;
    for (const name of shuffled) {
      while (oi < order.length && slots[order[oi]] !== null) oi++;
      if (oi >= order.length) break;
      slots[order[oi]] = name;
      oi++;
    }

    const nameToId = Object.fromEntries(teams.map((tm) => [tm.name, tm.id]));
    const matches = [];
    for (let i = 0; i < size; i += 2) {
      const aId = slots[i] ? nameToId[slots[i]] : null;
      const bId = slots[i + 1] ? nameToId[slots[i + 1]] : null;
      if (!aId && !bId) continue; // skip empty-empty
      const bye = !aId || !bId;
      const winnerId = bye ? aId || bId || null : null;
      matches.push({
        id: uid(),
        round: 1,
        aId,
        bId,
        status: bye ? "BYE" : "Scheduled",
        winnerId,
      });
    }
    return matches;
  }

  function createTournament() {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    if (targetTournamentId !== NEW_TOURNEY_SENTINEL) {
      // In existing mode, treat as Apply Entries
      const names = builderTeams.length
        ? builderTeams.map((b) => b.name)
        : namesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      applyEntriesToTournament(targetTournamentId, names);
      return;
    }
    if (!tName.trim()) {
      alert("Please enter a Tournament Name.");
      return;
    }
    if (builderTeams.length < 2) {
      alert("Please add at least 2 entries.");
      return;
    }
    if (!seed1 || !seed2 || seed1 === seed2) {
      alert("Pick two different seeds.");
      return;
    }
    const nameIndex = Object.fromEntries(builderTeams.map((tm) => [tm.name, true]));
    if (!nameIndex[seed1] || !nameIndex[seed2]) {
      alert("Seeds must be from the added entries.");
      return;
    }
    const matches = generateRound1Matches(builderTeams, seed1, seed2);
    const seedTopId = builderTeamMap[seed1];
    const seedBottomId = builderTeamMap[seed2];
    const tourney = {
      id: uid(),
      name: tName.trim(),
      createdAt: Date.now(),
      teams: builderTeams,
      matches,
      status: "active",
      seedTopId,
      seedBottomId,
      championId: null,
    };
    setTournaments((prev) => [tourney, ...prev]);

    // reset builder
    setTName("");
    setNamesText("");
    setSeed1("");
    setSeed2("");
    setBuilderTeams([]);
    setTargetTournamentId(NEW_TOURNEY_SENTINEL);
    setTab("fixtures");
  }

  // ------- Per-tournament derived helpers -------
  function roundCounts(tn) {
    const mp = new Map();
    for (const m of tn.matches) {
      if (!(m.aId || m.bId)) continue;
      mp.set(m.round, (mp.get(m.round) || 0) + 1);
    }
    return mp;
  }

  function maxRound(tn) {
    return tn.matches.length ? Math.max(...tn.matches.map((m) => m.round)) : 0;
  }

  function currentRoundMatches(tn) {
    const mr = maxRound(tn);
    return tn.matches.filter((m) => m.round === mr);
  }

  function canGenerateNext(tn) {
    const cur = currentRoundMatches(tn);
    if (!cur.length) return false;
    const valid = cur.filter((m) => m.aId || m.bId);
    return valid.length > 0 && valid.every((m) => !!m.winnerId);
  }

  function pickWinner(tournamentId, matchId, winnerId) {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    setTournaments((prev) =>
      prev.map((tn) => {
        if (tn.id !== tournamentId) return tn;
        const matches = tn.matches.map((m) =>
          m.id === matchId ? { ...m, winnerId, status: winnerId ? "Final" : m.status } : m
        );
        return { ...tn, matches };
      })
    );
  }

  function generateNextRound(tournamentId) {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    setTournaments((prev) =>
      prev.map((tn) => {
        if (tn.id !== tournamentId) return tn;
        if (!canGenerateNext(tn)) return tn;
        const cur = currentRoundMatches(tn).filter((m) => m.aId || m.bId);
        const winners = cur.map((m) => m.winnerId).filter(Boolean);
        if (winners.length <= 1) {
          return { ...tn, status: "completed", championId: winners[0] || null };
        }
        const nextRoundNo = maxRound(tn) + 1;
        const next = [];
        for (let i = 0; i < winners.length; i += 2) {
          const aId = winners[i] || null;
          const bId = winners[i + 1] || null;
          if (!aId && !bId) continue;
          const bye = !aId || !bId;
          const winnerId = bye ? aId || bId || null : null;
          next.push({
            id: uid(),
            round: nextRoundNo,
            aId,
            bId,
            status: bye ? "BYE" : "Scheduled",
            winnerId,
          });
        }
        return { ...tn, matches: [...tn.matches, ...next] };
      })
    );
  }

  function deleteTournament(tournamentId) {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    setTournaments((prev) => prev.filter((tn) => tn.id !== tournamentId));
  }

  // Add new entries to an existing tournament:
  // fill BYEs in Round 1 first, then create new Round 1 matches as needed
  function applyEntriesToTournament(tournamentId, newNames) {
    if (!isAdmin) {
      alert("Admin only.");
      return;
    }
    setTournaments((prev) =>
      prev.map((tn) => {
        if (tn.id !== tournamentId) return tn;

        // Guard: only allow adding entries while still in Round 1 (before bracket advances)
        const maxR = maxRound(tn);
        if (maxR > 1) {
          alert("Cannot add entries after the tournament has advanced beyond Round 1.");
          return tn;
        }

        const existingNamesSet = new Set(tn.teams.map((t) => t.name.toLowerCase()));
        const toAddNames = uniqueNames(newNames).filter(
          (n) => !existingNamesSet.has(n.toLowerCase())
        );
        if (toAddNames.length === 0) return tn;

        const newTeams = toAddNames.map((n) => ({ id: uid(), name: n }));
        const allTeams = [...tn.teams, ...newTeams];
        const idByName = Object.fromEntries(allTeams.map((t) => [t.name, t.id]));

        // Work on copies
        let matches = tn.matches.map((m) => ({ ...m }));

        // === 1) Fill BYE/TBD slots in Round 1 first ===
        // NOTE: Consider BYE/TBD even if a winner was auto-set earlier. Clear winner when both sides now present.
        const r1_before = matches.filter((m) => m.round === 1);
        const byeSlots = [];
        for (const m of r1_before) {
          if (!m.aId) byeSlots.push({ mid: m.id, side: "a" });
          if (!m.bId) byeSlots.push({ mid: m.id, side: "b" });
        }

        const nameQueue = [...toAddNames];
        for (const slot of byeSlots) {
          if (nameQueue.length === 0) break;
          const name = nameQueue.shift();
          const id = idByName[name];
          const mi = matches.findIndex((x) => x.id === slot.mid);
          if (mi >= 0) {
            if (slot.side === "a") matches[mi].aId = id;
            else matches[mi].bId = id;
            if (matches[mi].aId && matches[mi].bId) {
              matches[mi].status = "Scheduled";
              matches[mi].winnerId = null;
            }
          }
        }

        // === 2) Remaining names → new Round 1 matches ===
        const newR1Matches = [];
        while (nameQueue.length > 0) {
          const aName = nameQueue.shift();
          const bName = nameQueue.shift() || null; // odd → BYE
          const aId = idByName[aName];
          const bId = bName ? idByName[bName] : null;
          const bye = !aId || !bId;
          const winnerId = bye ? aId || bId || null : null; // auto-advance if single
          newR1Matches.push({
            id: uid(),
            round: 1,
            aId,
            bId,
            status: bye ? "BYE" : "Scheduled",
            winnerId,
          });
        }

        // Keep non-round-1 aside; recompute Round 1 AFTER we may have filled BYEs above
        const nonR1 = matches.filter((m) => m.round !== 1);
        const existingR1 = matches.filter((m) => m.round === 1);

        // === 3) Re-order Round 1 so seeds remain at TOP and BOTTOM (seeds only meet in Finals) ===
        const seedTopId = tn.seedTopId || null;
        const seedBottomId = tn.seedBottomId || null;
        if (seedTopId && seedBottomId) {
          const r1Matches = existingR1;
          const topIdx = r1Matches.findIndex(
            (m) => m.aId === seedTopId || m.bId === seedTopId
          );
          const bottomIdx = r1Matches.findIndex(
            (m) => m.aId === seedBottomId || m.bId === seedBottomId
          );
          if (topIdx !== -1 && bottomIdx !== -1) {
            const topMatch = r1Matches[topIdx];
            const bottomMatch = r1Matches[bottomIdx];
            const middleExisting = r1Matches.filter((_, i) => i !== topIdx && i !== bottomIdx);

            // STRICT ALTERNATION for new matches between top & bottom
            const between = middleExisting.slice();
            let frontInserts = 0;
            let backInserts = 0;
            newR1Matches.forEach((nm, idx) => {
              if (idx % 2 === 0) {
                const pos = frontInserts; // near top, moving inward
                between.splice(pos, 0, nm);
                frontInserts++;
              } else {
                const pos = between.length - backInserts;
                between.splice(pos, 0, nm);
                backInserts++;
              }
            });

            const newR1 = [topMatch, ...between, bottomMatch];
            matches = [...newR1, ...nonR1];
          } else {
            // Seeds not both present in r1; just append new matches after existing r1
            matches = [...existingR1, ...newR1Matches, ...nonR1];
          }
        } else {
          // No seed info; append new matches after existing r1
          matches = [...existingR1, ...newR1Matches, ...nonR1];
        }

        const updated = { ...tn, teams: allTeams, matches };
        setNamesText("");
        setBuilderTeams([]);
        return updated;
      })
    );
  }

  // Partition active vs completed
  const activeTournaments = tournaments.filter((tn) => tn.status === "active");
  const completedTournaments = tournaments.filter((tn) => tn.status === "completed");

  // ----------------------------- Styles -----------------------------
  const gpStyles = `
@keyframes diagPan {
  0% { background-position: 0 0; }
  100% { background-position: 400px 400px; }
}
@keyframes floatPan {
  0% { transform: translate3d(0,0,0); }
  100% { transform: translate3d(-80px,-80px,0); }
}
.gp3d {
  text-shadow:
    0 1px 0 rgba(0,0,0,.35),
    0 2px 0 rgba(0,0,0,.35),
    0 3px 0 rgba(0,0,0,.32),
    0 4px 0 rgba(0,0,0,.30),
    0 5px 0 rgba(0,0,0,.28),
    0 6px 0 rgba(0,0,0,.25),
    0 12px 20px rgba(0,0,0,.45),
    0 0 8px rgba(0,177,231,.25);
  transition: transform .3s ease, text-shadow .3s ease, filter .3s ease;
}
.gpGroup:hover .gp3d {
  transform: translateY(-4px);
  text-shadow:
    0 2px 0 rgba(0,0,0,.35),
    0 4px 0 rgba(0,0,0,.33),
    0 6px 0 rgba(0,0,0,.31),
    0 8px 0 rgba(0,0,0,.30),
    0 18px 28px rgba(0,0,0,.55),
    0 0 14px rgba(0,177,231,.45);
  filter: drop-shadow(0 0 6px rgba(0,177,231,.25));
}
/* Colorful stadium theme (reverted before image) */
.pageBg {
  background-image:
    radial-gradient(1200px 600px at 10% 0%, rgba(0,177,231,.25), transparent 60%),
    radial-gradient(900px 500px at 90% 20%, rgba(15,74,161,.35), transparent 60%),
    linear-gradient(180deg, #080b14 0%, #0a1020 40%, #0e1a33 100%);
  background-attachment: fixed;
}
.glass { background: rgba(255,255,255,0.04); backdrop-filter: blur(10px); }
.glass-header { background: rgba(255,255,255,0.06); backdrop-filter: blur(6px); }
.field { background: rgba(255,255,255,0.05); color: #fff; }
`;

  // ----------------------------- Render -----------------------------
  return (
    <div className="p-4 text-white min-h-screen pageBg" style={{ position: "relative", zIndex: 1 }}>
      <style>{gpStyles}</style>

      {/* HERO HEADER */}
      <section
        className="relative rounded-2xl overflow-hidden border mb-4 min-h-[25vh] flex items-center"
        style={{ borderColor: TM_BLUE }}
      >
        <div className="relative p-6 md:p-8 w-full gpGroup">
          <h1 className="text-5xl md:text-7xl lg:text-8xl font-extrabold tracking-widest text-center select-none">
            <span className="gp3d" style={{ color: "#ffffff" }}>
              GAME
            </span>
            <span className="gp3d ml-2" style={{ color: "#ffffff" }}>
              PORT
            </span>
          </h1>
        </div>
      </section>

      {/* Tabs / Actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          {isAdmin && <TabButton id="schedule" label="SCHEDULE" tab={tab} setTab={setTab} />}
          <TabButton id="fixtures" label="FIXTURES" tab={tab} setTab={setTab} />
          <TabButton id="standings" label="STANDINGS" tab={tab} setTab={setTab} />
          <TabButton id="winners" label="WINNERS" tab={tab} setTab={setTab} />
        </div>
        <div className="flex gap-2 items-center">
          {tab === "fixtures" && isAdmin && (
            <button
              className="px-3 py-2 border rounded hover:opacity-90"
              style={{ borderColor: TM_BLUE }}
              onClick={saveAll}
            >
              Save Results
            </button>
          )}
          {!isAdmin ? (
            <button
              className="px-3 py-2 border rounded hover:bg-white hover:text-black"
              style={{ borderColor: TM_BLUE }}
              onClick={() => setShowLogin(true)}
            >
              Admin Login
            </button>
          ) : (
            <button
              className="px-3 py-2 border rounded border-red-400 text-red-300 hover:bg-red-400 hover:text-black"
              onClick={handleLogout}
            >
              Logout
            </button>
          )}
        </div>
      </div>

      {/* Admin Login Modal */}
      {showLogin && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="w-[90vw] max-w-sm border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Admin Login</h3>
              <button
                className="w-6 h-6 border border-white rounded text-xs hover:bg-white hover:text-black"
                onClick={() => setShowLogin(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label className="text-xs">Admin ID</label>
                <input
                  className="w-full field border rounded-xl p-2 focus:border-white outline-none"
                  style={{ borderColor: TM_BLUE }}
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="enter admin id"
                />
              </div>
              <div>
                <label className="text-xs">Password</label>
                <input
                  type="password"
                  className="w-full field border rounded-xl p-2 focus:border-white outline-none"
                  style={{ borderColor: TM_BLUE }}
                  value={loginPw}
                  onChange={(e) => setLoginPw(e.target.value)}
                  placeholder="password"
                />
              </div>
              <button
                type="submit"
                className="w-full px-4 py-2 border border-emerald-400 text-emerald-300 rounded hover:bg-emerald-400 hover:text-black"
              >
                Login
              </button>
              <p className="text-xs text-white/60">
                (You can change admin ID &amp; password in code before publishing.)
              </p>
            </form>
          </div>
        </div>
      )}

      {/* SCHEDULE (Admin-only) */}
      {tab === "schedule" &&
        (isAdmin ? (
          <section className="grid md:grid-cols-2 gap-4">
            <div className="border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
              <h2 className="font-semibold mb-3">Tournament Setup</h2>

              <label className="text-xs block mb-3">
                Tournament
                <select
                  className="w-full field border rounded-xl p-2 focus:border-white outline-none"
                  style={{ borderColor: TM_BLUE }}
                  value={targetTournamentId}
                  onChange={(e) => setTargetTournamentId(e.target.value)}
                >
                  <option value={NEW_TOURNEY_SENTINEL}>➕ Create New Tournament</option>
                  {tournaments.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>

              {targetTournamentId === NEW_TOURNEY_SENTINEL && (
                <label className="text-xs block mb-3">
                  Tournament Name
                  <input
                    className="w-full field border rounded-xl p-2 focus:border-white outline-none"
                    style={{ borderColor: TM_BLUE }}
                    value={tName}
                    onChange={(e) => setTName(e.target.value)}
                    placeholder="e.g., Office TT Cup — Aug 2025"
                  />
                </label>
              )}

              <label className="text-xs block mb-2">Players (one per line)</label>
              <textarea
                className="w-full h-40 field border rounded p-2 mb-2"
                style={{ borderColor: TM_BLUE }}
                placeholder={`Enter player names, one per line
Example:
Akhil
Devi
Rahul
Meera`}
                value={namesText}
                onChange={(e) => setNamesText(e.target.value)}
              />

              <div className="flex items-center justify-between mb-2">
                {/* Upload left */}
                <div>
                  <input
                    ref={uploadRef}
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      await handlePlayersUpload(f);
                      if (uploadRef.current) uploadRef.current.value = "";
                    }}
                  />
                  <button
                    className={`px-3 py-2 border rounded inline-flex items-center gap-2 ${
                      targetTournamentId !== NEW_TOURNEY_SENTINEL
                        ? "border-zinc-700 text-zinc-500 cursor-not-allowed"
                        : "border-white hover:bg-white hover:text-black"
                    }`}
                    title="Upload Entry"
                    onClick={() => {
                      if (targetTournamentId === NEW_TOURNEY_SENTINEL && uploadRef.current)
                        uploadRef.current.click();
                    }}
                    disabled={targetTournamentId !== NEW_TOURNEY_SENTINEL}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="w-4 h-4"
                    >
                      <path d="M12 3a1 1 0 0 1 1 1v8.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4A1 1 0 1 1 8.707 10.293L11 12.586V4a1 1 0 0 1 1-1z" />
                      <path d="M4 15a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H6v2h12v-2h-1a1 1 0 1 1 0-2h2a1 1 0 0 1 1 1v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4z" />
                    </svg>
                    <span>Upload Entry</span>
                  </button>
                </div>

                {/* Add Entries on right */}
                <button
                  className="px-3 py-2 border rounded border-white hover:bg-white hover:text-black"
                  onClick={
                    targetTournamentId === NEW_TOURNEY_SENTINEL
                      ? loadTeamsFromText
                      : () =>
                          applyEntriesToTournament(
                            targetTournamentId,
                            builderTeams.length
                              ? builderTeams.map((b) => b.name)
                              : namesText
                                  .split(/\r?\n/)
                                  .map((s) => s.trim())
                                  .filter(Boolean)
                          )
                  }
                >
                  Add Entries
                </button>
              </div>

              {targetTournamentId === NEW_TOURNEY_SENTINEL && builderTeams.length > 0 && (
                <div className="my-3 flex gap-4 items-center">
                  <label className="text-xs">
                    Seed 1
                    <select
                      className="field border rounded p-1 ml-1"
                      style={{ borderColor: TM_BLUE }}
                      value={seed1}
                      onChange={(e) => setSeed1(e.target.value)}
                    >
                      <option value="">—</option>
                      {builderTeams.map((tm) => (
                        <option key={tm.id} value={tm.name}>
                          {tm.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs">
                    Seed 2
                    <select
                      className="field border rounded p-1 ml-1"
                      style={{ borderColor: TM_BLUE }}
                      value={seed2}
                      onChange={(e) => setSeed2(e.target.value)}
                    >
                      <option value="">—</option>
                      {builderTeams.map((tm) => (
                        <option key={tm.id} value={tm.name}>
                          {tm.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <div className="mt-6 text-center">
                <button
                  className="px-4 py-2 border border-emerald-400 text-emerald-300 rounded hover:bg-emerald-400 hover:text-black"
                  onClick={createTournament}
                >
                  {targetTournamentId === NEW_TOURNEY_SENTINEL
                    ? "Create Tournament"
                    : "Apply Entries to Selected"}
                </button>
              </div>
            </div>

            <div className="border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
              <h2 className="font-semibold mb-3">Tips</h2>
              <ul className="list-disc ml-5 text-sm text-white/90 space-y-1">
                <li>Select a tournament or create a new one.</li>
                <li>
                  For new tournaments: paste or upload names → <b>Add Entries</b> → pick <b>Seed 1</b> &amp;{" "}
                  <b>Seed 2</b> → <b>Create Tournament</b>.
                </li>
                <li>
                  For existing: paste or load names → <b>Add Entries</b>; we fill Round 1 BYEs first, then add new
                  matches (strict top/bottom alternation in the middle).
                </li>
              </ul>
            </div>
          </section>
        ) : (
          <section className="border rounded-2xl p-6 text-sm glass" style={{ borderColor: TM_BLUE }}>
            Viewer mode. Please{" "}
            <button className="underline" onClick={() => setShowLogin(true)}>
              login as Admin
            </button>{" "}
            to access SCHEDULE.
          </section>
        ))}

      {/* FIXTURES */}
      {tab === "fixtures" && (
        <section>
          {activeTournaments.length === 0 && (
            <p className="text-white/80 text-sm">
              No active tournaments.{" "}
              {isAdmin ? (
                <>
                  Create one from <b>SCHEDULE</b>.
                </>
              ) : (
                <>Ask an admin to create one.</>
              )}
            </p>
          )}

          {activeTournaments.map((tn) => {
            const mr = maxRound(tn);
            const counts = roundCounts(tn);
            const canNext = canGenerateNext(tn);
            const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));

            return (
              <Collapsible
                key={tn.id}
                title={tn.name}
                subtitle={`Active • ${tn.teams.length} players`}
                right={
                  <div className="flex items-center gap-2">
                    {isAdmin && (
                      <button
                        className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black"
                        onClick={() => deleteTournament(tn.id)}
                        title="Delete tournament"
                      >
                        Delete
                      </button>
                    )}
                    <span className="text-xs text-white/70">
                      Current: {stageLabelByCount(counts.get(mr)) || `Round ${mr}`}
                    </span>
                    {isAdmin && (
                      <button
                        className={`px-3 py-2 rounded-xl border transition ${
                          canNext
                            ? "border-white hover:bg-white hover:text-black"
                            : "border-zinc-700 text-zinc-500 cursor-not-allowed"
                        }`}
                        disabled={!canNext}
                        onClick={() => generateNextRound(tn.id)}
                      >
                        Generate Next Round
                      </button>
                    )}
                  </div>
                }
                defaultOpen={true}
              >
                <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                  {tn.matches.map((m, i) => (
                    <MatchRow
                      key={m.id}
                      idx={i + 1}
                      m={m}
                      teamMap={teamMap}
                      stageText={stageLabelByCount(roundCounts(tn).get(m.round)) || `Round ${m.round}`}
                      onPickWinner={(mid, wid) => (isAdmin ? pickWinner(tn.id, mid, wid) : null)}
                      canEdit={isAdmin}
                    />
                  ))}
                </div>
              </Collapsible>
            );
          })}
        </section>
      )}

      {/* STANDINGS */}
      {tab === "standings" && (
        <section>
          {tournaments.length === 0 && (
            <p className="text-white/80 text-sm">
              No tournaments yet.{" "}
              {isAdmin ? (
                <>
                  Create one from <b>SCHEDULE</b>.
                </>
              ) : (
                <>Ask an admin to create one.</>
              )}
            </p>
          )}

          {tournaments.map((tn) => {
            const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
            const byRound = new Map();
            for (const m of tn.matches) {
              if (!byRound.has(m.round)) byRound.set(m.round, []);
              byRound.get(m.round).push(m);
            }
            const ordered = Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]);
            const mr = tn.matches.length ? Math.max(...tn.matches.map((m) => m.round)) : 1;
            const subtitle =
              tn.status === "completed"
                ? `Completed • Champion: ${tn.championId ? teamMap[tn.championId] || "TBD" : "TBD"}`
                : `Active • Current: ${
                    stageLabelByCount(ordered.find(([r]) => r === mr)?.[1].length || 0) || `Round ${mr}`
                  }`;

            return (
              <Collapsible key={tn.id} title={tn.name} subtitle={subtitle} defaultOpen={false}>
                {ordered.map(([round, arr]) => (
                  <div key={round} className="mb-3">
                    <h3 className="font-semibold mb-1">
                      {stageLabelByCount(arr.length) || `Round ${round}`}
                    </h3>
                    <ul className="space-y-1 text-sm">
                      {arr.map((m, i) => {
                        const a = teamMap[m.aId] || "BYE/TBD";
                        const b = teamMap[m.bId] || "BYE/TBD";
                        const w = m.winnerId ? teamMap[m.winnerId] || "TBD" : null;
                        const isFinals = stageLabelByCount(arr.length) === "Finals";
                        return (
                          <li key={m.id}>
                            {isFinals ? (
                              <>
                                {a} vs {b} — {w ? <b>{w}</b> : <span className="text-zinc-400">TBD</span>}
                              </>
                            ) : (
                              <>
                                Match {i + 1}: {a} vs {b} —{" "}
                                {w ? <b>{w}</b> : <span className="text-zinc-400">TBD</span>}
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </Collapsible>
            );
          })}
        </section>
      )}

      {/* WINNERS */}
      {tab === "winners" && (
        <section>
          {completedTournaments.length === 0 && (
            <p className="text-white/80 text-sm">
              No completed tournaments yet. Finish one in <b>FIXTURES</b>.
            </p>
          )}

          {completedTournaments.map((tn) => {
            const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
            const byRound = new Map();
            for (const m of tn.matches) {
              if (!m.winnerId) continue;
              if (!byRound.has(m.round)) byRound.set(m.round, []);
              byRound.get(m.round).push(m);
            }
            const ordered = Array.from(byRound.entries())
              .sort((a, b) => a[0] - b[0])
              .filter(([_, arr]) => {
                const label = stageLabelByCount(arr.length);
                return label === "Finals" || label === "Semi Finals";
              });

            const championName = tn.championId ? teamMap[tn.championId] || "TBD" : "TBD";

            return (
              <Collapsible
                key={tn.id}
                title={tn.name}
                subtitle={`Champion: ${championName}`}
                defaultOpen={false}
              >
                {ordered.length === 0 ? (
                  <p className="text-white/80 text-sm">No Semi Finals/Finals recorded yet.</p>
                ) : (
                  ordered.map(([round, arr]) => (
                    <div key={round} className="mb-3">
                      <h3 className="font-semibold mb-1">{stageLabelByCount(arr.length)}</h3>
                      <ul className="space-y-1 text-sm">
                        {arr.map((m, i) => {
                          const a = teamMap[m.aId] || "BYE/TBD";
                          const b = teamMap[m.bId] || "BYE/TBD";
                          const w = teamMap[m.winnerId] || "TBD";
                          return (
                            <li key={m.id}>
                              {arr.length === 1 ? (
                                <>
                                  {a} vs {b} — <b>{w}</b>
                                </>
                              ) : (
                                <>
                                  Match {i + 1}: {a} vs {b} — <b>{w}</b>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))
                )}
              </Collapsible>
            );
          })}
        </section>
      )}

      {/* FOOTER */}
      <footer className="fixed bottom-4 right-6 text-2xl font-bold text-white/80">CV ENGG TML</footer>
    </div>
  );
}

/* ----------------------------- Dev Tests (console) ----------------------------- */
(function runDevTests() {
  try {
    const IS_DEV = false; // set true to see logs
    if (!IS_DEV) return;

    function assertEqual(name, got, expected) {
      const pass = Array.isArray(expected)
        ? JSON.stringify(got) === JSON.stringify(expected)
        : got === expected;
      // eslint-disable-next-line no-console
      console.log(`[TEST] ${name}: ${pass ? "PASS" : "FAIL"}`, { got, expected });
    }

    // CSV tests
    const csvLF = "Players,Rank\nAkhil,1\nDevi,2\nRahul,3";
    const csvCRLF = "Players,Rank\r\nMeera,1\r\nMayur,2\r\nZara,3";
    const csvTab = "Players\tRank\nP1\t1\nP2\t2";
    const csvSemi = "Players;Rank\nS1;1\nS2;2";
    const csvNoCol = "Name\nX\nY";
    assertEqual("CSV LF", parseCSVPlayers(csvLF), ["Akhil", "Devi", "Rahul"]);
    assertEqual("CSV CRLF", parseCSVPlayers(csvCRLF), ["Meera", "Mayur", "Zara"]);
    assertEqual("CSV Tab", parseCSVPlayers(csvTab), ["P1", "P2"]);
    assertEqual("CSV Semi", parseCSVPlayers(csvSemi), ["S1", "S2"]);
    assertEqual("CSV Missing Players", parseCSVPlayers(csvNoCol), []);

    // Dedupe test
    const csvDup = "Players\nA\nB\nA\n a \nB";
    assertEqual("CSV Dedupe", parseCSVPlayers(csvDup), ["A", "B"]);

    // XLSX test (in-memory workbook)
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Players"], ["A"], ["B"], ["C"]]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    parseExcelPlayers(buf).then((arr) => assertEqual("XLSX Players", arr, ["A", "B", "C"]));

    // Helper tests
    assertEqual("normalizeHeader players", normalizeHeader(" Players "), "players");
    assertEqual("uniqueNames case-insensitive", uniqueNames(["A", "a", "B", "b", " "]), ["A", "B"]);

    // Stage label tests
    assertEqual("stageLabel 1", stageLabelByCount(1), "Finals");
    assertEqual("stageLabel 2", stageLabelByCount(2), "Semi Finals");
    assertEqual("stageLabel 4", stageLabelByCount(4), "Quarter Finals");
    assertEqual("stageLabel 8", stageLabelByCount(8), "Pre quarters");
    assertEqual("stageLabel other", stageLabelByCount(3), null);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("Dev tests error:", e);
  }
})();
