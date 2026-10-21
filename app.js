import { CONFIG } from "./config.js";
import { fetchAssessmentData, fetchFromSheet, isSheetUrl, loadLocalSettings, ApiError } from "./dataAdapter.js";
import { analyse, STATUS } from "./analysis.js";

const LS_ENDPOINT = "assessmentDashboard:endpoint";
const LS_KEY = "assessmentDashboard:adminKey"; // browser-local only — never written to this repo, see README

const $ = sel => document.querySelector(sel);
const charts = {}; // Chart.js instances, destroyed and rebuilt on each refresh

let STATE = { rubrics: null, responses: [], sessions: [], scores: [], candidates: [], itemStats: {}, summary: null };
let sort = { key: "rank", dir: "asc" };
let timeSort = { key: "rank", dir: "asc" }, timeOnlyFlagged = false; // time-analysis table, independent of the leaderboard
let filters = { role: "all", status: "all", integrity: "all", search: "" };

/** Leaderboard integrity filter: value -> [label, predicate]. */
const INTEGRITY_FILTERS = {
  all: ["All sessions", () => true],
  clean: ["Finished both sessions themselves", c => c.finishedBoth],
  tab: ["Switched tabs (integrity review)", c => c.tabSwitch],
  timeout: ["Ran out of time only", c => c.timeoutOnly],
  none: ["No flags", c => !c.integrityFlags.length],
  noend: ["Session with no end record", c => c.notes.length > 0]
};

init();

async function init() {
  $("#exportBtn").addEventListener("click", exportCsv);
  $("#connectForm").addEventListener("submit", onConnect);
  $("#changeBackend").addEventListener("click", showConnectScreen);
  $("#refreshBtn").addEventListener("click", () => loadAndRender(true));
  $("#roleFilter").addEventListener("change", e => { filters.role = e.target.value; renderLeaderboard(); });
  $("#statusFilter").addEventListener("change", e => { filters.status = e.target.value; renderLeaderboard(); });
  $("#integrityFilter").addEventListener("change", e => { filters.integrity = e.target.value; renderLeaderboard(); });
  $("#timeOnlyFlagged").addEventListener("change", e => { timeOnlyFlagged = e.target.checked; renderTimeTable(); });
  document.querySelectorAll("#timeTable thead th[data-tsort]").forEach(th => th.addEventListener("click", () => {
    const key = th.dataset.tsort;
    timeSort.dir = timeSort.key === key && timeSort.dir === "asc" ? "desc" : "asc";
    timeSort.key = key;
    renderTimeTable();
  }));
  $("#searchBox").addEventListener("input", e => { filters.search = e.target.value.toLowerCase(); renderLeaderboard(); });
  document.querySelectorAll("#leaderboardTable thead th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      sort.dir = sort.key === key && sort.dir === "desc" ? "asc" : "desc";
      sort.key = key;
      renderLeaderboard();
    });
  });

  const local = await loadLocalSettings();
  const endpoint = localStorage.getItem(LS_ENDPOINT) || local.sheetUrl || CONFIG.defaultEndpoint || "";
  if (endpoint && !localStorage.getItem(LS_ENDPOINT) && isSheetUrl(endpoint)) localStorage.setItem(LS_ENDPOINT, endpoint);
  const key = sessionStorage.getItem(LS_KEY) || "";
  if (endpoint && (key || isSheetUrl(endpoint))) {
    $("#endpointInput").value = endpoint;
    $("#keyInput").value = key;
    // Auto-connecting: show a loading message, not the connect form, while the sheet downloads.
    $("#connectScreen").classList.add("hidden");
    $("#loadingScreen").classList.remove("hidden");
    loadAndRender(false);
  } else {
    $("#endpointInput").value = endpoint;
    showConnectScreen();
  }
}

function showConnectScreen() {
  $("#connectScreen").classList.remove("hidden");
  $("#dashboard").classList.add("hidden");
}

