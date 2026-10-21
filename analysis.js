/**
 * analysis.js — pure data-crunching. No DOM access, no network calls, no globals: just
 * (rubrics, responses, sessions, scores, config) in, {candidates, itemStats, summary} out.
 * That separation is what makes this reusable — app.js could be swapped for a CLI export
 * script or a different chart library without touching a single line here.
 *
 * The per-candidate math mirrors review.html's analyse() function (the per-question
 * reviewing tool this dashboard sits alongside) so the two never silently disagree on a
 * candidate's score. If you change a formula here, change it there too, or vice versa.
 */

const norm = s => String(s == null ? "" : s).trim();
const emailKey = s => norm(s).toLowerCase();
const normOpt = s => norm(s).replace(/\s+/g, " ").toLowerCase();
const tsOf = v => { const t = Date.parse(v); return isNaN(t) ? 0 : t; };
const byTs = (a, b) => tsOf(a["Timestamp"]) - tsOf(b["Timestamp"]);
const splitList = s => (norm(s) ? norm(s).split(",").map(x => x.trim()).filter(Boolean) : []);
const AI_NAME = "AI";

function wmean(list) {
  let s = 0, sw = 0, n = 0;
  list.forEach(x => { if (x.v == null) return; s += x.v * x.w; sw += x.w; n++; });
  return { pct: sw ? (s / sw) * 100 : null, n, total: list.length };
}

export function isExcludedEmail(email, config) {
  const e = emailKey(email);
  if (!e || e.indexOf("@") === -1) return true;
  if (config.excludeEmailPrefixes.some(p => e.indexOf(p) === 0)) return true;
  if ((config.excludeEmailSubstrings || []).some(s => e.includes(s))) return true;
  const domain = e.split("@")[1] || "";
  return config.excludeEmailDomains.includes(domain);
}

/** Latest-row-wins score per (email, qid, reviewer); a human score always beats "AI". */
function buildScoreIndex(scores) {
  const idx = new Map();
  scores.slice().sort(byTs).forEach(r => {
    const email = emailKey(r["Candidate Email"]), qid = norm(r["Question ID"]), rv = norm(r["Reviewer"]);
    if (!email || !qid || !rv) return;
    const k = email + "|" + qid;
    if (!idx.has(k)) idx.set(k, new Map());
    idx.get(k).set(rv, { score: Number(r["Score"]) });
  });
  return idx;
}
function scoreFor(idx, email, qid) {
  const m = idx.get(email + "|" + qid);
  if (!m) return null;
  const human = []; let ai = null;
  m.forEach((v, rv) => { if (v.score < 0) return; if (rv === AI_NAME) ai = v; else human.push(v.score); });
  const vals = human.length ? human : ai ? [ai.score] : [];
  if (!vals.length) return null;
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length, source: human.length ? "human" : "ai" };
}

export const STATUS = {
  pass: { label: "Meets all gates", tone: "good" },
  likely: { label: "Meets gates so far", tone: "info" },
  awaiting: { label: "Awaiting scores", tone: "plain" },
  lowprov: { label: "Below gate so far", tone: "warn" },
  below: { label: "Below gate", tone: "bad" },
  incomplete: { label: "Session missing", tone: "plain" }
};

/**
 * Runs the full analysis. `rubrics` is the {items, roles, competencies, dimensions,
 * quantOrder, commOrder} object your backend's "rubrics" action returns. `responses`,
 * `sessions`, `scores` are the row arrays from "review_data" / "scores". `config` is
 * config.js's CONFIG object (or your own, same shape).
 */
