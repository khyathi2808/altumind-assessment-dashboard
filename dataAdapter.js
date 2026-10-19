/**
 * dataAdapter.js — talks to the backend and returns {rubrics, responses, sessions, scores}
 * in the shape analysis.js expects. This is the one file that's specific to "an Apps
 * Script backend shaped like Code.gs" — swap it out (keeping the same return shape) to
 * point this dashboard at a different kind of backend entirely.
 *
 * Backend contract this adapter assumes (matches Code.gs's doGet):
 *   GET {endpoint}?action=rubrics&key={adminKey}      -> { ok, rubrics: {...} }
 *   GET {endpoint}?action=review_data&key={adminKey}  -> { ok, responses: [...], sessions: [...], scores: [...] }
 * Both responses are the row-objects-per-sheet-tab shape Code.gs's sheetToObjects()
 * produces: one object per row, keyed by column header.
 */

export class ApiError extends Error {}

/* ---------- Direct-from-Google-Sheet mode (no Apps Script deployment needed) ----------
 * Reads the Responses, Sessions and Scores tabs straight from the sheet as CSV, and the
 * rubric/answer key from local/rubrics.json (git-ignored, generated from rubrics.gs).
 * Requires the sheet to be readable by link. Same {rubrics, responses, sessions, scores}
 * return shape as fetchAssessmentData, so analysis.js doesn't know the difference. */

export function isSheetUrl(s) { return /docs\.google\.com\/spreadsheets\/d\/[\w-]+/.test(String(s || "")); }

/** Optional local/settings.json ({sheetUrl}) pre-fills the connect screen. Git-ignored. */
export async function loadLocalSettings() {
  try { const res = await fetch("local/settings.json", { cache: "no-store" }); return res.ok ? await res.json() : {}; }
  catch (e) { return {}; }
}

export async function fetchFromSheet(sheetUrl) {
  const id = (String(sheetUrl).match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1];
  if (!id) throw new ApiError("That doesn't look like a Google Sheets link.");
  const [rubrics, responses, sessions, scores] = await Promise.all([
    fetchRubrics(),
    fetchTab(id, "Responses"),
    fetchTab(id, "Sessions"),
    fetchTab(id, "Scores", true)
  ]);
  return { rubrics, responses, sessions, scores };
}

async function fetchRubrics() {
  let res;
  try { res = await fetch("local/rubrics.json", { cache: "no-store" }); } catch (e) { res = null; }
  if (!res || !res.ok) throw new ApiError("local/rubrics.json is missing. It holds the answer key and is kept out of git; regenerate it from rubrics.gs.");
  return res.json();
}

async function fetchTab(id, tab, optional) {
  const url = "https://docs.google.com/spreadsheets/d/" + id + "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(tab) + "&_=" + Date.now();
  let res;
  try { res = await fetch(url); } catch (e) {
    throw new ApiError("Could not read the sheet. Check the link, and that the sheet is shared as \"Anyone with the link can view\".");
  }
  if (!res.ok) throw new ApiError("The sheet answered " + res.status + " for the " + tab + " tab. Is it shared by link?");
  const rows = parseCsv(await res.text());
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  // gviz falls back to the first tab when a tab name doesn't exist; detect that by its headers.
  if (tab === "Scores" && !headers.includes("Reviewer")) { if (optional) return []; throw new ApiError("No Scores tab yet."); }
  if (tab === "Sessions" && !headers.includes("Status")) throw new ApiError("The sheet has no Sessions tab.");
  if (tab === "Responses" && !headers.includes("Question ID")) throw new ApiError("The sheet has no Responses tab.");
  return rows.slice(1).filter(r => r.some(v => v !== "")).map(r => {
    const o = {}; headers.forEach((h, i) => { o[h] = r[i] == null ? "" : r[i]; }); return o;
  });
}

/** RFC 4180 CSV parser: quoted fields, doubled quotes, and newlines inside quotes (written answers have them). */
export function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export async function fetchAssessmentData(endpoint, adminKey) {
  const [rub, rd] = await Promise.all([
    apiGet(endpoint, adminKey, "rubrics"),
    apiGet(endpoint, adminKey, "review_data")
  ]);
  return {
    rubrics: rub.rubrics,
    responses: rd.responses || [],
    sessions: rd.sessions || [],
    scores: rd.scores || []
  };
}

async function apiGet(endpoint, adminKey, action) {
  const url = endpoint + (endpoint.includes("?") ? "&" : "?") + "action=" + encodeURIComponent(action) + "&key=" + encodeURIComponent(adminKey);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new ApiError("Could not reach the backend. Check the Web App URL and your connection.");
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new ApiError("The backend answered but not with JSON. Check that it's an Apps Script Web App deployed with \"Anyone\" access, and that it has the dashboard endpoints (rubrics, review_data).");
  }
  if (!data.ok) throw new ApiError(data.error === "Invalid key" ? "That admin key was not accepted by the backend." : data.error || "Request failed");
  return data;
}
