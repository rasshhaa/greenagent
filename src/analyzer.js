const Groq = require('groq-sdk');

let _client = null;
function getClient() {
  if (!_client) _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _client;
}

const MODEL = 'llama-3.3-70b-versatile';

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────────────────────────

const MR_SYSTEM_PROMPT = `You are GreenAgent — an AI that evaluates code diffs for long-term sustainability.

Your job is NOT to check if code works today. You ask:
"Will this code hurt us architecturally, energetically, or in terms of technical debt 6 months from now?"

Analyze four dimensions:
1. ENERGY       — Unbounded loops, N+1 queries, missing caching, sync I/O in hot paths, heavy computation without memoization
2. DEBT         — Coupling, duplication, missing abstractions, patterns that will be hard to change later
3. SCALABILITY  — Bottlenecks, missing pagination, blocking operations at 5× or 10× load
4. ARCHITECTURE — God objects, bypassed separation of concerns, modularity violations, hidden dependencies

Respond ONLY with a valid JSON object. No markdown fences, no preamble, nothing outside the JSON.

{
  "score": <integer 0-100>,
  "verdict": "pass" | "review" | "block",
  "summary": "<1-2 sentence plain-English summary>",
  "dimensions": {
    "energy":       { "score": <0-100>, "finding": "<specific finding or 'No issues found'>", "impact": "low"|"medium"|"high" },
    "debt":         { "score": <0-100>, "finding": "<specific finding or 'No issues found'>", "impact": "low"|"medium"|"high" },
    "scalability":  { "score": <0-100>, "finding": "<specific finding or 'No issues found'>", "impact": "low"|"medium"|"high" },
    "architecture": { "score": <0-100>, "finding": "<specific finding or 'No issues found'>", "impact": "low"|"medium"|"high" }
  },
  "recommendations": [
    { "line": <line number or null>, "issue": "<what the problem is>", "fix": "<concrete actionable suggestion>" }
  ],
  "projection": "<1 sentence on what this code will cost or save 6 months from now>"
}

Score guide: 80-100 Pass, 65-79 Review (minor), 40-64 Review (moderate), 0-39 Block.
Be specific. Reference actual patterns in the diff.`;

const REPO_SYSTEM_PROMPT = `You are GreenAgent — an AI that evaluates an entire codebase for long-term sustainability.

You are given:
1. Every source file in the repository (with content)
2. A dependency map showing which files import which other files
3. The README / project description

Your job: assess the WHOLE SYSTEM — not individual files, but how they work together.
Ask: "Will this architecture hurt us in energy, debt, or scalability 6 months from now?"

Analyze four dimensions:
1. ENERGY       — Inefficient patterns across the codebase: repeated DB calls, missing caching layers, heavy sync operations, N+1 query patterns at the repo level
2. DEBT         — Cross-file coupling, circular dependencies, god modules with too many dependents, missing abstraction layers, inconsistent patterns across files
3. SCALABILITY  — Architectural bottlenecks, shared mutable state, missing queues/workers for heavy ops, monolithic coupling that prevents horizontal scaling
4. ARCHITECTURE — Overall structure health: separation of concerns, layering (routes/services/data), single-responsibility adherence, testability signals

Also identify HOTSPOT FILES — files that are:
- Most heavily depended upon (high in-degree)
- Doing too many things (high out-degree imports)  
- Containing the riskiest patterns
- Most likely to cause cascading failures

Respond ONLY with valid JSON. No markdown fences, no preamble, nothing outside JSON.

{
  "score": <integer 0-100>,
  "verdict": "pass" | "review" | "block",
  "summary": "<2-3 sentence plain-English summary of the whole codebase health>",
  "dimensions": {
    "energy":       { "score": <0-100>, "finding": "<specific cross-file finding>", "impact": "low"|"medium"|"high" },
    "debt":         { "score": <0-100>, "finding": "<specific cross-file finding>", "impact": "low"|"medium"|"high" },
    "scalability":  { "score": <0-100>, "finding": "<specific cross-file finding>", "impact": "low"|"medium"|"high" },
    "architecture": { "score": <0-100>, "finding": "<specific cross-file finding>", "impact": "low"|"medium"|"high" }
  },
  "hotspotFiles": [
    {
      "path": "<file path>",
      "risk": "high" | "medium" | "low",
      "reason": "<why this file is a hotspot>",
      "suggestion": "<what to do about it>"
    }
  ],
  "recommendations": [
    { "file": "<path or null for global>", "issue": "<cross-file problem>", "fix": "<concrete suggestion>" }
  ],
  "projection": "<2 sentences on what this codebase will cost or save 6 months from now if left as-is>"
}

Score guide: 80-100 Pass, 65-79 Review (minor), 40-64 Review (moderate), 0-39 Block.`;

