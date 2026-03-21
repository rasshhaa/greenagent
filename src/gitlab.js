const axios = require('axios');

function gl() {
  return axios.create({
    baseURL: `${process.env.GITLAB_URL || 'https://gitlab.com'}/api/v4`,
    headers: {
      'PRIVATE-TOKEN': process.env.GITLAB_TOKEN,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });
}

// ── MR helpers (unchanged) ────────────────────────────────────
async function getMRDiff(projectId, mrIid) {
  const { data } = await gl().get(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/diffs`
  );
  return data;
}

async function getMRDetails(projectId, mrIid) {
  const { data } = await gl().get(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`
  );
  return data;
}

async function getProjectDetails(projectId) {
  const { data } = await gl().get(`/projects/${encodeURIComponent(projectId)}`);
  return data;
}

// ── Repo-level helpers (NEW) ──────────────────────────────────

/**
 * List every file in a repo at a given ref (default: HEAD).
 * Returns flat array of { id, name, type, path, mode }
 * We filter to code + doc files only (skip binaries/locks etc.)
 */
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
  // always include README, Dockerfile, Makefile etc.
  if (['dockerfile', 'makefile', 'procfile', 'readme'].some(k => base.startsWith(k))) return true;
  // skip package-lock, yarn.lock, .min.js, dist/
  if (lower.includes('package-lock') || lower.includes('yarn.lock')) return false;
  if (lower.includes('.min.')) return false;
  if (lower.startsWith('dist/') || lower.startsWith('build/') || lower.startsWith('.git/')) return false;
  if (lower.includes('node_modules/')) return false;
  return CODE_EXTENSIONS.has(ext);
}

async function getRepoTree(projectId, ref = 'HEAD') {
  const items = [];
  let page = 1;
  // GitLab paginates at 100 per page; keep fetching until done
  while (true) {
    const { data } = await gl().get(
      `/projects/${encodeURIComponent(projectId)}/repository/tree`, {
        params: { ref, recursive: true, per_page: 100, page }
      }
    );
    if (!data.length) break;
    items.push(...data.filter(f => f.type === 'blob' && isCodeFile(f.path)));
    if (data.length < 100) break;
    page++;
  }
  return items; // [{ id, name, type:'blob', path, mode }]
}

/**
 * Fetch a single file's raw content (base64-decoded).
 * Returns { path, content, size } or null on error.
 * We cap at 80 KB per file to stay within LLM context.
 */
const MAX_FILE_BYTES = 80_000;

