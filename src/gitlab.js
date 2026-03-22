const axios = require('axios');

// ── Axios client factory ──────────────────────────────────────
// Accepts an optional token — used for per-user OAuth tokens.
// Falls back to server-level GITLAB_TOKEN env var.
function gl(token) {
  const t = token || process.env.GITLAB_TOKEN;
  // OAuth tokens (gloas-...) need Authorization: Bearer
  // Personal access tokens (glpat-...) use PRIVATE-TOKEN header
  const isOAuth = t && t.startsWith('gloas-');
  return axios.create({
    baseURL: `${process.env.GITLAB_URL || 'https://gitlab.com'}/api/v4`,
    headers: {
      ...(isOAuth
        ? { 'Authorization': `Bearer ${t}` }
        : { 'PRIVATE-TOKEN': t }),
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });
}

// ── OAuth helpers ─────────────────────────────────────────────

/**
 * Build the GitLab OAuth authorization URL.
 * Redirect the user here to begin login.
 */
function getOAuthUrl() {
  const base        = process.env.GITLAB_URL || 'https://gitlab.com';
  const clientId    = process.env.GITLAB_OAUTH_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.GITLAB_OAUTH_REDIRECT_URI);
  const scopes      = encodeURIComponent('api read_user');
  return `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scopes}`;
}

/**
 * Exchange a one-time authorization code for an access token.
 * Called after GitLab redirects to /auth/gitlab/callback?code=...
 */
