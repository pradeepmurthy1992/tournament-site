// Game-score validation and winner derivation for "games"-model sports:
// badminton, table tennis, and volleyball all share this shape (best-of-N
// games, each with a points target). A game is { a: number, b: number } —
// raw points for side A/B.
//
// gameConfig: { pointsToWin, winBy, cap, bestOf, deciderPointsToWin?,
// deciderWinBy?, deciderCap? }. The decider* fields are optional and only
// matter for sports like volleyball where the final (deciding) game plays
// to a different target than the rest (e.g. sets 1-4 to 25, set 5 to 15).

function effectiveConfig(gameConfig, gameIndex) {
  const { bestOf, deciderPointsToWin } = gameConfig;
  const isDecider = gameIndex === bestOf - 1;
  if (isDecider && deciderPointsToWin != null) {
    return {
      pointsToWin: deciderPointsToWin,
      winBy: gameConfig.deciderWinBy ?? gameConfig.winBy,
      cap: gameConfig.deciderCap ?? null,
    };
  }
  return gameConfig;
}

export function isValidGame(game, gameConfig, gameIndex = 0) {
  const { pointsToWin, winBy, cap } = effectiveConfig(gameConfig, gameIndex);
  const a = Number(game?.a), b = Number(game?.b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return false;
  if (a === b) return false;
  const hi = Math.max(a, b);
  if (cap != null && hi > cap) return false;
  if (cap != null && hi === cap) return true; // capped game: win by any margin at the cap
  return hi >= pointsToWin && Math.abs(a - b) >= winBy;
}

export function gameWinnerSide(game) {
  if (!game) return null;
  const a = Number(game.a), b = Number(game.b);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return a > b ? "a" : "b";
}

// games: array of {a,b}. Returns "a" | "b" | null (null = match not yet decided).
export function matchWinnerSideFromGames(games, bestOf) {
  const needed = Math.ceil(bestOf / 2);
  let aWins = 0, bWins = 0;
  for (const g of games || []) {
    const side = gameWinnerSide(g);
    if (side === "a") aWins++;
    else if (side === "b") bWins++;
    if (aWins >= needed || bWins >= needed) break;
  }
  if (aWins >= needed) return "a";
  if (bWins >= needed) return "b";
  return null;
}

export function isMatchComplete(games, bestOf) {
  return matchWinnerSideFromGames(games, bestOf) !== null;
}

// Total points won/lost across all games played so far — used for group-stage
// point-differential tiebreaks.
export function pointsDiffFromGames(games) {
  let a = 0, b = 0;
  for (const g of games || []) { a += Number(g.a) || 0; b += Number(g.b) || 0; }
  return { a, b };
}
