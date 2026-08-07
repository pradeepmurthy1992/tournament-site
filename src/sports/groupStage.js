// Sport-agnostic round-robin group engine: splits entrants into groups,
// schedules a round robin within each group (circle method), and computes a
// standings table with a standard tiebreak chain. Works for any match model
// as long as completed matches carry a `winnerId` — callers (e.g. the
// badminton game-score UI) are responsible for deriving that winnerId from
// their sport-specific scoring.

const uid = () => Math.random().toString(36).slice(2, 9);

// Deals teamIds into `numGroups` groups round-robin style, so groups stay
// balanced in size regardless of entrant count.
export function splitIntoGroups(teamIds, numGroups) {
  const groups = Array.from({ length: numGroups }, () => []);
  teamIds.forEach((id, i) => groups[i % numGroups].push(id));
  return groups;
}

// Circle method: fixes one team, rotates the rest. Returns rounds, each an
// array of [aId, bId] pairs; a null in a pair means the other side has a bye.
export function generateRoundRobinPairs(teamIds) {
  const ids = teamIds.slice();
  if (ids.length % 2 !== 0) ids.push(null); // bye slot
  const n = ids.length;
  const rounds = [];
  const fixed = ids[0];
  let rest = ids.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const arranged = [fixed, ...rest];
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arranged[i], b = arranged[n - 1 - i];
      if (a != null && b != null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    rest = [rest[rest.length - 1], ...rest.slice(0, rest.length - 1)]; // rotate
  }
  return rounds;
}

// Builds match objects (stage: "group") for one group, ready to append to a
// tournament's `matches` array.
export function buildGroupMatches(groupId, teamIds) {
  const rounds = generateRoundRobinPairs(teamIds);
  const matches = [];
  rounds.forEach((pairs, roundIdx) => {
    for (const [aId, bId] of pairs) {
      matches.push({
        id: uid(),
        stage: "group",
        groupId,
        round: roundIdx + 1,
        aId,
        bId,
        status: "Scheduled",
        winnerId: null,
        games: [],
      });
    }
  });
  return matches;
}

// matches: all matches for one group. getDiff(match) -> {a,b} points/games
// scored by side A/B, used only as a tiebreaker (optional). A match with
// `drawn: true` (score/result-model sports — football, cricket, chess)
// counts as decided with no winner: both sides get pointsRule.draw.
export function computeStandings(teamIds, matches, { pointsRule = { win: 1, loss: 0, draw: 0 }, getDiff } = {}) {
  const table = new Map(teamIds.map((id) => [id, {
    teamId: id, played: 0, won: 0, drawn: 0, lost: 0, points: 0, diffFor: 0, diffAgainst: 0,
  }]));

  const headToHead = new Map(); // `${winnerId}:${loserId}` -> true

  for (const m of matches) {
    if (!m.aId || !m.bId) continue; // bye
    if (!m.winnerId && !m.drawn) continue; // not played yet

    if (m.drawn) {
      const a = table.get(m.aId), b = table.get(m.bId);
      if (!a || !b) continue;
      a.played++; b.played++;
      a.drawn++; b.drawn++;
      a.points += pointsRule.draw ?? 0; b.points += pointsRule.draw ?? 0;
      if (typeof getDiff === "function") {
        const d = getDiff(m) || { a: 0, b: 0 };
        a.diffFor += d.a; a.diffAgainst += d.b;
        b.diffFor += d.b; b.diffAgainst += d.a;
      }
      continue;
    }

    const loserId = m.winnerId === m.aId ? m.bId : m.aId;
    const w = table.get(m.winnerId), l = table.get(loserId);
    if (!w || !l) continue;
    w.played++; l.played++;
    w.won++; l.lost++;
    w.points += pointsRule.win ?? 1;
    l.points += pointsRule.loss ?? 0;
    headToHead.set(`${m.winnerId}:${loserId}`, true);

    if (typeof getDiff === "function") {
      const d = getDiff(m) || { a: 0, b: 0 };
      const [forW, forL] = m.winnerId === m.aId ? [d.a, d.b] : [d.b, d.a];
      w.diffFor += forW; w.diffAgainst += forL;
      l.diffFor += forL; l.diffAgainst += forW;
    }
  }

  const rows = Array.from(table.values()).map((r) => ({ ...r, diff: r.diffFor - r.diffAgainst }));

  rows.sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    // two-way head-to-head tiebreak
    if (headToHead.get(`${x.teamId}:${y.teamId}`)) return -1;
    if (headToHead.get(`${y.teamId}:${x.teamId}`)) return 1;
    if (y.diff !== x.diff) return y.diff - x.diff;
    return 0;
  });

  return rows;
}

export function isGroupComplete(matches) {
  return matches.every((m) => (!m.aId || !m.bId) || !!m.winnerId || !!m.drawn);
}

export function topNTeamIds(standings, n) {
  return standings.slice(0, n).map((r) => r.teamId);
}
