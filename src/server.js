require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const crypto    = require('crypto');

const { analyzeDiff, analyzeRepo }                                          = require('./analyzer');
const { getOAuthUrl, exchangeCodeForToken, getAuthenticatedUser,
        getMRDiff, getMRDetails, getProjectDetails,
        getUserProjects, getRepoTree, getRepoFiles, getReadme, getCommits,
        registerWebhook, postMRComment, postCommitComment }                 = require('./gitlab');
const store                                                                 = require('./store');

const app = express();

app.set('trust proxy', 1); // required for Render/proxied deployments

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', rateLimit({ windowMs: 60_000, max: 120, validate: { xForwardedForHeader: false } }));

// ─────────────────────────────────────────────────────────────
// SSE — real-time push to dashboard
// ─────────────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
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
// OAUTH — Step 1: Redirect user to GitLab login
// GET /auth/gitlab → redirects to GitLab consent screen
// ─────────────────────────────────────────────────────────────
app.get('/auth/gitlab', (req, res) => {
  if (!process.env.GITLAB_OAUTH_CLIENT_ID) {
    return res.status(500).send('OAuth not configured. Add GITLAB_OAUTH_CLIENT_ID and GITLAB_OAUTH_CLIENT_SECRET to .env');
  }
  const url = getOAuthUrl();
  console.log(`[oauth] Redirecting to GitLab: ${url}`);
  res.redirect(url);
});

// ─────────────────────────────────────────────────────────────
// OAUTH — Step 2: GitLab redirects back with ?code=...
// GET /auth/gitlab/callback → exchange code → get user → register all repos
// ─────────────────────────────────────────────────────────────
app.get('/auth/gitlab/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('[oauth] GitLab returned error:', error);
    return res.redirect('/?oauth=error&msg=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.redirect('/?oauth=error&msg=no_code');
  }

  try {
    // Exchange code for token
    console.log('[oauth] Exchanging code for token...');
    const tokenData = await exchangeCodeForToken(code);
    const token     = tokenData.access_token;

    // Get user profile
    console.log('[oauth] Fetching user profile...');
    const glUser = await getAuthenticatedUser(token);
    console.log(`[oauth] ✅ Logged in as ${glUser.username} (${glUser.name})`);

    // Save user session
    store.saveUser({
      id:         glUser.id,
      username:   glUser.username,
      name:       glUser.name,
      email:      glUser.email,
      avatar_url: glUser.avatar_url,
      token
    });

    // Register webhooks on all owned repos in background
    registerAllRepos(glUser, token).catch(err =>
      console.error('[oauth/register-repos]', err.message)
    );

    // Redirect to dashboard with user info in query string
    const params = new URLSearchParams({
      oauth:    'success',
      userId:   glUser.id,
      username: glUser.username,
      name:     glUser.name,
      avatar:   glUser.avatar_url || ''
    });
    res.redirect(`/?${params.toString()}`);

  } catch (err) {
    console.error('[oauth/callback] Error:', err.response?.data || err.message);
    res.redirect('/?oauth=error&msg=' + encodeURIComponent(err.message));
  }
});