// ─────────────────────────────────────────────────────────────
// DEPENDENCY GRAPH EXTRACTION (static analysis, no runtime)
// ─────────────────────────────────────────────────────────────

/**
 * Extract import/require relationships from file content.
 * Returns array of { from: filePath, to: rawImportPath }
 * Works for JS/TS/Python/Go/Ruby/Rust etc.
 */
function extractImports(filePath, content) {
  const imports = [];
  const ext = filePath.split('.').pop().toLowerCase();

  if (['js','ts','jsx','tsx','mjs','cjs'].includes(ext)) {
    // ES6 import ... from '...'
    const esImport = /import\s+(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = esImport.exec(content)) !== null) imports.push(m[1]);
    // CommonJS require('...')
    const cjsReq = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = cjsReq.exec(content)) !== null) imports.push(m[1]);
  } else if (ext === 'py') {
    const pyFrom = /from\s+([\w.]+)\s+import/g;
    const pyImp  = /^import\s+([\w.]+)/gm;
    let m;
    while ((m = pyFrom.exec(content)) !== null) imports.push(m[1].replace(/\./g, '/'));
    while ((m = pyImp.exec(content))  !== null) imports.push(m[1].replace(/\./g, '/'));
  } else if (ext === 'go') {
    const goImp = /"([^"]+)"/g;
    const inBlock = content.match(/import\s*\(([\s\S]*?)\)/);
    if (inBlock) { let m; while ((m = goImp.exec(inBlock[1])) !== null) imports.push(m[1]); }
    const single = /import\s+"([^"]+)"/g;
    let m;
    while ((m = single.exec(content)) !== null) imports.push(m[1]);
  } else if (ext === 'rb') {
    const rbReq = /require_relative\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = rbReq.exec(content)) !== null) imports.push(m[1]);
  } else if (['java','kt','scala','cs'].includes(ext)) {
    const javaImp = /^import\s+([\w.]+);/gm;
    let m;
    while ((m = javaImp.exec(content)) !== null) imports.push(m[1].replace(/\./g, '/'));
  } else if (ext === 'rs') {
    const rsUse = /^use\s+([\w:]+)/gm;
    let m;
    while ((m = rsUse.exec(content)) !== null) imports.push(m[1].replace(/::/g, '/'));
  }

  return imports;
}

/**
 * Resolve a raw import path to an actual file path in the repo.
 * e.g. './store' from 'src/server.js' → 'src/store.js'
 */