async function onConnect(e) {
  e.preventDefault();
  const endpoint = $("#endpointInput").value.trim();
  const key = $("#keyInput").value.trim();
  if (!endpoint || (!key && !isSheetUrl(endpoint))) {
    $("#connectError").textContent = "An admin key is needed for an Apps Script URL. A Google Sheet link needs none.";
    $("#connectError").classList.remove("hidden");
    return;
  }
  localStorage.setItem(LS_ENDPOINT, endpoint);
  // The admin key is deliberately kept in sessionStorage, not localStorage: it clears when
  // the tab closes, rather than sitting on disk indefinitely on a shared or public machine.
  // Re-type it next visit, or switch this to localStorage yourself if that trade-off is
  // wrong for how you use this.
  sessionStorage.setItem(LS_KEY, key);
  await loadAndRender(false);
}

async function loadAndRender(forceShowErrors) {
  const endpoint = localStorage.getItem(LS_ENDPOINT), key = sessionStorage.getItem(LS_KEY);
  setStatus("Loading…");
  try {
    const data = isSheetUrl(endpoint) ? await fetchFromSheet(endpoint) : await fetchAssessmentData(endpoint, key);
    STATE.rubrics = data.rubrics; STATE.responses = data.responses; STATE.sessions = data.sessions; STATE.scores = data.scores;
    const result = analyse(STATE.rubrics, STATE.responses, STATE.sessions, STATE.scores, CONFIG);
    STATE.candidates = result.candidates; STATE.itemStats = result.itemStats; STATE.summary = result.summary; STATE.timing = result.timing;
    $("#connectScreen").classList.add("hidden");
    $("#loadingScreen").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    populateFilters();
    renderAll();
    if (typeof Chart !== "undefined") setStatus("Updated " + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus("");
    $("#loadingScreen").classList.add("hidden");
    const msg = err instanceof ApiError ? err.message : "Unexpected error: " + err.message;
    if (forceShowErrors || $("#dashboard").classList.contains("hidden")) {
      showConnectScreen();
      $("#connectError").textContent = msg;
      $("#connectError").classList.remove("hidden");
    } else {
      alert(msg);
    }
  }
}

function setStatus(text) { $("#statusLine").textContent = text; }

function populateFilters() {
  const roles = new Set(); STATE.candidates.forEach(c => c.roles.forEach(r => roles.add(r)));
  const roleSel = $("#roleFilter");
  roleSel.innerHTML = '<option value="all">All roles</option>' +
    [...roles].sort().map(r => `<option value="${r}">${roleLabel(r)}</option>`).join("");
  const statusSel = $("#statusFilter");
  statusSel.innerHTML = '<option value="all">All statuses</option>' +
    Object.keys(STATUS).map(s => `<option value="${s}">${STATUS[s].label}</option>`).join("");
  $("#integrityFilter").innerHTML = Object.entries(INTEGRITY_FILTERS).map(([k, [label, test]]) =>
    `<option value="${k}">${label}${k === "all" ? "" : " (" + STATE.candidates.filter(test).length + ")"}</option>`).join("");
  // Rebuilt on every refresh: keep showing the filters that are still applied.
  roleSel.value = filters.role; statusSel.value = filters.status; $("#integrityFilter").value = filters.integrity;
}

function roleLabel(id) { return (STATE.rubrics.roles && STATE.rubrics.roles[id]) || id; }

function renderAll() {
  renderStatCards();
  renderLeaderboard(); // plain HTML: render it before the charts so it never depends on Chart.js
  renderTimeCards(); renderTimeTable();
  if (typeof Chart === "undefined") {
    setStatus("Charts unavailable: the Chart.js library didn't load (offline, or the CDN is blocked).");
    return;
  }
  // Each chart on its own, so one failure leaves the rest of the dashboard standing.
  [renderFunnelChart, renderStatusChart, renderRoleChart, renderScoreHistograms,
   renderGradesChart, renderItemDifficultyChart, renderScoringCoverageChart,
   renderTimeScatter, renderTimeRankChart].forEach(fn => {
    try { fn(); } catch (err) { console.error(fn.name + " failed:", err); }
  });
}

/* ---------- stat cards ---------- */
function renderStatCards() {
  const s = STATE.summary;
  const cards = [
    ["Candidates (real)", s.n],
    ["Ranked (all sections scored)", s.rankedN],
    // All counts are candidates: finished + auto-submitted = ended both; tab switch + timeout only = flagged.
    ["Ended both sessions", s.endedBoth + " / " + s.n],
    ["↳ finished both themselves", s.finishedBothN],
    ["↳ auto-submitted at least once", s.autoSubmittedBothN],
    ["Meets all gates", (s.byStatus.pass || 0)],
    ["Integrity review: switched tabs", s.tabSwitchN],
    ["Ran out of time only (not an integrity issue)", s.timeoutOnlyN],
    ["AI-scored items", s.aiScoredN],
    ["Human-scored items", s.humanScoredN],
    ["Still unscored", s.unscoredN],
    ["Avg total (of those scored)", fmtPct(wavg(STATE.candidates.map(c => c.total)))]
  ];
  $("#statCards").innerHTML = cards.map(([label, val]) => `
    <div class="stat-card">
      <div class="stat-value">${val}</div>
      <div class="stat-label">${label}</div>
    </div>`).join("");
}
function wavg(arr) { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function fmtPct(p) { return p == null ? "n/a" : Math.round(p) + "%"; }

/** Raw points behind a section's percentage, e.g. "12/14 MCQ, 9.0/18 written" or "14.0/18".
 *  Each answer is out of 3 (an MCQ counts 0 or 3, a written/video grade 0-3). Only answers with
 *  a value are counted, so a blank answer in an ended session adds 0 to the score and 3 to the max. */
function sectionRaw(c, sectionKey) {
  const recs = Object.values(c.recs).filter(r => r.it.section === sectionKey);
  if (!recs.length) return "";
  if (sectionKey === "quant") {
    const mcq = recs.filter(r => r.it.kind === "mcq"), subj = recs.filter(r => r.it.kind === "subjective");
    const subjScored = subj.filter(r => r.v != null);
    const subjSum = subjScored.reduce((a, r) => a + r.v * 3, 0), subjMax = subjScored.length * 3;
    const parts = [];
    if (mcq.length) parts.push(mcq.filter(r => r.correct).length + "/" + mcq.length + " MCQ");
    if (subj.length) parts.push(subjMax ? subjSum.toFixed(1) + "/" + subjMax + " written" : "written not yet scored");
    return parts.join(", ");
  }
  const scored = recs.filter(r => r.v != null);
  if (!scored.length) return "not yet scored";
  return scored.reduce((a, r) => a + r.v * 3, 0).toFixed(1) + "/" + (scored.length * 3);
}

/* ---------- charts (Chart.js, loaded from CDN in index.html) ---------- */
function destroy(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function themeColors() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
  return {
    text: dark ? "#e8e4da" : "#2a241a",
    grid: dark ? "#3a3326" : "#e7e1d2",
    series: ["#3d7a5f", "#c9973a", "#7b6fb0", "#c05a5a", "#4a8fc2", "#8aab4a"]
  };
}

/** Funnel with the "ended" steps split by how the session ended, so a forced submission
 *  isn't shown as a completion. Started / gate rows are a single segment. */
function renderFunnelChart() {
  const c = STATE.candidates, n = (k, v) => c.filter(x => x.sessEnd[k] === v).length;
  const rows = [
    { label: "Started Session 1", reached: c.filter(x => x.sess.session1).length },
    { label: "Ended Session 1", finished: n("s1", "finished"), tab: n("s1", "tab"), timeout: n("s1", "timeout") },
    { label: "Started Session 2", reached: c.filter(x => x.sess.session2).length },
    { label: "Ended Session 2", finished: n("s2", "finished"), tab: n("s2", "tab"), timeout: n("s2", "timeout") },
    { label: "Meets all gates", reached: c.filter(x => x.status === "pass").length }
  ];
  const t = themeColors(), dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
  const seg = (label, key, color) => ({ label, data: rows.map(r => r[key] || 0), backgroundColor: color, borderColor: dark ? "#1d1a14" : "#ffffff", borderWidth: 1, borderSkipped: false });
  destroy("funnel");
  charts.funnel = new Chart($("#funnelChart"), {
    type: "bar",
    data: {
      labels: rows.map(r => r.label),
      datasets: [
        seg("Reached", "reached", t.series[0]),
        seg("Finished themselves", "finished", t.series[0]),
        seg("Auto-submitted: tab switch", "tab", t.series[1]),
        seg("Auto-submitted: time ran out", "timeout", dark ? "#6b675e" : "#a9a59c")
      ]
    },
    options: {
      indexAxis: "y",
      aspectRatio: 1.1, // taller than the default 2:1 so five rows plus the legend stay readable
      interaction: { mode: "index", axis: "y", intersect: false },
      plugins: {
        legend: { position: "top", labels: { color: t.text, boxWidth: 10, font: { size: 11 }, filter: i => i.text !== "Reached" } },
        tooltip: { filter: i => i.raw > 0 }
      },
      scales: {
        x: { stacked: true, ticks: { color: t.text }, grid: { color: t.grid }, beginAtZero: true },
        y: { stacked: true, ticks: { color: t.text, autoSkip: false }, grid: { display: false } }
      }
    }
  });
}

function renderStatusChart() {
  const s = STATE.summary.byStatus;
  const labels = Object.keys(STATUS).filter(k => s[k]);
  const t = themeColors();
  destroy("status");
  charts.status = new Chart($("#statusChart"), {
    type: "doughnut",
    data: { labels: labels.map(k => STATUS[k].label), datasets: [{ data: labels.map(k => s[k]), backgroundColor: t.series }] },
    options: { plugins: { legend: { labels: { color: t.text } } }, color: t.text }
  });
}

function renderRoleChart() {
  const r = STATE.summary.byRole;
  const labels = Object.keys(r).sort((a, b) => r[b] - r[a]);
  const t = themeColors();
  destroy("role");
  charts.role = new Chart($("#roleChart"), {
    type: "bar",
    data: { labels: labels.map(roleLabel), datasets: [{ data: labels.map(l => r[l]), backgroundColor: t.series[1] }] },
    options: baseBarOptions(t)
  });
}

function binInto10s(values) {
  const bins = new Array(10).fill(0);
  values.filter(v => v != null).forEach(v => { const i = Math.min(9, Math.floor(v / 10)); bins[i]++; });
  return bins;
}
function renderScoreHistograms() {
  const t = themeColors();
  const sections = [["quant", "quantHist"], ["comm", "commHist"], ["beh", "behHist"], ["total", "totalHist"]];
  sections.forEach(([key, canvasId]) => {
    const values = STATE.candidates.map(c => key === "total" ? c.total : c[key].pct);
    destroy(canvasId);
    charts[canvasId] = new Chart($("#" + canvasId), {
      type: "bar",
      data: {
        labels: ["0-10", "10-20", "20-30", "30-40", "40-50", "50-60", "60-70", "70-80", "80-90", "90-100"],
        datasets: [{ data: binInto10s(values), backgroundColor: t.series[2] }]
      },
      options: baseBarOptions(t)
    });
  });
}

function renderItemDifficultyChart() {
  const items = Object.values(STATE.itemStats).sort((a, b) => a.pctCorrect - b.pctCorrect);
  const t = themeColors();
  destroy("difficulty");
  charts.difficulty = new Chart($("#difficultyChart"), {
    type: "bar",
    data: {
      labels: items.map(i => i.id),
      datasets: [{
        label: "% correct",
        data: items.map(i => i.pctCorrect),
        backgroundColor: items.map(i => i.discrimination != null && i.discrimination < 0.1 ? t.series[3] : t.series[0])
      }]
    },
    options: { ...baseBarOptions(t, { indexAxis: "y" }),
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const it = items[ctx.dataIndex];
          return `${Math.round(it.pctCorrect)}% correct (n=${it.n})` + (it.discrimination != null ? `, discrimination ${it.discrimination.toFixed(2)}` : "");
        } } } } }
  });
}