// ─────────────────────────────────────────────────────────────
// Background: register webhooks on all user repos
// ─────────────────────────────────────────────────────────────
async function registerAllRepos(glUser, token) {
  const baseUrl    = process.env.TUNNEL_URL || `http://localhost:${process.env.PORT || 3000}`;
  const webhookUrl = `${baseUrl}/webhook/gitlab`;
  const secret     = process.env.GITLAB_WEBHOOK_SECRET || crypto.randomBytes(16).toString('hex');

  console.log(`[oauth] Fetching all repos for ${glUser.username}...`);
  const projects = await getUserProjects(token);
  console.log(`[oauth] Found ${projects.length} repos`);

  for (const project of projects) {
    try {
      await registerWebhook(project.id, webhookUrl, secret, token);

      store.saveRepo({
        projectId:   project.id,
        namespace:   project.path_with_namespace,
        name:        project.name,
        userId:      glUser.id,
        username:    glUser.username,
        connectedAt: new Date().toISOString(),
        webhookUrl
      });

      broadcast('repo_connected', {
        projectId: project.id,
        namespace: project.path_with_namespace,
        name:      project.name,
        username:  glUser.username
      });

      console.log(`[oauth] ✅ Webhook registered: ${project.path_with_namespace}`);

      // Trigger initial scan
      processRepo({
        projectId:   project.id,
        projectName: project.path_with_namespace,
        ref:         project.default_branch || 'main',
        commitSha:   `oauth-connect-${Date.now()}`,
        token
      }).catch(err => console.error(`[oauth/scan] ${project.name}:`, err.message));

      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      console.error(`[oauth] Failed for ${project.path_with_namespace}:`, err.message);
    }
  }

  broadcast('account_synced', {
    username:  glUser.username,
    repoCount: projects.length
  });

  console.log(`[oauth] All repos registered for ${glUser.username}`);
}