function resolveImport(fromFile, rawImport, allPaths) {
  // Only try to resolve relative imports — skip npm packages
  if (!rawImport.startsWith('.') && !rawImport.startsWith('/')) return null;

  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  // Build candidate path
  const joined = fromDir ? `${fromDir}/${rawImport}` : rawImport;

  // Normalize: remove ../ and ./
  const parts = [];
  for (const part of joined.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const base = parts.join('/');

  // Try exact match, then with common extensions
  for (const candidate of [
    base,
    `${base}.js`, `${base}.ts`, `${base}.jsx`, `${base}.tsx`,
    `${base}/index.js`, `${base}/index.ts`, `${base}/index.jsx`,
    `${base}.py`, `${base}.go`, `${base}.rb`
  ]) {
    if (allPaths.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a full dependency graph from repo files.
 * Returns { nodes: [...], edges: [...] }
 * This is the REAL graph — not fake architecture nodes.
 */
function buildDependencyGraph(files) {
  const allPaths = new Set(files.map(f => f.path));
  const edgeSet  = new Set(); // deduplicate
  const rawEdges = []; // { source, target, weight }

  // In-degree and out-degree per file
  const inDegree  = {};
  const outDegree = {};
  files.forEach(f => { inDegree[f.path] = 0; outDegree[f.path] = 0; });

  files.forEach(file => {
    const imports = extractImports(file.path, file.content);
    imports.forEach(raw => {
      const resolved = resolveImport(file.path, raw, allPaths);
      if (resolved && resolved !== file.path) {
        const key = `${file.path}→${resolved}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          rawEdges.push({ source: file.path, target: resolved, weight: 0.8 });
          outDegree[file.path]  = (outDegree[file.path]  || 0) + 1;
          inDegree[resolved]    = (inDegree[resolved]    || 0) + 1;
        }
      }
    });
  });

  // Determine node status based on connectivity
  const nodes = files.map(f => {
    const inD  = inDegree[f.path]  || 0;
    const outD = outDegree[f.path] || 0;
    const total = inD + outD;

    // High in-degree = heavily depended upon = high risk if changed
    // High out-degree = depends on many things = fragile
    let status = 'stable';
    if (inD >= 3)           status = 'affected';   // hub — many depend on it
    if (inD >= 5 || outD >= 6) status = 'changed'; // hotspot — very high coupling

    // Shorten label for display: take last 2 path segments
    const parts = f.path.split('/');
    const label = parts.length > 2 ? parts.slice(-2).join('/') : f.path;

    return {
      id:          f.path,        // full path (unique key)
      label,                      // display label
      layer:       inferLayer(f.path),
      status,
      connections: total,
      inDegree:    inD,
      outDegree:   outD,
      size:        f.size || f.content.length
    };
  });

  return { nodes, edges: rawEdges };
}

/**
 * Infer an architectural layer from a file path.
 * Used for grouping/coloring in the graph.
 */
function inferLayer(filePath) {
  const p = filePath.toLowerCase();
  if (p.includes('route') || p.includes('controller') || p.includes('handler')) return 'route';
  if (p.includes('service') || p.includes('usecase') || p.includes('business')) return 'service';
  if (p.includes('model') || p.includes('schema') || p.includes('entity'))      return 'model';
  if (p.includes('repo') || p.includes('store') || p.includes('db') || p.includes('database')) return 'data';
  if (p.includes('middleware') || p.includes('auth') || p.includes('guard'))    return 'middleware';
  if (p.includes('util') || p.includes('helper') || p.includes('lib'))          return 'util';
  if (p.includes('config') || p.includes('.env') || p.includes('setting'))      return 'config';
  if (p.includes('test') || p.includes('spec') || p.includes('__test__'))       return 'test';
  if (p.includes('public') || p.includes('static') || p.includes('asset'))      return 'static';
  if (p.endsWith('.md') || p.endsWith('.txt'))                                   return 'doc';
  if (p.includes('index'))                                                        return 'entry';
  return 'module';
}

// ─────────────────────────────────────────────────────────────
// CONTEXT BUILDER — condense repo for LLM prompt
// ─────────────────────────────────────────────────────────────

const MAX_CONTEXT_CHARS = 60_000; // Groq 70B has 128k context; leave room for output

/**
 * Build a condensed text representation of the repo for the LLM.
 * Prioritises: README, high-connectivity files, then fills budget.
 */
function buildRepoContext(files, graph, readme) {
  const parts = [];
  let budget  = MAX_CONTEXT_CHARS;

  // 1. README first (project intent)
  if (readme) {
    const chunk = `=== README ===\n${readme.content.slice(0, 3000)}\n`;
    parts.push(chunk); budget -= chunk.length;
  }

  // 2. Dependency summary
  const depSummary = buildDepSummary(graph);
  parts.push(depSummary); budget -= depSummary.length;

  // 3. Files sorted by connectivity (hotspots first, then rest)
  const sorted = [...files].sort((a, b) => {
    const na = graph.nodes.find(n => n.id === a.path);
    const nb = graph.nodes.find(n => n.id === b.path);
    return (nb?.connections || 0) - (na?.connections || 0);
  });

  for (const file of sorted) {
    if (budget <= 0) break;
    const allowance = Math.min(budget, file.path.endsWith('.md') ? 1500 : 4000);
    const snippet   = file.content.slice(0, allowance);
    const chunk     = `\n=== FILE: ${file.path} ===\n${snippet}\n`;
    parts.push(chunk);
    budget -= chunk.length;
  }

  return parts.join('');
}

function buildDepSummary(graph) {
  const lines = ['=== DEPENDENCY MAP ==='];
  // Show top 30 edges to give structural overview
  graph.edges.slice(0, 30).forEach(e => {
    lines.push(`${e.source} → ${e.target}`);
  });
  // Hotspot summary
  const hubs = graph.nodes
    .sort((a,b) => b.connections - a.connections)
    .slice(0, 10)
    .map(n => `  ${n.id} (in:${n.inDegree} out:${n.outDegree})`);
  lines.push('\nMost-connected files:');
  lines.push(...hubs);
  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Analyze a single MR diff (original behaviour, unchanged).
 */
async function analyzeDiff({ diff, mrTitle, mrDescription, filePaths }) {
  const truncated = diff.length > 12000
    ? diff.slice(0, 12000) + '\n\n[diff truncated]'
    : diff;

  const userMessage =
    `MR Title: ${mrTitle}\n` +
    `Description: ${mrDescription || '(none)'}\n` +
    `Files changed: ${filePaths.join(', ')}\n\n` +
    `--- DIFF ---\n${truncated}\n--- END DIFF ---`;

  const response = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.2,
    messages: [
      { role: 'system', content: MR_SYSTEM_PROMPT },
      { role: 'user',   content: userMessage }
    ]
  });

  return parseAndThreshold(response.choices[0].message.content);
}

/**
 * Analyze an entire repo.
 * @param {Object} opts
 * @param {Array}  opts.files    — [{ path, content, size }]
 * @param {Object} opts.readme   — { path, content } | null
 * @param {string} opts.repoName
 * @param {string} opts.ref      — git ref (branch/commit)
 * @param {Array}  opts.commits  — recent commits metadata
 */
async function analyzeRepo({ files, readme, repoName, ref, commits = [] }) {
  console.log(`[analyzer] Building dependency graph for ${files.length} files...`);
  const graph = buildDependencyGraph(files);
  console.log(`[analyzer] Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  const context = buildRepoContext(files, graph, readme);

  const commitsSummary = commits.length
    ? `\nRecent commits:\n${commits.map(c => `- ${c.short_id} ${c.title} (${c.author_name})`).join('\n')}`
    : '';

  const userMessage =
    `Repository: ${repoName}\n` +
    `Branch/Ref: ${ref}\n` +
    `Total files analyzed: ${files.length}\n` +
    `Total dependency edges: ${graph.edges.length}\n` +
    commitsSummary + '\n\n' +
    context;

  console.log(`[analyzer] Sending ${userMessage.length} chars to Groq for repo analysis...`);

  const response = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 2000,
    temperature: 0.2,
    messages: [
      { role: 'system', content: REPO_SYSTEM_PROMPT },
      { role: 'user',   content: userMessage }
    ]
  });

  const result = parseAndThreshold(response.choices[0].message.content);

  // Merge real graph into the result so it travels with the analysis
  result.dependencyGraph = graph;
  result.fileCount       = files.length;
  result.repoName        = repoName;
  result.ref             = ref;

  // Annotate graph nodes with hotspot data from LLM
  if (result.hotspotFiles) {
    result.hotspotFiles.forEach(hs => {
      const node = graph.nodes.find(n => n.id === hs.path);
      if (node) {
        node.status    = hs.risk === 'high' ? 'changed' : hs.risk === 'medium' ? 'affected' : node.status;
        node.hsReason  = hs.reason;
        node.hsSuggest = hs.suggestion;
      }
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function parseAndThreshold(raw) {
  const clean = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let result;
  try {
    result = JSON.parse(clean);
  } catch {
    console.error('[analyzer] Non-JSON response:\n', raw.slice(0, 500));
    throw new Error('Failed to parse Groq response as JSON');
  }

  const blockAt  = parseInt(process.env.BLOCK_THRESHOLD  || '40');
  const reviewAt = parseInt(process.env.REVIEW_THRESHOLD || '65');
  result.verdict =
    result.score <= blockAt  ? 'block'  :
    result.score <= reviewAt ? 'review' : 'pass';

  return result;
}

module.exports = { analyzeDiff, analyzeRepo, buildDependencyGraph };