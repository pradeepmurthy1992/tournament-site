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

Tournaments carry a `sport` id (`src/sports/registry.js`) and a `format`
(`"knockout"` or `"groups"`). Existing tournaments with no `sport`/`format`
field default to `sport: "generic"`, `format: "knockout"` — the original
pick-a-winner single-elimination behavior, unchanged.

**Implemented:**
- `generic` — pick a winner per match (original behavior).
- `badminton` — best-of-3 games to 21 points, win by 2, hard cap at 30
  (`src/sports/badminton.js`). Winner is derived automatically once a side
  wins 2 games.
- Round-robin groups (`src/sports/groupStage.js`) — sport-agnostic: splits
  entrants into groups, schedules a round robin (circle method), and
  computes a standings table (Played/Won/Lost/Points, tiebreak by
  head-to-head then point differential). Works with any sport whose matches
  end up with a `winnerId`. "Generate Knockout Bracket" seeds the top N per
  group into the existing knockout engine once every group is complete
  (paid tier only — free tier stops at the round-robin stage).

**Designed but not yet built** (`implemented: false` in the registry —
extend `sports/` following the `badminton.js` pattern):
- **Table tennis** — same shape as badminton: best-of-5/7 games to 11,
  win by 2 (no hard cap). Reuses the whole `games` match model.
- **Tennis** — seeded single-elim draw (reuses the existing bracket engine
  as-is), but each match is best-of-3/5 *sets*, and each set is first-to-6
  *games* win-by-2 with a tiebreak at 6-6. Needs a new `matchModel: "sets"`
  (a set is itself a mini best-of-N-games contest).
- **Football** — group stage = round robin, 3/1/0 points for win/draw/loss,
  tiebreak by goal difference then goals-for then head-to-head; knockout =
  single match, extra time + penalties on a draw. Needs a `matchModel:
  "score"` (free-form goals-for-each-side, draws allowed) and points-table
  support for draws (the current `groupStage.js` assumes every match has a
  clear winner).
- **Cricket** — league table, 2 points per win (0 for a loss, tie rules
  vary by competition), Net Run Rate as the primary tiebreaker instead of
  point/game differential; tied knockout matches go to a Super Over. Also
  needs the `"score"` match model plus an NRR calculator (runs/overs per
  side, not just a point total).
