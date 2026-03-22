/**
 * In-memory store — swap for SQLite/Postgres in production.
 * Handles MR analyses, Repo analyses, Connected repos, and OAuth user sessions.
 */

const analyses     = [];
const repoAnalyses = [];
const repos        = [];
const users        = {}; // userId → { id, username, name, email, avatar_url, token, connectedAt }
const MAX          = 200;

// ── MR analyses ───────────────────────────────────────────────
function save(data) {
  const entry = { ...data, id: `mr-${data.projectId}-${data.mrIid}-${Date.now()}`, kind: 'mr', analyzedAt: new Date().toISOString() };
  analyses.unshift(entry);
  if (analyses.length > MAX) analyses.splice(MAX);
  return entry;
}

function list({ limit = 50, projectId } = {}) {
  let res = analyses;
  if (projectId) res = res.filter(a => String(a.projectId) === String(projectId));
  return res.slice(0, limit);
}

function stats() {
  if (!analyses.length) return { total: 0, avgScore: 0, passCount: 0, reviewCount: 0, blockCount: 0, recentTrend: [] };
  const avg = Math.round(analyses.reduce((s, a) => s + a.score, 0) / analyses.length);
  return {
    total:       analyses.length,
    avgScore:    avg,
    passCount:   analyses.filter(a => a.verdict === 'pass').length,
    reviewCount: analyses.filter(a => a.verdict === 'review').length,
    blockCount:  analyses.filter(a => a.verdict === 'block').length,
    recentTrend: analyses.slice(0, 10).map(a => ({ score: a.score, at: a.analyzedAt }))
  };
}

// ── Repo analyses ─────────────────────────────────────────────
function saveRepoAnalysis(data) {
  const entry = { ...data, id: `repo-${data.projectId}-${Date.now()}`, kind: 'repo', analyzedAt: new Date().toISOString() };
  repoAnalyses.unshift(entry);
  if (repoAnalyses.length > MAX) repoAnalyses.splice(MAX);
  return entry;
}

function listRepoAnalyses({ limit = 20, projectId } = {}) {
  let res = repoAnalyses;
  if (projectId) res = res.filter(a => String(a.projectId) === String(projectId));
  return res.slice(0, limit);
}

function getLatestRepoAnalysis(projectId) {
  return repoAnalyses.find(a => String(a.projectId) === String(projectId)) || null;
}

function repoStats() {
  if (!repoAnalyses.length) return { total: 0, avgScore: 0, passCount: 0, reviewCount: 0, blockCount: 0 };
  const avg = Math.round(repoAnalyses.reduce((s, a) => s + a.score, 0) / repoAnalyses.length);
  return {
    total:       repoAnalyses.length,
    avgScore:    avg,
    passCount:   repoAnalyses.filter(a => a.verdict === 'pass').length,
    reviewCount: repoAnalyses.filter(a => a.verdict === 'review').length,
    blockCount:  repoAnalyses.filter(a => a.verdict === 'block').length
  };
}

// ── Connected repos ───────────────────────────────────────────
function saveRepo(data) {
  const existing = repos.findIndex(r => String(r.projectId) === String(data.projectId));
  if (existing >= 0) repos[existing] = data;
  else repos.unshift(data);
}

function listRepos() { return repos; }

// ── OAuth user sessions ───────────────────────────────────────
/**
 * Save or update a logged-in user's session.
 * Key is GitLab user ID.
 */
function saveUser(userData) {
  users[String(userData.id)] = { ...userData, connectedAt: new Date().toISOString() };
  return users[String(userData.id)];
}

function getUser(userId) {
  return users[String(userId)] || null;
}

/**
 * Find a user by their OAuth session token.
 * Used to look up the token when a webhook arrives for their repo.
 */
function getUserByProjectId(projectId) {
  // Find which user owns this repo
  const repo = repos.find(r => String(r.projectId) === String(projectId));
  if (!repo?.userId) return null;
  return users[String(repo.userId)] || null;
}

function listUsers() {
  return Object.values(users);
}

module.exports = {
  // MR
  save, list, stats,
  // Repo
  saveRepoAnalysis, listRepoAnalyses, getLatestRepoAnalysis, repoStats,
  // Connected repos
  saveRepo, listRepos,
  // OAuth users
  saveUser, getUser, getUserByProjectId, listUsers
};