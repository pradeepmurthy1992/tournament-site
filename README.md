# FixtureForge

Multi-sport tournament maker: knockout brackets, round-robin groups, seeding,
live fixtures/standings, and PDF/Excel export. React + Vite frontend on
GitHub Pages; a small serverless API on Vercel handles admin auth and writes.

## Local development

```bash
npm install
npm run dev
```

The frontend reads tournament data directly from JSONBin (public read, no
key needed). To test admin actions (login, save, score entry) locally,
point `src/db.js`'s `BIN_ID` at a **throwaway/staging** JSONBin bin — never
the production one — and run a local copy of the API (`vercel dev`, or just
stub `adminLogin`/`saveStore` while iterating on UI).

## Architecture

- **Frontend** (`src/`) — deployed to GitHub Pages via `.github/workflows/deploy.yml`
  on every push to `main`. Same URL as today.
- **API** (`api/`) — two serverless functions, deployed separately to Vercel
  (Vercel auto-detects the `api/` folder; GitHub Pages ignores it):
  - `POST /api/admin-login` — exchanges an access code for a signed session token.
  - `POST /api/tournaments` — writes the tournament snapshot to JSONBin;
    requires a valid admin token. Reads bypass this and hit JSONBin directly
    (it's a public-read bin, so no secret is needed for reads).
- **Data store** — JSONBin (`src/db.js`). One shared bin for the whole site.

## One-time deploy setup

1. **Rotate the JSONBin key.** The old master key was committed to this repo
   and is public — log into jsonbin.io → your bin → regenerate the Master
   Key. Never put the new key in a file; it only goes into Vercel env vars
   (step 3).
2. **Create the Vercel project.** vercel.com → "Add New… → Project" → import
   this GitHub repo. Vercel will build it automatically; you can ignore the
   `*.vercel.app` URL it gives the frontend — we only use its `/api/*` routes.
3. **Set environment variables** in Vercel (Project Settings → Environment
   Variables):
   | Variable | Value |
   |---|---|
   | `JSONBIN_BIN_ID` | the bin ID (currently `68b15f2fd0ea881f4069feab`) |
   | `JSONBIN_MASTER_KEY` | the **new**, rotated master key from step 1 |
   | `ADMIN_CODES` | `code1:Alice,code2:Bob` — see "Admin access" below |
   | `SESSION_SECRET` | any long random string (e.g. `openssl rand -hex 32`) |

   Redeploy after setting these (Vercel does this automatically on save, or
   click "Redeploy").
4. **Point the frontend at your Vercel API.** Edit `src/config.js`:
   ```js
   export const API_BASE = "https://your-project.vercel.app";
   ```
   Commit and push — GitHub Pages redeploys the frontend automatically.

## Admin access (multi-user, paid)

There's no per-customer database — admin access is a shared list of named
access codes, checked server-side. This is intentionally lightweight: every
admin code can manage the *same* site's tournaments (there's one JSONBin per
deployment), there's no password reset flow, and the only audit trail is the
display name shown next to "Logged in as:".

**To sell/grant a new admin seat:**
1. Get paid however you like (UPI, cash, bank transfer — no payment
   integration here).
2. Pick a new unique code, e.g. `aug2026-priya`.
3. Add `,aug2026-priya:Priya` to the `ADMIN_CODES` env var in Vercel.
4. Redeploy (one click).
5. Share the code with them — they enter it under "Admin Login".

**To revoke access:** remove their `code:Name` pair from `ADMIN_CODES` and
redeploy. Any session tokens already issued to them still work until they
expire (12h) — for immediate revocation, rotate `SESSION_SECRET` (this logs
*everyone* out, including other current admins).

If you outgrow this (want truly separate tournaments per paying customer,
real password reset, audit logs, or actual Stripe billing), that needs a
real database + auth provider (e.g. Supabase) — a bigger rebuild than this
round covered.

## Sport engine

Tournaments carry a `sport` id (`src/sports/registry.js`) and a `format`
(`"knockout"` or `"groups"`). Existing tournaments with no `sport`/`format`
field default to `sport: "generic"`, `format: "knockout"` — today's
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
  group into the existing knockout engine once every group is complete.

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