async function getFileContent(projectId, filePath, ref = 'HEAD') {
  try {
    const { data } = await gl().get(
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

/**
 * Fetch multiple files concurrently (rate-limited to 6 at a time).
 */
async function getRepoFiles(projectId, tree, ref = 'HEAD') {
  const results = [];
  const CHUNK = 6;
  for (let i = 0; i < tree.length; i += CHUNK) {
    const chunk = tree.slice(i, i + CHUNK);
    const fetched = await Promise.all(chunk.map(f => getFileContent(projectId, f.path, ref)));
    results.push(...fetched.filter(Boolean));
  }
  return results;
}

/**
 * Get the README content specifically (for project context).
 */
async function getReadme(projectId, ref = 'HEAD') {
  for (const name of ['README.md', 'README.rst', 'README.txt', 'readme.md']) {
    try {
      return await getFileContent(projectId, name, ref);
    } catch {}
  }
  return null;
}

/**
 * Get the last N commits on a branch.
 */
async function getCommits(projectId, ref = 'HEAD', limit = 5) {
  const { data } = await gl().get(
    `/projects/${encodeURIComponent(projectId)}/repository/commits`,
    { params: { ref_name: ref, per_page: limit } }
  );
  return data;
}

// ── Auto-register webhook ─────────────────────────────────────
async function registerWebhook(projectId, webhookUrl, secret) {
  try {
    const { data: existing } = await gl().get(
      `/projects/${encodeURIComponent(projectId)}/hooks`
    );
    for (const hook of existing) {
      if (hook.url.includes('/webhook/gitlab')) {
        await gl().delete(`/projects/${encodeURIComponent(projectId)}/hooks/${hook.id}`);
        console.log(`[gitlab] Removed old webhook ${hook.id}`);
      }
    }
  } catch {}

  const { data } = await gl().post(
    `/projects/${encodeURIComponent(projectId)}/hooks`,
    {
      url:                        webhookUrl,
      token:                      secret,
      merge_requests_events:      true,
      push_events:                true,   // ← now also listen to pushes
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

// ── MR comment builder ────────────────────────────────────────
async function postMRComment(projectId, mrIid, analysis) {
  await gl().post(
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`,
    { body: buildComment(analysis) }
  );
}

function buildComment({ score, verdict, summary, dimensions, recommendations, projection }) {
  const icon     = verdict === 'pass' ? '✅' : verdict === 'review' ? '⚠️' : '🚫';
  const colorDot = score >= 65 ? '🟩' : score >= 40 ? '🟨' : '🟥';
  const bar      = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));
  const imp      = { low: '🟢', medium: '🟡', high: '🔴' };

  const dimRows = Object.entries(dimensions)
    .map(([k, v]) =>
      `| ${imp[v.impact]} **${k.charAt(0).toUpperCase() + k.slice(1)}** | ${v.score}/100 | ${v.finding} |`
    ).join('\n');

  const recos = recommendations.length
    ? recommendations.map(r => `- **${r.line ? `Line ${r.line}: ` : ''}${r.issue}**\n  → ${r.fix}`).join('\n')
    : '- No specific refactors needed.';

  return `## 🌱 GreenAgent Sustainability Report

${icon} **${verdict.toUpperCase()}** &nbsp;&nbsp; \`${score} / 100\`

${colorDot} \`${bar}\` ${score}%

> ${summary}

---

### Dimension Breakdown

| Dimension | Score | Finding |
|-----------|-------|---------|
${dimRows}

---

### Recommendations

${recos}

---

### 6-Month Projection

> 📅 ${projection}

---
<sub>Powered by **GreenAgent** · *Not "does it work?" but "will it hurt us?"*</sub>`;
}

/**
 * Post a repo-level analysis as a commit comment on the latest commit.
 */
async function postCommitComment(projectId, sha, analysis) {
  await gl().post(
    `/projects/${encodeURIComponent(projectId)}/repository/commits/${sha}/comments`,
    { note: buildRepoComment(analysis) }
  );
}

function buildRepoComment({ score, verdict, summary, dimensions, recommendations, projection, dependencyGraph }) {
  const icon     = verdict === 'pass' ? '✅' : verdict === 'review' ? '⚠️' : '🚫';
  const colorDot = score >= 65 ? '🟩' : score >= 40 ? '🟨' : '🟥';
  const bar      = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));
  const imp      = { low: '🟢', medium: '🟡', high: '🔴' };

  const dimRows = Object.entries(dimensions)
    .map(([k, v]) =>
      `| ${imp[v.impact]} **${k.charAt(0).toUpperCase() + k.slice(1)}** | ${v.score}/100 | ${v.finding} |`
    ).join('\n');

  const recos = (recommendations || []).length
    ? recommendations.map(r => `- **${r.file ? `\`${r.file}\`: ` : ''}${r.issue}**\n  → ${r.fix}`).join('\n')
    : '- No specific refactors needed.';

  const hotNodes = (dependencyGraph?.nodes || [])
    .filter(n => n.status !== 'stable')
    .slice(0, 5)
    .map(n => `- \`${n.id}\` — ${n.status} (${n.connections} connections)`)
    .join('\n') || '- All files look stable.';

  return `## 🌱 GreenAgent Repo Sustainability Report

${icon} **${verdict.toUpperCase()}** &nbsp;&nbsp; \`${score} / 100\`

${colorDot} \`${bar}\` ${score}%

> ${summary}

---

### Dimension Breakdown

| Dimension | Score | Finding |
|-----------|-------|---------|
${dimRows}

---

### Hotspot Files

${hotNodes}

---

### Recommendations

${recos}

---

### 6-Month Projection

> 📅 ${projection}

---
<sub>Powered by **GreenAgent** · Whole-repo analysis · *Not "does it work?" but "will it hurt us?"*</sub>`;
}

module.exports = {
  getMRDiff, getMRDetails, getProjectDetails,
  getRepoTree, getRepoFiles, getReadme, getFileContent, getCommits,
  registerWebhook,
  postMRComment, postCommitComment
};