/** Grade buckets in scale order. 0-3 are one hue light->dark (an ordered scale, not
 *  categories); blank and not-graded are neutral grays so they never read as a grade. */
const GRADE_BUCKETS = ["3", "2", "1", "0", "blank", "pending"];
const GRADE_LABELS = { 3: "3 Strong", 2: "2 Adequate", 1: "1 Weak", 0: "0 No signal", blank: "Blank answer (counts as 0)", pending: "Not graded yet" };
function gradeColors() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
  // Ordinal blue ramp, validated (validate_palette.js --ordinal) against each surface.
  return dark
    ? { 3: "#9ec5f4", 2: "#5598e7", 1: "#2a78d6", 0: "#184f95", blank: "#6b675e", pending: "#3a3833", gap: "#1d1a14" }
    : { 3: "#0d366b", 2: "#1c5cab", 1: "#3987e5", 0: "#86b6ef", blank: "#a9a59c", pending: "#dedad1", gap: "#ffffff" };
}

/** One row per written/video question; behavioral items grouped by competency across roles.
 *  Only answers whose session has ended are counted (an in-progress answer isn't final). */
function gradeBreakdown() {
  const R = STATE.rubrics, rows = new Map();
  const rowFor = it => {
    const key = it.section === "beh" ? "beh_" + it.competency : it.id;
    if (!rows.has(key)) {
      const label = it.section === "beh"
        ? "Behavioral · " + ((R.competencies && R.competencies[it.competency]) || it.competency)
        : it.id + " · " + String(it.tag || "").split(":")[0];
      rows.set(key, { label, order: it.section === "beh" ? 2 : it.section === "comm" ? 1 : 0, counts: Object.fromEntries(GRADE_BUCKETS.map(b => [b, 0])) });
    }
    return rows.get(key);
  };
  STATE.candidates.forEach(c => Object.values(c.recs).forEach(rec => {
    if (rec.it.kind !== "subjective" || !rec.sessEnded) return;
    const b = rec.autoZero ? "blank" : rec.score ? String(Math.min(3, Math.max(0, Math.round(rec.score.avg)))) : "pending";
    rowFor(rec.it).counts[b]++;
  }));
  return [...rows.values()].sort((a, b) => a.order - b.order);
}