export function analyse(rubrics, responses, sessions, scores, config) {
  const R = rubrics;
  const scoreIdx = buildScoreIndex(scores);
  const compKeys = Object.keys(R.competencies || {});
  const roleIds = Object.keys(R.roles || {});

  const cands = new Map();
  const getCand = (email, name) => {
    if (!cands.has(email)) cands.set(email, { email, name: "", sess: {}, ans: {}, roles: [] });
    const c = cands.get(email);
    if (name && norm(name)) c.name = norm(name);
    return c;
  };

  sessions.slice().sort(byTs).forEach(r => {
    const email = emailKey(r["Candidate Email"]); if (!email || isExcludedEmail(email, config)) return;
    const sid = norm(r["Session"]); if (sid !== "session1" && sid !== "session2") return;
    const c = getCand(email, r["Candidate Name"]);
    const s = c.sess[sid] || (c.sess[sid] = {});
    const status = norm(r["Status"]);
    if (status === "started") {
      if (!s.startedAt) { s.startedAt = r["Timestamp"]; s.roles = splitList(r["Roles Selected"]); }
    } else if (!s.endedAt) {
      s.endedAt = r["Timestamp"]; s.status = status;
      const auto = status.indexOf("auto-completed") === 0;
      const m = /\(([^)]*)\)/.exec(status);
      s.reason = auto ? (m ? m[1] : "auto") : "completed";
    }
  });

  responses.slice().sort(byTs).forEach(r => {
    const email = emailKey(r["Candidate Email"]); if (!email || isExcludedEmail(email, config)) return;
    const qid = norm(r["Question ID"]); if (!qid) return;
    const c = getCand(email, r["Candidate Name"]);
    c.ans[qid] = {
      text: norm(r["Answer Text"]),
      sel: norm(r["Selected Option"]),
      correctCol: norm(r["Correct?"]).toLowerCase(), // the sheet's own MCQ marking, used when the rubric has no key
      video: norm(r["Video Link"]),
      time: Number(r["Time Spent (sec)"]) || 0,
      autoSubmitted: norm(r["Auto-submitted (timeout)"]).toLowerCase() === "yes" // its time only covers the last visit
    };
  });

  cands.forEach(c => {
    let roles = (c.sess.session2 && c.sess.session2.roles) || [];
    if (!roles.length) {
      const set = new Set();
      Object.keys(c.ans).forEach(q => { const i = q.lastIndexOf("_"); if (i > 0 && roleIds.includes(q.slice(0, i))) set.add(q.slice(0, i)); });
      roles = [...set];
    }
    c.roles = roles.filter(r => roleIds.includes(r));
    c.ended = { s1: !!(c.sess.session1 && c.sess.session1.endedAt), s2: !!(c.sess.session2 && c.sess.session2.endedAt) };

    const expected = [];
    if (c.sess.session1) Object.values(R.items).forEach(it => { if (it.section !== "beh") expected.push(it.id); });
    if (c.sess.session2) c.roles.forEach(role => compKeys.forEach(k => expected.push(role + "_" + k)));

    c.recs = {};
    expected.forEach(qid => {
      const it = R.items[qid]; if (!it) return; // unknown question id (e.g. a retired role naming) — skip, never crash
      const sessEnded = it.section === "beh" ? c.ended.s2 : c.ended.s1;
      const a = c.ans[qid] || null;
      const rec = { qid, it, a, sessEnded };
      if (it.kind === "mcq") {
        rec.answered = !!(a && a.sel);
        // Answer key when the full rubric is loaded; otherwise the sheet's Correct? column.
        rec.correct = rec.answered && (it.key != null ? normOpt(a.sel) === normOpt(it.key) : a.correctCol === "yes");
        rec.v = rec.answered ? (rec.correct ? 1 : 0) : sessEnded ? 0 : null;
      } else {
        rec.empty = !a || (it.video ? !a.video : !a.text.trim());
        rec.score = scoreFor(scoreIdx, c.email, qid);
        if (rec.empty && sessEnded) { rec.v = 0; rec.autoZero = true; }
        else if (rec.empty) rec.v = null;
        else rec.v = rec.score ? rec.score.avg / 3 : null;
        rec.needsScore = !rec.empty && !rec.score;
      }
      c.recs[qid] = rec;
    });

    const recs = Object.values(c.recs);
    const quantRecs = recs.filter(r => r.it.section === "quant");
    const mcq = quantRecs.filter(r => r.it.kind === "mcq"), subj = quantRecs.filter(r => r.it.kind === "subjective");
    const mcqAgg = wmean(mcq.map(r => ({ v: r.v, w: 1 }))), subjAgg = wmean(subj.map(r => ({ v: r.v, w: 1 })));
    c.quant = {
      mcq: mcqAgg, subj: subjAgg,
      pct: mcqAgg.pct != null && subjAgg.pct != null ? config.mcqShare * mcqAgg.pct + config.subjShare * subjAgg.pct : null,
      has: quantRecs.length > 0
    };

    const commRecs = recs.filter(r => r.it.section === "comm");
    c.comm = { ...wmean(commRecs.map(r => ({ v: r.v, w: 1 }))), has: commRecs.length > 0 };

    const behRecs = recs.filter(r => r.it.section === "beh");
    c.beh = { ...wmean(behRecs.map(r => ({ v: r.v, w: 1 }))), has: behRecs.length > 0, byRole: {}, byComp: {} };
    c.roles.forEach(role => { c.beh.byRole[role] = wmean(behRecs.filter(r => r.it.role === role).map(r => ({ v: r.v, w: 1 }))); });
    compKeys.forEach(k => { c.beh.byComp[k] = wmean(behRecs.filter(r => r.it.competency === k).map(r => ({ v: r.v, w: 1 }))); });

    c.dims = {};
    Object.keys(R.dimensions || {}).forEach(d => {
      c.dims[d] = wmean(quantRecs.filter(r => r.it.dims && r.it.dims.includes(d)).map(r => ({ v: r.v, w: r.it.kind === "mcq" ? 1 : config.algoSubjWeight })));
    });
    c.algo = c.dims.algorithmic || null;

    c.unscored = recs.filter(r => r.needsScore);
    c.unscoredVideo = c.unscored.filter(r => r.it.video);
    c.unscoredText = c.unscored.filter(r => !r.it.video);
    c.aiScoredN = recs.filter(r => r.score && r.score.source === "ai").length;
    c.humanScoredN = recs.filter(r => r.score && r.score.source === "human").length;
    c.provisional = c.unscored.length > 0;

    // How each session ended: finished (candidate pressed Finish), tab (auto-submitted after a
    // tab switch), timeout (auto-submitted when time ran out), open (started, no end record),
    // none (never started).
    const endOf = s => !s ? "none" : !s.endedAt ? "open"
      : s.reason === "completed" ? "finished" : s.reason === "tab_hidden" ? "tab" : s.reason === "time_limit" ? "timeout" : "auto";
    c.sessEnd = { s1: endOf(c.sess.session1), s2: endOf(c.sess.session2) };
    c.finishedBoth = c.sessEnd.s1 === "finished" && c.sessEnd.s2 === "finished";

    // integrityFlags: one per auto-submitted session. "hard" = tab switch (an integrity
    // concern), "info" = ran out of time (not one). blanks = answers that session left
    // unanswered, which score 0. notes: data oddities for a reviewer, not integrity flags.
    c.integrityFlags = []; c.notes = [];
    [[1, "s1"], [2, "s2"]].forEach(([n, k]) => {
      const blanks = recs.filter(r => (n === 2) === (r.it.section === "beh") && r.autoZero).length;
      const lost = blanks ? " — " + blanks + " question" + (blanks === 1 ? "" : "s") + " left unanswered (scored 0)" : "";
      if (c.sessEnd[k] === "tab") c.integrityFlags.push({ level: "hard", kind: "tab", session: n, blanks, text: "Session " + n + " ended automatically (tab switched/hidden)" + lost });
      else if (c.sessEnd[k] === "timeout") c.integrityFlags.push({ level: "info", kind: "timeout", session: n, blanks, text: "Session " + n + " ran out of time" + lost });
      // Only Session 1 → it normally has to end before Session 2 can start, so an open Session 1
      // next to an ended Session 2 is a lost record. An open Session 2 is ordinary drop-off.
      if (n === 1 && c.sessEnd.s1 === "open" && c.ended.s2) c.notes.push({ kind: "noend", session: 1, text: "Session 1 has no end record (started, never submitted), but Session 2 ended — check by hand" });
    });
    c.tabSwitch = c.integrityFlags.some(f => f.kind === "tab");
    c.timeoutOnly = !c.tabSwitch && c.integrityFlags.some(f => f.kind === "timeout");
  });

  applyGatesAndStatus(cands, config);

  const candidates = [...cands.values()];
  applyRanks(candidates);
  return { candidates, itemStats: computeItemStats(candidates, R), summary: computeSummary(candidates, config), timing: computeTiming(candidates, config) };
}

