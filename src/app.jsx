// ====== Persistence glue (backend-agnostic) ======
import React, { useEffect, useMemo, useState, useRef } from "react";
import { loadStoreOnce, saveStore /*, subscribeStore*/ } from "./db";

/* Using CDN globals (index.html):
   <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
   <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
   <script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"></script>
*/
/* global XLSX, html2canvas, jspdf */

/**
 * Tournament Maker — Multiple Concurrent Tournaments (TT & Badminton)
 * Tabs: SCHEDULE (admin only), FIXTURES, STANDINGS, WINNERS, DELETED (admin only)
 * Cloud persistence via ./db (e.g., JSONBin)
 * Admin auth: simple in-app username/password (change before sharing)
 */

const TM_BLUE = "#0f4aa1";
const NEW_TOURNEY_SENTINEL = "__NEW__";
const uid = () => Math.random().toString(36).slice(2, 9);

// ⚠️ Change before sharing
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "gameport123";

// ---------- helpers ----------
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
  return names; // raw list, NOT unique
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
    const names = rows.map((r) => String(r[key] || "").trim()).filter(Boolean);
    return names; // raw list, NOT unique
  } catch {
    return [];
  }
}


/** Short round code by match-count in that round */
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

function timeStr(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return String(ts || "");
  }
}
function playerName(teamMap, id) {
  return teamMap[id] || (id ? "Unknown" : "BYE/TBD");
}
function statusText(m) {
  if (m.status && String(m.status).trim()) return m.status; // Scheduled / BYE / Final etc.
  const bothEmpty = !m.aId && !m.bId;
  const singleBye = (!!m.aId && !m.bId) || (!m.aId && !!m.bId);
  if (bothEmpty) return "Empty";
  if (singleBye) return "BYE";
  return "TBD";
}
function winnerText(teamMap, m) {
  return m.winnerId ? (teamMap[m.winnerId] || "TBD") : "TBD";
}
function groupMatchesByRound(tn) {
  const byRound = new Map();
  for (const m of tn.matches) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round).push(m);
  }
  return Array.from(byRound.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([round, matches]) => ({ round, matches }));
}

// ---------- Export: Excel ----------
function exportTournamentToExcel(tn) {
  try {
    const wb = XLSX.utils.book_new();
    const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
    const grouped = groupMatchesByRound(tn);
    if (grouped.length === 0) {
      alert("No matches to export.");
      return;
    }
    for (const { round, matches } of grouped) {
      const data = [["Match #", "Player A", "Player B", "Winner", "Status"]];
      matches.forEach((m, i) => {
        const a = playerName(teamMap, m.aId);
        const b = playerName(teamMap, m.bId);
        const w = winnerText(teamMap, m);
        const s = statusText(m);
        data.push([i + 1, a, b, w, s]);
      });
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = [{ wch: 8 }, { wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 14 }];
      // ★ Use short code for the visible sheet name
      const label = stageShort(matches.length);
      XLSX.utils.book_append_sheet(wb, ws, label);
    }
    const fname = `${tn.name.replace(/[^\w\-]+/g, "_")}_fixtures.xlsx`;
    XLSX.writeFile(wb, fname);
  } catch (e) {
    console.error("Excel export failed:", e);
    alert("Excel export failed. Check console.");
  }
}

// ---------- Export: PDF ----------
/** Vector PDF export: no element splits, white paper, black text */
// ---- Bracket helpers (add once, near your other helpers) ----
function nextPow2(n){ let p=1; while(p<n) p*=2; return p; }



/** Build a full (projected) bracket up to Finals, padding with placeholders */
function buildProjectedRounds(tn) {
  const byRound = new Map();
  for (const m of (tn.matches || [])) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round).push(m);
  }
  for (const [r, arr] of byRound) byRound.set(r, arr.slice());

  const teamCount = (tn.teams || []).length;
  if (teamCount < 2) {
    const only = (byRound.get(1) || []).slice();
    return only.length ? [{ round: 1, matches: only }] : [];
  }
  const slots = nextPow2(teamCount);
  const totalRounds = Math.log2(slots);
  const out = [];

  for (let r = 1; r <= totalRounds; r++) {
    const expected = slots / Math.pow(2, r); // matches in round r
    const existing = (byRound.get(r) || []).slice(0, expected);
    const padded = Array.from({ length: expected }, (_, i) => {
      const ex = existing[i];
      if (ex) return ex;
      return {
        id: `__placeholder_${r}_${i}__`,
        round: r,
        aId: null,
        bId: null,
        status: r === 1 ? "Scheduled" : "Pending",
        winnerId: null,
      };
    });
    out.push({ round: r, matches: padded });
  }
  return out;
}