function renderGradesChart() {
  const rows = gradeBreakdown(), t = themeColors(), g = gradeColors();
  destroy("grades");
  charts.grades = new Chart($("#gradesChart"), {
    type: "bar",
    data: {
      labels: rows.map(r => r.label),
      datasets: GRADE_BUCKETS.map(b => ({
        label: GRADE_LABELS[b], data: rows.map(r => r.counts[b]),
        backgroundColor: g[b], borderColor: g.gap, borderWidth: 1, borderSkipped: false, borderRadius: 2
      }))
    },
    options: {
      indexAxis: "y", maintainAspectRatio: true,
      interaction: { mode: "index", axis: "y", intersect: false },
      plugins: {
        legend: { position: "top", labels: { color: t.text, boxWidth: 12 } },
        tooltip: { callbacks: {
          label: ctx => {
            const total = GRADE_BUCKETS.reduce((s, b) => s + rows[ctx.dataIndex].counts[b], 0);
            return `${ctx.dataset.label}: ${ctx.raw} (${total ? Math.round(ctx.raw / total * 100) : 0}%)`;
          }
        } }
      },
      scales: {
        x: { stacked: true, ticks: { color: t.text }, grid: { color: t.grid }, title: { display: true, text: "Answers", color: t.text } },
        y: { stacked: true, ticks: { color: t.text, autoSkip: false }, grid: { display: false } }
      }
    }
  });
}

