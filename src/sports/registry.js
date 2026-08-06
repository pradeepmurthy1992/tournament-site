// Pluggable sport definitions. `matchModel` tells the UI/engine how a single
// match is scored:
//   "winner" -> admin just picks a winner (today's behavior)
//   "games"  -> best-of-N games, each to a target score (badminton, table tennis)
//   "sets"   -> best-of-N sets of games with tiebreaks (tennis) — design only
//   "score"  -> free-form score with a points table + tiebreak rules (football, cricket) — design only
//
// Only "generic" and "badminton" are wired into the UI/engine this round.
// The others are stubbed with `implemented: false` so the shape is ready —
// see README.md "Sport conventions" for the rules each would need.

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
    label: "Table Tennis (coming soon)",
    matchModel: "games",
    supportsGroups: true,
    implemented: false,
    gameConfig: { pointsToWin: 11, winBy: 2, cap: null, bestOf: 5 },
    pointsRule: { win: 1, loss: 0 },
  },
  tennis: {
    id: "tennis",
    label: "Tennis (coming soon)",
    matchModel: "sets",
    supportsGroups: true,
    implemented: false,
  },
  football: {
    id: "football",
    label: "Football (coming soon)",
    matchModel: "score",
    supportsGroups: true,
    implemented: false,
    pointsRule: { win: 3, draw: 1, loss: 0 },
  },
  cricket: {
    id: "cricket",
    label: "Cricket (coming soon)",
    matchModel: "score",
    supportsGroups: true,
    implemented: false,
    pointsRule: { win: 2, tie: 1, loss: 0 },
  },
};

export function getSport(id) {
  return SPORTS[id] || SPORTS.generic;
}

export function listSelectableSports() {
  return Object.values(SPORTS);
}