// ─────────────────────────────────────────────────────────────
// /api/sync-repos — pick up any new repos since last login
// ─────────────────────────────────────────────────────────────
app.post('/api/sync-repos', async (req, res) => {
  const { userId } = req.body;
  const user = store.getUser(userId);
  if (!user) return res.status(401).json({ error: 'User not found. Please log in again.' });

  try {
    const baseUrl    = process.env.TUNNEL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const webhookUrl = `${baseUrl}/webhook/gitlab`;
    const secret     = process.env.GITLAB_WEBHOOK_SECRET || crypto.randomBytes(16).toString('hex');

    const projects    = await getUserProjects(user.token);
    const knownIds    = new Set(store.listRepos().map(r => String(r.projectId)));
    const newProjects = projects.filter(p => !knownIds.has(String(p.id)));

    console.log(`[sync-repos] ${projects.length} total, ${newProjects.length} new for ${user.username}`);

    res.json({ success: true, total: projects.length, newlyAdded: newProjects.length });

    for (const project of newProjects) {
      try {
        await registerWebhook(project.id, webhookUrl, secret, user.token);
        store.saveRepo({
          projectId:   project.id,
          namespace:   project.path_with_namespace,
          name:        project.name,
          userId:      user.id,
          username:    user.username,
          connectedAt: new Date().toISOString(),
          webhookUrl
        });
        broadcast('repo_connected', { projectId: project.id, namespace: project.path_with_namespace, name: project.name });

        processRepo({
          projectId:   project.id,
          projectName: project.path_with_namespace,
          ref:         project.default_branch || 'main',
          commitSha:   `sync-${Date.now()}`,
          token:       user.token
        }).catch(err => console.error(`[sync-repos/scan] ${project.name}:`, err.message));

        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        console.error(`[sync-repos] Failed for ${project.path_with_namespace}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[sync-repos] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GitLab Webhook — MR Hook + Push Hook
// ─────────────────────────────────────────────────────────────
app.post('/webhook/gitlab', async (req, res) => {
  const secret = process.env.GITLAB_WEBHOOK_SECRET;
  if (secret && req.headers['x-gitlab-token'] !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const event = req.headers['x-gitlab-event'];
  res.status(200).json({ received: true });

  // Look up the user token for this project
  const getToken = (projectId) => {
    const user = store.getUserByProjectId(projectId);
    return user?.token || process.env.GITLAB_TOKEN; // fallback to env token
  };

  if (event === 'Merge Request Hook') {
    const action    = req.body.object_attributes?.action;
    if (!['open', 'update', 'reopen'].includes(action)) return;
    const projectId = req.body.project?.id;
    const mrIid     = req.body.object_attributes?.iid;
    const mrTitle   = req.body.object_attributes?.title;
    const mrDesc    = req.body.object_attributes?.description;
    if (!projectId || !mrIid) return;
    processMR({ projectId, mrIid, mrTitle, mrDescription: mrDesc, token: getToken(projectId) })
      .catch(err => console.error(`[webhook/mr] MR !${mrIid}:`, err.message));

  } else if (event === 'Push Hook') {
    const projectId   = req.body.project?.id;
    const projectName = req.body.project?.path_with_namespace || req.body.project?.name;
    const ref         = (req.body.ref || 'refs/heads/main').replace('refs/heads/', '');
    const commitSha   = req.body.after;
    if (!projectId || !commitSha || commitSha === '0000000000000000000000000000000000000000') return;

    const existing = store.getLatestRepoAnalysis(projectId);
    if (existing && existing.commitSha === commitSha) {
      console.log(`[webhook/push] Already analysed ${commitSha.slice(0,7)} — skipping`);
      return;
    }

    // Auto-register if unknown
    const alreadyKnown = store.listRepos().find(r => String(r.projectId) === String(projectId));
    if (!alreadyKnown) {
      console.log(`[webhook/push] New repo detected — auto-registering ${projectName}`);
      store.saveRepo({
        projectId, namespace: projectName, name: projectName,
        connectedAt: new Date().toISOString(),
        webhookUrl: `${process.env.TUNNEL_URL}/webhook/gitlab`
      });
      broadcast('repo_connected', { projectId, namespace: projectName, name: projectName });
    }

    processRepo({ projectId, projectName, ref, commitSha, token: getToken(projectId) })
      .catch(err => console.error(`[webhook/push] Repo ${projectId}:`, err.message));
  }
});

// ─────────────────────────────────────────────────────────────
// MR analysis pipeline
// ─────────────────────────────────────────────────────────────
async function processMR({ projectId, mrIid, mrTitle, mrDescription, token }) {
  console.log(`\n🔍 [MR] Analyzing MR !${mrIid} (project: ${projectId})`);
  broadcast('analyzing', { kind: 'mr', projectId, mrIid, mrTitle });

  const diffs = await getMRDiff(projectId, mrIid, token);
  if (!diffs?.length) { console.log('⚠️  No diff — skipping'); return; }

  const diffText  = diffs.map(d => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`).join('\n\n');
  const filePaths = diffs.map(d => d.new_path || d.old_path);

  const analysis = await analyzeDiff({ diff: diffText, mrTitle, mrDescription, filePaths });
  console.log(`✅ [MR] Score: ${analysis.score}/100 — ${analysis.verdict.toUpperCase()}`);

  await postMRComment(projectId, mrIid, analysis, token);

  // Look up userId from repo so we can filter by user later
  const repo   = store.listRepos().find(r => String(r.projectId) === String(projectId));
  const userId = repo?.userId;
  const saved  = store.save({ projectId, mrIid, mrTitle, filePaths, userId, ...analysis });

  broadcast('analysis_complete', { kind: 'mr', ...saved, stats: store.stats() });
}

// ─────────────────────────────────────────────────────────────
// Repo analysis pipeline
// ─────────────────────────────────────────────────────────────
async function processRepo({ projectId, projectName, ref, commitSha, token }) {
  console.log(`\n🌳 [REPO] Full-repo analysis for ${projectName} @ ${ref}`);
  broadcast('repo_analyzing', { kind: 'repo', projectId, projectName, ref, commitSha });

  const tree = await getRepoTree(projectId, ref, token);
  console.log(`[repo] Found ${tree.length} code files`);
  if (tree.length === 0) { console.log('[repo] No code files — skipping'); return; }

  const MAX_FILES = 120;
  const capped    = tree.length > MAX_FILES ? prioritiseFiles(tree, MAX_FILES) : tree;
  if (tree.length > MAX_FILES) console.log(`[repo] Capped to ${MAX_FILES} files (was ${tree.length})`);

  const files = await getRepoFiles(projectId, capped, ref, token);
  console.log(`[repo] Fetched ${files.length} files`);

  const [readme, commits] = await Promise.all([
    getReadme(projectId, ref, token),
    getCommits(projectId, ref, 5, token).catch(() => [])
  ]);

  const analysis    = await analyzeRepo({ files, readme, repoName: projectName, ref, commits });
  analysis.commitSha = commitSha;
  console.log(`✅ [REPO] Score: ${analysis.score}/100 — ${analysis.verdict.toUpperCase()}`);

  try {
    await postCommitComment(projectId, commitSha, analysis, token);
    console.log(`[repo] Comment posted on commit ${commitSha.slice(0,7)}`);
  } catch (err) {
    console.warn(`[repo] Could not post commit comment: ${err.message}`);
  }

  // Look up userId from repo
  const repo   = store.listRepos().find(r => String(r.projectId) === String(projectId));
  const userId = repo?.userId;
  const saved  = store.saveRepoAnalysis({ projectId, projectName, ref, commitSha, fileCount: files.length, userId, ...analysis });

  broadcast('repo_analysis_complete', {
    kind: 'repo', id: saved.id, projectId, projectName, ref,
    score: analysis.score, verdict: analysis.verdict, summary: analysis.summary,
    fileCount: files.length,
    nodeCount: analysis.dependencyGraph.nodes.length,
    edgeCount: analysis.dependencyGraph.edges.length,
    hotspotFiles: analysis.hotspotFiles || [],
    analyzedAt: saved.analyzedAt
  });
}

function prioritiseFiles(tree, limit) {
  const score = (p) => {
    const l = p.toLowerCase();
    if (l.includes('index'))  return 10;
    if (l.includes('main'))   return 9;
    if (l.includes('app'))    return 8;
    if (l.includes('server')) return 8;
    if (l.includes('router') || l.includes('route')) return 7;
    if (l.includes('service')) return 6;
    if (l.includes('model') || l.includes('schema')) return 6;
    if (l.includes('config')) return 5;
    if (l.endsWith('.md'))    return 4;
    return 1;
  };
  return [...tree].sort((a,b) => score(b.path) - score(a.path)).slice(0, limit);
}

// ─────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────
app.get('/api/analyses', async (req, res) => {
  const { limit, projectId, userId } = req.query;
  let data = store.list({ limit: parseInt(limit)||50, projectId });
  if (userId) data = data.filter(a => String(a.userId) === String(userId));
  res.json(data);
});
app.get('/api/stats', async (req, res) => {
  const { userId } = req.query;
  if (userId) {
    const all = store.list({ limit: 200 }).filter(a => String(a.userId) === String(userId));
    if (!all.length) return res.json({ total:0, avgScore:0, passCount:0, reviewCount:0, blockCount:0, recentTrend:[] });
    const avg = Math.round(all.reduce((s,a) => s+a.score, 0) / all.length);
    return res.json({ total:all.length, avgScore:avg,
      passCount:   all.filter(a=>a.verdict==='pass').length,
      reviewCount: all.filter(a=>a.verdict==='review').length,
      blockCount:  all.filter(a=>a.verdict==='block').length,
      recentTrend: all.slice(0,10).map(a=>({score:a.score,at:a.analyzedAt}))
    });
  }
  res.json(store.stats());
});
app.get('/api/repo-analyses', async (req, res) => {
  const { limit, projectId, userId } = req.query;
  let data = store.listRepoAnalyses({ limit: parseInt(limit)||20, projectId });
  if (userId) data = data.filter(a => String(a.userId) === String(userId));
  res.json(data);
});
app.get('/api/repo-stats',       (req, res) => res.json(store.repoStats()));
app.get('/api/repos',            (req, res) => res.json(store.listRepos()));

app.get('/api/repo-analyses/latest', (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const result = store.getLatestRepoAnalysis(projectId);
  if (!result) return res.status(404).json({ error: 'No repo analysis found' });
  res.json(result);
});

app.post('/api/analyze-repo', async (req, res) => {
  const { projectId, ref = 'main', userId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  const token = store.getUser(userId)?.token || process.env.GITLAB_TOKEN;
  try {
    const project = await getProjectDetails(projectId, token);
    res.json({ started: true, projectName: project.name, ref });
    processRepo({ projectId, projectName: project.path_with_namespace, ref: project.default_branch || ref, commitSha: `manual-${Date.now()}`, token })
      .catch(err => console.error('[api/analyze-repo]', err.message));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/analyze', async (req, res) => {
  const { projectId, mrIid, userId } = req.body;
  if (!projectId || !mrIid) return res.status(400).json({ error: 'projectId and mrIid are required' });
  const token = store.getUser(userId)?.token || process.env.GITLAB_TOKEN;
  try {
    const mr = await getMRDetails(projectId, mrIid, token);
    res.json({ started: true, mrTitle: mr.title });
    processMR({ projectId, mrIid, mrTitle: mr.title, mrDescription: mr.description, token })
      .catch(err => console.error('[api/analyze]', err.message));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/repo-tree', async (req, res) => {
  const { projectId, ref = 'HEAD', userId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const token = store.getUser(userId)?.token || process.env.GITLAB_TOKEN;
  try {
    const tree = await getRepoTree(projectId, ref, token);
    res.json(tree.map(f => ({ path: f.path, name: f.path.split('/').pop(), type: 'blob' })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/repo-file', async (req, res) => {
  const { projectId, path: filePath, ref = 'HEAD', userId } = req.query;
  if (!projectId || !filePath) return res.status(400).json({ error: 'projectId and path required' });
  const token = store.getUser(userId)?.token || process.env.GITLAB_TOKEN;
  try {
    const file = await getFileContent(projectId, filePath, ref, token);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json({ path: file.path, content: file.content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/repo-diff', async (req, res) => {
  const { projectId, path: filePath, userId } = req.query;
  if (!projectId || !filePath) return res.status(400).json({ error: 'projectId and path required' });
  const token = store.getUser(userId)?.token || process.env.GITLAB_TOKEN;
  try {
    const analyses = store.list({ projectId, limit: 5 });
    for (const a of analyses) {
      if (a.mrIid) {
        const diffs = await getMRDiff(projectId, a.mrIid, token);
        const match = diffs.find(d => d.new_path === filePath || d.old_path === filePath);
        if (match) return res.json({ diff: match.diff || '' });
      }
    }
    res.json({ diff: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mr-diffs', async (req, res) => {
  const { projectId, mrIid, userId } = req.query;
  if (!projectId || !mrIid) return res.status(400).json({ error: 'projectId and mrIid required' });
  const token = store.getUser(userId)?.token || process.env.GITLAB_TOKEN;
  try {
    const diffs = await getMRDiff(projectId, mrIid, token);
    res.json(diffs.map(d => ({
      path: d.new_path || d.old_path, oldPath: d.old_path, newPath: d.new_path,
      diff: d.diff || '', newFile: d.new_file, deletedFile: d.deleted_file, renamedFile: d.renamed_file
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok', groq: !!process.env.GROQ_API_KEY,
  gitlab: !!process.env.GITLAB_TOKEN,
  oauth:  !!process.env.GITLAB_OAUTH_CLIENT_ID,
  uptime: Math.round(process.uptime()),
  tunnel: process.env.TUNNEL_URL || null
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🌱 GreenAgent running`);
  console.log(`   App     → http://localhost:${PORT}`);
  console.log(`   OAuth   → GET  /auth/gitlab`);
  console.log(`   Webhook → POST /webhook/gitlab`);
  console.log(`   Events  → GET  /api/events`);
  if (process.env.TUNNEL_URL) console.log(`   Tunnel  → ${process.env.TUNNEL_URL}`);
  else console.log(`   ⚠️  Set TUNNEL_URL in .env\n`);
  if (!process.env.GITLAB_OAUTH_CLIENT_ID) console.log(`   ⚠️  OAuth not configured — add GITLAB_OAUTH_CLIENT_ID + GITLAB_OAUTH_CLIENT_SECRET to .env`);
});