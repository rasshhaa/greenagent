require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const crypto    = require('crypto');

const { analyzeDiff, analyzeRepo }                                    = require('./analyzer');
const { getMRDiff, getMRDetails, getProjectDetails,
        getRepoTree, getRepoFiles, getReadme, getCommits,
        registerWebhook, postMRComment, postCommitComment }           = require('./gitlab');
const store                                                           = require('./store');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', rateLimit({ windowMs: 60_000, max: 60 }));

// ─────────────────────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  sseClients.add(res);
  console.log(`[sse] Client connected — ${sseClients.size} total`);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => { try { client.write(msg); } catch {} });
}

// ─────────────────────────────────────────────────────────────
// /api/connect
// ─────────────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { namespace, email } = req.body;
  if (!namespace || !email) {
    return res.status(400).json({ error: 'namespace and email are required' });
  }
  try {
    const project    = await getProjectDetails(namespace);
    const baseUrl    = process.env.TUNNEL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const webhookUrl = `${baseUrl}/webhook/gitlab`;
    const secret     = process.env.GITLAB_WEBHOOK_SECRET || crypto.randomBytes(16).toString('hex');

    await registerWebhook(project.id, webhookUrl, secret);
    console.log(`[connect] ✅ Webhook registered for ${project.path_with_namespace}`);

    store.saveRepo({
      projectId:   project.id,
      namespace:   project.path_with_namespace,
      name:        project.name,
      email,
      connectedAt: new Date().toISOString(),
      webhookUrl
    });

    broadcast('repo_connected', {
      projectId: project.id,
      namespace: project.path_with_namespace,
      name:      project.name
    });

    res.json({
      success:   true,
      projectId: project.id,
      name:      project.name,
      namespace: project.path_with_namespace,
      webhookUrl
    });
  } catch (err) {
    console.error('[connect] Error:', err.response?.data || err.message);
    const status  = err.response?.status;
    const message =
      status === 404 ? `Repo "${namespace}" not found.` :
      status === 401 ? 'GitLab token is invalid or missing api scope.' :
      status === 403 ? `No access to "${namespace}".` :
      err.message;
    res.status(400).json({ error: message });
  }
});