/** Label helpers for placeholder names */
function feederLabel(roundMatchesCount, matchIdxZeroBased) {
  // e.g., roundMatchesCount=4 → QF ; index 0 → QF1, index 1 → QF2...
  const label = stageShort(roundMatchesCount);
  return `${label}${matchIdxZeroBased + 1}`;
}

function placeholderName(prevRoundMatchesCount, childMatchIndex) {
  // childMatchIndex is zero-based into previous round
  return `Winner of ${feederLabel(prevRoundMatchesCount, childMatchIndex)}`;
}

// ---- NEW Vector PDF exporter (replace your exportTournamentToPDF with this) ----
async function exportTournamentToPDF(tn) {
  const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF || (window.jspdf && window.jspdf.default);
  if (!jsPDFCtor) { alert("jsPDF not found. Include jspdf.umd.min.js"); return; }

  const rounds = buildProjectedRounds(tn);
  if (!rounds.length) { alert("No matches to export."); return; }

  const pdf = new jsPDFCtor({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 36;

  // Colors / styles (white background, black text/lines)
  const BG = "#ffffff";
  const FG = "#000000";
  const LINE = "#000000";

  // Title + meta
  const title = `${tn.name} — Fixtures`;
  pdf.setFillColor(BG);
  pdf.rect(0, 0, pageW, pageH, "F");
  pdf.setTextColor(FG);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.text(title, margin, margin + 6);

  // Layout measurements in "virtual" coordinates before scale-to-fit
  const colGap = 44;      // space between rounds
  const boxW  = 210;      // match box width for early rounds
  const boxH0 = 34;       // base box height (Round 1)
  const vGap0 = 16;       // vertical gap between boxes in Round 1
  const strokeW = 1.2;

  // Box height grows slightly for later rounds (more whitespace), spacing doubles each round
  const colWidths = rounds.map((_, rIdx) => boxW * Math.max(0.75, 1 - rIdx * 0.08));
  const roundHeights = rounds.map((_, rIdx) => boxH0 + rIdx * 4);
  const roundVGaps   = rounds.map((_, rIdx) => vGap0 * Math.pow(2, rIdx));

  // Compute column x positions
  const colX = [];
  let totalW = margin; // start virtual width counting from 0, margins applied after scale
  for (let r = 0; r < rounds.length; r++) {
    if (r === 0) {
      colX[r] = 0;
      totalW += colWidths[r];
    } else {
      colX[r] = colX[r - 1] + colWidths[r - 1] + colGap;
      totalW += colGap + colWidths[r];
    }
  }

  // Compute total virtual height = enough to stack all R1 matches
  const r1Count = rounds[0].matches.length;
  const boxH = roundHeights[0];
  const vGap = roundVGaps[0];
  const bodyH = r1Count * boxH + (r1Count - 1) * vGap;
  const totalH = bodyH;

  // Scale-to-fit (so everything stays on one page)
  const maxW = pageW - margin * 2;
  const maxH = pageH - (margin * 2 + 18 + 10); // leave room for title
  const scale = Math.min(1, maxW / totalW, maxH / totalH);

  // Draw origin
  const originX = margin;
  const originY = margin + 24; // below title
  const S = (n) => n * scale;

  // Teams map
  const teamMap = Object.fromEntries((tn.teams || []).map(t => [t.id, t.name]));

  // Cache all box positions for connectors: pos[r][i] = {x,y,w,h}
  const pos = rounds.map((r, rIdx) => {
    const matches = r.matches;
    const thisBoxH = roundHeights[rIdx];
    const thisVGap = roundVGaps[rIdx];

    // For round r: each match spans one "row block" whose height equals
    // (prev round's box + gap) * 2, except for Round 1 which is simple stack.
    const arr = [];
    if (rIdx === 0) {
      // straight stack
      let y = 0;
      for (let i = 0; i < matches.length; i++) {
        arr.push({
          x: colX[rIdx],
          y,
          w: colWidths[rIdx],
          h: thisBoxH,
        });
        y += thisBoxH + thisVGap;
      }
    } else {
      const prevCount = rounds[rIdx - 1].matches.length;
      const prevBoxH  = roundHeights[rIdx - 1];
      const prevVGap  = roundVGaps[rIdx - 1];

      // The vertical spacing for a round r box is exactly the "span" of its two children:
      const childBlockH = prevBoxH + prevVGap; // height per child block
      const myBlockH = childBlockH * 2 - prevVGap; // span of two children minus the middle gap
      let y = (myBlockH - thisBoxH) / 2; // center within child span

      for (let i = 0; i < matches.length; i++) {
        arr.push({
          x: colX[rIdx],
          y,
          w: colWidths[rIdx],
          h: thisBoxH,
        });
        y += myBlockH;
      }
    }
    return arr;
  });

  // Helpers (text)
  const playerName = (id) => teamMap[id] || (id ? "Unknown" : "BYE/TBD");
  const boxText = (rIdx, iIdx, side, m) => {
    if (rIdx === 0) {
      return playerName(side === "a" ? m.aId : m.bId);
    }
    const prevCount = rounds[rIdx - 1].matches.length;
    const childIndex = iIdx * 2 + (side === "a" ? 0 : 1);
    return placeholderName(prevCount, childIndex);
  };
  const winnerText = (m) => (m.winnerId ? (teamMap[m.winnerId] || "TBD") : "TBD");

  // Draw boxes + text
  pdf.setLineWidth(strokeW);
  pdf.setDrawColor(LINE);
  pdf.setFont("helvetica", "normal");

  for (let r = 0; r < rounds.length; r++) {
    const matches = rounds[r].matches;
    const labelForRound = stageShort(matches.length);
    const thisBoxH = roundHeights[r];

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const p = pos[r][i];

      // box
      pdf.setFillColor("#ffffff");
      pdf.rect(originX + S(p.x), originY + S(p.y), S(p.w), S(p.h), "S");

      // text
      pdf.setFontSize(10 * scale);
      const pad = 6 * scale;

      // Round label small at top-left
      pdf.setFont("helvetica", "bold");
      pdf.text(labelForRound, originX + S(p.x) + pad, originY + S(p.y) + pad + 8 * scale);

      // names
      pdf.setFont("helvetica", "normal");
      const aY = originY + S(p.y) + pad + 18 * scale;
      const bY = originY + S(p.y) + pad + 34 * scale;

      const aTxt = boxText(r, i, "a", m);
      const bTxt = boxText(r, i, "b", m);
      pdf.text(aTxt, originX + S(p.x) + pad, aY);
      pdf.text(bTxt, originX + S(p.x) + pad, bY);

      // winner line (optional, small)
      const wTxt = `Winner: ${winnerText(m)}`;
      pdf.setFontSize(9 * scale);
      pdf.text(wTxt, originX + S(p.x) + pad, originY + S(p.y + thisBoxH) - pad);
    }
  }

  // Draw connectors from round r to r+1
  for (let r = 0; r < rounds.length - 1; r++) {
    const child = pos[r];
    const parent = pos[r + 1];

    for (let i = 0; i < parent.length; i++) {
      const p = parent[i];

      // children indices
      const c1 = child[i * 2];
      const c2 = child[i * 2 + 1];
      if (!c1 || !c2) continue;

      // right-middle of each child box
      const c1x = originX + S(c1.x + c1.w);
      const c2x = originX + S(c2.x + c2.w);
      const c1y = originY + S(c1.y + c1.h / 2);
      const c2y = originY + S(c2.y + c2.h / 2);

      // left-middle of parent box
      const px = originX + S(p.x);
      const py = originY + S(p.y + p.h / 2);

      // Draw: child1 → horizontal to mid, child2 → horizontal to mid, vertical between them, and into parent
      const midX = px - 10 * scale;

      pdf.setDrawColor(LINE);
      pdf.line(c1x, c1y, midX, c1y);
      pdf.line(c2x, c2y, midX, c2y);

      // vertical join
      pdf.line(midX, c1y, midX, c2y);

      // into parent
      pdf.line(midX, py, px, py);
    }
  }

  pdf.save(`${tn.name.replace(/[^\w\-]+/g, "_")}_fixtures.pdf`);
}

// ---------- UI bits ----------
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
      <div className="flex items-center justify-between px-3 py-2 glass-header" style={{ borderColor: TM_BLUE }}>
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
        {stageText === "F" ? "" : <> • M{idx}</>}
      </span>
      <span className="flex-1">{aName}</span>
      {!bothEmpty && !singleBye && <span>vs</span>}
      <span className="flex-1">{bName}</span>
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
            m.winnerId ? "border-emerald-400 text-emerald-300" : "border-white hover:bg-white hover:text-black"
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

// ================= Component =================
export default function TournamentMaker() {
  const [tab, setTab] = useState("fixtures");

  // Admin state (simple in-app auth)
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem("gp_is_admin") === "1");
  const [showLogin, setShowLogin] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");

  const [tName, setTName] = useState("");
  const [targetTournamentId, setTargetTournamentId] = useState(NEW_TOURNEY_SENTINEL);
  const [namesText, setNamesText] = useState("");
  const [seed1, setSeed1] = useState("");
  const [seed2, setSeed2] = useState("");
  const [builderTeams, setBuilderTeams] = useState([]);

  const uploadRef = useRef(null);

  const [tournaments, setTournaments] = useState(() => []);
  const [deletedTournaments, setDeletedTournaments] = useState(() => []);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePw, setDeletePw] = useState("");
  const [deleteTargetId, setDeleteTargetId] = useState(null);

  // Load once
  useEffect(() => {
    (async () => {
      try {
        const data = await loadStoreOnce();
        setTournaments(Array.isArray(data.tournaments) ? data.tournaments : []);
        setDeletedTournaments(Array.isArray(data.deleted) ? data.deleted : []);
      } catch (e) {
        console.warn("Load error:", e);
      }
    })();
  }, []);

  // builder map
  const builderTeamMap = useMemo(
    () => Object.fromEntries(builderTeams.map((tm) => [tm.name, tm.id])),
    [builderTeams]
  );

  function loadTeamsFromText() {
  if (!isAdmin) return alert("Admin only.");
  const lines = namesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return alert("Please enter at least one player.");

  const dups = findDuplicateNamesCaseInsensitive(lines);
  if (dups.length > 0) {
    alert(
      "Duplicate names found:\n\n" +
      dups.map((n) => `• ${n}`).join("\n") +
      "\n\nPlease remove duplicates and try again."
    );
    return;
  }

  // no duplicates: build teams
  const teams = lines.map((n) => ({ id: uid(), name: n }));
  setBuilderTeams(teams);

  if (targetTournamentId === NEW_TOURNEY_SENTINEL) {
    setSeed1(lines[0] || "");
    setSeed2(lines[1] || "");
  }
}


  async function handlePlayersUpload(file) {
  if (!isAdmin) return alert("Admin only.");
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
  if (names.length === 0) return alert("Could not find a 'Players' column in the file.");

  const dups = findDuplicateNamesCaseInsensitive(names);
  if (dups.length > 0) {
    alert(
      "Duplicate names found in the uploaded file:\n\n" +
      dups.map((n) => `• ${n}`).join("\n") +
      "\n\nPlease remove duplicates and try again."
    );
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

    const half = size / 2;
    const topAvail = [];
    const botAvail = [];
    for (let i = 0; i < half; i++) if (i !== 0 && i !== 1) topAvail.push(i);
    for (let i = half; i < size; i++) if (i !== size - 1 && i !== size - 2) botAvail.push(i);

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
      if (!aId && !bId) continue;
      const bye = !aId || !bId;
      let winnerId = null;
      if (bye) winnerId = aId || bId || null;

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
    if (!isAdmin) return alert("Admin only.");
    if (targetTournamentId !== NEW_TOURNEY_SENTINEL) {
      const names = builderTeams.length
        ? builderTeams.map((b) => b.name)
        : namesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      applyEntriesToTournament(targetTournamentId, names); // NOTE: still referenced, implement if needed.
      return;
    }
     // Duplicate guard (case-insensitive)
{
  const names = builderTeams.map((t) => t.name);
  const dups = findDuplicateNamesCaseInsensitive(names);
  if (dups.length > 0) {
    alert(
      "Duplicate names found:\n\n" +
      dups.map((n) => `• ${n}`).join("\n") +
      "\n\nPlease remove duplicates and try again."
    );
    return;
  }
}

    if (!tName.trim()) return alert("Please enter a Tournament Name.");
    if (builderTeams.length < 2) return alert("Please add at least 2 entries.");
    if (!seed1 || !seed2 || seed1 === seed2) return alert("Pick two different seeds.");
    const nameIndex = Object.fromEntries(builderTeams.map((tm) => [tm.name, true]));
    if (!nameIndex[seed1] || !nameIndex[seed2]) return alert("Seeds must be from the added entries.");

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

    setTName("");
    setNamesText("");
    setSeed1("");
    setSeed2("");
    setBuilderTeams([]);
    setTargetTournamentId(NEW_TOURNEY_SENTINEL);
    setTab("fixtures");
  }

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
    if (!isAdmin) return alert("Admin only.");
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
    if (!isAdmin) return alert("Admin only.");
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
          let winnerId = null;
          if (bye) winnerId = aId || bId || null;

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

  // Delete modal & archive
  function openDeleteModal(tournamentId) {
    if (!isAdmin) return alert("Admin only.");
    setDeleteTargetId(tournamentId);
    setDeletePw("");
    setShowDeleteModal(true);
  }
  function confirmDelete() {
    if (!isAdmin) return;
    if (deletePw !== ADMIN_PASSWORD) return alert("Incorrect password.");
    const ok = window.confirm?.(
      "Are you sure you want to delete this tournament?\nIt will be moved to the DELETED tab (not permanently erased)."
    );
    if (!ok) return;

    setTournaments((prev) => {
      const idx = prev.findIndex((t) => t.id === deleteTargetId);
      if (idx === -1) return prev;
      const t = prev[idx];
      const remaining = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      const archived = { ...t, deletedAt: Date.now() };
      setDeletedTournaments((old) => [archived, ...old]);
      return remaining;
    });

    setShowDeleteModal(false);
    setDeleteTargetId(null);
    setDeletePw("");
  }
  function cancelDelete() {
    setShowDeleteModal(false);
    setDeleteTargetId(null);
    setDeletePw("");
  }

  // Restore & permanent delete from DELETED
  function restoreTournament(tournamentId) {
    if (!isAdmin) return alert("Admin only.");
    setDeletedTournaments((prevDeleted) => {
      const idx = prevDeleted.findIndex((t) => t.id === tournamentId);
      if (idx === -1) return prevDeleted;
      const t = prevDeleted[idx];
      const restDeleted = [...prevDeleted.slice(0, idx), ...prevDeleted.slice(idx + 1)];
      const { deletedAt, ...restored } = t;
      setTournaments((prev) => [restored, ...prev]);
      return restDeleted;
    });
    setTab("fixtures");
  }
  function deleteForever(tournamentId) {
    if (!isAdmin) return alert("Admin only.");
    const ok = window.confirm("Permanently delete this tournament from DELETED?\nThis cannot be undone.");
    if (!ok) return;
    setDeletedTournaments((prev) => prev.filter((t) => t.id !== tournamentId));
    // Click "Save" to persist to JSONBin.
  }
function findDuplicateNamesCaseInsensitive(names) {
  const seen = new Map(); // lcName -> originalName (first seen)
  const dupSet = new Set(); // lcName duplicates
  for (const raw of names.map((s) => String(s || "").trim()).filter(Boolean)) {
    const lc = raw.toLowerCase();
    if (seen.has(lc)) dupSet.add(lc);
    else seen.set(lc, raw);
  }
  // return duplicates using their first-seen casing for readability
  return Array.from(dupSet).map((lc) => seen.get(lc));
}

  // Save
  const saveAll = async () => {
    if (!isAdmin) return alert("Admin only.");
    try {
      await saveStore({ tournaments, deleted: deletedTournaments });
      alert("Saved.");
    } catch (e) {
      console.error(e);
      alert("Save failed. Check console.");
    }
  };

  const gpStyles = `
@keyframes diagPan { 0% { background-position: 0 0; } 100% { background-position: 400px 400px; } }
@keyframes floatPan { 0% { transform: translate3d(0,0,0); } 100% { transform: translate3d(-80px,-80px,0); } }
.gp3d { text-shadow: 0 1px 0 rgba(0,0,0,.35), 0 2px 0 rgba(0,0,0,.35), 0 3px 0 rgba(0,0,0,.32), 0 4px 0 rgba(0,0,0,.30), 0 5px 0 rgba(0,0,0,.28), 0 6px 0 rgba(0,0,0,.25), 0 12px 20px rgba(0,0,0,.45), 0 0 8px rgba(0,177,231,.25); transition: transform .3s ease, text-shadow .3s ease, filter .3s ease; }
.gpGroup:hover .gp3d { transform: translateY(-4px); text-shadow: 0 2px 0 rgba(0,0,0,.35), 0 4px 0 rgba(0,0,0,.33), 0 6px 0 rgba(0,0,0,.31), 0 8px 0 rgba(0,0,0,.30), 0 18px 28px rgba(0,0,0,.55), 0 0 14px rgba(0,177,231,.45); filter: drop-shadow(0 0 6px rgba(0,177,231,.25)); }
.pageBg { background-image: radial-gradient(1200px 600px at 10% 0%, rgba(0,177,231,.25), transparent 60%), radial-gradient(900px 500px at 90% 20%, rgba(15,74,161,.35), transparent 60%), linear-gradient(180deg, #080b14 0%, #0a1020 40%, #0e1a33 100%); background-attachment: fixed; }
.glass { background: rgba(255,255,255,0.04); backdrop-filter: blur(10px); }
.glass-header { background: rgba(255,255,255,0.06); backdrop-filter: blur(6px); }
.field { background: rgba(255,255,255,0.05); color: #fff; }
`;

  return (
    <div className="p-4 text-white min-h-screen pageBg" style={{ position: "relative", zIndex: 1 }}>
      <style>{gpStyles}</style>

      <section className="relative rounded-2xl overflow-hidden border mb-4 min-h-[25vh] flex items-center" style={{ borderColor: TM_BLUE }}>
        <div className="relative p-6 md:p-8 w-full gpGroup">
          <h1 className="text-5xl md:text-7xl lg:text-8xl font-extrabold tracking-widest text-center select-none">
            <span className="gp3d" style={{ color: "#ffffff" }}>GAME</span>
            <span className="gp3d ml-2" style={{ color: "#ffffff" }}>PORT</span>
          </h1>
        </div>
      </section>

      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          {isAdmin && <TabButton id="schedule" label="SCHEDULE" tab={tab} setTab={setTab} />}
          <TabButton id="fixtures" label="FIXTURES" tab={tab} setTab={setTab} />
          <TabButton id="standings" label="STANDINGS" tab={tab} setTab={setTab} />
          <TabButton id="winners" label="W INNERS" tab={tab} setTab={setTab} />
          {isAdmin && <TabButton id="deleted" label="DELETED" tab={tab} setTab={setTab} />}
        </div>
        <div className="flex gap-2 items-center">
          {(tab === "fixtures" || (tab === "deleted" && isAdmin)) && (
            <button className="px-3 py-2 border rounded hover:opacity-90" style={{ borderColor: TM_BLUE }} onClick={saveAll}>
              Save
            </button>
          )}
          {!isAdmin ? (
            <button className="px-3 py-2 border rounded hover:bg-white hover:text-black" style={{ borderColor: TM_BLUE }} onClick={() => setShowLogin(true)}>
              Admin Login
            </button>
          ) : (
            <button className="px-3 py-2 border rounded border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => {
              setIsAdmin(false);
              localStorage.removeItem("gp_is_admin");
              if (tab === "schedule" || tab === "deleted") setTab("fixtures");
            }}>
              Logout
            </button>
          )}
        </div>
      </div>

      {showLogin && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="w-[90vw] max-w-sm border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Admin Login</h3>
              <button className="w-6 h-6 border border-white rounded text-xs hover:bg-white hover:text-black" onClick={() => setShowLogin(false)}>×</button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              if (loginId === ADMIN_USERNAME && loginPw === ADMIN_PASSWORD) {
                setIsAdmin(true);
                localStorage.setItem("gp_is_admin", "1");
                setShowLogin(false);
                setLoginId("");
                setLoginPw("");
              } else {
                alert("Invalid credentials");
              }
            }} className="space-y-3">
              <div>
                <label className="text-xs">Admin ID</label>
                <input className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="enter admin id" />
              </div>
              <div>
                <label className="text-xs">Password</label>
                <input type="password" className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={loginPw} onChange={(e) => setLoginPw(e.target.value)} placeholder="password" />
              </div>
              <button type="submit" className="w-full px-4 py-2 border border-emerald-400 text-emerald-300 rounded hover:bg-emerald-400 hover:text-black">Login</button>
              <p className="text-xs text-white/60">(Change admin ID & password in code before publishing.)</p>
            </form>
          </div>
        </div>
      )}

      {showDeleteModal && isAdmin && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="w-[90vw] max-w-md border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h3 className="font-semibold mb-2">Confirm Delete</h3>
            <p className="text-sm text-white/80 mb-3">
              Re-enter your admin <b>password</b> to delete. It will be moved to the <b>DELETED</b> tab (not permanently erased).
            </p>
            <div className="mb-3">
              <label className="text-xs">Admin Password</label>
              <input type="password" className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={deletePw} onChange={(e) => setDeletePw(e.target.value)} placeholder="password" />
            </div>
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-2 border rounded border-zinc-400 text-zinc-200 hover:bg-zinc-200 hover:text-black" onClick={() => {
                setShowDeleteModal(false);
                setDeleteTargetId(null);
                setDeletePw("");
              }}>Cancel</button>
              <button className="px-3 py-2 border rounded border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => {
                if (deletePw !== ADMIN_PASSWORD) return alert("Incorrect password.");
                const ok = window.confirm("Are you sure you want to delete this tournament?\nIt will be moved to the DELETED tab (not permanently erased).");
                if (!ok) return;
                setTournaments((prev) => {
                  const idx = prev.findIndex((t) => t.id === deleteTargetId);
                  if (idx === -1) return prev;
                  const t = prev[idx];
                  const remaining = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
                  const archived = { ...t, deletedAt: Date.now() };
                  setDeletedTournaments((old) => [archived, ...old]);
                  return remaining;
                });
                setShowDeleteModal(false);
                setDeleteTargetId(null);
                setDeletePw("");
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {tab === "schedule" && (isAdmin ? (
        <section className="grid md:grid-cols-2 gap-4">
          <div className="border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="font-semibold mb-3">Tournament Setup</h2>

            <label className="text-xs block mb-3">
              Tournament
              <select className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={targetTournamentId} onChange={(e) => setTargetTournamentId(e.target.value)}>
                <option value={NEW_TOURNEY_SENTINEL}>➕ Create New Tournament</option>
                {tournaments.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>

            {targetTournamentId === NEW_TOURNEY_SENTINEL && (
              <label className="text-xs block mb-3">
                Tournament Name
                <input className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={tName} onChange={(e) => setTName(e.target.value)} placeholder="e.g., Office TT Cup — Aug 2025" />
              </label>
            )}

            <label className="text-xs block mb-2">Players (one per line)</label>
            <textarea className="w-full h-40 field border rounded p-2 mb-2" style={{ borderColor: TM_BLUE }} placeholder={`Enter player names, one per line
Example:
Akhil
Devi
Rahul
Meera`} value={namesText} onChange={(e) => setNamesText(e.target.value)} />

            <div className="flex items-center justify-between mb-2">
              <div>
                <input ref={uploadRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    await handlePlayersUpload(f);
                    if (uploadRef.current) uploadRef.current.value = "";
                  }}
                />
                <button
                  className={`px-3 py-2 border rounded inline-flex items-center gap-2 ${
                    targetTournamentId !== NEW_TOURNEY_SENTINEL ? "border-zinc-700 text-zinc-500 cursor-not-allowed" : "border-white hover:bg-white hover:text-black"
                  }`}
                  title="Upload Entry"
                  onClick={() => {
                    if (targetTournamentId === NEW_TOURNEY_SENTINEL && uploadRef.current) uploadRef.current.click();
                  }}
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
                          builderTeams.length
                            ? builderTeams.map((b) => b.name)
                            : namesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
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
                  <select className="field border rounded p-1 ml-1" style={{ borderColor: TM_BLUE }} value={seed1} onChange={(e) => setSeed1(e.target.value)}>
                    <option value="">—</option>
                    {builderTeams.map((tm) => (
                      <option key={tm.id} value={tm.name}>{tm.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  Seed 2
                  <select className="field border rounded p-1 ml-1" style={{ borderColor: TM_BLUE }} value={seed2} onChange={(e) => setSeed2(e.target.value)}>
                    <option value="">—</option>
                    {builderTeams.map((tm) => (
                      <option key={tm.id} value={tm.name}>{tm.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div className="mt-6 text-center">
              <button className="px-4 py-2 border border-emerald-400 text-emerald-300 rounded hover:bg-emerald-400 hover:text-black" onClick={createTournament}>
                {targetTournamentId === NEW_TOURNEY_SENTINEL ? "Create Tournament" : "Apply Entries to Selected"}
              </button>
            </div>
          </div>

          <div className="border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="font-semibold mb-3">Tips</h2>
            <ul className="list-disc ml-5 text-sm text-white/90 space-y-1">
              <li>Select a tournament or create a new one.</li>
              <li>New: paste/upload names → <b>Add Entries</b> → pick seeds → <b>Create Tournament</b>.</li>
              <li>Existing: paste/upload names → <b>Add Entries</b>; fills BYEs first, then adds matches.</li>
            </ul>
          </div>
        </section>
      ) : (
        <section className="border rounded-2xl p-6 text-sm glass" style={{ borderColor: TM_BLUE }}>
          Viewer mode. Please <button className="underline" onClick={() => setShowLogin(true)}>login as Admin</button> to access SCHEDULE.
        </section>
      ))}

      {tab === "fixtures" && (
        <section>
          {tournaments.filter(t => t.status === "active").length === 0 && (
            <p className="text-white/80 text-sm">
              No active tournaments. {isAdmin ? <>Create one from <b>SCHEDULE</b>.</> : <>Ask an admin to create one.</>}
            </p>
          )}

          {tournaments.filter(t => t.status === "active").map((tn) => {
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
                      <button className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => openDeleteModal(tn.id)} title="Delete tournament">
                        Delete
                      </button>
                    )}
                    <button
                      className="px-2 py-1 rounded border hover:bg-white hover:text-black"
                      style={{ borderColor: TM_BLUE }}
                      onClick={() => exportTournamentToPDF(tn)}
                    >
                      Export PDF
                    </button>
                    <button
                      className="px-2 py-1 rounded border hover:bg-white hover:text-black"
                      style={{ borderColor: TM_BLUE }}
                      onClick={() => exportTournamentToExcel(tn)}
                    >
                      Export Excel
                    </button>
                    <span className="text-xs text-white/70">
                      Current: {stageShort(counts.get(mr) || 0)}
                    </span>
                    {isAdmin && (
                      <button
                        className={`px-3 py-2 rounded-xl border transition ${
                          canNext ? "border-white hover:bg-white hover:text-black" : "border-zinc-700 text-zinc-500 cursor-not-allowed"
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
                      stageText={stageShort(roundCounts(tn).get(m.round) || 0)}
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

      {tab === "standings" && (
        <section>
          {tournaments.length === 0 && (
            <p className="text-white/80 text-sm">
              No tournaments yet. {isAdmin ? <>Create one from <b>SCHEDULE</b>.</> : <>Ask an admin to create one.</>}
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
            const currentCount = (ordered.find(([r]) => r === mr)?.[1].length) || 0;
            const subtitle =
              tn.status === "completed"
                ? `Completed • Champion: ${tn.championId ? teamMap[tn.championId] || "TBD" : "TBD"}`
                : `Active • Current: ${stageShort(currentCount)}`;

            return (
              <Collapsible
  key={tn.id}
  title={tn.name}
  subtitle={subtitle}
  right={
    isAdmin ? (
      <button
        className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black"
        onClick={() => openDeleteModal(tn.id)}
        title="Delete tournament"
      >
        Delete
      </button>
    ) : null
  }
  defaultOpen={false}
>

                {ordered.map(([round, arr]) => (
                  <div key={round} className="mb-3">
                    <h3 className="font-semibold mb-1">{stageShort(arr.length)}</h3>
                    <ul className="space-y-1 text-sm">
                      {arr.map((m, i) => {
                        const a = teamMap[m.aId] || "BYE/TBD";
                        const b = teamMap[m.bId] || "BYE/TBD";
                        const w = m.winnerId ? teamMap[m.winnerId] || "TBD" : null;
                        const isFinals = stageShort(arr.length) === "F";
                        return (
                          <li key={m.id}>
                            {isFinals ? (
                              <>
                                {a} vs {b} — {w ? <b>{w}</b> : <span className="text-zinc-400">TBD</span>}
                              </>
                            ) : (
                              <>
                                Match {i + 1}: {a} vs {b} — {w ? <b>{w}</b> : <span className="text-zinc-400">TBD</span>}
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

      {tab === "winners" && (
        <section>
          {tournaments.filter(t => t.status === "completed").length === 0 && (
            <p className="text-white/80 text-sm">No completed tournaments yet. Finish one in <b>FIXTURES</b>.</p>
          )}
          {tournaments.filter(t => t.status === "completed").map((tn) => {
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
                const code = stageShort(arr.length);
                return code === "F" || code === "SF";
              });
            const championName = tn.championId ? teamMap[tn.championId] || "TBD" : "TBD";
            return (
              <Collapsible
  key={tn.id}
  title={tn.name}
  subtitle={`Champion: ${championName}`}
  right={
    isAdmin ? (
      <button
        className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black"
        onClick={() => openDeleteModal(tn.id)}
        title="Delete tournament"
      >
        Delete
      </button>
    ) : null
  }
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

      {tab === "deleted" && (isAdmin ? (
        <section>
          {deletedTournaments.length === 0 ? (
            <p className="text-white/80 text-sm">No deleted tournaments.</p>
          ) : (
            deletedTournaments.map((tn) => {
              const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
              const subtitle = `Deleted: ${timeStr(tn.deletedAt)} • Created: ${timeStr(tn.createdAt)} • Players: ${tn.teams.length}`;
              return (
                <Collapsible
                  key={tn.id}
                  title={tn.name}
                  subtitle={subtitle}
                  right={
                    <div className="flex items-center gap-2">
                      <button
                        className="px-3 py-1 rounded border border-emerald-400 text-emerald-300 hover:bg-emerald-400 hover:text-black"
                        onClick={() => restoreTournament(tn.id)}
                        title="Restore to Fixtures"
                      >
                        Restore
                      </button>
                      <button
                        className="px-3 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black"
                        onClick={() => deleteForever(tn.id)}
                        title="Delete permanently"
                      >
                        Delete Permanently
                      </button>
                    </div>
                  }
                  defaultOpen={false}
                >
                  <div className="text-sm space-y-2">
                    <div>
                      <b>Status when deleted:</b> {tn.status}
                      {tn.status === "completed" && tn.championId ? ` • Champion: ${teamMap[tn.championId] || "TBD"}` : ""}
                    </div>
                    <div>
                      <b>Players:</b>
                      <ul className="list-disc ml-5">
                        {tn.teams.map((t) => (
                          <li key={t.id}>{t.name}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <b>Matches:</b>
                      <ul className="list-disc ml-5">
                        {tn.matches.map((m) => {
                          const a = teamMap[m.aId] || "BYE/TBD";
                          const b = teamMap[m.bId] || "BYE/TBD";
                          const w = m.winnerId ? teamMap[m.winnerId] || "TBD" : "TBD";
                          return (
                            <li key={m.id}>
                              Round {m.round}: {a} vs {b} — Winner: {w}
                            </li>
                          );
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
        <section className="border rounded-2xl p-6 text-sm glass" style={{ borderColor: TM_BLUE }}>
          Viewer mode. Please <button className="underline" onClick={() => setShowLogin(true)}>login as Admin</button> to access DELETED.
        </section>
      ))}

      <footer className="fixed bottom-4 right-6 text-2xl font-bold text-white/80">CV ENGG TML</footer>
    </div>
  );
}

/* Minimal sanity checks in console (disabled) */
(function runDevTests() {
  try {
    const IS_DEV = false;
    if (!IS_DEV) return;
    const eq = (name, got, exp) =>
      console.log(`[TEST] ${name}:`, Array.isArray(exp) ? JSON.stringify(got) === JSON.stringify(exp) : got === exp ? "PASS" : "FAIL");
    // eq("normalizeHeader", normalizeHeader(" Players "), "players");
  } catch (e) {
    console.warn("Dev tests error:", e);
  }
})();