function applyGatesAndStatus(cands, config) {
  const g = config.gates, w = config.weights;
  cands.forEach(c => {
    const secs = [["quant", c.quant.pct], ["comm", c.comm.pct], ["beh", c.beh.pct]];
    let sw = 0, s = 0;
    secs.forEach(([k, p]) => { if (p != null) { s += p * w[k]; sw += w[k]; } });
    c.total = sw ? s / sw : null;
    c.floor = c.quant.pct != null && c.comm.pct != null && c.beh.pct != null ? Math.min(c.quant.pct, c.comm.pct, c.beh.pct) : null;

    const checks = [["quant", c.quant.pct, g.quant], ["comm", c.comm.pct, g.comm], ["beh", c.beh.pct, g.beh], ["algo", c.algo ? c.algo.pct : null, g.algo]];
    c.gateFails = checks.filter(([, p, gate]) => p != null && p < gate).map(([k]) => k);
    c.gateMissing = checks.filter(([, p]) => p == null).map(([k]) => k);

    if (!(c.ended.s1 && c.ended.s2)) c.status = "incomplete";
    else if (c.gateFails.length) c.status = c.provisional ? "lowprov" : "below";
    else if (c.gateMissing.length >= 2 || c.quant.pct == null || c.beh.pct == null) c.status = "awaiting";
    else if (c.provisional || c.gateMissing.length) c.status = "likely";
    else c.status = "pass";
  });
}