function renderScoringCoverageChart() {
  const s = STATE.summary;
  const t = themeColors();
  destroy("coverage");
  charts.coverage = new Chart($("#coverageChart"), {
    type: "doughnut",
    data: {
      labels: ["AI-scored", "Human-scored", "Unscored"],
      datasets: [{ data: [s.aiScoredN, s.humanScoredN, s.unscoredN], backgroundColor: [t.series[4], t.series[0], t.series[3]] }]
    },
    options: { plugins: { legend: { labels: { color: t.text } } } }
  });
}

function baseBarOptions(t, extra) {
  return Object.assign({
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: t.text }, grid: { color: t.grid } },
      y: { ticks: { color: t.text }, grid: { color: t.grid }, beginAtZero: true }
    }
  }, extra || {});
}

/* ---------- leaderboard ---------- */
/** Rank shown in the table: within the selected role when a role filter is on, else overall. */
function rankOf(c) { return filters.role !== "all" ? (c.roleRank[filters.role] ?? null) : c.rank; }

function filteredSortedRows() {
  let rows = STATE.candidates.slice();
  if (filters.role !== "all") rows = rows.filter(c => c.roles.includes(filters.role));
  if (filters.status !== "all") rows = rows.filter(c => c.status === filters.status);
  if (filters.integrity !== "all") rows = rows.filter(INTEGRITY_FILTERS[filters.integrity][1]);
  if (filters.search) rows = rows.filter(c => (c.name + " " + c.email).toLowerCase().includes(filters.search));

  const get = c => {
    if (sort.key === "name") return c.name || c.email;
    if (sort.key === "status") return c.status;
    if (sort.key === "rank") return rankOf(c);
    if (sort.key === "total") return c.total;
    return c[sort.key] ? c[sort.key].pct : null; // quant / comm / beh are {pct, ...} objects
  };
  rows.sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1; // blanks always last
    const cmp = typeof av === "string" || typeof bv === "string" ? String(av).localeCompare(String(bv)) : av - bv;
    return sort.dir === "asc" ? cmp : -cmp;
  });
  return rows;
}