async function exchangeCodeForToken(code) {
  const base = process.env.GITLAB_URL || 'https://gitlab.com';
  console.log('[oauth] redirect_uri being sent:', process.env.GITLAB_OAUTH_REDIRECT_URI);
  console.log('[oauth] client_id being sent:', process.env.GITLAB_OAUTH_CLIENT_ID?.slice(0, 10) + '...');
  const payload = {
    client_id:     process.env.GITLAB_OAUTH_CLIENT_ID,
    client_secret: process.env.GITLAB_OAUTH_CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  process.env.GITLAB_OAUTH_REDIRECT_URI
  };
  try {
    const { data } = await axios.post(`${base}/oauth/token`, payload);
    return data;
  } catch (err) {
    console.error('[oauth] token exchange failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Get the currently authenticated user's profile.
 */
async function getAuthenticatedUser(token) {
  const { data } = await gl(token).get('/user');
  return data; // { id, username, name, email, avatar_url, ... }
}

// ── MR helpers ────────────────────────────────────────────────
async function getMRDiff(projectId, mrIid, token) {
  const { data } = await gl(token).get(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/diffs`
  );
  return data;
}

async function getMRDetails(projectId, mrIid, token) {
  const { data } = await gl(token).get(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`
  );
  return data;
}

async function getProjectDetails(projectId, token) {
  const { data } = await gl(token).get(`/projects/${encodeURIComponent(projectId)}`);
  return data;
}

// ── Fetch ALL owned projects for a user ───────────────────────
async function getUserProjects(token) {
  const projects = [];
  let page = 1;
  while (true) {
    const { data } = await gl(token).get('/projects', {
      params: { owned: true, per_page: 100, page, order_by: 'last_activity_at', sort: 'desc' }
    });
    if (!data.length) break;
    projects.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return projects;
}

// ── Repo-level helpers ────────────────────────────────────────
const CODE_EXTENSIONS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'java', 'kt', 'scala',
  'rs', 'c', 'cpp', 'h', 'cs', 'php',
  'vue', 'svelte', 'astro',
  'html', 'css', 'scss', 'less',
  'json', 'yaml', 'yml', 'toml',
  'md', 'txt', 'env.example', 'gitignore',
  'sql', 'graphql', 'proto', 'sh', 'bash',
  'dockerfile', 'makefile'
]);

function isCodeFile(path) {
  const lower = path.toLowerCase();
  const ext   = lower.split('.').pop();
  const base  = lower.split('/').pop();
  if (['dockerfile', 'makefile', 'procfile', 'readme'].some(k => base.startsWith(k))) return true;
  if (lower.includes('package-lock') || lower.includes('yarn.lock')) return false;
  if (lower.includes('.min.')) return false;
  if (lower.startsWith('dist/') || lower.startsWith('build/') || lower.startsWith('.git/')) return false;
  if (lower.includes('node_modules/')) return false;
  return CODE_EXTENSIONS.has(ext);
}

async function getRepoTree(projectId, ref = 'HEAD', token) {
  const items = [];
  let page = 1;
  while (true) {
    const { data } = await gl(token).get(
      `/projects/${encodeURIComponent(projectId)}/repository/tree`,
      { params: { ref, recursive: true, per_page: 100, page } }
    );
    if (!data.length) break;
    items.push(...data.filter(f => f.type === 'blob' && isCodeFile(f.path)));
    if (data.length < 100) break;
    page++;
  }
  return items;
}

const MAX_FILE_BYTES = 80_000;

async function getFileContent(projectId, filePath, ref = 'HEAD', token) {
  try {
    const { data } = await gl(token).get(
      `/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}`,
      { params: { ref } }
    );
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    return {
      path:    filePath,
      content: raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) + '\n// [truncated]' : raw,
      size:    data.size
    };
  } catch (err) {
    console.warn(`[gitlab] Could not fetch ${filePath}: ${err.message}`);
    return null;
  }
}

async function getRepoFiles(projectId, tree, ref = 'HEAD', token) {
  const results = [];
  const CHUNK = 6;
  for (let i = 0; i < tree.length; i += CHUNK) {
    const chunk   = tree.slice(i, i + CHUNK);
    const fetched = await Promise.all(chunk.map(f => getFileContent(projectId, f.path, ref, token)));
    results.push(...fetched.filter(Boolean));
  }
  return results;
}

async function getReadme(projectId, ref = 'HEAD', token) {
  for (const name of ['README.md', 'README.rst', 'README.txt', 'readme.md']) {
    try { return await getFileContent(projectId, name, ref, token); } catch {}
  }
  return null;
}

async function getCommits(projectId, ref = 'HEAD', limit = 5, token) {
  const { data } = await gl(token).get(
    `/projects/${encodeURIComponent(projectId)}/repository/commits`,
    { params: { ref_name: ref, per_page: limit } }
  );
  return data;
}

// ── Webhook registration ──────────────────────────────────────
async function registerWebhook(projectId, webhookUrl, secret, token) {
  try {
    const { data: existing } = await gl(token).get(
      `/projects/${encodeURIComponent(projectId)}/hooks`
    );
    for (const hook of existing) {
      if (hook.url.includes('/webhook/gitlab')) {
        await gl(token).delete(`/projects/${encodeURIComponent(projectId)}/hooks/${hook.id}`);
        console.log(`[gitlab] Removed old webhook ${hook.id}`);
      }
    }
  } catch {}

  const { data } = await gl(token).post(
    `/projects/${encodeURIComponent(projectId)}/hooks`,
    {
      url:                        webhookUrl,
      token:                      secret,
      merge_requests_events:      true,
      push_events:                true,
      tag_push_events:            false,
      issues_events:              false,
      confidential_issues_events: false,
      note_events:                false,
      confidential_note_events:   false,
      pipeline_events:            false,
      wiki_page_events:           false,
      enable_ssl_verification:    false
    }
  );
  return data;
}

// ── Comment builders ──────────────────────────────────────────
async function postMRComment(projectId, mrIid, analysis, token) {
  await gl(token).post(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`,
    { body: buildComment(analysis) }
  );
}

function buildComment({ score, verdict, summary, dimensions, recommendations, projection }) {
  const icon     = verdict === 'pass' ? '✅' : verdict === 'review' ? '⚠️' : '🚫';
  const colorDot = score >= 65 ? '🟩' : score >= 40 ? '🟨' : '🟥';
  const bar      = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));
  const imp      = { low: '🟢', medium: '🟡', high: '🔴' };
  const dimRows  = Object.entries(dimensions)
    .map(([k, v]) => `| ${imp[v.impact]} **${k.charAt(0).toUpperCase()+k.slice(1)}** | ${v.score}/100 | ${v.finding} |`)
    .join('\n');
  const recos = recommendations.length
    ? recommendations.map(r => `- **${r.line ? `Line ${r.line}: ` : ''}${r.issue}**\n  → ${r.fix}`).join('\n')
    : '- No specific refactors needed.';
  return `## 🌱 GreenAgent Sustainability Report\n\n${icon} **${verdict.toUpperCase()}** &nbsp;&nbsp; \`${score} / 100\`\n\n${colorDot} \`${bar}\` ${score}%\n\n> ${summary}\n\n---\n\n### Dimension Breakdown\n\n| Dimension | Score | Finding |\n|-----------|-------|------|\n${dimRows}\n\n---\n\n### Recommendations\n\n${recos}\n\n---\n\n### 6-Month Projection\n\n> 📅 ${projection}\n\n---\n<sub>Powered by **GreenAgent** · *Not "does it work?" but "will it hurt us?"*</sub>`;
}

async function postCommitComment(projectId, sha, analysis, token) {
  await gl(token).post(
    `/projects/${encodeURIComponent(projectId)}/repository/commits/${sha}/comments`,
    { note: buildRepoComment(analysis) }
  );
}

function buildRepoComment({ score, verdict, summary, dimensions, recommendations, projection, dependencyGraph }) {
  const icon     = verdict === 'pass' ? '✅' : verdict === 'review' ? '⚠️' : '🚫';
  const colorDot = score >= 65 ? '🟩' : score >= 40 ? '🟨' : '🟥';
  const bar      = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));
  const imp      = { low: '🟢', medium: '🟡', high: '🔴' };
  const dimRows  = Object.entries(dimensions)
    .map(([k, v]) => `| ${imp[v.impact]} **${k.charAt(0).toUpperCase()+k.slice(1)}** | ${v.score}/100 | ${v.finding} |`)
    .join('\n');
  const recos    = (recommendations || []).length
    ? recommendations.map(r => `- **${r.file ? `\`${r.file}\`: ` : ''}${r.issue}**\n  → ${r.fix}`).join('\n')
    : '- No specific refactors needed.';
  const hotNodes = (dependencyGraph?.nodes || [])
    .filter(n => n.status !== 'stable').slice(0, 5)
    .map(n => `- \`${n.id}\` — ${n.status} (${n.connections} connections)`).join('\n') || '- All files look stable.';
  return `## 🌱 GreenAgent Repo Sustainability Report\n\n${icon} **${verdict.toUpperCase()}** &nbsp;&nbsp; \`${score} / 100\`\n\n${colorDot} \`${bar}\` ${score}%\n\n> ${summary}\n\n---\n\n### Dimension Breakdown\n\n| Dimension | Score | Finding |\n|-----------|-------|------|\n${dimRows}\n\n---\n\n### Hotspot Files\n\n${hotNodes}\n\n---\n\n### Recommendations\n\n${recos}\n\n---\n\n### 6-Month Projection\n\n> 📅 ${projection}\n\n---\n<sub>Powered by **GreenAgent** · Whole-repo analysis</sub>`;
}

module.exports = {
  getOAuthUrl, exchangeCodeForToken, getAuthenticatedUser,
  getMRDiff, getMRDetails, getProjectDetails,
  getUserProjects,
  getRepoTree, getRepoFiles, getReadme, getFileContent, getCommits,
  registerWebhook,
  postMRComment, postCommitComment
};