/**
 * Overall rank, plus rank within each role. Only candidates who finished both sessions and
 * have a score in every section are ranked: a total built from fewer sections isn't
 * comparable. Ties on total break on the weakest section (floor), then Quant. Ranks are
 * provisional while a candidate still has unscored answers (c.provisional).
 */
function applyRanks(candidates) {
  const n = v => (v == null ? -1 : v);
  const ranked = candidates
    // All three sections must have a score: a total averaged over just one graded section
    // (e.g. Comm 100%, Quant and Beh still ungraded) isn't comparable to a full one.
    .filter(c => c.ended.s1 && c.ended.s2 && c.quant.pct != null && c.comm.pct != null && c.beh.pct != null)
    .sort((a, b) => b.total - a.total || n(b.floor) - n(a.floor) || n(b.quant.pct) - n(a.quant.pct));
  candidates.forEach(c => { c.rank = null; c.roleRank = {}; });
  ranked.forEach((c, i) => { c.rank = i + 1; });
  const perRole = {};
  ranked.forEach(c => c.roles.forEach(r => { perRole[r] = (perRole[r] || 0) + 1; c.roleRank[r] = perRole[r]; }));
}

/**
 * Time analysis. Adds c.timing to each candidate and returns a summary; changes nothing else.
 *
 * Only "usable" timings count: answered, time > 0, not auto-submitted (an auto-submitted
 * answer's time only covers the last visit, e.g. 4s for a 200-character answer), and not
 * video (the recording time isn't in Time Spent). Speed index = the candidate's median of
 * (their time / that question's median time): 1.0 is typical, 0.5 is twice as fast. A median
 * so one long pause doesn't swing it.
 *
 * Signals are reasons for a person to look, not verdicts:
 *  - typing: a written answer appeared faster than anyone types (paste is blocked in the app)
 *  - marks:  curly quotes / em dash in a written answer; the test box types straight quotes,
 *            so these mean the text was inserted, not typed
 *  - mcq:    many correct MCQs answered in a few seconds
 *  - fastTop: fastest X% overall and top Y% score among ranked candidates
 */
function computeTiming(candidates, config) {
  const T = config.timing;
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const usable = r => r.a && r.a.time > 0 && !r.a.autoSubmitted && !r.it.video && (r.it.kind === "mcq" ? r.answered : !r.empty);

  const byQ = {};
  candidates.forEach(c => Object.values(c.recs).forEach(r => { if (usable(r)) (byQ[r.qid] = byQ[r.qid] || []).push(r.a.time); }));
  const qMedian = Object.fromEntries(Object.entries(byQ).map(([q, v]) => [q, median(v)]));

  candidates.forEach(c => {
    const recs = Object.values(c.recs).filter(usable);
    // Average time per question, with each answer capped at 3x that question's median so a
    // candidate who left the tab open on one question doesn't look slow everywhere.
    const capped = recs.map(r => Math.min(r.a.time, 3 * qMedian[r.qid]));
    const signals = [];
    const written = recs.filter(r => r.it.kind === "subjective");
    const typed = written.filter(r => r.a.text.length >= T.minCharsForSpeed && r.a.text.length / r.a.time > T.maxCharsPerSec);
    if (typed.length) signals.push({ kind: "typing", label: "Faster than typing", text: "Written answers that appeared faster than anyone can type: " +
      typed.map(r => r.qid + " (" + r.a.text.length + " chars in " + r.a.time + "s)").join(", ") });
    const marked = written.filter(r => /[‘’“”—]/.test(r.a.text));
    if (marked.length) signals.push({ kind: "marks", label: "Inserted text", text: "Curly quotes or em dashes, which the test box doesn't type, in: " + marked.map(r => r.qid).join(", ") });
    const fastMcq = recs.filter(r => r.it.kind === "mcq" && r.correct && r.a.time < T.fastMcqSec);
    if (fastMcq.length >= T.fastMcqMin) signals.push({ kind: "mcq", label: "Fast & correct MCQs", text: fastMcq.length + " correct MCQs answered in under " + T.fastMcqSec + "s each (typical is about 25s)" });
    c.timing = {
      totalSec: recs.reduce((a, r) => a + r.a.time, 0),
      avgSec: capped.length ? capped.reduce((a, b) => a + b, 0) / capped.length : null,
      speedIndex: median(recs.map(r => r.a.time / qMedian[r.qid])),
      n: recs.length,
      signals
    };
  });

  // "Fast overall + top score" needs the ranked pool to compare against.
  const ranked = candidates.filter(c => c.rank != null && c.timing.speedIndex != null);
  const pctile = (vals, p) => { const s = vals.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : null; };
  const fastCut = pctile(ranked.map(c => c.timing.speedIndex), T.fastestPct);
  const topCut = pctile(ranked.map(c => c.total), 100 - T.topScorePct);
  ranked.forEach(c => {
    if (c.timing.speedIndex <= fastCut && c.total >= topCut) c.timing.signals.push({ kind: "fastTop", label: "Fast + top score",
      text: "Among the fastest " + T.fastestPct + "% (speed index " + c.timing.speedIndex.toFixed(2) + ") and in the top " + T.topScorePct + "% by total score" });
  });

  const count = k => candidates.filter(c => c.timing.signals.some(s => s.kind === k)).length;
  return {
    qMedian,
    medianTotalMin: median(ranked.map(c => c.timing.totalSec / 60)),
    medianAvgSec: median(ranked.map(c => c.timing.avgSec).filter(x => x != null)),
    reviewN: candidates.filter(c => c.timing.signals.length).length,
    byKind: { typing: count("typing"), marks: count("marks"), mcq: count("mcq"), fastTop: count("fastTop") }
  };
}

