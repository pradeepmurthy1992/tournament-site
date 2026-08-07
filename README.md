# FixtureForge

Multi-sport tournament maker: knockout brackets, round-robin groups, seeding,
live fixtures/standings, and PDF/Excel export. React + Vite frontend on
GitHub Pages; Supabase (Postgres + Auth + Row-Level Security) for accounts,
data, and per-organizer isolation.

**v2 note:** this replaced the earlier JSONBin + Vercel-proxy + shared
access-code setup entirely. If you were mid-way through that runbook, stop —
none of it applies anymore. See "Supersedes" in the project's plan history
if you want the full reasoning.

## Local development

```bash
npm install
npm run dev
```

You need a Supabase project even for local dev — there's no more
"just read a public bin" mode, since tournament data is now scoped per
signed-in user via Row-Level Security. See "One-time backend setup" below;
it takes about 5 minutes and the free tier is enough for this app's scale.

## Architecture

- **Frontend** (`src/`) — deployed to GitHub Pages via
  `.github/workflows/deploy.yml` on every push to `main`. Same URL as
  before.
- **Backend** — entirely Supabase, no custom server code:
  - **Auth** (`src/auth/`) — Supabase Auth (email/password). Every sign-up
    auto-creates a `profiles` row (`role: "user"`, `tier: "free"`) via a
    database trigger — see `supabase/migrations/0001_init.sql`.
  - **Data** (`src/db.js`) — the `tournaments` table, one row per
    tournament. Row-Level Security policies mean a normal user's
    queries only ever reach their own rows; the super admin's reach
    everyone's. This is enforced by Postgres itself, not application code.
  - **Tier limits** — a database trigger (`enforce_tier_limits`) rejects
    any insert/update that puts a free-tier tournament over 8 participants,
    or gives it more than one round-robin group, or adds a knockout stage.
    The UI also hides those options for free-tier users, but the trigger is
    the actual enforcement — it can't be bypassed by editing client code.

## One-time backend setup

1. **Create a Supabase project.** supabase.com → sign up → New Project.
   Free tier is fine. Note the project's URL and **anon** key
   (Settings → API) — unlike the old JSONBin master key, the anon key is
   *safe* to put in client code, because Row-Level Security (not key
   secrecy) is what actually protects the data.
2. **Apply the schema.** Open the Supabase SQL Editor and run the contents
   of `supabase/migrations/0001_init.sql` once.
3. **Point the app at your project.** Edit `src/config.js`:
   ```js
   export const SUPABASE_URL = "https://your-project.supabase.co";
   export const SUPABASE_ANON_KEY = "your-anon-key";
   ```
   Commit and push — GitHub Pages redeploys the frontend automatically.
4. **Sign up as yourself** in the running app (Dashboard tab → Sign Up).
   This creates your `profiles` row.
5. **Bootstrap yourself as super admin.** There's no self-serve promotion
   (deliberately — see the migration file). In the Supabase SQL Editor:
   ```sql
   update public.profiles set role = 'super_admin' where email = 'you@example.com';
   ```
   Refresh the app — you'll now see the Admin tab.
6. **(Optional) Migrate the old live tournament data.** If you had
   tournaments in the old JSONBin store, run
   `scripts/migrate-jsonbin-to-supabase.mjs` once — see the comment at the
   top of that file for exact usage. It needs your Supabase **service
   role** key (different from the anon key, never used in the browser) as
   an environment variable, passed on the command line — never commit it.

## Roles & tiers

- **Free** (default for every new sign-up): one round-robin group, up to
  8 participants, no knockout bracket.
- **Paid**: unlimited participants, any format (knockout, or groups with a
  knockout stage after).
- **Super admin**: exactly one account (you, bootstrapped in step 5 above).
  Sees every organizer's tournaments and users from the **Admin** tab
  (read/oversight — the normal Schedule/Fixtures/etc. tabs still only ever
  show *your own* tournaments, even for the super admin, so day-to-day use
  looks the same as any other account). Can grant or revoke paid tier for
  any user from that same tab.

**To grant paid access:** get paid however you like (this app has no
payment integration) → open the **Admin** tab → find the user → click
**Grant Paid**. To revoke, click **Revoke to Free** on the same row.

**On isolation:** one organizer's tournament data is invisible to another
organizer by construction — every query is filtered by Postgres
Row-Level-Security policies (`owner_id = auth.uid()`), not by anything the
client asks nicely for. This is access control, not encryption — the
super-admin bypass (`is_super_admin()`) is a deliberate, narrow exception
built into the same policies, not a separate backdoor.

## Roadmap (not built yet)

These were scoped out of this round so each phase ships as something
actually testable, rather than one huge unreviewable change:

- **Public registration links** — a shareable per-tournament link with a
  deadline; anyone can self-register (no account needed) up to that
  deadline; the organizer approves/rejects and can add or remove
  participants at any time regardless of the deadline.