/** Inline badges, one per flagged session: amber for a tab switch (integrity), gray for a
 *  timeout (not integrity), blue for a missing end record (data check). The full sentence,
 *  including how many answers were left blank, is in each badge's hover text. */
function flagBadges(c) {
  const style = { tab: ["warn", "Tab switch"], timeout: ["plain", "Timed out"], noend: ["info", "No end record"] };
  const items = c.integrityFlags.concat(c.notes);
  if (!items.length) return '<span class="muted">—</span>';
  return '<div class="flag-badges">' + items.map(f => {
    const [tone, label] = style[f.kind];
    return `<span class="badge badge-${tone}" title="${esc(f.text)}">${label} · S${f.session}</span>`;
  }).join("") + "</div>";
}

function renderLeaderboard() {
  const rows = filteredSortedRows();
  $("#leaderboardCount").textContent = rows.length + " candidate" + (rows.length === 1 ? "" : "s");
  $("#leaderboardBody").innerHTML = rows.map(c => `
    <tr>
      <td>${rankOf(c) == null ? '<span class="muted" title="Not ranked: needs both sessions completed and a score in every section">—</span>' : "<b>" + rankOf(c) + "</b>" + (c.provisional ? '<span class="muted" title="Provisional: some answers not graded yet">*</span>' : "")}</td>
      <td>${esc(c.name || "(no name)")}<div class="muted small">${esc(c.email)}</div></td>
      <td class="wrap">${c.roles.map(roleLabel).join(", ")}</td>
      <td>${fmtPct(c.quant.pct)}<div class="muted small">${esc(sectionRaw(c, "quant"))}</div></td>
      <td>${fmtPct(c.comm.pct)}<div class="muted small">${esc(sectionRaw(c, "comm"))}</div></td>
      <td>${fmtPct(c.beh.pct)}<div class="muted small">${esc(sectionRaw(c, "beh"))}</div></td>
      <td><b>${fmtPct(c.total)}</b></td>
      <td><span class="badge badge-${STATUS[c.status].tone}">${STATUS[c.status].label}</span></td>
      <td>${c.unscored.length || "—"}</td>
      <td class="wrap">${flagBadges(c)}</td>
    </tr>`).join("");
}
function exportCsv() {
  const pct = p => (p == null ? "" : Math.round(p * 10) / 10);
  const cell = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const END = { finished: "Finished", tab: "Auto-submitted (tab switch)", timeout: "Auto-submitted (time ran out)", open: "Started, no end record", none: "Not started", auto: "Auto-submitted" };
  const head = ["Rank", "Provisional", "Name", "Email", "Roles", "Quant %", "Comm %", "Beh %", "Total %", "Status",
    "Unscored answers", "Session 1 end", "Session 2 end", "Tab switches", "Timeouts", "Answers left blank by auto-submit", "Notes"];
  const lines = [head].concat(filteredSortedRows().map(c => [
    rankOf(c) ?? "", c.rank != null && c.provisional ? "yes" : "", c.name, c.email, c.roles.map(roleLabel).join("; "),
    pct(c.quant.pct), pct(c.comm.pct), pct(c.beh.pct), pct(c.total), STATUS[c.status].label,
    c.unscored.length, END[c.sessEnd.s1], END[c.sessEnd.s2],
    c.integrityFlags.filter(f => f.kind === "tab").length, c.integrityFlags.filter(f => f.kind === "timeout").length,
    c.integrityFlags.reduce((a, f) => a + f.blanks, 0), c.notes.map(n => n.text).join("; ")
  ])).map(r => r.map(cell).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "candidate-ranking-" + new Date().toISOString().slice(0, 10) + (filters.role !== "all" ? "-" + filters.role : "") + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

/* ---------- time analysis (section below the leaderboard) ---------- */
const fmtMin = sec => (sec == null ? "n/a" : Math.round(sec / 60) + " min");
const fmtSec = sec => (sec == null ? "n/a" : Math.round(sec) + " s");
const SPEED_COLOR = () => getComputedStyle(document.documentElement).getPropertyValue("--speed").trim() || "#5b3fa8";
const NORMAL_COLOR = () => (matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light" ? "#7d786d" : "#a9a59c");

function renderTimeCards() {
  const tm = STATE.timing;
  const cards = [
    ["Median time spent (ranked)", tm.medianTotalMin == null ? "n/a" : Math.round(tm.medianTotalMin) + " min"],
    ["Median avg time per question", fmtSec(tm.medianAvgSec)],
    ["Candidates with a speed signal", tm.reviewN],
    ["↳ faster than typing", tm.byKind.typing],
    ["↳ inserted-text marks", tm.byKind.marks],
    ["↳ fast & correct MCQs", tm.byKind.mcq],
    ["↳ fast + top score", tm.byKind.fastTop]
  ];
  $("#timeCards").innerHTML = cards.map(([label, val]) => `
    <div class="stat-card"><div class="stat-value">${val}</div><div class="stat-label">${label}</div></div>`).join("");
}

function speedBadges(c) {
  if (!c.timing.signals.length) return '<span class="muted">—</span>';
  return '<div class="flag-badges">' + c.timing.signals.map(s => `<span class="badge badge-speed" title="${esc(s.text)}">${esc(s.label)}</span>`).join("") + "</div>";
}

function renderTimeTable() {
  // Ranked candidates, plus any unranked one with a speed signal so nothing flagged is hidden.
  let rows = STATE.candidates.filter(c => c.rank != null || c.timing.signals.length);
  if (timeOnlyFlagged) rows = rows.filter(c => c.timing.signals.length);
  const get = c => timeSort.key === "name" ? (c.name || c.email) : timeSort.key === "rank" ? c.rank : timeSort.key === "total" ? c.total : c.timing[timeSort.key];
  rows.sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return timeSort.dir === "asc" ? cmp : -cmp;
  });
  $("#timeCount").textContent = rows.length + " candidate" + (rows.length === 1 ? "" : "s");
  $("#timeBody").innerHTML = rows.map(c => `
    <tr>
      <td>${c.rank == null ? '<span class="muted" title="Not ranked">—</span>' : "<b>" + c.rank + "</b>"}</td>
      <td>${esc(c.name || "(no name)")}<div class="muted small">${esc(c.email)}</div></td>
      <td><b>${fmtPct(c.total)}</b></td>
      <td>${fmtMin(c.timing.totalSec)}<div class="muted small">${c.timing.n} timed answers</div></td>
      <td>${fmtSec(c.timing.avgSec)}</td>
      <td>${c.timing.speedIndex == null ? "n/a" : c.timing.speedIndex.toFixed(2)}</td>
      <td class="wrap">${speedBadges(c)}</td>
    </tr>`).join("");
}

function renderTimeScatter() {
  const t = themeColors(), pts = STATE.candidates.filter(c => c.rank != null && c.timing.n);
  const toPt = c => ({ x: Math.round(c.timing.totalSec / 60), y: Math.round(c.total), c });
  const normal = pts.filter(c => !c.timing.signals.length).map(toPt), flagged = pts.filter(c => c.timing.signals.length).map(toPt);
  destroy("timeScatter");
  charts.timeScatter = new Chart($("#timeScatter"), {
    type: "scatter",
    data: { datasets: [
      { label: "No speed signal", data: normal, backgroundColor: NORMAL_COLOR(), pointRadius: 4, pointHoverRadius: 6 },
      { label: "Speed signal", data: flagged, backgroundColor: SPEED_COLOR(), pointRadius: 6, pointHoverRadius: 8 }
    ] },
    options: {
      plugins: {
        legend: { labels: { color: t.text, boxWidth: 10 } },
        tooltip: { callbacks: { label: ctx => {
          const c = ctx.raw.c;
          return [`#${c.rank} ${c.name || c.email}: ${ctx.raw.y}% in ${ctx.raw.x} min`].concat(c.timing.signals.map(s => "• " + s.label));
        } } }
      },
      scales: {
        x: { title: { display: true, text: "Time spent (minutes)", color: t.text }, ticks: { color: t.text }, grid: { color: t.grid }, beginAtZero: true },
        y: { title: { display: true, text: "Total score %", color: t.text }, ticks: { color: t.text }, grid: { color: t.grid }, min: 0, max: 100 }
      }
    }
  });
}

function renderTimeRankChart() {
  const t = themeColors();
  const top = STATE.candidates.filter(c => c.rank != null).sort((a, b) => a.rank - b.rank).slice(0, 20);
  destroy("timeRank");
  charts.timeRank = new Chart($("#timeRankChart"), {
    type: "bar",
    data: {
      labels: top.map(c => `#${c.rank} ${(c.name || c.email).slice(0, 18)} · ${fmtMin(c.timing.totalSec)}`),
      datasets: [{ label: "Total score %", data: top.map(c => Math.round(c.total)),
        backgroundColor: top.map(c => c.timing.signals.length ? SPEED_COLOR() : t.series[0]), borderRadius: 2 }]
    },
    options: {
      indexAxis: "y", aspectRatio: 0.9,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const c = top[ctx.dataIndex];
          return [`Total ${Math.round(c.total)}% · ${fmtMin(c.timing.totalSec)} · avg ${fmtSec(c.timing.avgSec)}/question · speed ${c.timing.speedIndex == null ? "n/a" : c.timing.speedIndex.toFixed(2)}`]
            .concat(c.timing.signals.map(s => "• " + s.label));
        } } }
      },
      scales: {
        x: { min: 0, max: 100, ticks: { color: t.text }, grid: { color: t.grid }, title: { display: true, text: "Total score %", color: t.text } },
        y: { ticks: { color: t.text, autoSkip: false, font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}
