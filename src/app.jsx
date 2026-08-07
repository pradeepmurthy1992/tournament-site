// ====== Persistence glue (Supabase-backed, see src/db.js) ======
import React, { useEffect, useMemo, useState, useRef } from "react";
import { loadStoreOnce, saveStore, adminSetTier, adminListProfiles } from "./db";
import { useAuth } from "./auth/AuthContext";
import AuthForms from "./auth/AuthForms";
import { getSport, listSelectableSports } from "./sports/registry";
import {
  splitIntoGroups,
  buildGroupMatches,
  computeStandings,
  isGroupComplete,
  topNTeamIds,
} from "./sports/groupStage";
import {
  isValidGame,
  matchWinnerSideFromGames,
  isMatchComplete as isGamesMatchComplete,
  pointsDiffFromGames,
} from "./sports/badminton";
import { ACCENT, ACCENT_SECONDARY } from "./theme";

/* Using CDN globals (index.html):
   <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
   <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
   <script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"></script>
*/
/* global XLSX, html2canvas, jspdf */

/**
 * FixtureForge — Multi-Sport Tournament Maker
 * Tabs: DASHBOARD, SCHEDULE, FIXTURES, STANDINGS, WINNERS, DELETED (all
 * scoped to the signed-in organizer's own tournaments), EXPLORE (public,
 * placeholder), ADMIN (super admin only — cross-organizer oversight).
 */

