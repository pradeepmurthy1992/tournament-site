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
 */

const TM_BLUE = "#0f4aa1";
const NEW_TOURNEY_SENTINEL = "__NEW__";
const uid = () => Math.random().toString(36).slice(2, 9);

// ⚠️ Change before sharing
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "gameport123";

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
function groupMatchesByRound(tn) {
  const byRound = new Map();
  for (const m of tn.matches) { if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
  return Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]).map(([round, matches]) => ({ round, matches }));
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
    const grouped = groupMatchesByRound(tn);
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
  for (const m of (tn.matches || [])) { if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
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

function drawRichLine(pdf, x, y, parts, opt) {
  // parts: [{text, bold?:boolean, strike?:boolean}]
  // opt: { font: "helvetica", size: 11, color: "#000000", strikeYOffset?: number }
  const { font = "helvetica", size = 11, color = "#000000", strikeYOffset = -2 } = opt || {};
  pdf.setTextColor(color);
  let cursor = x;
  for (const p of parts) {
    const style = p.bold ? "bold" : "normal";
    pdf.setFont(font, style);
    pdf.setFontSize(size);
    const w = pdf.getTextWidth(p.text);
    pdf.text(p.text, cursor, y);
    if (p.strike) {
      // Draw a strike-through line across this token
      const thickness = Math.max(0.6, size * 0.06);
      const midY = y + strikeYOffset;
      pdf.setLineWidth(thickness);
      pdf.line(cursor, midY, cursor + w, midY);
    }
    cursor += w;
  }
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

  const pdf = new jsPDFCtor({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 36;

  // Colors / styles (white background, black text/lines)
  const BG = "#ffffff";
  const FG = "#000000";

  // Title
  pdf.setFillColor(BG);
  pdf.rect(0, 0, pageW, pageH, "F");
  pdf.setTextColor(FG);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.text(`${tn.name} — Fixtures`, margin, margin + 6);

  // Layout “virtual space” then scale-to-fit
  const colGap = 44;
  const boxW = 210;
  const boxH0 = 54;        // taller to fit two lines nicely
  const vGap0 = 16;

  const colWidths = rounds.map((_, rIdx) => boxW * Math.max(0.75, 1 - rIdx * 0.08));
  const roundHeights = rounds.map((_, rIdx) => boxH0 + rIdx * 4);
  const roundVGaps = rounds.map((_, rIdx) => vGap0 * Math.pow(2, rIdx));

  // Column x
  const colX = [];
  let totalW = 0;
  for (let r = 0; r < rounds.length; r++) {
    if (r === 0) {
      colX[r] = 0;
      totalW += colWidths[r];
    } else {
      colX[r] = colX[r - 1] + colWidths[r - 1] + colGap;
      totalW += colGap + colWidths[r];
    }
  }

  const r1Count = rounds[0].matches.length;
  const bodyH = r1Count * roundHeights[0] + (r1Count - 1) * roundVGaps[0];
  const maxW = pageW - margin * 2;
  const maxH = pageH - (margin * 2 + 18 + 10);
  const scale = Math.min(1, maxW / totalW, maxH / bodyH);

  const originX = margin;
  const originY = margin + 24;
  const S = (n) => n * scale;

  // Cache positions: pos[r][i] = {x,y,w,h}
  const pos = rounds.map((r, rIdx) => {
    const matches = r.matches;
    const thisBoxH = roundHeights[rIdx];
    const thisVGap = roundVGaps[rIdx];

    const arr = [];
    if (rIdx === 0) {
      let y = 0;
      for (let i = 0; i < matches.length; i++) {
        arr.push({ x: colX[rIdx], y, w: colWidths[rIdx], h: thisBoxH });
        y += thisBoxH + thisVGap;
      }
    } else {
      const prevBoxH = roundHeights[rIdx - 1];
      const prevVGap = roundVGaps[rIdx - 1];
      const childBlockH = prevBoxH + prevVGap;
      const myBlockH = childBlockH * 2 - prevVGap;
      let y = (myBlockH - thisBoxH) / 2;
      for (let i = 0; i < matches.length; i++) {
        arr.push({ x: colX[rIdx], y, w: colWidths[rIdx], h: thisBoxH });
        y += myBlockH;
      }
    }
    return arr;
  });

  // Thin, uniform border everywhere (boxes + connectors)
  const BOX_LINE_W = Math.max(0.6, 0.6 * scale); // minimal & uniform
  const CONN_LINE_W = BOX_LINE_W;

  /* --- utilities --- */
  const getChildWinnersOrPlaceholders = (rIdx, iIdx) => {
    const childRound = rounds[rIdx - 1];
    const left = childRound?.matches?.[iIdx * 2];
    const right = childRound?.matches?.[iIdx * 2 + 1];
    const leftNo = left ? matchNoById.get(left.id) : null;
    const rightNo = right ? matchNoById.get(right.id) : null;

    const leftWinner = left?.winnerId ? (teamMap[left.winnerId] || "TBD") : null;
    const rightWinner = right?.winnerId ? (teamMap[right.winnerId] || "TBD") : null;

    if (leftWinner && rightWinner) {
      return { type: "names", a: leftWinner, aId: left.winnerId, b: rightWinner, bId: right.winnerId };
    }
    // placeholder single line stays as requested
    return { type: "placeholder", text: `[Winner of M${leftNo ?? "?"} Vs M${rightNo ?? "?"}]` };
  };

  const getRound1Names = (m) => {
    const a = teamMap[m.aId] || (m.aId ? "Unknown" : "BYE/TBD");
    const b = teamMap[m.bId] || (m.bId ? "Unknown" : "BYE/TBD");
    return { type: "names", a, aId: m.aId, b, bId: m.bId };
  };

  // Draw everything
  for (let r = 0; r < rounds.length; r++) {
    const matches = rounds[r].matches;

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const p = pos[r][i];

      // Box
      pdf.setDrawColor(0);
      pdf.setLineWidth(BOX_LINE_W);
      pdf.rect(originX + S(p.x), originY + S(p.y), S(p.w), S(p.h), "S");

      const padX = 6 * scale;
      const padTop = 6 * scale;

      // Lines Y positions (with small gaps)
      const titleY = originY + S(p.y) + padTop + 10 * scale;     // "Match M#"
      const gapAfterTitle = 3 * scale;                            // small gap after "Match M#"
      const line1Y = titleY + gapAfterTitle + 11 * scale;         // first participant line
      const gapBetweenLines = 3 * scale;                          // small gap between lines
      const line2Y = line1Y + gapBetweenLines + 11 * scale;       // second participant line

      // Label: "Match M#"
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(10 * scale);
      pdf.setTextColor(FG);
      pdf.text(`Match M${matchNoById.get(m.id)}`, originX + S(p.x) + padX, titleY);

      const info = r === 0 ? getRound1Names(m) : getChildWinnersOrPlaceholders(r, i);

      if (info.type === "placeholder") {
        // Single line centered-ish left (you can fully center if wanted)
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(11 * scale);
        pdf.setTextColor(FG);
        pdf.text(info.text, originX + S(p.x) + padX, line1Y);
        // nothing on second line for placeholders
      } else {
        const winnerId = m.winnerId || null;

        const leftIsWinner = winnerId && winnerId === info.aId;
        const rightIsWinner = winnerId && winnerId === info.bId;

        // Line 1: "<Name A>  VS"
        const line1Parts = [
          ...buildParts(info.a || "TBD", { bold: !!leftIsWinner, strike: !!(winnerId && !leftIsWinner && info.a && info.a !== "BYE/TBD") }),
          { text: "  VS", bold: false, strike: false },
        ];
        drawRichLine(pdf, originX + S(p.x) + padX, line1Y, line1Parts, { size: 11 * scale, color: FG });

        // Line 2: "Name B"
        const line2Parts = [
          ...buildParts(info.b || "TBD", { bold: !!rightIsWinner, strike: !!(winnerId && !rightIsWinner && info.b && info.b !== "BYE/TBD") })
        ];
        drawRichLine(pdf, originX + S(p.x) + padX, line2Y, line2Parts, { size: 11 * scale, color: FG });
      }
    }
  }

  // Connectors (thin & consistent)
  for (let r = 0; r < rounds.length - 1; r++) {
    const child = pos[r];
    const parent = pos[r + 1];

    for (let i = 0; i < parent.length; i++) {
      const p = parent[i];
      const c1 = child[i * 2];
      const c2 = child[i * 2 + 1];
      if (!c1 || !c2) continue;

      const c1x = originX + S(c1.x + c1.w);
      const c2x = originX + S(c2.x + c2.w);
      const c1y = originY + S(c1.y + c1.h / 2);
      const c2y = originY + S(c2.y + c2.h / 2);

      const px = originX + S(p.x);
      const py = originY + S(p.y + p.h / 2);

      const midX = px - 10 * scale;

      pdf.setDrawColor(0);
      pdf.setLineWidth(CONN_LINE_W);
      pdf.line(c1x, c1y, midX, c1y);
      pdf.line(c2x, c2y, midX, c2y);
      pdf.line(midX, c1y, midX, c2y);
      pdf.line(midX, py, px, py);
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
function MatchRow({ idx, m, teamMap, onPickWinner, stageText, canEdit }) {
  const aName = teamMap[m.aId] || (m.aId ? "Unknown" : "BYE/TBD");
  const bName = teamMap[m.bId] || (m.bId ? "Unknown" : "BYE/TBD");
  const bothEmpty = !m.aId && !m.bId;
  const singleBye = (!!m.aId && !m.bId) || (!m.aId && !!m.bId);
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-1 sm:gap-2 py-2 text-sm">
      <span className="text-zinc-400 sm:w-24">
        {stageText}{stageText === "F" ? "" : <> • M{idx}</>}
      </span>
      <div className="flex-1">{aName}</div>
      {!bothEmpty && !singleBye && <span className="hidden sm:inline">vs</span>}
      <div className="flex-1">{bName}</div>

      {!canEdit ? (
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

/* ---------------- Component ---------------- */
export default function TournamentMaker() {
  const [tab, setTab] = useState("fixtures");

  // Admin
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem("gp_is_admin") === "1");
  const [showLogin, setShowLogin] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");

  // Builder state
  const [tName, setTName] = useState("");
  const [targetTournamentId, setTargetTournamentId] = useState(NEW_TOURNEY_SENTINEL);
  const [namesText, setNamesText] = useState("");
  const [seed1, setSeed1] = useState("");
  const [seed2, setSeed2] = useState("");
  const [seed3, setSeed3] = useState("");
  const [seed4, setSeed4] = useState("");
  const [builderTeams, setBuilderTeams] = useState([]);

  const uploadRef = useRef(null);

  // Data
  const [tournaments, setTournaments] = useState(() => []);
  const [deletedTournaments, setDeletedTournaments] = useState(() => []);

  // Delete modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePw, setDeletePw] = useState("");
  const [deleteTargetId, setDeleteTargetId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await loadStoreOnce();
        setTournaments(Array.isArray(data.tournaments) ? data.tournaments : []);
        setDeletedTournaments(Array.isArray(data.deleted) ? data.deleted : []);
      } catch (e) { console.warn("Load error:", e); }
    })();
  }, []);

  const builderTeamMap = useMemo(
    () => Object.fromEntries(builderTeams.map((tm) => [tm.name, tm.id])),
    [builderTeams]
  );

  function loadTeamsFromText() {
    if (!isAdmin) return alert("Admin only.");
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
    if (!isAdmin) return alert("Admin only.");
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

  function roundCounts(tn) { const mp = new Map(); for (const m of tn.matches) { if (!(m.aId || m.bId)) continue; mp.set(m.round, (mp.get(m.round) || 0) + 1); } return mp; }
  function maxRound(tn) { return tn.matches.length ? Math.max(...tn.matches.map((m) => m.round)) : 0; }
  function currentRoundMatches(tn) { const mr = maxRound(tn); return tn.matches.filter((m) => m.round === mr); }
  function canGenerateNext(tn) { const cur = currentRoundMatches(tn); if (!cur.length) return false; const valid = cur.filter((m) => m.aId || m.bId); return valid.length > 0 && valid.every((m) => !!m.winnerId); }

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
      matches.push({ id: uid(), round: 1, aId, bId, status: bye ? "BYE" : "Scheduled", winnerId: bye ? (aId || bId || null) : null });
    }
    return matches;
  }

  function pickWinner(tournamentId, matchId, winnerId) {
    if (!isAdmin) return alert("Admin only.");
    setTournaments((prev) => prev.map((tn) => {
      if (tn.id !== tournamentId) return tn;
      const matches = tn.matches.map((m) => (m.id === matchId ? { ...m, winnerId, status: winnerId ? "Final" : m.status } : m));
      return { ...tn, matches };
    }));
  }
  function generateNextRound(tournamentId) {
    if (!isAdmin) return alert("Admin only.");
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
        next.push({ id: uid(), round: nextRoundNo, aId, bId, status: bye ? "BYE" : "Scheduled", winnerId: bye ? (aId || bId || null) : null });
      }
      return { ...tn, matches: [...tn.matches, ...next] };
    }));
  }

  function openDeleteModal(tournamentId) { if (!isAdmin) return alert("Admin only."); setDeleteTargetId(tournamentId); setDeletePw(""); setShowDeleteModal(true); }
  function confirmDelete() {
    if (!isAdmin) return;
    if (deletePw !== ADMIN_PASSWORD) return alert("Incorrect password.");
    const ok = window.confirm?.("Are you sure you want to delete this tournament?\nIt will be moved to the DELETED tab (not permanently erased).");
    if (!ok) return;
    setTournaments((prev) => {
      const idx = prev.findIndex((t) => t.id === deleteTargetId); if (idx === -1) return prev;
      const t = prev[idx]; const remaining = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      const archived = { ...t, deletedAt: Date.now() };
      setDeletedTournaments((old) => [archived, ...old]);
      return remaining;
    });
    setShowDeleteModal(false); setDeleteTargetId(null); setDeletePw("");
  }
  function cancelDelete() { setShowDeleteModal(false); setDeleteTargetId(null); setDeletePw(""); }
  function restoreTournament(tournamentId) {
    if (!isAdmin) return alert("Admin only.");
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
    if (!isAdmin) return alert("Admin only.");
    const ok = window.confirm("Permanently delete this tournament from DELETED?\nThis cannot be undone.");
    if (!ok) return;
    setDeletedTournaments((prev) => prev.filter((t) => t.id !== tournamentId));
  }

  function applyEntriesToTournament(tournamentId, newNames) {
    if (!isAdmin) return alert("Admin only.");
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
    if (!isAdmin) return alert("Admin only.");
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

    const tourney = { id: uid(), name: tName.trim(), createdAt: Date.now(), teams: builderTeams, matches, status: "active", seedTopId, seedBottomId, seed3Id, seed4Id, championId: null };
    setTournaments((prev) => [tourney, ...prev]);

    setTName(""); setNamesText(""); setSeed1(""); setSeed2(""); setSeed3(""); setSeed4(""); setBuilderTeams([]);
    setTargetTournamentId(NEW_TOURNEY_SENTINEL); setTab("fixtures");
  }

  const saveAll = async () => {
    if (!isAdmin) return alert("Admin only.");
    try { await saveStore({ tournaments, deleted: deletedTournaments }); alert("Saved."); }
    catch (e) { console.error(e); alert("Save failed. Check console."); }
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

  const activeTournaments = tournaments.filter((tn) => tn.status === "active");
  const completedTournaments = tournaments.filter((tn) => tn.status === "completed");

  return (
    <div className="p-3 sm:p-4 text-white min-h-screen pageBg" style={{ position: "relative", zIndex: 1 }}>
      <style>{gpStyles}</style>

      <section className="relative rounded-2xl overflow-hidden border mb-3 sm:mb-4 min-h-[18vh] sm:min-h-[25vh] flex items-center" style={{ borderColor: TM_BLUE }}>
        <div className="relative p-4 sm:p-6 md:p-8 w-full gpGroup">
          <h1 className="text-4xl sm:text-5xl md:text-7xl lg:text-8xl font-extrabold tracking-widest text-center select-none">
            <span className="gp3d" style={{ color: "#ffffff" }}>GAME</span>
            <span className="gp3d ml-2" style={{ color: "#ffffff" }}>PORT</span>
          </h1>
        </div>
      </section>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 mb-3 sm:mb-4">
        <div className="flex flex-wrap gap-2">
          {isAdmin && <TabButton id="schedule" label="SCHEDULE" tab={tab} setTab={setTab} />}
          <TabButton id="fixtures" label="FIXTURES" tab={tab} setTab={setTab} />
          <TabButton id="standings" label="STANDINGS" tab={tab} setTab={setTab} />
          <TabButton id="winners" label="WINNERS" tab={tab} setTab={setTab} />
          {isAdmin && <TabButton id="deleted" label="DELETED" tab={tab} setTab={setTab} />}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {(tab === "fixtures" || (tab === "deleted" && isAdmin)) && (
            <button className="px-3 py-2 border rounded hover:opacity-90" style={{ borderColor: TM_BLUE }} onClick={saveAll}>Save</button>
          )}
          {!isAdmin ? (
            <button className="px-3 py-2 border rounded hover:bg-white hover:text-black" style={{ borderColor: TM_BLUE }} onClick={() => setShowLogin(true)}>Admin Login</button>
          ) : (
            <button className="px-3 py-2 border rounded border-red-400 text-red-300 hover:bg-red-400 hover:text-black"
              onClick={() => { setIsAdmin(false); localStorage.removeItem("gp_is_admin"); if (tab === "schedule" || tab === "deleted") setTab("fixtures"); }}>Logout</button>
          )}
        </div>
      </div>

      {/* Admin Login */}
      {showLogin && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-3">
          <div className="w-full max-w-sm border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Admin Login</h3>
              <button className="w-6 h-6 border border-white rounded text-xs hover:bg-white hover:text-black" onClick={() => setShowLogin(false)}>×</button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              if (loginId === ADMIN_USERNAME && loginPw === ADMIN_PASSWORD) {
                setIsAdmin(true); localStorage.setItem("gp_is_admin", "1"); setShowLogin(false); setLoginId(""); setLoginPw("");
              } else { alert("Invalid credentials"); }
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

      {/* Delete confirm */}
      {showDeleteModal && isAdmin && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-3">
          <div className="w-full max-w-md border rounded-2xl p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h3 className="font-semibold mb-2">Confirm Delete</h3>
            <p className="text-sm text-white/80 mb-3">Re-enter your admin <b>password</b> to delete. It will be moved to the <b>DELETED</b> tab.</p>
            <div className="mb-3">
              <label className="text-xs">Admin Password</label>
              <input type="password" className="w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={deletePw} onChange={(e) => setDeletePw(e.target.value)} placeholder="password" />
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <button className="px-3 py-2 border rounded border-zinc-400 text-zinc-200 hover:bg-zinc-200 hover:text-black" onClick={cancelDelete}>Cancel</button>
              <button className="px-3 py-2 border rounded border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* SCHEDULE */}
      {tab === "schedule" && (isAdmin ? (
        <section className="grid md:grid-cols-2 gap-3 sm:gap-4">
          <div className="border rounded-2xl p-3 sm:p-4 glass" style={{ borderColor: TM_BLUE }}>
            <h2 className="font-semibold mb-3">Tournament Setup</h2>

            <label className="text-xs block mb-3">
              Tournament
              <div className="mt-1">
                <DarkSelect
                  value={targetTournamentId}
                  onChange={setTargetTournamentId}
                  options={[{ value: NEW_TOURNEY_SENTINEL, label: "➕ Create New Tournament" }, ...tournaments.map(t => ({ value: t.id, label: t.name }))]}
                />
              </div>
            </label>

            {targetTournamentId === NEW_TOURNEY_SENTINEL && (
              <label className="text-xs block mb-3">
                Tournament Name
                <input className="mt-1 w-full field border rounded-xl p-2 focus:border-white outline-none" style={{ borderColor: TM_BLUE }} value={tName} onChange={(e) => setTName(e.target.value)} placeholder="e.g., Office TT Cup — Aug 2025" />
              </label>
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

            {targetTournamentId === NEW_TOURNEY_SENTINEL && builderTeams.length > 0 && (
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
          Viewer mode. Please <button className="underline" onClick={() => setShowLogin(true)}>login as Admin</button> to access SCHEDULE.
        </section>
      ))}

      {/* FIXTURES */}
      {tab === "fixtures" && (
        <section>
          {activeTournaments.length === 0 && (
            <p className="text-white/80 text-sm">
              No active tournaments. {isAdmin ? <>Create one from <b>SCHEDULE</b>.</> : <>Ask an admin to create one.</>}
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
                  <>
                    {isAdmin && (
                      <button className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => openDeleteModal(tn.id)} title="Delete tournament">
                        Delete
                      </button>
                    )}
                    <button className="px-2 py-1 rounded border hover:bg-white hover:text-black" style={{ borderColor: TM_BLUE }} onClick={() => exportTournamentToPDF(tn)}>Export PDF</button>
                    <button className="px-2 py-1 rounded border hover:bg-white hover:text-black" style={{ borderColor: TM_BLUE }} onClick={() => exportTournamentToExcel(tn)}>Export Excel</button>
                    <span className="text-xs text-white/70">Current: {stageShort(counts.get(mr) || 0)}</span>
                    {isAdmin && (
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

      {/* STANDINGS */}
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
            for (const m of tn.matches) { if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
            const ordered = Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]);
            const mr = tn.matches.length ? Math.max(...tn.matches.map((m) => m.round)) : 1;
            const currentCount = (ordered.find(([r]) => r === mr)?.[1].length) || 0;
            const subtitle = tn.status === "completed"
              ? `Completed • Champion: ${tn.championId ? teamMap[tn.championId] || "TBD" : "TBD"}`
              : `Active • Current: ${stageShort(currentCount)}`;

            return (
              <Collapsible
                key={tn.id}
                title={tn.name}
                subtitle={subtitle}
                right={isAdmin ? (
                  <button className="px-2 py-1 rounded border border-red-400 text-red-300 hover:bg-red-400 hover:text-black" onClick={() => openDeleteModal(tn.id)} title="Delete tournament">
                    Delete
                  </button>
                ) : null}
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
                              <>{a} vs {b} — {w ? <b>{w}</b> : <span className="text-zinc-400">TBD</span>}</>
                            ) : (
                              <>Match {i + 1}: {a} vs {b} — {w ? <b>{w}</b> : <span className="text-zinc-400">TBD</span>}</>
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
          {completedTournaments.length === 0 && <p className="text-white/80 text-sm">No completed tournaments yet. Finish one in <b>FIXTURES</b>.</p>}
          {completedTournaments.map((tn) => {
            const teamMap = Object.fromEntries(tn.teams.map((tm) => [tm.id, tm.name]));
            const byRound = new Map();
            for (const m of tn.matches) { if (!m.winnerId) continue; if (!byRound.has(m.round)) byRound.set(m.round, []); byRound.get(m.round).push(m); }
            const ordered = Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]).filter(([_, arr]) => {
              const code = stageShort(arr.length); return code === "F" || code === "SF";
            });
            const championName = tn.championId ? teamMap[tn.championId] || "TBD" : "TBD";
            return (
              <Collapsible
                key={tn.id}
                title={tn.name}
                subtitle={`Champion: ${championName}`}
                right={isAdmin ? (
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
          Viewer mode. Please <button className="underline" onClick={() => setShowLogin(true)}>login as Admin</button> to access DELETED.
        </section>
      ))}

      <footer className="fixed bottom-3 right-3 sm:bottom-4 sm:right-6 text-lg sm:text-2xl font-bold text-white/80">CV ENGG TML</footer>
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
