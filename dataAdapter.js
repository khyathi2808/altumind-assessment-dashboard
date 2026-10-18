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