const TM_BLUE = ACCENT; // kept as an alias so the many existing borderColor:TM_BLUE references pick up the new palette
const NEW_TOURNEY_SENTINEL = "__NEW__";
const FREE_TIER_MAX_PLAYERS = 8;
const uid = () => Math.random().toString(36).slice(2, 9);
const uuid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${uid()}-${uid()}-${uid()}`);

/* ---------------- Helpers ---------------- */
function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}
function uniqueNames(arr) {
  const seen = new Set();
  const out = [];
  for (const n of arr.map((s) => String(s || "").trim()).filter(Boolean)) {
    const k = n.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(n); }
  }
  return out;
}
function findDuplicateNamesCaseInsensitive(arr) {
  const seen = new Map();
  const dups = new Set();
  for (const raw of arr) {
    const s = String(raw || "").trim(); if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) { dups.add(seen.get(k)); dups.add(s); } else { seen.set(k, s); }
  }
  return Array.from(dups);
}
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
  } catch {
    return [];
  }
}

function timeStr(ts) { try { return new Date(ts).toLocaleString(); } catch { return String(ts || ""); } }
function playerName(teamMap, id) { return teamMap[id] || (id ? "Unknown" : "BYE/TBD"); }
function statusText(m) {
  if (m.status && String(m.status).trim()) return m.status;
  const bothEmpty = !m.aId && !m.bId;
  const singleBye = (!!m.aId && !m.bId) || (!m.aId && !!m.bId);
  if (bothEmpty) return "Empty";
  if (singleBye) return "BYE";
  return "TBD";
}
function winnerText(teamMap, m) { return m.winnerId ? (teamMap[m.winnerId] || "TBD") : "TBD"; }
function groupMatchesByRound(matches) {
  const byRound = new Map();
  for (const m of matches) { if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
  return Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]).map(([round, matches]) => ({ round, matches }));
}
function knockoutMatches(tn) {
  return (tn.matches || []).filter((m) => (m.stage || "knockout") === "knockout");
}
function stageShort(count) {
  if (!Number.isFinite(count) || count <= 0) return "R?";
  if (count === 1) return "F";
  if (count === 2) return "SF";
  if (count === 4) return "QF";
  if (count === 8) return "R16";
  if (count === 16) return "R32";
  if (count === 32) return "R64";
  return `R${count * 2}`;
}
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

/* ---------------- Excel export ---------------- */
function exportTournamentToExcel(tn) {
  try {
    const wb = XLSX.utils.book_new();
    const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
    const grouped = groupMatchesByRound(knockoutMatches(tn));
    if (grouped.length === 0) return alert("No matches to export.");
    for (const { matches } of grouped) {
      const data = [["Match #", "Player A", "Player B", "Winner", "Status"]];
      matches.forEach((m, i) => {
        data.push([i + 1, playerName(teamMap, m.aId), playerName(teamMap, m.bId), winnerText(teamMap, m), statusText(m)]);
      });
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = [{ wch: 8 }, { wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, stageShort(matches.length));
    }
    XLSX.writeFile(wb, `${tn.name.replace(/[^\w\-]+/g, "_")}_fixtures.xlsx`);
  } catch (e) { console.error("Excel export failed:", e); alert("Excel export failed. Check console."); }
}

/* ---------------- Vector PDF bracket ---------------- */
function buildProjectedRounds(tn) {
  const byRound = new Map();
  for (const m of knockoutMatches(tn)) { if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
  for (const [r, arr] of byRound) byRound.set(r, arr.slice());

  const teamCount = (tn.teams || []).length;
  if (teamCount < 2) { const only = (byRound.get(1) || []).slice(); return only.length ? [{ round: 1, matches: only }] : []; }
  const slots = nextPow2(teamCount);
  const totalRounds = Math.log2(slots);
  const out = [];
  for (let r = 1; r <= totalRounds; r++) {
    const expected = slots / Math.pow(2, r);
    const existing = (byRound.get(r) || []).slice(0, expected);
    const padded = Array.from({ length: expected }, (_, i) => existing[i] || ({
      id: `__placeholder_${r}_${i}__`, round: r, aId: null, bId: null, status: r === 1 ? "Scheduled" : "Pending", winnerId: null,
    }));
    out.push({ round: r, matches: padded });
  }
  return out;
}
function feederLabel(roundMatchesCount, i0) { return `${stageShort(roundMatchesCount)}${i0 + 1}`; }
function placeholderName(prevCount, childIndex) { return `Winner of ${feederLabel(prevCount, childIndex)}`; }

/* ===== Helpers for PDF numbering and rich text ===== */
function buildMatchNumbering(rounds) {
  // Returns: { matchNoById, idByRoundIndex, childNosByParentIndex }
  // matchNo is assigned sequentially across all projected rounds (R1..Final)
  const matchNoById = new Map();
  const idByRoundIndex = rounds.map(r => r.matches.map(m => m.id));
  let counter = 1;
  for (let r = 0; r < rounds.length; r++) {
    for (const m of rounds[r].matches) {
      matchNoById.set(m.id, counter++);
    }
  }
  // Precompute child match numbers for each parent (from r-1)
  const childNosByParentIndex = new Map(); // key `${r}:${i}` -> [c1No, c2No]
  for (let r = 1; r < rounds.length; r++) {
    const children = idByRoundIndex[r - 1];
    for (let i = 0; i < rounds[r].matches.length; i++) {
      const c1Id = children[i * 2];
      const c2Id = children[i * 2 + 1];
      const c1No = c1Id != null ? matchNoById.get(c1Id) : null;
      const c2No = c2Id != null ? matchNoById.get(c2Id) : null;
      childNosByParentIndex.set(`${r}:${i}`, [c1No, c2No]);
    }
  }
  return { matchNoById, idByRoundIndex, childNosByParentIndex };
}


/* ===== Reworked exportTournamentToPDF ===== */
/* ===== Updated helpers (centered strike, rich text) ===== */
function drawRichLine(pdf, x, y, parts, opt) {
  // parts: [{text, bold?:boolean, strike?:boolean}]
  // opt: { font: "helvetica", size: 11, color: "#000000" }
  const { font = "helvetica", size = 11, color = "#000000" } = opt || {};
  pdf.setTextColor(color);
  let cursor = x;

  for (const p of parts) {
    const style = p.bold ? "bold" : "normal";
    pdf.setFont(font, style);
    pdf.setFontSize(size);

    const text = p.text ?? "";
    const w = pdf.getTextWidth(text);
    // baseline text
    pdf.text(text, cursor, y);

    if (p.strike && w > 0) {
      // Center the strike through the visual middle of the glyphs
      // Baseline at y; approximate midline ~ y - 0.33 * size (works well for Helvetica)
      const midY = y - size * 0.33;
      const thickness = Math.max(0.6, size * 0.065);
      const prevLW = pdf.getLineWidth();
      pdf.setLineWidth(thickness);
      pdf.line(cursor, midY, cursor + w, midY);
      pdf.setLineWidth(prevLW);
    }
    cursor += w;
  }
}

/* Pretty line builder */
function buildParts(text, { bold = false, strike = false } = {}) {
  return [{ text, bold, strike }];
}

/* ===== Reworked exportTournamentToPDF (two-line layout + thin borders) ===== */
async function exportTournamentToPDF(tn) {
  const jsPDFCtor =
    (window.jspdf && window.jspdf.jsPDF) ||
    window.jsPDF ||
    (window.jspdf && window.jspdf.default);
  if (!jsPDFCtor) {
    alert("jsPDF not found. Include jspdf.umd.min.js");
    return;
  }

  const rounds = buildProjectedRounds(tn);
  if (!rounds.length) {
    alert("No matches to export.");
    return;
  }

  // Assign sequential match numbers across all rounds (R1..Final)
  const matchNoById = new Map();
  let mCounter = 1;
  for (const r of rounds) for (const m of r.matches) matchNoById.set(m.id, mCounter++);

  // Quick lookup for team names
  const teamMap = Object.fromEntries((tn.teams || []).map((t) => [t.id, t.name]));

  // Layout constants
  const boxW = 200;
  const boxH = 50;
  const colGap = 50;
  const vGap = 20; // base vertical gap

  // PDF setup
  const pdf = new jsPDFCtor({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 36;
  const BG = "#ffffff";
  const FG = "#000000";

  // Title
  pdf.setFillColor(BG);
  pdf.rect(0, 0, pageW, pageH, "F");
  pdf.setTextColor(FG);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.text(`${tn.name} — Fixtures`, margin, margin + 6);

  // Calculate column X positions
  const colX = Array.from({ length: rounds.length }, (_, i) => i * (boxW + colGap));
  
  // Calculate total width for scaling
  const totalW = rounds.length * boxW + (rounds.length - 1) * colGap;
  const maxW = pageW - margin * 2;
  const maxH = pageH - (margin * 2 + 30);
  
  // Calculate positions for each round
  const positions = [];
  
  // First round: evenly spaced
  const r1Matches = rounds[0].matches.length;
  const r1TotalH = r1Matches * boxH + (r1Matches - 1) * vGap;
  const scale = Math.min(1, maxW / totalW, maxH / r1TotalH);
  
  positions[0] = [];
  for (let i = 0; i < r1Matches; i++) {
    positions[0][i] = {
      x: colX[0],
      y: i * (boxH + vGap),
      w: boxW,
      h: boxH
    };
  }

  // Subsequent rounds: center between child matches
  for (let r = 1; r < rounds.length; r++) {
    positions[r] = [];
    const matches = rounds[r].matches;
    
    for (let i = 0; i < matches.length; i++) {
      // Find the two child matches
      const child1Idx = i * 2;
      const child2Idx = i * 2 + 1;
      
      const child1Pos = positions[r - 1][child1Idx];
      const child2Pos = positions[r - 1][child2Idx];
      
      // Center this match between its two children
      const centerY = (child1Pos.y + child1Pos.h/2 + child2Pos.y + child2Pos.h/2) / 2;
      
      positions[r][i] = {
        x: colX[r],
        y: centerY - boxH/2,
        w: boxW,
        h: boxH
      };
    }
  }

  const originX = margin;
  const originY = margin + 40;

  // Draw all boxes and content
  for (let r = 0; r < rounds.length; r++) {
    const matches = rounds[r].matches;
    
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const pos = positions[r][i];
      
      const x = originX + scale * pos.x;
      const y = originY + scale * pos.y;
      const w = scale * pos.w;
      const h = scale * pos.h;

      // Draw box
      pdf.setDrawColor(0);
      pdf.setLineWidth(Math.max(0.6, 0.6 * scale));
      pdf.rect(x, y, w, h, "S");

      // Draw content
      const titleFontSize = 9 * scale;
      const playerFontSize = 10 * scale;
      const padding = 6 * scale;

      // Match title
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(titleFontSize);
      pdf.setTextColor(FG);
      pdf.text(`Match M${matchNoById.get(m.id)}`, x + padding, y + 12 * scale);

      // Player names or placeholders
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(playerFontSize);

      let line1Text, line2Text;

      if (r === 0) {
        // First round: actual player names
        const aName = teamMap[m.aId] || (m.aId ? "Unknown" : "BYE/TBD");
        const bName = teamMap[m.bId] || (m.bId ? "Unknown" : "BYE/TBD");
        line1Text = `${aName}  VS`;
        line2Text = bName;
      } else {
        // Later rounds: winner placeholders
        const child1Idx = i * 2;
        const child2Idx = i * 2 + 1;
        const child1 = rounds[r - 1].matches[child1Idx];
        const child2 = rounds[r - 1].matches[child2Idx];
        const child1No = child1 ? matchNoById.get(child1.id) : "?";
        const child2No = child2 ? matchNoById.get(child2.id) : "?";
        line1Text = `[Winner of M${child1No}]  VS`;
        line2Text = `[Winner of M${child2No}]`;
      }

      // Position text vertically centered
      const line1Y = y + h/2 - 4 * scale;
      const line2Y = y + h/2 + 8 * scale;

      pdf.text(line1Text, x + padding, line1Y);
      pdf.text(line2Text, x + padding, line2Y);
    }
  }

  // Draw connectors
  for (let r = 0; r < rounds.length - 1; r++) {
    const parentMatches = rounds[r + 1].matches;
    
    for (let i = 0; i < parentMatches.length; i++) {
      const parentPos = positions[r + 1][i];
      const child1Pos = positions[r][i * 2];
      const child2Pos = positions[r][i * 2 + 1];

      const parentX = originX + scale * parentPos.x;
      const parentY = originY + scale * (parentPos.y + parentPos.h/2);
      
      const child1X = originX + scale * (child1Pos.x + child1Pos.w);
      const child1Y = originY + scale * (child1Pos.y + child1Pos.h/2);
      
      const child2X = originX + scale * (child2Pos.x + child2Pos.w);
      const child2Y = originY + scale * (child2Pos.y + child2Pos.h/2);

      const junctionX = parentX - 15 * scale;

      pdf.setDrawColor(0);
      pdf.setLineWidth(Math.max(0.6, 0.6 * scale));
      
      // Horizontal lines from children to junction
      pdf.line(child1X, child1Y, junctionX, child1Y);
      pdf.line(child2X, child2Y, junctionX, child2Y);
      
      // Vertical line connecting the children
      pdf.line(junctionX, child1Y, junctionX, child2Y);
      
      // Horizontal line from junction to parent
      pdf.line(junctionX, parentY, parentX, parentY);
    }
  }

  pdf.save(`${tn.name.replace(/[^\w\-]+/g, "_")}_fixtures.pdf`);
}




/* ---------------- Dark themed custom select (mobile + desktop) ---------------- */
function DarkSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  className = "",
  style = {},
  itemClassName = "",
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const [focusIdx, setFocusIdx] = useState(-1);

  const current = options.find(o => o.value === value) || null;

  useEffect(() => {
    function onDocClick(e) {
      if (!btnRef.current) return;
      if (btnRef.current.contains(e.target)) return;
      if (listRef.current && listRef.current.contains(e.target)) return;
      setOpen(false); setFocusIdx(-1);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function openMenu() {
    if (disabled) return;
    setOpen(true);
    const idx = Math.max(0, options.findIndex(o => o.value === value));
    setFocusIdx(idx);
    // decide dropUp vs dropDown
    setTimeout(() => {
      const btn = btnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const spaceBelow = vh - rect.bottom;
      const approxListH = Math.min(320, options.length * 40 + 8); // ~item height 40px
      setDropUp(spaceBelow < approxListH && rect.top > approxListH);
    }, 0);
  }

  function choose(idx) {
    const opt = options[idx];
    if (!opt) return;
    onChange?.(opt.value);
    setOpen(false); setFocusIdx(-1);
  }

  function onKeyDown(e) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); setFocusIdx(-1); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx(i => Math.min(options.length - 1, (i < 0 ? 0 : i + 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx(i => Math.max(0, (i < 0 ? 0 : i - 1))); }
    else if (e.key === "Enter") { e.preventDefault(); if (focusIdx >= 0) choose(focusIdx); }
    else if (e.key === "Tab") { setOpen(false); setFocusIdx(-1); }
  }

  return (
    <div className={`relative w-full ${className}`} style={{ ...style }}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border field focus:border-white outline-none transition
          ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-white/5 cursor-pointer"}`}
        style={{ borderColor: TM_BLUE }}
      >
        <span className={`truncate ${current ? "" : "text-white/60"}`}>
          {current ? (current.label ?? String(current.value)) : placeholder}
        </span>
        <svg viewBox="0 0 24 24" className={`w-4 h-4 shrink-0 transition-transform ${open && !dropUp ? "rotate-180" : ""}`} fill="currentColor" aria-hidden="true">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className={`absolute z-50 max-h-80 w-full overflow-auto rounded-xl border glass shadow-xl`}
          style={{
            borderColor: TM_BLUE,
            background: "rgba(20,22,35,0.98)",
            backdropFilter: "blur(8px)",
            marginTop: dropUp ? 0 : 4,
            marginBottom: dropUp ? 4 : 0,
            bottom: dropUp ? "calc(100%)" : "auto",
            top: dropUp ? "auto" : "calc(100%)",
          }}
          onKeyDown={onKeyDown}
        >
          {options.length === 0 ? (
            <li className="px-3 py-2 text-sm text-white/60">No options</li>
          ) : options.map((o, idx) => {
            const isSelected = value === o.value;
            const isFocused = focusIdx === idx;
            return (
              <li
                key={String(o.value) + idx}
                role="option"
                aria-selected={isSelected}
                className={`px-3 py-2 text-sm text-white flex items-center justify-between
                  ${isFocused ? "bg-white/10" : "bg-transparent"}
                  hover:bg-white/10 cursor-pointer ${itemClassName}`}
                onMouseEnter={() => setFocusIdx(idx)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(idx)}
              >
                <span className="truncate">{o.label ?? String(o.value)}</span>
                {isSelected && (
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
                    <path d="M9 16.2l-3.5-3.6L4 14.1 9 19l11-11-1.5-1.4z" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------- UI bits ---------------- */
function TabButton({ id, label, tab, setTab }) {
  const active = tab === id;
  return (
    <button
      onClick={() => setTab(id)}
      className="px-3 py-2 rounded-xl border transition hover:opacity-90"
      style={{
        borderColor: TM_BLUE,
        backgroundColor: active ? TM_BLUE : "transparent",
        color: "white",
      }}
    >
      {label}
    </button>
  );
}
function Collapsible({ title, subtitle, right, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-zinc-700 rounded-2xl mb-3 overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3 py-2 glass-header" style={{ borderColor: TM_BLUE }}>
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
        <div className="flex flex-wrap gap-2">{right}</div>
      </div>
      {open && <div className="p-3">{children}</div>}
    </div>
  );
}
// Best-of-N game-score entry for "games"-model sports (badminton, table tennis).
function GameScoreEntry({ games, gameConfig, onChange, disabled }) {
  const list = games && games.length ? games : [{ a: "", b: "" }];
  const bestOf = gameConfig.bestOf;
  const winnerSide = matchWinnerSideFromGames(list, bestOf);
  const decidedGames = list.filter((g) => g.a !== "" && g.b !== "" && isValidGame({ a: Number(g.a), b: Number(g.b) }, gameConfig)).length;

  function setGame(i, side, value) {
    const next = list.map((g, gi) => (gi === i ? { ...g, [side]: value } : g));
    onChange(next.map((g) => ({ a: g.a === "" ? "" : Number(g.a), b: g.b === "" ? "" : Number(g.b) })));
  }
  function addGame() { onChange([...list, { a: "", b: "" }]); }
  function removeGame(i) { onChange(list.filter((_, gi) => gi !== i)); }

  return (
    <div className="flex flex-col gap-1 w-full sm:w-auto">
      {list.map((g, i) => {
        const valid = g.a === "" || g.b === "" ? true : isValidGame({ a: Number(g.a), b: Number(g.b) }, gameConfig);
        return (
          <div key={i} className="flex items-center gap-1">
            <span className="text-[10px] text-white/50 w-6">G{i + 1}</span>
            <input type="number" min={0} disabled={disabled} value={g.a}
              onChange={(e) => setGame(i, "a", e.target.value)}
              className="w-14 field border rounded p-1 text-center" style={{ borderColor: TM_BLUE }} />
            <span className="text-white/50">–</span>
            <input type="number" min={0} disabled={disabled} value={g.b}
              onChange={(e) => setGame(i, "b", e.target.value)}
              className="w-14 field border rounded p-1 text-center" style={{ borderColor: TM_BLUE }} />
            {!disabled && list.length > 1 && (
              <button type="button" onClick={() => removeGame(i)} className="text-white/40 hover:text-red-300 text-xs px-1">✕</button>
            )}
            {!valid && <span className="text-[10px] text-red-300">invalid score</span>}
          </div>
        );
      })}
      {!disabled && list.length < bestOf && (
        <button type="button" onClick={addGame} className="text-[11px] text-left text-white/60 hover:text-white underline">+ add game</button>
      )}
      <span className="text-[10px] text-white/50">
        {winnerSide ? "Match decided" : `Best of ${bestOf} • ${decidedGames} game(s) recorded`}
      </span>
    </div>
  );
}

function MatchRow({ idx, m, teamMap, onPickWinner, onUpdateGames, sport, stageText, canEdit }) {
  const aName = teamMap[m.aId] || (m.aId ? "Unknown" : "BYE/TBD");
  const bName = teamMap[m.bId] || (m.bId ? "Unknown" : "BYE/TBD");
  const bothEmpty = !m.aId && !m.bId;
  const singleBye = (!!m.aId && !m.bId) || (!m.aId && !!m.bId);
  const usesGames = sport?.matchModel === "games" && !bothEmpty && !singleBye;
  const aEliminated = m.winnerId && m.aId && m.winnerId !== m.aId;
  const bEliminated = m.winnerId && m.bId && m.winnerId !== m.bId;
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-1 sm:gap-2 py-2 text-sm">
      <span className="text-zinc-400 sm:w-24">
        {stageText}{stageText === "F" ? "" : <> • M{idx}</>}
      </span>
      <div className={`flex-1 ${aEliminated ? "line-through text-white/40" : ""}`}>{aName}</div>
      {!bothEmpty && !singleBye && <span className="hidden sm:inline">vs</span>}
      <div className={`flex-1 ${bEliminated ? "line-through text-white/40" : ""}`}>{bName}</div>

      {usesGames ? (
        canEdit ? (
          <GameScoreEntry
            games={m.games || []}
            gameConfig={sport.gameConfig}
            onChange={(games) => onUpdateGames(m.id, games)}
          />
        ) : (
          <span className="text-xs">
            {(m.games || []).length === 0 ? (
              <span className="text-white/60">Not started</span>
            ) : (
              <>
                {(m.games || []).map((g, i) => `${g.a}-${g.b}`).join(", ")}
                {m.winnerId && <> — Winner: <b>{teamMap[m.winnerId] || "TBD"}</b></>}
              </>
            )}
          </span>
        )
      ) : !canEdit ? (
        <span className="text-xs">
          {bothEmpty ? (
            <span className="text-white/60">(empty pairing)</span>
          ) : singleBye ? (
            <span className="text-white/70">Auto-advance available</span>
          ) : m.winnerId ? (
            <>Winner: <b>{teamMap[m.winnerId] || "TBD"}</b></>
          ) : (
            <span className="text-white/60">Winner: TBD</span>
          )}
        </span>
      ) : bothEmpty ? (
        <span className="text-xs text-white/60">(empty pairing)</span>
      ) : singleBye ? (
        <button
          className={`px-2 py-1 rounded border ${
            m.winnerId ? "border-emerald-400 text-emerald-300" : "border-white hover:bg-white hover:text-black"
          }`}
          onClick={() => { const winnerId = m.aId || m.bId || null; if (winnerId) onPickWinner(m.id, winnerId); }}
        >
          {m.winnerId ? "Advanced" : "Auto-advance"}
        </button>
      ) : (
        <div className="w-full sm:w-auto sm:min-w-[200px]">
          <DarkSelect
            value={m.winnerId || ""}
            onChange={(val) => onPickWinner(m.id, val || null)}
            options={[
              { value: "", label: "Winner — pick" },
              ...(m.aId ? [{ value: m.aId, label: aName }] : []),
              ...(m.bId ? [{ value: m.bId, label: bName }] : []),
            ]}
          />
        </div>
      )}
    </div>
  );
}

// Group-stage standings table: Played / Won / Lost / Points / Diff.
function GroupStandingsTable({ group, standings, teamMap }) {
  return (
    <div className="mb-4">
      <h4 className="font-semibold mb-1 text-sm">{group.name}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm border-collapse">
          <thead>
            <tr className="text-left text-white/60 border-b" style={{ borderColor: "rgba(255,255,255,0.15)" }}>
              <th className="py-1 pr-2">Player</th>
              <th className="py-1 px-2 text-center">P</th>
              <th className="py-1 px-2 text-center">W</th>
              <th className="py-1 px-2 text-center">L</th>
              <th className="py-1 px-2 text-center">Pts</th>
              <th className="py-1 px-2 text-center">Diff</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row, i) => (
              <tr key={row.teamId} className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                <td className="py-1 pr-2">{i < 2 && <span className="text-emerald-300">●</span>} {teamMap[row.teamId] || "Unknown"}</td>
                <td className="py-1 px-2 text-center">{row.played}</td>
                <td className="py-1 px-2 text-center">{row.won}</td>
                <td className="py-1 px-2 text-center">{row.lost}</td>
                <td className="py-1 px-2 text-center font-semibold">{row.points}</td>
                <td className="py-1 px-2 text-center">{row.diff > 0 ? `+${row.diff}` : row.diff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Clickable group-summary card: name, player count, match progress. Used
// as the drill-down entry point into a group's fixtures (see FIXTURES tab)
// instead of dumping every group's matches into one long flat list.
function GroupCard({ group, playerCount, played, total, selected, onClick }) {
  const pct = total > 0 ? Math.round((played / total) * 100) : 0;
  const complete = total > 0 && played === total;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-2 transition ${selected ? "glass" : "hover:bg-white/5"}`}
      style={{ borderColor: selected ? ACCENT : "rgba(255,255,255,0.15)", boxShadow: selected ? `0 0 0 1px ${ACCENT}` : "none" }}
    >
      <div className="flex items-center justify-between gap-1 mb-0.5">
        <span className="font-semibold text-xs truncate">{group.name}</span>
        {complete && <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase" style={{ background: ACCENT_SECONDARY, color: "#08201c" }}>Done</span>}
      </div>
      <div className="text-[10px] text-white/60 mb-1.5 truncate">{playerCount}p • {played}/{total} played</div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.1)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: complete ? ACCENT_SECONDARY : ACCENT }} />
      </div>
    </button>
  );
}

// Single read-only match box for the visual bracket: two names stacked,
// the eliminated side struck through, winner bolded. Unreached future
// matches show "Winner of M#" placeholders (matchNo comes from
// buildMatchNumbering, same sequential numbering the PDF export uses).
function BracketMatchBox({ m, teamMap, childNos }) {
  const aElim = m.winnerId && m.aId && m.winnerId !== m.aId;
  const bElim = m.winnerId && m.bId && m.winnerId !== m.bId;
  const isFuture = !m.aId && !m.bId && childNos;
  const aName = m.aId ? (teamMap[m.aId] || "Unknown") : (isFuture ? `Winner of M${childNos[0] ?? "?"}` : "BYE/TBD");
  const bName = m.bId ? (teamMap[m.bId] || "Unknown") : (isFuture ? `Winner of M${childNos[1] ?? "?"}` : "BYE/TBD");
  return (
    <div className="rounded-lg border px-2 py-1.5 text-[11px] w-36 sm:w-40 shrink-0"
      style={{ borderColor: m.winnerId ? ACCENT_SECONDARY : "rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.03)" }}>
      <div className={`truncate ${aElim ? "line-through text-white/35" : m.winnerId === m.aId ? "font-semibold" : isFuture ? "text-white/40 italic" : ""}`}>{aName}</div>
      <div className="h-px my-1" style={{ background: "rgba(255,255,255,0.1)" }} />
      <div className={`truncate ${bElim ? "line-through text-white/35" : m.winnerId === m.bId ? "font-semibold" : isFuture ? "text-white/40 italic" : ""}`}>{bName}</div>
    </div>
  );
}

// Full read-only knockout bracket: one column per round, horizontally
// scrollable, each round's boxes evenly spaced across the tallest
// column's height — a light-weight approximation of proper bracket
// connectors without needing pixel-exact JS layout math.
function KnockoutBracket({ tn, teamMap }) {
  const rounds = buildProjectedRounds(tn);
  if (!rounds.length) return <p className="text-sm text-white/60 px-1">No knockout matches yet.</p>;
  const { childNosByParentIndex } = buildMatchNumbering(rounds);
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-5 items-stretch" style={{ width: "max-content" }}>
        {rounds.map((r, ri) => (
          <div key={r.round} className="flex flex-col justify-around gap-3">
            <div className="text-center text-[10px] font-semibold text-white/60 uppercase tracking-wide">{stageShort(r.matches.length)}</div>
            {r.matches.map((m, mi) => (
              <BracketMatchBox
                key={m.id}
                m={m}
                teamMap={teamMap}
                childNos={ri > 0 ? childNosByParentIndex.get(`${ri}:${mi}`) : null}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Component ---------------- */
export default function TournamentMaker() {
  const [tab, setTab] = useState("dashboard");

  // Auth — real Supabase account, not the old shared access-code scheme.
  const { user, profile, loading: authLoading, isSuperAdmin, isPaid, signOut } = useAuth();
  const isLoggedIn = !!user;

  // Admin tab data (super admin only)
  const [profiles, setProfiles] = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(false);

  // FIXTURES tab: which group is currently drilled into, per tournament ({ [tournamentId]: groupId })
  const [selectedGroupByTournament, setSelectedGroupByTournament] = useState({});

  // Builder state
  const [tName, setTName] = useState("");
  const [targetTournamentId, setTargetTournamentId] = useState(NEW_TOURNEY_SENTINEL);
  const [namesText, setNamesText] = useState("");
  const [seed1, setSeed1] = useState("");
  const [seed2, setSeed2] = useState("");
  const [seed3, setSeed3] = useState("");
  const [seed4, setSeed4] = useState("");
  const [builderTeams, setBuilderTeams] = useState([]);
  const [sportId, setSportId] = useState("generic");
  const [format, setFormat] = useState("knockout"); // "knockout" | "groups"
  const [numGroups, setNumGroups] = useState(2);
  const [advancePerGroup, setAdvancePerGroup] = useState(2);

  const uploadRef = useRef(null);

  // Data
  const [tournaments, setTournaments] = useState(() => []);
  const [deletedTournaments, setDeletedTournaments] = useState(() => []);
  const [loadState, setLoadState] = useState("loading"); // "loading" | "ready" | "error"
  const [loadError, setLoadError] = useState("");

  // Delete modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState(null);

  async function refreshFromStore() {
    setLoadState("loading");
    try {
      const data = await loadStoreOnce();
      setTournaments(Array.isArray(data.tournaments) ? data.tournaments : []);
      setDeletedTournaments(Array.isArray(data.deleted) ? data.deleted : []);
      setLoadState("ready");
    } catch (e) {
      console.warn("Load error:", e);
      setLoadError(e?.message || "Failed to load tournaments.");
      setLoadState("error");
    }
  }

  useEffect(() => {
    if (!user) { setTournaments([]); setDeletedTournaments([]); setLoadState("ready"); return; }
    refreshFromStore();
  }, [user]);

  // Free-tier tournaments are always a single round-robin group — lock the
  // builder state to that shape rather than letting a stale paid-tier
  // selection linger (e.g. right after a downgrade).
  useEffect(() => {
    if (isPaid) return;
    setFormat("groups"); setNumGroups(1); setAdvancePerGroup(1);
  }, [isPaid]);

  useEffect(() => {
    if (!isSuperAdmin || tab !== "admin") return;
    setProfilesLoading(true);
    adminListProfiles().then(setProfiles).catch((e) => console.warn("Failed to load profiles:", e)).finally(() => setProfilesLoading(false));
  }, [isSuperAdmin, tab]);

  // RLS already scopes `tournaments`/`deletedTournaments` to what the caller
  // may read (own rows, or — for the super admin — everyone's). The normal
  // tabs (Schedule/Fixtures/Standings/Winners/Deleted) only ever show the
  // signed-in user's *own* tournaments, even for the super admin — cross-
  // organizer visibility is deliberately confined to the Admin tab instead
  // of leaking into everyday editing screens.
  const myTournaments = useMemo(() => tournaments.filter((t) => t.ownerId === user?.id), [tournaments, user]);
  const myDeletedTournaments = useMemo(() => deletedTournaments.filter((t) => t.ownerId === user?.id), [deletedTournaments, user]);

  const builderTeamMap = useMemo(
    () => Object.fromEntries(builderTeams.map((tm) => [tm.name, tm.id])),
    [builderTeams]
  );

  function loadTeamsFromText() {
    if (!isLoggedIn) return alert("Please log in first.");
    const lines = namesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const uniq = Array.from(new Set(lines));
    const dups = findDuplicateNamesCaseInsensitive(lines);
    if (dups.length > 0) {
      alert("Duplicate names found:\n\n" + dups.map((n) => `• ${n}`).join("\n") + "\n\nPlease fix and try again.");
      return;
    }
    const teams = uniq.map((n) => ({ id: uid(), name: n }));
    setBuilderTeams(teams);
    if (targetTournamentId === NEW_TOURNEY_SENTINEL) {
      setSeed1(uniq[0] || ""); setSeed2(uniq[1] || ""); setSeed3(uniq[2] || ""); setSeed4(uniq[3] || "");
    }
  }

  async function handlePlayersUpload(file) {
    if (!isLoggedIn) return alert("Please log in first.");
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    let names = [];
    if (ext === "csv") { const text = await file.text(); names = parseCSVPlayers(text); }
    else if (ext === "xlsx" || ext === "xls") { const buf = await file.arrayBuffer(); names = await parseExcelPlayers(buf); }
    else return alert("Unsupported file type. Please upload .csv, .xlsx, or .xls");
    if (names.length === 0) return alert("Could not find a 'Players' column in the file.");

    const dups = findDuplicateNamesCaseInsensitive(names);
    if (dups.length > 0) {
      alert("Duplicate names found in uploaded file:\n\n" + dups.map((n) => `• ${n}`).join("\n") + "\n\nPlease fix and re-upload.");
      return;
    }
    const teams = names.map((n) => ({ id: uid(), name: n }));
    setBuilderTeams(teams);
    if (targetTournamentId === NEW_TOURNEY_SENTINEL) {
      setSeed1(names[0] || ""); setSeed2(names[1] || ""); setSeed3(names[2] || ""); setSeed4(names[3] || "");
    }
  }

  function roundCounts(tn) { const mp = new Map(); for (const m of knockoutMatches(tn)) { if (!(m.aId || m.bId)) continue; mp.set(m.round, (mp.get(m.round) || 0) + 1); } return mp; }
  function maxRound(tn) { const ko = knockoutMatches(tn); return ko.length ? Math.max(...ko.map((m) => m.round)) : 0; }
  function currentRoundMatches(tn) { const mr = maxRound(tn); return knockoutMatches(tn).filter((m) => m.round === mr); }
  function canGenerateNext(tn) { const cur = currentRoundMatches(tn); if (!cur.length) return false; const valid = cur.filter((m) => m.aId || m.bId); return valid.length > 0 && valid.every((m) => !!m.winnerId); }

  // Has the group stage finished (all group matches decided) and knockout not yet generated?
  function canGenerateKnockoutFromGroups(tn) {
    if (tn.format !== "groups" || tn.groupStage?.complete) return false;
    const groupMatches = (tn.matches || []).filter((m) => m.stage === "group");
    if (!groupMatches.length) return false;
    return (tn.groups || []).every((g) =>
      isGroupComplete(groupMatches.filter((m) => m.groupId === g.id))
    );
  }

  function generateRound1Matches(teams, seeds) {
    const names = teams.map((x) => x.name);
    let size = 1; while (size < names.length) size *= 2;
    const slots = Array(size).fill(null);
    const hasS3 = !!seeds.s3, hasS4 = !!seeds.s4;
    slots[0] = seeds.s1; slots[size - 1] = seeds.s2;
    if (hasS3 && hasS4 && size >= 4) { slots[size / 2] = seeds.s3; slots[size / 2 - 1] = seeds.s4; }
    const reserved = new Set([seeds.s1, seeds.s2, hasS3 ? seeds.s3 : null, hasS4 ? seeds.s4 : null].filter(Boolean).map((n) => n.toLowerCase()));
    const others = names.filter((n) => !reserved.has(n.toLowerCase()));
    const shuffled = (() => { const a = others.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; })();

    const order = []; const half = size / 2, quarter = size / 4;
    function pushRange(s, e) { for (let i = s; i < e; i++) if (slots[i] === null) order.push(i); }
    pushRange(0, quarter); pushRange(half, half + quarter); pushRange(quarter, half); pushRange(half + quarter, size);

    let oi = 0; for (const pos of order) { if (oi >= shuffled.length) break; slots[pos] = shuffled[oi++]; }

    const nameToId = Object.fromEntries(teams.map((tm) => [tm.name, tm.id]));
    const matches = [];
    for (let i = 0; i < size; i += 2) {
      const aId = slots[i] ? nameToId[slots[i]] : null;
      const bId = slots[i + 1] ? nameToId[slots[i + 1]] : null;
      if (!aId && !bId) continue;
      const bye = !aId || !bId;
      matches.push({ id: uid(), stage: "knockout", round: 1, aId, bId, status: bye ? "BYE" : "Scheduled", winnerId: bye ? (aId || bId || null) : null, games: [] });
    }
    return matches;
  }

  // Seeds the top-N finishers of each group into a fresh knockout bracket,
  // reusing the existing seeding engine. Advancing teams are interleaved
  // across groups (all rank-1s, then all rank-2s, ...) so same-group teams
  // are less likely to meet in the very first round.
  function generateKnockoutFromGroups(tournamentId) {
    if (!isLoggedIn) return alert("Please log in first.");
    setTournaments((prev) => prev.map((tn) => {
      if (tn.id !== tournamentId) return tn;
      if (!canGenerateKnockoutFromGroups(tn)) return tn;
      const sport = getSport(tn.sport);
      const teamMap = Object.fromEntries(tn.teams.map((t) => [t.id, t.name]));
      const groupMatches = tn.matches.filter((m) => m.stage === "group");
      const advancingByGroup = tn.groups.map((g) => {
        const gm = groupMatches.filter((m) => m.groupId === g.id);
        const standings = computeStandings(g.teamIds, gm, {
          pointsRule: sport.pointsRule,
          getDiff: sport.matchModel === "games" ? (m) => pointsDiffFromGames(m.games) : undefined,
        });
        return topNTeamIds(standings, tn.groupStage.advancePerGroup);
      });
      const advancing = [];
      const maxLen = Math.max(...advancingByGroup.map((a) => a.length), 0);
      for (let rank = 0; rank < maxLen; rank++) {
        for (const grp of advancingByGroup) if (grp[rank]) advancing.push(grp[rank]);
      }
      const teams = advancing.map((id) => ({ id, name: teamMap[id] }));
      if (teams.length < 2) { alert("Not enough teams advanced to form a knockout bracket."); return tn; }
      const s1 = teams[0]?.name, s2 = teams[1]?.name;
      const matches = generateRound1Matches(teams, { s1, s2, s3: null, s4: null });
      return { ...tn, matches: [...tn.matches, ...matches], groupStage: { ...tn.groupStage, complete: true } };
    }));
  }

  function pickWinner(tournamentId, matchId, winnerId) {
    if (!isLoggedIn) return alert("Please log in first.");
    setTournaments((prev) => prev.map((tn) => {
      if (tn.id !== tournamentId) return tn;
      const matches = tn.matches.map((m) => (m.id === matchId ? { ...m, winnerId, status: winnerId ? "Final" : m.status } : m));
      return { ...tn, matches };
    }));
  }

  // Updates the game-by-game score for a "games"-model match (badminton) and
  // derives the winner once enough games have been won.
  function updateMatchGames(tournamentId, matchId, games) {
    if (!isLoggedIn) return alert("Please log in first.");
    setTournaments((prev) => prev.map((tn) => {
      if (tn.id !== tournamentId) return tn;
      const sport = getSport(tn.sport);
      const bestOf = sport.gameConfig?.bestOf || 3;
      const matches = tn.matches.map((m) => {
        if (m.id !== matchId) return m;
        const side = matchWinnerSideFromGames(games, bestOf);
        const winnerId = side === "a" ? m.aId : side === "b" ? m.bId : null;
        return { ...m, games, winnerId, status: winnerId ? "Final" : "Scheduled" };
      });
      return { ...tn, matches };
    }));
  }
  function generateNextRound(tournamentId) {
    if (!isLoggedIn) return alert("Please log in first.");
    setTournaments((prev) => prev.map((tn) => {
      if (tn.id !== tournamentId) return tn;
      if (!canGenerateNext(tn)) return tn;
      const cur = currentRoundMatches(tn).filter((m) => m.aId || m.bId);
      const winners = cur.map((m) => m.winnerId).filter(Boolean);
      if (winners.length <= 1) return { ...tn, status: "completed", championId: winners[0] || null };
      const nextRoundNo = maxRound(tn) + 1, next = [];
      for (let i = 0; i < winners.length; i += 2) {
        const aId = winners[i] || null, bId = winners[i + 1] || null;
        if (!aId && !bId) continue;
        const bye = !aId || !bId;
        next.push({ id: uid(), stage: "knockout", round: nextRoundNo, aId, bId, status: bye ? "BYE" : "Scheduled", winnerId: bye ? (aId || bId || null) : null, games: [] });
      }
      return { ...tn, matches: [...tn.matches, ...next] };
    }));
  }

  function openDeleteModal(tournamentId) { if (!isLoggedIn) return alert("Please log in first."); setDeleteTargetId(tournamentId); setShowDeleteModal(true); }
  function confirmDelete() {
    if (!isLoggedIn) return;
    setTournaments((prev) => {
      const idx = prev.findIndex((t) => t.id === deleteTargetId); if (idx === -1) return prev;
      const t = prev[idx]; const remaining = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      const archived = { ...t, deletedAt: Date.now() };
      setDeletedTournaments((old) => [archived, ...old]);
      return remaining;
    });
    setShowDeleteModal(false); setDeleteTargetId(null);
  }
  function cancelDelete() { setShowDeleteModal(false); setDeleteTargetId(null); }
  function restoreTournament(tournamentId) {
    if (!isLoggedIn) return alert("Please log in first.");
    setDeletedTournaments((prevDeleted) => {
      const idx = prevDeleted.findIndex((t) => t.id === tournamentId);
      if (idx === -1) return prevDeleted;
      const t = prevDeleted[idx]; const restDeleted = [...prevDeleted.slice(0, idx), ...prevDeleted.slice(idx + 1)]; const { deletedAt, ...restored } = t;
      setTournaments((prev) => [restored, ...prev]);
      return restDeleted;
    });
    setTab("fixtures");
  }
  function deleteForever(tournamentId) {
    if (!isLoggedIn) return alert("Please log in first.");
    const ok = window.confirm("Permanently delete this tournament from DELETED?\nThis cannot be undone.");
    if (!ok) return;
    setDeletedTournaments((prev) => prev.filter((t) => t.id !== tournamentId));
  }

  function applyEntriesToTournament(tournamentId, newNames) {
    if (!isLoggedIn) return alert("Please log in first.");
    const dups = findDuplicateNamesCaseInsensitive(newNames);
    if (dups.length > 0) {
      alert("Duplicate names found:\n\n" + dups.map((n) => `• ${n}`).join("\n") + "\n\nPlease remove duplicates and try again.");
      return;
    }
    setTournaments((prev) => prev.map((tn) => {
      if (tn.id !== tournamentId) return tn;
      const maxR = maxRound(tn); if (maxR > 1) { alert("Cannot add entries after Round 1."); return tn; }
      const existingNamesSet = new Set(tn.teams.map((t) => t.name.toLowerCase()));
      const toAddNames = uniqueNames(newNames).filter((n) => !existingNamesSet.has(n.toLowerCase()));
      if (toAddNames.length === 0) return tn;
      const newTeams = toAddNames.map((n) => ({ id: uid(), name: n }));
      const allTeams = [...tn.teams, ...newTeams];
      const idByName = Object.fromEntries(allTeams.map((t) => [t.name, t.id]));
      let matches = tn.matches.map((m) => ({ ...m }));

      const r1_before = matches.filter((m) => m.round === 1);
      const byeSlots = [];
      for (const m of r1_before) { if (!m.aId) byeSlots.push({ mid: m.id, side: "a" }); if (!m.bId) byeSlots.push({ mid: m.id, side: "b" }); }
      const nameQueue = [...toAddNames];
      for (const slot of byeSlots) {
        if (nameQueue.length === 0) break;
        const name = nameQueue.shift(), id = idByName[name]; const mi = matches.findIndex((x) => x.id === slot.mid);
        if (mi >= 0) { if (slot.side === "a") matches[mi].aId = id; else matches[mi].bId = id;
          if (matches[mi].aId && matches[mi].bId) { matches[mi].status = "Scheduled"; matches[mi].winnerId = null; } }
      }
      while (nameQueue.length > 0) {
        const aName = nameQueue.shift(), bName = nameQueue.shift() || null;
        const aId = idByName[aName], bId = bName ? idByName[bName] : null;
        const bye = !aId || !bId;
        matches.push({ id: uid(), round: 1, aId, bId, status: bye ? "BYE" : "Scheduled", winnerId: bye ? (aId || bId || null) : null });
      }
      const updated = { ...tn, teams: allTeams, matches };
      setNamesText(""); setBuilderTeams([]);
      return updated;
    }));
  }

  function createTournament() {
    if (!isLoggedIn) return alert("Please log in first.");
    if (targetTournamentId !== NEW_TOURNEY_SENTINEL) {
      const names = builderTeams.length ? builderTeams.map((b) => b.name) : namesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      applyEntriesToTournament(targetTournamentId, names);
      return;
    }
    if (!tName.trim()) return alert("Please enter a Tournament Name.");
    if (builderTeams.length < 2) return alert("Please add at least 2 entries.");

    const names = builderTeams.map((t) => t.name);
    const dups = findDuplicateNamesCaseInsensitive(names);
    if (dups.length > 0) return alert("Duplicate names found:\n\n" + dups.map((n) => `• ${n}`).join("\n"));

    if (!isPaid) {
      if (builderTeams.length > FREE_TIER_MAX_PLAYERS) return alert(`Free tier is limited to ${FREE_TIER_MAX_PLAYERS} participants. Ask the site owner for paid access to go bigger.`);
      if (format !== "groups" || numGroups !== 1) return alert("Free tier tournaments are round-robin only (a single group). Ask the site owner for paid access to unlock brackets.");
    }

    if (format === "groups") {
      if (builderTeams.length < numGroups * 2) return alert(`Need at least ${numGroups * 2} entries for ${numGroups} groups.`);
      const groupIds = Array.from({ length: numGroups }, () => uid());
      const buckets = splitIntoGroups(builderTeams.map((t) => t.id), numGroups);
      const groups = groupIds.map((id, i) => ({ id, name: `Group ${String.fromCharCode(65 + i)}`, teamIds: buckets[i] }));
      const matches = groups.flatMap((g) => buildGroupMatches(g.id, g.teamIds));
      const advance = Math.min(advancePerGroup, Math.min(...buckets.map((b) => b.length)));

      const tourney = {
        id: uuid(), ownerId: user.id, name: tName.trim(), createdAt: Date.now(), teams: builderTeams, matches, status: "active",
        sport: sportId, format: "groups", groups, groupStage: { advancePerGroup: advance, complete: false },
        championId: null,
      };
      setTournaments((prev) => [tourney, ...prev]);
      setTName(""); setNamesText(""); setBuilderTeams([]); setSportId("generic"); setFormat("knockout");
      setTargetTournamentId(NEW_TOURNEY_SENTINEL); setTab("fixtures");
      return;
    }

    const picked = [seed1, seed2, seed3, seed4].filter(Boolean);
    if (picked.length < 2) return alert("Select at least Seed 1 and Seed 2.");
    if (!(picked.length === 2 || picked.length === 4)) return alert("You can select either 2 seeds or 4 seeds (not 3).");
    const setPicked = new Set(picked.map((s) => s.trim().toLowerCase()));
    if (setPicked.size !== picked.length) return alert("Seeds must be different players.");
    const nameIndex = Object.fromEntries(builderTeams.map((tm) => [tm.name.toLowerCase(), true]));
    for (const s of picked) if (!nameIndex[s.toLowerCase()]) return alert(`Seed not in entries: ${s}`);

    const matches = generateRound1Matches(builderTeams, { s1: seed1, s2: seed2, s3: picked.length === 4 ? seed3 : null, s4: picked.length === 4 ? seed4 : null });
    const seedTopId = builderTeamMap[seed1], seedBottomId = builderTeamMap[seed2];
    const seed3Id = picked.length === 4 ? builderTeamMap[seed3] : null, seed4Id = picked.length === 4 ? builderTeamMap[seed4] : null;

    const tourney = { id: uuid(), ownerId: user.id, name: tName.trim(), createdAt: Date.now(), teams: builderTeams, matches, status: "active", sport: sportId, format: "knockout", seedTopId, seedBottomId, seed3Id, seed4Id, championId: null };
    setTournaments((prev) => [tourney, ...prev]);

    setTName(""); setNamesText(""); setSeed1(""); setSeed2(""); setSeed3(""); setSeed4(""); setBuilderTeams([]); setSportId("generic"); setFormat("knockout");
    setTargetTournamentId(NEW_TOURNEY_SENTINEL); setTab("fixtures");
  }

  const saveAll = async () => {
    if (!isLoggedIn) return alert("Please log in first.");
    try {
      await saveStore({ tournaments, deleted: deletedTournaments }, user.id);
      alert("Saved.");
    } catch (e) {
      console.error(e);
      alert(`Save failed: ${e.message || "check console"}`);
    }
  };

  const gpStyles = `
@keyframes diagPan { 0% { background-position: 0 0; } 100% { background-position: 400px 400px; } }
@keyframes floatPan { 0% { transform: translate3d(0,0,0); } 100% { transform: translate3d(-80px,-80px,0); } }
.gp3d { text-shadow: 0 1px 0 rgba(0,0,0,.35), 0 2px 0 rgba(0,0,0,.35), 0 3px 0 rgba(0,0,0,.32), 0 4px 0 rgba(0,0,0,.30), 0 5px 0 rgba(0,0,0,.28), 0 6px 0 rgba(0,0,0,.25), 0 12px 20px rgba(0,0,0,.45), 0 0 8px rgba(255,90,31,.30); transition: transform .3s ease, text-shadow .3s ease, filter .3s ease; }
.gpGroup:hover .gp3d { transform: translateY(-4px); text-shadow: 0 2px 0 rgba(0,0,0,.35), 0 4px 0 rgba(0,0,0,.33), 0 6px 0 rgba(0,0,0,.31), 0 8px 0 rgba(0,0,0,.30), 0 18px 28px rgba(0,0,0,.55), 0 0 14px rgba(0,201,167,.45); filter: drop-shadow(0 0 6px rgba(255,90,31,.30)); }
.pageBg { background-image: radial-gradient(1200px 600px at 10% 0%, rgba(255,90,31,.22), transparent 60%), radial-gradient(900px 500px at 90% 20%, rgba(0,201,167,.20), transparent 60%), linear-gradient(180deg, #0c0a09 0%, #100d0b 40%, #171310 100%); background-attachment: fixed; }
.glass { background: rgba(255,255,255,0.04); backdrop-filter: blur(10px); }
.glass-header { background: rgba(255,255,255,0.06); backdrop-filter: blur(6px); }
.field { background: rgba(255,255,255,0.05); color: #fff; }
`;

  const activeTournaments = myTournaments.filter((tn) => tn.status === "active");
  const completedTournaments = myTournaments.filter((tn) => tn.status === "completed");

  return (
    <div className="p-3 sm:p-4 text-white min-h-screen pageBg" style={{ position: "relative", zIndex: 1 }}>
      <style>{gpStyles}</style>

      <section className="relative rounded-2xl overflow-hidden border mb-3 sm:mb-4 min-h-[18vh] sm:min-h-[25vh] flex items-center" style={{ borderColor: TM_BLUE }}>
        <div className="relative p-4 sm:p-6 md:p-8 w-full gpGroup">
          <h1 className="text-4xl sm:text-5xl md:text-7xl lg:text-8xl font-extrabold tracking-widest text-center select-none">
            <span className="gp3d" style={{ color: "#ffffff" }}>FIXTURE</span>
            <span className="gp3d ml-2" style={{ color: "#ffffff" }}>FORGE</span>
          </h1>
        </div>
      </section>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 mb-3 sm:mb-4">
        <div className="flex flex-wrap gap-2">
          <TabButton id="dashboard" label="DASHBOARD" tab={tab} setTab={setTab} />
          {isLoggedIn && <TabButton id="schedule" label="SCHEDULE" tab={tab} setTab={setTab} />}
          {isLoggedIn && <TabButton id="fixtures" label="FIXTURES" tab={tab} setTab={setTab} />}
          {isLoggedIn && <TabButton id="standings" label="STANDINGS" tab={tab} setTab={setTab} />}
          {isLoggedIn && <TabButton id="winners" label="WINNERS" tab={tab} setTab={setTab} />}
          {isLoggedIn && <TabButton id="deleted" label="DELETED" tab={tab} setTab={setTab} />}
          <TabButton id="explore" label="EXPLORE" tab={tab} setTab={setTab} />
          {isSuperAdmin && <TabButton id="admin" label="ADMIN" tab={tab} setTab={setTab} />}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {(tab === "fixtures" || tab === "deleted") && isLoggedIn && (
            <button className="px-3 py-2 border rounded hover:opacity-90" style={{ borderColor: TM_BLUE }} onClick={saveAll}>Save</button>
          )}
          {isLoggedIn && (
            <>
              <span className="text-xs text-white/70">
                {profile?.display_name || user.email}
                <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase" style={{ background: isPaid ? ACCENT_SECONDARY : "rgba(255,255,255,0.15)", color: isPaid ? "#08201c" : "#fff" }}>
                  {isSuperAdmin ? "Super Admin" : isPaid ? "Paid" : "Free"}
                </span>
              </span>
              <button className="px-3 py-2 border rounded border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={signOut}>Sign Out</button>
            </>
          )}
        </div>
      </div>

      {isLoggedIn && loadState === "loading" && (
        <div className="mb-3 sm:mb-4 border rounded-2xl p-3 text-sm glass flex items-center gap-2" style={{ borderColor: TM_BLUE }}>
          <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          Loading tournaments…
        </div>
      )}
      {isLoggedIn && loadState === "error" && (
        <div className="mb-3 sm:mb-4 border border-red-400 rounded-2xl p-3 text-sm glass flex flex-wrap items-center justify-between gap-2">
          <span className="text-red-300">Couldn't load tournaments: {loadError}</span>
          <button className="px-3 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={refreshFromStore}>Retry</button>
        </div>
      )}

      {/* Delete confirm */}
      {showDeleteModal && isLoggedIn && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-3">
          <div className="w-full max-w-md border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h3 className="font-semibold mb-2">Confirm Delete</h3>
            <p className="text-sm text-white/80 mb-3">Are you sure? It will be moved to the <b>DELETED</b> tab (not permanently erased).</p>
            <div className="flex flex-wrap gap-2 justify-end">
              <button className="px-3 py-2 border rounded border-zinc-400 text-zinc-200 hover:bg-zinc-200 hover:text-black" onClick={cancelDelete}>Cancel</button>
              <button className="px-3 py-2 border rounded border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* DASHBOARD */}
      {tab === "dashboard" && (
        isLoggedIn ? (
          <section className="border rounded-2xl p-4 sm:p-6 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="text-xl font-semibold mb-1">Welcome back, {profile?.display_name || user.email}</h2>
            <p className="text-sm text-white/70 mb-4">
              {isSuperAdmin ? "Super admin — you can see every organizer's tournaments from the Admin tab." :
                isPaid ? "Paid access: unlimited participants, any format." :
                `Free tier: up to ${FREE_TIER_MAX_PLAYERS} participants, round robin only.`}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="border rounded-xl p-3 text-center" style={{ borderColor: TM_BLUE }}>
                <div className="text-2xl font-bold">{activeTournaments.length}</div>
                <div className="text-xs text-white/60">Active</div>
              </div>
              <div className="border rounded-xl p-3 text-center" style={{ borderColor: TM_BLUE }}>
                <div className="text-2xl font-bold">{completedTournaments.length}</div>
                <div className="text-xs text-white/60">Completed</div>
              </div>
              <div className="border rounded-xl p-3 text-center" style={{ borderColor: TM_BLUE }}>
                <div className="text-2xl font-bold">{myDeletedTournaments.length}</div>
                <div className="text-xs text-white/60">Deleted</div>
              </div>
              <div className="border rounded-xl p-3 text-center" style={{ borderColor: TM_BLUE }}>
                <div className="text-2xl font-bold uppercase">{isSuperAdmin ? "Super" : isPaid ? "Paid" : "Free"}</div>
                <div className="text-xs text-white/60">Plan</div>
              </div>
            </div>
            <button className="px-4 py-2 border border-emerald-400 text-emerald-300 rounded hover:bg-emerald-400 hover:text-black" onClick={() => setTab("schedule")}>
              Create a tournament
            </button>
          </section>
        ) : (
          <section>
            <div className="text-center mb-6">
              <h2 className="text-2xl font-semibold mb-2">Run tournaments for any sport, free to start</h2>
              <p className="text-sm text-white/70 max-w-lg mx-auto">
                Sign up to create round-robin and knockout tournaments, track fixtures and standings, and
                export brackets to PDF or Excel. Free accounts get a round-robin group of up to {FREE_TIER_MAX_PLAYERS} players —
                ask the site owner for paid access to unlock brackets and larger fields.
              </p>
            </div>
            <AuthForms onDone={() => setTab("dashboard")} />
          </section>
        )
      )}

      {/* SCHEDULE */}
      {tab === "schedule" && (isLoggedIn ? (
        <section className="grid md:grid-cols-2 gap-3 sm:gap-4">
          <div className="border rounded-2xl p-3 sm:p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="font-semibold mb-3">Tournament Setup</h2>

            <label className="text-xs block mb-3">
              Tournament
              <div className="mt-1">
                <DarkSelect
                  value={targetTournamentId}
                  onChange={setTargetTournamentId}
                  options={[{ value: NEW_TOURNEY_SENTINEL, label: "➕ Create New Tournament" }, ...myTournaments.map(t => ({ value: t.id, label: t.name }))]}
                />
              </div>
            </label>

            {targetTournamentId === NEW_TOURNEY_SENTINEL && (
              <>
                <label className="text-xs block mb-3">
                  Tournament Name
                  <input className="mt-1 w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={tName} onChange={(e) => setTName(e.target.value)} placeholder="e.g., Office TT Cup — Aug 2025" />
                </label>

                {!isPaid && (
                  <p className="text-xs mb-3 px-3 py-2 rounded-xl border" style={{ borderColor: ACCENT_SECONDARY, color: ACCENT_SECONDARY }}>
                    Free tier: single round-robin group, up to {FREE_TIER_MAX_PLAYERS} players, no knockout bracket.
                    Ask the site owner for paid access to unlock brackets and larger fields.
                  </p>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <label className="text-xs">
                    Sport
                    <div className="mt-1">
                      <DarkSelect value={sportId} onChange={setSportId}
                        options={listSelectableSports().filter(s => s.implemented).map(s => ({ value: s.id, label: s.label }))} />
                    </div>
                  </label>
                  {isPaid ? (
                    <label className="text-xs">
                      Format
                      <div className="mt-1">
                        <DarkSelect value={format} onChange={setFormat}
                          options={[
                            { value: "knockout", label: "Knockout only" },
                            ...(getSport(sportId).supportsGroups ? [{ value: "groups", label: "Groups + Knockout" }] : []),
                          ]} />
                      </div>
                    </label>
                  ) : (
                    <label className="text-xs">
                      Format
                      <div className="mt-1 px-3 py-2 rounded-xl border field text-white/70" style={{ borderColor: TM_BLUE }}>Round Robin (Free tier)</div>
                    </label>
                  )}
                </div>

                {isPaid && format === "groups" && (
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <label className="text-xs">
                      Number of groups
                      <input type="number" min={2} max={8} className="mt-1 w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={numGroups} onChange={(e) => setNumGroups(Math.max(2, Number(e.target.value) || 2))} />
                    </label>
                    <label className="text-xs">
                      Advance per group
                      <input type="number" min={1} max={4} className="mt-1 w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={advancePerGroup} onChange={(e) => setAdvancePerGroup(Math.max(1, Number(e.target.value) || 1))} />
                    </label>
                  </div>
                )}
              </>
            )}

            <label className="text-xs block mb-2">Players (one per line)</label>
            <textarea className="w-full h-40 field border rounded p-2 mb-2" style={{ borderColor: TM_BLUE }} placeholder={`Enter player names, one per line
Example:
Akhil
Devi
Rahul
Meera`} value={namesText} onChange={(e) => setNamesText(e.target.value)} />

            <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between mb-2">
              <div>
                <input ref={uploadRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                  onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; await handlePlayersUpload(f); if (uploadRef.current) uploadRef.current.value = ""; }}
                />
                <button
                  className={`px-3 py-2 border rounded inline-flex items-center gap-2 ${
                    targetTournamentId !== NEW_TOURNEY_SENTINEL ? "border-zinc-700 text-zinc-500 cursor-not-allowed" : "border-white hover:bg-white hover:text-black"
                  }`}
                  title="Upload Entry"
                  onClick={() => { if (targetTournamentId === NEW_TOURNEY_SENTINEL && uploadRef.current) uploadRef.current.click(); }}
                  disabled={targetTournamentId !== NEW_TOURNEY_SENTINEL}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                    <path d="M12 3a1 1 0 0 1 1 1v8.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4A1 1 0 1 1 8.707 10.293L11 12.586V4a1 1 0 0 1 1-1z" />
                    <path d="M4 15a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H6v2h12v-2h-1a1 1 0 1 1 0-2h2a1 1 0 0 1 1 1v4z" />
                  </svg>
                  <span>Upload Entry</span>
                </button>
              </div>

              <button
                className="px-3 py-2 border rounded border-white hover:bg-white hover:text-black"
                onClick={
                  targetTournamentId === NEW_TOURNEY_SENTINEL
                    ? loadTeamsFromText
                    : () =>
                        applyEntriesToTournament(
                          targetTournamentId,
                          builderTeams.length ? builderTeams.map((b) => b.name)
                            : namesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                        )
                }
              >
                Add Entries
              </button>
            </div>

            {targetTournamentId === NEW_TOURNEY_SENTINEL && format === "knockout" && builderTeams.length > 0 && (
              <div className="my-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs">
                  Seed 1
                  <div className="mt-1">
                    <DarkSelect value={seed1} onChange={setSeed1}
                      options={[{ value: "", label: "—" }, ...builderTeams.map(tm => ({ value: tm.name, label: tm.name }))]} />
                  </div>
                </label>
                <label className="text-xs">
                  Seed 2
                  <div className="mt-1">
                    <DarkSelect value={seed2} onChange={setSeed2}
                      options={[{ value: "", label: "—" }, ...builderTeams.map(tm => ({ value: tm.name, label: tm.name }))]} />
                  </div>
                </label>
                <label className="text-xs">
                  Seed 3 (optional)
                  <div className="mt-1">
                    <DarkSelect value={seed3} onChange={setSeed3}
                      options={[{ value: "", label: "—" }, ...builderTeams.map(tm => ({ value: tm.name, label: tm.name }))]} />
                  </div>
                </label>
                <label className="text-xs">
                  Seed 4 (optional)
                  <div className="mt-1">
                    <DarkSelect value={seed4} onChange={setSeed4}
                      options={[{ value: "", label: "—" }, ...builderTeams.map(tm => ({ value: tm.name, label: tm.name }))]} />
                  </div>
                </label>
                <p className="sm:col-span-2 text-[11px] text-white/70">
                  Seeding rules: Seed 1 & 2 opposite ends (final only). Seeds 3 & 4 in opposite halves (final only). Top-4 meet no earlier than SF.
                </p>
              </div>
            )}

            <div className="mt-4 sm:mt-6 text-center">
              <button className="w-full sm:w-auto px-4 py-2 border border-emerald-400 text-emerald-300 rounded hover:bg-emerald-400 hover:text-black" onClick={createTournament}>
                {targetTournamentId === NEW_TOURNEY_SENTINEL ? "Create Tournament" : "Apply Entries to Selected"}
              </button>
            </div>
          </div>

          <div className="border rounded-2xl p-3 sm:p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="font-semibold mb-3">Tips</h2>
            <ul className="list-disc ml-5 text-sm text-white/90 space-y-1">
              <li>Select a tournament or create a new one.</li>
              <li>New: paste/upload names → <b>Add Entries</b> → pick seeds → <b>Create Tournament</b>.</li>
              <li>Existing: paste/upload names → <b>Add Entries</b>; fills BYEs first, then adds matches.</li>
            </ul>
          </div>
        </section>
      ) : (
        <section className="border rounded-2xl p-4 text-sm glass" style={{ borderColor: TM_BLUE }}>
          Please <button className="underline" onClick={() => setTab("dashboard")}>log in</button> to access SCHEDULE.
        </section>
      ))}

      {/* FIXTURES */}
      {tab === "fixtures" && (
        <section>
          {activeTournaments.length === 0 && (
            <p className="text-white/80 text-sm">
              No active tournaments yet. Create one from <b>SCHEDULE</b>.
            </p>
          )}

          {activeTournaments.map((tn) => {
            const mr = maxRound(tn);
            const counts = roundCounts(tn);
            const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
            const sport = getSport(tn.sport);
            const isGroupFmt = tn.format === "groups";
            const ko = knockoutMatches(tn);

            return (
              <Collapsible
                key={tn.id}
                title={tn.name}
                subtitle={`Active • ${sport.label} • ${tn.teams.length} players`}
                right={
                  <>
                    {isLoggedIn && (
                      <button className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => openDeleteModal(tn.id)} title="Delete tournament">
                        Delete
                      </button>
                    )}
                    <button className="px-2 py-1 rounded border hover:bg-white hover:text-black" style={{ borderColor: TM_BLUE }} onClick={() => exportTournamentToPDF(tn)}>Export PDF</button>
                    <button className="px-2 py-1 rounded border hover:bg-white hover:text-black" style={{ borderColor: TM_BLUE }} onClick={() => exportTournamentToExcel(tn)}>Export Excel</button>
                    {ko.length > 0 && <span className="text-xs text-white/70">Current: {stageShort(counts.get(mr) || 0)}</span>}
                  </>
                }
                defaultOpen={true}
              >
                {isGroupFmt && (() => {
                  const activeGroupId = selectedGroupByTournament[tn.id] || tn.groups[0]?.id;
                  const activeGroup = tn.groups.find((g) => g.id === activeGroupId) || tn.groups[0];
                  const activeGroupMatches = activeGroup ? tn.matches.filter((m) => m.groupId === activeGroup.id) : [];
                  return (
                    <div className="mb-4">
                      <div className="grid gap-1.5 mb-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}>
                        {tn.groups.map((g) => {
                          const groupMatches = tn.matches.filter((m) => m.groupId === g.id);
                          const played = groupMatches.filter((m) => m.winnerId).length;
                          return (
                            <GroupCard
                              key={g.id}
                              group={g}
                              playerCount={g.teamIds.length}
                              played={played}
                              total={groupMatches.length}
                              selected={g.id === activeGroup?.id}
                              onClick={() => setSelectedGroupByTournament((prev) => ({ ...prev, [tn.id]: g.id }))}
                            />
                          );
                        })}
                      </div>

                      {activeGroup && (
                        <div className="border rounded-2xl overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                          <div className="px-3 py-2 glass-header text-sm font-semibold">{activeGroup.name} fixtures</div>
                          <div className="divide-y px-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                            {activeGroupMatches.map((m, i) => (
                              <MatchRow
                                key={m.id}
                                idx={i + 1}
                                m={m}
                                teamMap={teamMap}
                                sport={sport}
                                stageText="Grp"
                                onPickWinner={() => {}}
                                onUpdateGames={() => {}}
                                canEdit={false}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {ko.length > 0 && (
                  <div>
                    {isGroupFmt && <h4 className="font-semibold text-sm mb-2">Knockout bracket</h4>}
                    <KnockoutBracket tn={tn} teamMap={teamMap} />
                  </div>
                )}
              </Collapsible>
            );
          })}
        </section>
      )}

      {/* STANDINGS */}
      {tab === "standings" && (
        <section>
          {myTournaments.length === 0 && (
            <p className="text-white/80 text-sm">No tournaments yet. Create one from <b>SCHEDULE</b>.</p>
          )}

          {myTournaments.map((tn) => {
            const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
            const sport = getSport(tn.sport);
            const isGroupFmt = tn.format === "groups";
            const ko = knockoutMatches(tn);
            const byRound = new Map();
            for (const m of ko) { if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
            const ordered = Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]);
            const mr = ko.length ? Math.max(...ko.map((m) => m.round)) : 1;
            const currentCount = (ordered.find(([r]) => r === mr)?.[1].length) || 0;
            const subtitle = tn.status === "completed"
              ? `Completed • Champion: ${tn.championId ? teamMap[tn.championId] || "TBD" : "TBD"}`
              : ko.length
                ? `Active • Current: ${stageShort(currentCount)}`
                : `Active • Group stage`;
            const canNext = canGenerateNext(tn);
            const canKO = isGroupFmt && canGenerateKnockoutFromGroups(tn);
            const activeGroupId = selectedGroupByTournament[tn.id] || tn.groups?.[0]?.id;
            const activeGroup = tn.groups?.find((g) => g.id === activeGroupId) || tn.groups?.[0];
            const activeGroupMatches = activeGroup ? tn.matches.filter((m) => m.groupId === activeGroup.id) : [];

            return (
              <Collapsible
                key={tn.id}
                title={tn.name}
                subtitle={subtitle}
                right={
                  <>
                    {isLoggedIn && (
                      <button className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => openDeleteModal(tn.id)} title="Delete tournament">
                        Delete
                      </button>
                    )}
                    {isPaid && canKO && (
                      <button className="px-3 py-2 rounded-xl border border-emerald-400 text-emerald-300 hover:bg-emerald-400 hover:text-black"
                        onClick={() => generateKnockoutFromGroups(tn.id)}>
                        Generate Knockout Bracket
                      </button>
                    )}
                    {isLoggedIn && ko.length > 0 && (
                      <button
                        className={`px-3 py-2 rounded-xl border transition ${canNext ? "border-white hover:bg-white hover:text-black" : "border-zinc-700 text-zinc-500 cursor-not-allowed"}`}
                        disabled={!canNext}
                        onClick={() => generateNextRound(tn.id)}
                      >
                        Generate Next Round
                      </button>
                    )}
                  </>
                }
                defaultOpen={true}
              >
                {isGroupFmt && tn.groups.map((g) => {
                  const groupMatches = tn.matches.filter((m) => m.groupId === g.id);
                  const standings = computeStandings(g.teamIds, groupMatches, {
                    pointsRule: sport.pointsRule,
                    getDiff: sport.matchModel === "games" ? (m) => pointsDiffFromGames(m.games) : undefined,
                  });
                  return <GroupStandingsTable key={g.id} group={g} standings={standings} teamMap={teamMap} />;
                })}

                {isGroupFmt && (
                  <div className="mb-4">
                    <h4 className="font-semibold text-sm mb-2">Enter results</h4>
                    <div className="grid gap-1.5 mb-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}>
                      {tn.groups.map((g) => {
                        const groupMatches = tn.matches.filter((m) => m.groupId === g.id);
                        const played = groupMatches.filter((m) => m.winnerId).length;
                        return (
                          <GroupCard
                            key={g.id}
                            group={g}
                            playerCount={g.teamIds.length}
                            played={played}
                            total={groupMatches.length}
                            selected={g.id === activeGroup?.id}
                            onClick={() => setSelectedGroupByTournament((prev) => ({ ...prev, [tn.id]: g.id }))}
                          />
                        );
                      })}
                    </div>
                    {activeGroup && (
                      <div className="border rounded-2xl overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                        <div className="px-3 py-2 glass-header text-sm font-semibold">{activeGroup.name} results</div>
                        <div className="divide-y px-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                          {activeGroupMatches.map((m, i) => (
                            <MatchRow
                              key={m.id}
                              idx={i + 1}
                              m={m}
                              teamMap={teamMap}
                              sport={sport}
                              stageText="Grp"
                              onPickWinner={(mid, wid) => (isLoggedIn ? pickWinner(tn.id, mid, wid) : null)}
                              onUpdateGames={(mid, games) => (isLoggedIn ? updateMatchGames(tn.id, mid, games) : null)}
                              canEdit={isLoggedIn}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {ko.length > 0 && (
                  <div>
                    {isGroupFmt && <h4 className="font-semibold text-sm mb-1">Knockout results</h4>}
                    {ordered.map(([round, arr]) => (
                      <div key={round} className="mb-2">
                        <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                          {arr.map((m, i) => (
                            <MatchRow
                              key={m.id}
                              idx={i + 1}
                              m={m}
                              teamMap={teamMap}
                              sport={sport}
                              stageText={stageShort(arr.length)}
                              onPickWinner={(mid, wid) => (isLoggedIn ? pickWinner(tn.id, mid, wid) : null)}
                              onUpdateGames={(mid, games) => (isLoggedIn ? updateMatchGames(tn.id, mid, games) : null)}
                              canEdit={isLoggedIn}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Collapsible>
            );
          })}
        </section>
      )}

      {/* WINNERS */}
      {tab === "winners" && (
        <section>
          {completedTournaments.length === 0 && <p className="text-white/80 text-sm">No completed tournaments yet. Finish one in <b>FIXTURES</b>.</p>}
          {completedTournaments.map((tn) => {
            const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
            const byRound = new Map();
            for (const m of knockoutMatches(tn)) { if (!m.winnerId) continue; if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
            const ordered = Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]).filter(([_, arr]) => {
              const code = stageShort(arr.length); return code === "F" || code === "SF";
            });
            const championName = tn.championId ? teamMap[tn.championId] || "TBD" : "TBD";
            return (
              <Collapsible
                key={tn.id}
                title={tn.name}
                subtitle={`Champion: ${championName}`}
                right={isLoggedIn ? (
                  <button className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => openDeleteModal(tn.id)} title="Delete tournament">
                    Delete
                  </button>
                ) : null}
                defaultOpen={false}
              >
                {ordered.length === 0 ? (
                  <p className="text-white/80 text-sm">No SF/F recorded yet.</p>
                ) : (
                  ordered.map(([round, arr]) => (
                    <div key={round} className="mb-3">
                      <h3 className="font-semibold mb-1">{stageShort(arr.length)}</h3>
                      <ul className="space-y-1 text-sm">
                        {arr.map((m, i) => {
                          const a = teamMap[m.aId] || "BYE/TBD";
                          const b = teamMap[m.bId] || "BYE/TBD";
                          const w = teamMap[m.winnerId] || "TBD";
                          return (
                            <li key={m.id}>
                              {arr.length === 1 ? (<>{a} vs {b} — <b>{w}</b></>) : (<>Match {i + 1}: {a} vs {b} — <b>{w}</b></>)}
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

      {/* DELETED */}
      {tab === "deleted" && (isLoggedIn ? (
        <section>
          {myDeletedTournaments.length === 0 ? (
            <p className="text-white/80 text-sm">No deleted tournaments.</p>
          ) : (
            myDeletedTournaments.map((tn) => {
              const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
              const subtitle = `Deleted: ${timeStr(tn.deletedAt)} • Created: ${timeStr(tn.createdAt)} • Players: ${tn.teams.length}`;
              return (
                <Collapsible
                  key={tn.id}
                  title={tn.name}
                  subtitle={subtitle}
                  right={
                    <div className="flex flex-wrap gap-2">
                      <button className="px-3 py-1 rounded border border-emerald-400 text-emerald-300 hover:bg-emerald-400 hover:text-black" onClick={() => restoreTournament(tn.id)} title="Restore to Fixtures">Restore</button>
                      <button className="px-3 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => deleteForever(tn.id)} title="Delete permanently">Delete Permanently</button>
                    </div>
                  }
                  defaultOpen={false}
                >
                  <div className="text-sm space-y-2">
                    <div><b>Status when deleted:</b> {tn.status}{tn.status === "completed" && tn.championId ? ` • Champion: ${teamMap[tn.championId] || "TBD"}` : ""}</div>
                    <div>
                      <b>Players:</b>
                      <ul className="list-disc ml-5">{tn.teams.map((t) => (<li key={t.id}>{t.name}</li>))}</ul>
                    </div>
                    <div>
                      <b>Matches:</b>
                      <ul className="list-disc ml-5">
                        {tn.matches.map((m) => {
                          const a = teamMap[m.aId] || "BYE/TBD"; const b = teamMap[m.bId] || "BYE/TBD";
                          const w = m.winnerId ? teamMap[m.winnerId] || "TBD" : "TBD";
                          return (<li key={m.id}>Round {m.round}: {a} vs {b} — Winner: {w}</li>);
                        })}
                      </ul>
                    </div>
                  </div>
                </Collapsible>
              );
            })
          )}
        </section>
      ) : (
        <section className="border rounded-2xl p-4 text-sm glass" style={{ borderColor: TM_BLUE }}>
          Please <button className="underline" onClick={() => setTab("dashboard")}>log in</button> to access DELETED.
        </section>
      ))}

      {/* EXPLORE */}
      {tab === "explore" && (
        <section className="border rounded-2xl p-6 text-center glass" style={{ borderColor: TM_BLUE }}>
          <h2 className="text-xl font-semibold mb-2">Public tournament browsing is coming soon</h2>
          <p className="text-sm text-white/70 max-w-md mx-auto">
            In a future update, organizers will be able to publish a tournament with a shareable link so
            anyone can follow live scores and standings without an account — like the participant
            registration links, this is on the roadmap but not built yet.
          </p>
        </section>
      )}

      {/* ADMIN (super admin only) */}
      {tab === "admin" && (isSuperAdmin ? (
        <section className="space-y-4">
          <div className="border rounded-2xl p-3 sm:p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="font-semibold mb-3">Users</h2>
            {profilesLoading ? (
              <p className="text-sm text-white/70">Loading…</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-white/60 border-b" style={{ borderColor: "rgba(255,255,255,0.15)" }}>
                      <th className="py-1 pr-2">Name</th>
                      <th className="py-1 pr-2">Email</th>
                      <th className="py-1 pr-2">Role</th>
                      <th className="py-1 pr-2">Tier</th>
                      <th className="py-1 pr-2">Tournaments</th>
                      <th className="py-1 pr-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((p) => {
                      const ownedCount = tournaments.filter((t) => t.ownerId === p.id).length;
                      return (
                        <tr key={p.id} className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                          <td className="py-1 pr-2">{p.display_name || "—"}</td>
                          <td className="py-1 pr-2">{p.email}</td>
                          <td className="py-1 pr-2">{p.role}</td>
                          <td className="py-1 pr-2">{p.tier}</td>
                          <td className="py-1 pr-2">{ownedCount}</td>
                          <td className="py-1 pr-2">
                            {p.role !== "super_admin" && (
                              p.tier === "paid" ? (
                                <button className="px-2 py-1 rounded border border-zinc-400 text-zinc-200 hover:bg-zinc-200 hover:text-black"
                                  onClick={() => adminSetTier(p.id, "free").then(() => adminListProfiles().then(setProfiles))}>
                                  Revoke to Free
                                </button>
                              ) : (
                                <button className="px-2 py-1 rounded border border-emerald-400 text-emerald-300 hover:bg-emerald-400 hover:text-black"
                                  onClick={() => adminSetTier(p.id, "paid").then(() => adminListProfiles().then(setProfiles))}>
                                  Grant Paid
                                </button>
                              )
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="border rounded-2xl p-3 sm:p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="font-semibold mb-3">All Tournaments (every organizer)</h2>
            {tournaments.length === 0 ? (
              <p className="text-sm text-white/70">No tournaments yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-white/60 border-b" style={{ borderColor: "rgba(255,255,255,0.15)" }}>
                      <th className="py-1 pr-2">Name</th>
                      <th className="py-1 pr-2">Owner</th>
                      <th className="py-1 pr-2">Sport</th>
                      <th className="py-1 pr-2">Format</th>
                      <th className="py-1 pr-2">Status</th>
                      <th className="py-1 pr-2">Players</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tournaments.map((t) => {
                      const owner = profiles.find((p) => p.id === t.ownerId);
                      return (
                        <tr key={t.id} className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                          <td className="py-1 pr-2">{t.name}</td>
                          <td className="py-1 pr-2">{owner?.email || t.ownerId}</td>
                          <td className="py-1 pr-2">{getSport(t.sport).label}</td>
                          <td className="py-1 pr-2">{t.format}</td>
                          <td className="py-1 pr-2">{t.status}</td>
                          <td className="py-1 pr-2">{t.teams?.length ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="border rounded-2xl p-4 text-sm glass" style={{ borderColor: TM_BLUE }}>Admin only.</section>
      ))}
    </div>
  );
}

/* Minimal sanity checks in console (disabled) */
(function runDevTests() {
  try {
    const IS_DEV = false; if (!IS_DEV) return;
    const eq = (name, got, exp) => console.log(`[TEST] ${name}:`, Array.isArray(exp) ? JSON.stringify(got) === JSON.stringify(exp) : got === exp ? "PASS" : "FAIL");
  } catch (e) { console.warn("Dev tests error:", e); }
})();