/** MCQ difficulty (% correct) and discrimination (top-27% minus bottom-27% correct rate,
 *  by overall total) — a low or negative discrimination flags a question worth reviewing:
 *  it isn't separating stronger candidates from weaker ones the way it should. */
function computeItemStats(candidates, R) {
  const stats = {};
  Object.values(R.items).forEach(it => {
    if (it.kind !== "mcq") return;
    const answered = candidates.map(c => c.recs[it.id]).filter(r => r && r.answered);
    if (!answered.length) return;
    stats[it.id] = { id: it.id, tag: it.tag, n: answered.length, pctCorrect: (answered.filter(r => r.correct).length / answered.length) * 100 };
  });
  const ranked = candidates.filter(c => c.total != null).sort((a, b) => b.total - a.total);
  const k = Math.floor(ranked.length * 0.27);
  if (ranked.length >= 10 && k >= 3) {
    const top = ranked.slice(0, k), bottom = ranked.slice(-k);
    const rate = (group, qid) => {
      const a = group.map(c => c.recs[qid]).filter(r => r && r.answered);
      return a.length ? a.filter(r => r.correct).length / a.length : null;
    };
    Object.values(stats).forEach(s => {
      const pt = rate(top, s.id), pb = rate(bottom, s.id);
      s.discrimination = pt != null && pb != null ? pt - pb : null;
    });
  }
  return stats;
}

function computeSummary(candidates, config) {
  const n = candidates.length;
  const startedBoth = candidates.filter(c => c.sess.session1 && c.sess.session2).length;
  const endedBoth = candidates.filter(c => c.ended.s1 && c.ended.s2).length;
  const byStatus = {}; candidates.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const byRole = {}; candidates.forEach(c => c.roles.forEach(r => { byRole[r] = (byRole[r] || 0) + 1; }));
  const aiScoredN = candidates.reduce((a, c) => a + c.aiScoredN, 0);
  const humanScoredN = candidates.reduce((a, c) => a + c.humanScoredN, 0);
  const unscoredN = candidates.reduce((a, c) => a + c.unscored.length, 0);
  const avg = key => { const v = candidates.map(c => c[key] && c[key].pct).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const flaggedN = candidates.filter(c => c.integrityFlags.length).length;
  const rankedN = candidates.filter(c => c.rank != null).length;
  // Everything below counts candidates, so the pairs add up: tabSwitchN + timeoutOnlyN =
  // flaggedN, and finishedBothN + autoSubmittedBothN = endedBoth.
  const tabSwitchN = candidates.filter(c => c.tabSwitch).length;
  const timeoutOnlyN = candidates.filter(c => c.timeoutOnly).length;
  const finishedBothN = candidates.filter(c => c.finishedBoth).length;
  const autoSubmittedBothN = endedBoth - finishedBothN;
  const noEndN = candidates.filter(c => c.notes.length).length;
  return {
    n, startedBoth, endedBoth, byStatus, byRole, rankedN,
    tabSwitchN, timeoutOnlyN, finishedBothN, autoSubmittedBothN, noEndN,
    aiScoredN, humanScoredN, unscoredN, flaggedN,
    sectionAverages: { quant: avg("quant"), comm: avg("comm"), beh: avg("beh") },
    priorityPool: candidates.filter(c => c.quant.mcq.pct != null && c.quant.mcq.pct >= config.mcqPriorityMin).length
  };
}
