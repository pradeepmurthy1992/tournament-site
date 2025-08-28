// Vercel Serverless Function: /api/tournaments
// Reads/writes a JSON snapshot in a GitHub repo using the Contents API.
// Methods:
//  - GET  -> read tournaments JSON
//  - POST -> write tournaments JSON (full snapshot)
//
// Env vars to set in Vercel dashboard (Project Settings -> Environment Variables):
//  - GITHUB_TOKEN   (fine-grained PAT with 'Contents: Read & Write' on target repo)
//  - GITHUB_REPO    (e.g. "myuser/tournament-site-data")
//  - GITHUB_BRANCH  (e.g. "main")
//  - GITHUB_FILE    (e.g. "data/tournaments.json")

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*"); // or set your domain
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH, GITHUB_FILE } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_BRANCH || !GITHUB_FILE) {
    return res
      .status(500)
      .json({ error: "Missing env vars: GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH, GITHUB_FILE" });
  }

  const baseUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(
    GITHUB_FILE
  )}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  try {
    if (req.method === "GET") {
      // Read file (if exists)
      const r = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      });
      if (r.status === 404) {
        // file not found -> return an empty snapshot
        return res.status(200).json({ tournaments: [], deleted: [], updatedAt: Date.now() });
      }
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: "GitHub read failed", detail: t });
      }
      const data = await r.json(); // { content, sha, ...}
      const raw = Buffer.from(data.content, "base64").toString("utf8");
      try {
        const json = JSON.parse(raw);
        return res.status(200).json(json);
      } catch {
        // corrupted or not JSON
        return res.status(200).json({ tournaments: [], deleted: [], updatedAt: Date.now() });
      }
    }

    if (req.method === "POST") {
      // Expect full snapshot body { tournaments:[], deleted:[] }
      const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
      const snapshot = {
        tournaments: Array.isArray(body.tournaments) ? body.tournaments : [],
        deleted: Array.isArray(body.deleted) ? body.deleted : [],
        updatedAt: Date.now(),
      };
      const content = Buffer.from(JSON.stringify(snapshot, null, 2), "utf8").toString("base64");

      // 1) Get current SHA (if file exists) to avoid conflicts
      let sha = undefined;
      const head = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      });
      if (head.ok) {
        const json = await head.json();
        sha = json.sha;
      } else if (head.status !== 404) {
        const t = await head.text();
        return res.status(head.status).json({ error: "GitHub HEAD failed", detail: t });
      }

      // 2) Write (create/update)
      const putUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(
        GITHUB_FILE
      )}`;
      const commitMessage = `chore(data): update tournaments.json at ${new Date().toISOString()}`;
      const put = await fetch(putUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: commitMessage,
          content,
          branch: GITHUB_BRANCH,
          sha, // include only if file exists
        }),
      });

      if (!put.ok) {
        const t = await put.text();
        return res.status(put.status).json({ error: "GitHub write failed", detail: t });
      }
      return res.status(200).json({ ok: true, updatedAt: snapshot.updatedAt });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "API error", detail: String(e?.message || e) });
  }
}