- **Email notifications** — participants get emailed when fixtures are
  generated or change. Needs a Supabase Edge Function (to hold a Resend
  API key server-side) triggered on tournament updates.
- **Public live spectator view** — a read-only link, no login, that
  updates live via Supabase Realtime instead of on refresh. The "Explore"
  tab is a placeholder for this today.

## Sport engine

### Squad type (singles/doubles/team size) and rosters

An "entrant" in the bracket is always just one thing — one name that wins
or loses — regardless of whether it represents one player or an eleven-a-side
football team. Each sport in `src/sports/registry.js` lists its
`squadFormats` (e.g. badminton: Singles/Doubles; football: 5/7/9/11-a-side;
volleyball: Indoor 6/Beach 2; cricket: 11-a-side/8-a-side; chess: Individual
only). When a sport has more than one option, a **Squad type** dropdown
appears in Setup.

For any squad type bigger than 1, the bulk-entry box switches from
"one player per line" to **"one team per line: `Team Name: Player 1, Player
2, ...`"** — the part before the first colon becomes the entrant's display
name, everything after (comma-separated) becomes its roster. A line with no
colon still works, it just has no roster attached. Roster is pure display
metadata (shown as small subtext under the name in Fixtures/Standings) —
the bracket, scoring, and standings engines never look at it, so this
required no changes to `groupStage.js` or any `matchModel`. File upload
(CSV/XLSX) doesn't support a roster column yet — uploaded entrants get an
empty roster; use the text box for teams whose members you want recorded.

### Match models

Tournaments carry a `sport` id (`src/sports/registry.js`) and a `format`
(`"knockout"` or `"groups"`). Existing tournaments with no `sport`/`format`
field default to `sport: "generic"`, `format: "knockout"` — the original
pick-a-winner single-elimination behavior, unchanged. Every sport plugs
into the same knockout bracket engine and the same round-robin group
engine (`src/sports/groupStage.js`) — only how a single *match* is scored
differs, via one of four `matchModel`s:

- **`"winner"`** — admin just picks a winner. `generic`, the original
  behavior.
- **`"games"`** — best-of-N games to a target score
  (`src/sports/badminton.js`, shared despite the filename). Winner is
  derived automatically once a side wins enough games.
  - `badminton` — best-of-3 to 21, win by 2, capped at 30.
  - `tabletennis` — best-of-5 to 11, win by 2, no cap.
  - `volleyball` — best-of-5 to 25, win by 2; the deciding 5th set (if
    reached) only goes to 15 — `gameConfig.deciderPointsToWin` tells
    `badminton.js` to switch targets on the last possible game.
- **`"score"`** — a final score per side (`src/sports/score.js`), draws
  allowed. Used for `football` (3/1/0 points, goal-difference tiebreak)
  and `cricket` (2/1/0, run-difference tiebreak — see note below). In the
  **group/league stage** a level score is a legitimate final result; in
  the **knockout stage** it isn't enough on its own — the UI additionally
  requires an explicit winner pick (standing in for extra time / a
  penalty shootout / a Super Over, none of which are modeled play-by-play
  here, just the final outcome).
- **`"result"`** — win/draw/loss picked directly, no score or games. Used
  for `chess` (win = 1 point, draw = 0.5, loss = 0).

**Cricket tiebreak note:** real cricket ranks tied group-stage teams by
Net Run Rate, which needs overs-faced/overs-bowled per innings, not just
a runs total. That's not modeled here — cricket currently uses simple run
difference instead, which is disclosed in the registry rather than
mislabeled as true NRR. Good enough for a small club/office group stage;
would need real overs tracking to be tournament-grade.

**Designed but not yet built:**
- **Tennis** (`implemented: false`) — seeded single-elim draw (reuses the
  existing bracket engine as-is), but each match is best-of-3/5 *sets*,
  and each set is first-to-6 *games* win-by-2 with a tiebreak at 6-6.
  Needs a new `matchModel: "sets"` (a set is itself a mini best-of-N-games
  contest) — structurally different enough from the `"games"` model above
  that it wasn't worth forcing into the same shape.
- **Swiss-system pairing for chess** — the usual format for large chess
  fields (pair players with similar scores each round, never repeat a
  pairing). Chess today runs correctly via the existing round-robin and
  knockout formats (fine for club-sized fields), but Swiss is a genuinely
  different *scheduling* algorithm — dynamic, generated round-by-round
  from live standings, rather than computed once upfront — and wasn't
  built this round.
- **More sports generally** — the whole point of the `matchModel` split
  above is that adding another sport is usually just a new
  `src/sports/registry.js` entry (pick the closest existing `matchModel`
  and supply its config) rather than new engine code. Kabaddi, basketball,
  etc. would mostly slot in the same way volleyball did.
