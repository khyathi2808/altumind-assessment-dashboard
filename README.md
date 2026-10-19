# Assessment Analytics Dashboard

A static, no-build-step dashboard that turns assessment data (candidates, scores, sessions)
into charts and a sortable leaderboard. It's a separate tool from a per-candidate review
dashboard like `review.html` — this one is for the aggregate, stakeholder-facing view
("how is the overall pool doing, where are the weak items, who's shortlist-ready"), not for
scoring individual answers.

**It is just HTML/CSS/JS.** No npm, no build, no server — open `index.html` locally, or push
this folder to GitHub and turn on Pages, and that's the whole deployment.

## How it works

1. You open the page and paste in your backend's Web App URL and admin key (once per
   browser — see **Security** below).
2. The page fetches your rubric and response data directly from your backend, in your
   browser.
3. Everything else — scoring, aggregation, charts, the leaderboard — happens client-side.

There is no database, no backend of its own, and nothing is ever sent anywhere except your
own assessment backend.

## File structure

```
index.html        page shell, connect screen, chart/table containers
style.css         all styling (light/dark aware, responsive)
app.js            DOM wiring: connect flow, chart rendering, leaderboard — the only file
                  that touches the page
analysis.js       pure scoring engine: (rubrics, responses, sessions, scores, config) in,
                  {candidates, itemStats, summary} out. No DOM, no fetch.
dataAdapter.js    talks to the backend and returns data in the shape analysis.js expects
config.js         weights, gates, labels, excluded-email rules — edit this to retune
                  scoring or adapt to a different assessment
```

That split is what makes it reusable:

- **Using this for a different cohort of the *same* assessment?** Nothing to change —
  just a different Web App URL and admin key at connect time.
- **Retuning pass/fail thresholds or section weights?** Edit `config.js` only.
- **Pointing this at a genuinely different assessment** (different rubric structure,
  different backend)? Edit `dataAdapter.js` to fetch and reshape your data, and/or
  `config.js` for labels/weights. `analysis.js` and `app.js` don't need to change as long
  as `dataAdapter.js` still returns `{rubrics, responses, sessions, scores}` in the shape
  described below.

## Data contract

`analysis.js` expects:

- **`rubrics`** — `{ items: { [questionId]: {...} }, roles, competencies, dimensions }`.
  Each item needs at least `id`, `kind` (`"mcq"` or `"subjective"`), `section`
  (`"quant"` / `"comm"` / `"beh"`), and for MCQs a `key` (the correct option text).
  This dashboard assumes the same three-section model (quantitative / communication /
  behavioral) as the assessment it was built for — if your rubric uses different section
  names, update `config.js`'s `sectionLabels` and the `section ===` checks in
  `analysis.js`.
- **`responses`** — one row per answer: `Candidate Email`, `Candidate Name`, `Session`,
  `Question ID`, `Answer Text`, `Selected Option`, `Video Link`, `Time Spent (sec)`.
- **`sessions`** — one row per session start/end event: `Candidate Email`, `Session`,
  `Status`, `Timestamp`, `Roles Selected`.
- **`scores`** — one row per reviewer score: `Candidate Email`, `Question ID`, `Reviewer`,
  `Score`, `Timestamp`. Reviewer name `"AI"` is treated as a fallback — a human score for
  the same item always wins.

`dataAdapter.js` as shipped expects a backend with two GET actions,
`?action=rubrics&key=...` and `?action=review_data&key=...`, returning exactly that shape —
which is what the paired Apps Script backend (`Code.gs`) already provides. Point it at a
different backend by rewriting `fetchAssessmentData()` to call whatever API you have and
return the same four fields.

## Deploying to GitHub Pages

1. Create a new (can be private) GitHub repository and push this folder's contents to it:
   ```bash
   git init
   git add .
   git commit -m "Assessment analytics dashboard"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch →
   Branch: `main` / `(root)` → Save**.
3. GitHub gives you a URL like `https://<you>.github.io/<repo>/` within a minute or two.
   Open it, paste in your Web App URL and admin key, and you're looking at your dashboard.
4. Share that same URL with anyone who should see it — they'll each need the admin key too
   (see **Security**), but nothing else to install.

No GitHub Actions, no build step, no `gh-pages` branch needed — Pages serves the repo
directly.

## Security — the admin key

This repo can be public (there's nothing secret in the code), but **the admin key is
secret** — it's the same key that gates write access to your assessment's scores. This
dashboard:

- Never contains the key in any file you commit.
- Only asks for it in the browser, at connect time.
- Stores it in `sessionStorage` (clears when the tab closes), not `localStorage` — so it
  doesn't sit on disk indefinitely on a shared machine. If you're the only one using your
  own browser and want it to persist across sessions, that's a one-line change in `app.js`
  (`sessionStorage` → `localStorage`), but understand the trade-off before you make it.
- Sends the key only to the backend URL you typed in, in a request your own browser makes
  directly — it never passes through any third-party server.

Whoever you give the dashboard link to still needs the admin key separately. Treat sharing
the link the same way you'd treat sharing the key itself.

## Local development

No build step — just serve the folder so ES module imports work (opening `index.html`
directly via `file://` will fail on the `import` statements in most browsers):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## What's deliberately not in here

This dashboard intentionally does **not** duplicate `review.html`'s per-candidate integrity
checks (near-duplicate answer detection across candidates, typing-speed flags, session
geolocation distance). Those are reviewer-workflow tools, not aggregate stats — adding them
here would mean maintaining the same logic in two places. If you want them surfaced here
too, port the relevant functions from `review.html`'s `computeFlags()` into `analysis.js`
the same way the rest of this engine was ported.
