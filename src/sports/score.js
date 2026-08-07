// Final-score match model with draws (football, cricket). A match's score
// is { a: number, b: number } — goals, runs, whatever the sport counts.
// Unlike the "games" model (badminton/TT/volleyball) or "winner" model
// (generic), a level score is a legitimate final result in a group/league
// match — draws are first-class here, which is why this is a separate
// module rather than reusing badminton.js's win-or-else logic.

export function isValidScore(score) {
  const a = Number(score?.a), b = Number(score?.b);
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0;
}

// "a" | "b" | "draw" | null (null = not entered / invalid).
export function resultFromScore(score) {
  if (!isValidScore(score)) return null;
  const a = Number(score.a), b = Number(score.b);
  if (a > b) return "a";
  if (b > a) return "b";
  return "draw";
}

export function scoreDiff(score) {
  if (!isValidScore(score)) return { a: 0, b: 0 };
  return { a: Number(score.a), b: Number(score.b) };
}
