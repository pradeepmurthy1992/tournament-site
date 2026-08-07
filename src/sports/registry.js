// Pluggable sport definitions. `matchModel` tells the UI/engine how a single
// match is scored:
//   "winner" -> admin just picks a winner (generic fallback)
//   "games"  -> best-of-N games, each to a target score (badminton, table
//               tennis, volleyball — see src/sports/badminton.js, shared
//               across all three despite the filename)
//   "score"  -> free-form final score per side, draws allowed, sport-specific
//               tiebreaker (football, cricket — see src/sports/score.js)
//   "result" -> win/draw/loss picked directly (no games or score), for
//               sports where "the score" isn't really a bracket concept —
//               chess (see src/sports/chess.js)
//   "sets"   -> best-of-N sets of games with tiebreaks (tennis) — design only
//
// `implemented: false` entries are stubbed so the shape is ready but not
// selectable yet — see README.md "Sport conventions".

export const SPORTS = {
  generic: {
    id: "generic",
    label: "Generic (pick winner)",
    matchModel: "winner",
    supportsGroups: false,
    implemented: true,
  },
  badminton: {
    id: "badminton",
    label: "Badminton",
    matchModel: "games",
    supportsGroups: true,
    implemented: true,
    gameConfig: { pointsToWin: 21, winBy: 2, cap: 30, bestOf: 3 },
    pointsRule: { win: 1, loss: 0 },
  },
  tabletennis: {
    id: "tabletennis",
    label: "Table Tennis",
    matchModel: "games",
    supportsGroups: true,
    implemented: true,
    gameConfig: { pointsToWin: 11, winBy: 2, cap: null, bestOf: 5 },
    pointsRule: { win: 1, loss: 0 },
  },
  volleyball: {
    id: "volleyball",
    label: "Volleyball",
    matchModel: "games",
    supportsGroups: true,
    implemented: true,
    // Sets 1-4 play to 25 (win by 2); if a deciding 5th set is needed it
    // only goes to 15 — the decider* fields tell badminton.js to switch
    // targets on the last possible game.
    gameConfig: { pointsToWin: 25, winBy: 2, cap: null, bestOf: 5, deciderPointsToWin: 15, deciderWinBy: 2 },
    pointsRule: { win: 1, loss: 0 },
  },
  football: {
    id: "football",
    label: "Football",
    matchModel: "score",
    supportsGroups: true,
    implemented: true,
    pointsRule: { win: 3, draw: 1, loss: 0 },
    scoreLabels: { a: "Goals", b: "Goals" },
  },
  cricket: {
    id: "cricket",
    label: "Cricket",
    matchModel: "score",
    supportsGroups: true,
    implemented: true,
    pointsRule: { win: 2, draw: 1, loss: 0 }, // "draw" here covers a tied match
    scoreLabels: { a: "Runs", b: "Runs" },
    // Simplified tiebreaker: total run difference across group matches,
    // not true Net Run Rate (which needs overs-faced/bowled per innings,
    // not modeled here). Good enough to rank a small club/office group
    // stage; flagged clearly rather than mislabeled as real NRR.
  },
  chess: {
    id: "chess",
    label: "Chess",
    matchModel: "result", // admin picks Win A / Win B / Draw directly, no score or games
    supportsGroups: true, // round-robin and knockout both work well for chess as-is
    implemented: true,
    pointsRule: { win: 1, draw: 0.5, loss: 0 },
    // Swiss-system pairing (the usual format for large chess fields) is a
    // genuinely separate scheduling algorithm from round-robin/knockout —
    // not built this round. Round-robin already suits small-to-medium
    // fields (e.g. club championships) correctly and fairly today.
  },
  tennis: {
    id: "tennis",
    label: "Tennis (coming soon)",
    matchModel: "sets",
    supportsGroups: true,
    implemented: false,
  },
};

export function getSport(id) {
  return SPORTS[id] || SPORTS.generic;
}

export function listSelectableSports() {
  return Object.values(SPORTS);
}