// ─────────────────────────────────────────────────────────────
// GitLab Webhook — handles both MR events AND push events
// ─────────────────────────────────────────────────────────────
app.post('/webhook/gitlab', async (req, res) => {
  const secret = process.env.GITLAB_WEBHOOK_SECRET;
  if (secret && req.headers['x-gitlab-token'] !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const event = req.headers['x-gitlab-event'];
  res.status(200).json({ received: true });

  if (event === 'Merge Request Hook') {
    // ── MR-level analysis (file diff) ──
    const action    = req.body.object_attributes?.action;
    if (!['open', 'update', 'reopen'].includes(action)) return;

    const projectId = req.body.project?.id;
    const mrIid     = req.body.object_attributes?.iid;
    const mrTitle   = req.body.object_attributes?.title;
    const mrDesc    = req.body.object_attributes?.description;
    if (!projectId || !mrIid) return;

    processMR({ projectId, mrIid, mrTitle, mrDescription: mrDesc })
      .catch(err => console.error(`[webhook/mr] MR !${mrIid}:`, err.message));

  } else if (event === 'Push Hook') {
    // ── Repo-level analysis (full codebase) ──
    const projectId   = req.body.project?.id;
    const projectName = req.body.project?.name || req.body.project?.path_with_namespace;
    const ref         = (req.body.ref || 'refs/heads/main').replace('refs/heads/', '');
    const commitSha   = req.body.after; // latest commit SHA

    if (!projectId || !commitSha || commitSha === '0000000000000000000000000000000000000000') return;

    // Debounce: don't re-analyse the same commit twice
    const existing = store.getLatestRepoAnalysis(projectId);
    if (existing && existing.commitSha === commitSha) {
      console.log(`[webhook/push] Already analysed ${commitSha.slice(0,7)} — skipping`);
      return;
    }

    processRepo({ projectId, projectName, ref, commitSha })
      .catch(err => console.error(`[webhook/push] Repo ${projectId}:`, err.message));
  }
});

// ─────────────────────────────────────────────────────────────
// MR analysis pipeline (unchanged from before)
// ─────────────────────────────────────────────────────────────
async function processMR({ projectId, mrIid, mrTitle, mrDescription }) {
  console.log(`\n🔍 [MR] Analyzing MR !${mrIid} (project: ${projectId})`);
  broadcast('analyzing', { kind: 'mr', projectId, mrIid, mrTitle });

  const diffs = await getMRDiff(projectId, mrIid);
  if (!diffs?.length) { console.log('⚠️  No diff — skipping'); return; }

  const diffText  = diffs.map(d => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`).join('\n\n');
  const filePaths = diffs.map(d => d.new_path || d.old_path);

  const analysis = await analyzeDiff({ diff: diffText, mrTitle, mrDescription, filePaths });
  console.log(`✅ [MR] Score: ${analysis.score}/100 — ${analysis.verdict.toUpperCase()}`);

  await postMRComment(projectId, mrIid, analysis);
  const saved = store.save({ projectId, mrIid, mrTitle, filePaths, ...analysis });
  broadcast('analysis_complete', { kind: 'mr', ...saved, stats: store.stats() });
}

// ─────────────────────────────────────────────────────────────
// Repo analysis pipeline (NEW)
// ─────────────────────────────────────────────────────────────
async function processRepo({ projectId, projectName, ref, commitSha }) {
  console.log(`\n🌳 [REPO] Starting full-repo analysis for ${projectName} @ ${ref}`);
  broadcast('repo_analyzing', { kind: 'repo', projectId, projectName, ref, commitSha });

  // 1. Fetch full file tree
  const tree = await getRepoTree(projectId, ref);
  console.log(`[repo] Found ${tree.length} code files`);

  if (tree.length === 0) {
    console.log('[repo] No code files found — skipping');
    return;
  }

  // Cap at 120 files to stay within LLM context and reasonable time
  const MAX_FILES = 120;
  const capped = tree.length > MAX_FILES
    ? prioritiseFiles(tree, MAX_FILES)
    : tree;
  if (tree.length > MAX_FILES) {
    console.log(`[repo] Capped to ${MAX_FILES} priority files (was ${tree.length})`);
  }

  // 2. Fetch file contents concurrently
  const files = await getRepoFiles(projectId, capped, ref);
  console.log(`[repo] Fetched ${files.length} files`);

  // 3. Fetch README and recent commits for context
  const [readme, commits] = await Promise.all([
    getReadme(projectId, ref),
    getCommits(projectId, ref, 5).catch(() => [])
  ]);

  // 4. Run analysis
  const analysis = await analyzeRepo({
    files,
    readme,
    repoName: projectName,
    ref,
    commits
  });

  analysis.commitSha = commitSha;
  console.log(`✅ [REPO] Score: ${analysis.score}/100 — ${analysis.verdict.toUpperCase()}`);
  console.log(`   Graph: ${analysis.dependencyGraph.nodes.length} nodes, ${analysis.dependencyGraph.edges.length} edges`);

  // 5. Post commit comment on GitLab
  try {
    await postCommitComment(projectId, commitSha, analysis);
    console.log(`[repo] Comment posted on commit ${commitSha.slice(0,7)}`);
  } catch (err) {
    console.warn(`[repo] Could not post commit comment: ${err.message}`);
  }

  // 6. Save and broadcast
  const saved = store.saveRepoAnalysis({
    projectId,
    projectName,
    ref,
    commitSha,
    fileCount: files.length,
    ...analysis
  });

  broadcast('repo_analysis_complete', {
    kind: 'repo',
    id:           saved.id,
    projectId,
    projectName,
    ref,
    score:        analysis.score,
    verdict:      analysis.verdict,
    summary:      analysis.summary,
    fileCount:    files.length,
    nodeCount:    analysis.dependencyGraph.nodes.length,
    edgeCount:    analysis.dependencyGraph.edges.length,
    hotspotFiles: analysis.hotspotFiles || [],
    analyzedAt:   saved.analyzedAt
  });
}

/**
 * When there are too many files, prioritise by likely importance:
 * entry points, high-level config, then alphabetically.
 */
function prioritiseFiles(tree, limit) {
  const score = (p) => {
    const l = p.toLowerCase();
    if (l.includes('index'))         return 10;
    if (l.includes('main'))          return 9;
    if (l.includes('app'))           return 8;
    if (l.includes('server'))        return 8;
    if (l.includes('router') || l.includes('route')) return 7;
    if (l.includes('service'))       return 6;
    if (l.includes('model') || l.includes('schema')) return 6;
    if (l.includes('config'))        return 5;
    if (l.endsWith('.md'))           return 4;
    return 1;
  };
  return [...tree].sort((a,b) => score(b.path) - score(a.path)).slice(0, limit);
}

// ─────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────

// MR analyses
app.get('/api/analyses', (req, res) => {
  res.json(store.list({
    limit:     parseInt(req.query.limit) || 50,
    projectId: req.query.projectId
  }));
});

app.get('/api/stats', (req, res) => res.json(store.stats()));

// Repo analyses
app.get('/api/repo-analyses', (req, res) => {
  res.json(store.listRepoAnalyses({
    limit:     parseInt(req.query.limit) || 20,
    projectId: req.query.projectId
  }));
});

app.get('/api/repo-analyses/latest', (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const result = store.getLatestRepoAnalysis(projectId);
  if (!result) return res.status(404).json({ error: 'No repo analysis found' });
  res.json(result);
});

app.get('/api/repo-stats', (req, res) => res.json(store.repoStats()));

// Manually trigger repo analysis (for dashboard "Analyze Repo" button)
app.post('/api/analyze-repo', async (req, res) => {
  const { projectId, ref = 'main' } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  try {
    const project = await getProjectDetails(projectId);
    res.json({ started: true, projectName: project.name, ref });
    processRepo({
      projectId,
      projectName: project.path_with_namespace,
      ref:         project.default_branch || ref,
      commitSha:   `manual-${Date.now()}`
    }).catch(err => console.error('[api/analyze-repo]', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MR manual trigger
app.post('/api/analyze', async (req, res) => {
  const { projectId, mrIid } = req.body;
  if (!projectId || !mrIid) {
    return res.status(400).json({ error: 'projectId and mrIid are required' });
  }
  try {
    const mr = await getMRDetails(projectId, mrIid);
    res.json({ started: true, mrTitle: mr.title });
    processMR({ projectId, mrIid, mrTitle: mr.title, mrDescription: mr.description })
      .catch(err => console.error('[api/analyze]', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/repos', (req, res) => res.json(store.listRepos()));

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  groq:   !!process.env.GROQ_API_KEY,
  gitlab: !!process.env.GITLAB_TOKEN,
  uptime: Math.round(process.uptime()),
  tunnel: process.env.TUNNEL_URL || null
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🌱 GreenAgent running`);
  console.log(`   App          → http://localhost:${PORT}`);
  console.log(`   MR Webhook   → POST /webhook/gitlab  (Merge Request Hook)`);
  console.log(`   Push Webhook → POST /webhook/gitlab  (Push Hook)`);
  console.log(`   Events (SSE) → GET  /api/events`);
  if (process.env.TUNNEL_URL) {
    console.log(`   Tunnel       → ${process.env.TUNNEL_URL}`);
  } else {
    console.log(`   ⚠️  Set TUNNEL_URL in .env once localtunnel/ngrok is running\n`);
  }
});