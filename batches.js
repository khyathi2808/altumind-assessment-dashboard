/**
 * batches.js — splits the sheet into assessment batches (cohorts) by date, so each batch can
 * be analysed on its own. Pure: no DOM, no fetch.
 *
 * Each candidate belongs to the batch of the moment they FIRST appear in the sheet (their
 * earliest Sessions or Responses timestamp), so someone who finishes Session 2 the next day
 * stays with their batch. Batches are found automatically: sorted by first activity, a new
 * batch starts wherever there's a gap longer than config.batchGapDays. A cluster smaller than
 * config.pilotMaxCandidates is labelled "Pilot" and isn't numbered, so a small trial run
 * doesn't become "Batch 1". config.batches, when non-empty, replaces the automatic split.
 */
import { isExcludedEmail } from "./analysis.js";

const DAY = 86400000;
const tsOf = v => { const t = Date.parse(v); return isNaN(t) ? null : t; };
const fmtDay = (t, withYear) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });

function dateRange(start, end) {
  const s = new Date(start), e = new Date(end);
  if (s.toDateString() === e.toDateString()) return fmtDay(start, true);
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) return s.getDate() + "–" + fmtDay(end, true);
  return fmtDay(start, s.getFullYear() !== e.getFullYear()) + " – " + fmtDay(end, true);
}

/** Earliest timestamp per real (non-excluded) candidate email, from Sessions and Responses. */
function firstActivity(responses, sessions, config) {
  const first = new Map();
  [sessions, responses].forEach(rows => rows.forEach(r => {
    const email = String(r["Candidate Email"] == null ? "" : r["Candidate Email"]).trim().toLowerCase();
    const t = tsOf(r["Timestamp"]);
    if (!email || t == null || isExcludedEmail(email, config)) return;
    if (!first.has(email) || t < first.get(email)) first.set(email, t);
  }));
  return first;
}

/**
 * Returns [{id, label, range, start, end, n, emails:Set, pilot}] in date order. id is the
 * batch's first day (YYYY-MM-DD), so it stays the same when later batches arrive.
 */
export function detectBatches(responses, sessions, config) {
  const first = firstActivity(responses, sessions, config);
  const list = [...first.entries()].sort((a, b) => a[1] - b[1]);
  let groups = [];

  if (config.batches && config.batches.length) {
    // Manual split: [{name, from: "YYYY-MM-DD", to: "YYYY-MM-DD"}], dates inclusive (local time).
    groups = config.batches.map(b => ({ name: b.name, from: Date.parse(b.from + "T00:00:00"), to: Date.parse(b.to + "T23:59:59.999"), items: [] }));
    list.forEach(([email, t]) => { const g = groups.find(g => t >= g.from && t <= g.to); if (g) g.items.push([email, t]); });
    groups = groups.filter(g => g.items.length);
  } else {
    const gap = (config.batchGapDays || 3) * DAY;
    list.forEach(item => {
      const last = groups[groups.length - 1];
      if (!last || item[1] - last.items[last.items.length - 1][1] > gap) groups.push({ items: [item] });
      else last.items.push(item);
    });
  }

  let num = 0;
  return groups.map(g => {
    const start = g.items[0][1], end = g.items[g.items.length - 1][1];
    const pilot = !g.name && g.items.length < (config.pilotMaxCandidates || 0);
    const range = dateRange(start, end);
    const label = g.name || (pilot ? "Pilot" : "Batch " + (++num));
    const d = new Date(start), id = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return { id, label, range, start, end, n: g.items.length, pilot, emails: new Set(g.items.map(([e]) => e)) };
  });
}

/** The same {responses, sessions, scores} with only that batch's candidates. batch null = all. */
export function filterToBatch(data, batch) {
  if (!batch) return data;
  const keep = r => batch.emails.has(String(r["Candidate Email"] == null ? "" : r["Candidate Email"]).trim().toLowerCase());
  return { ...data, responses: data.responses.filter(keep), sessions: data.sessions.filter(keep), scores: data.scores.filter(keep) };
}
