'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const REPORT_DIR = path.join(ROOT, 'reports');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DEFAULT_BASE_URL = (process.env.BASE_URL || 'http://95.31.169.106').replace(/\/$/, '');
const DEFAULT_SLOW_MS = Number.parseInt(process.env.SLOW_MS || '2000', 10);
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const MODES = [
  { id: 'smoke', flag: '--smoke', label: 'Smoke', duration: '~10 сек', description: 'Быстрая проверка доступности страниц и ключевых API.' },
  { id: 'auth', flag: '--auth', label: 'Auth', duration: '~15 сек', description: 'Регистрация, логин, сессия, профиль и пароль.' },
  { id: 'api', flag: '--api', label: 'API', duration: '~20 сек', description: 'Публичные и защищенные API, схемы и пагинация.' },
  { id: 'ui', flag: '--ui', label: 'UI', duration: '~30 сек', description: 'Playwright-проверки страниц, навигации и элементов.' },
  { id: 'appointments', flag: '--appointments', label: 'Appointments', duration: '~30 сек', description: 'Запись на прием через API и UI.' },
  { id: 'security', flag: '--security', label: 'Security', duration: '~15 сек', description: '401/422, инъекции, длины полей и UUID.' },
  { id: 'scenarios', flag: '--scenarios', label: 'Scenarios', duration: '~40 сек', description: 'Поведенческие сценарии и изоляция данных.' },
  { id: 'chaos', flag: '--chaos', label: 'Chaos', duration: '~60 сек', description: 'Конкурентность, p50/p95 и race condition.' },
  { id: 'edge', flag: '--edge', label: 'Edge', duration: '~30 сек', description: 'Граничные значения, Unicode, XSS и нестандартные входы.' },
  { id: 'infra', flag: '--infra', label: 'Infra', duration: '~10 сек', description: 'CORS, security headers и утечки stack trace.' },
  { id: 'authz', flag: '--authz', label: 'Authz', duration: '~25 сек', description: 'IDOR и privilege escalation.' },
  { id: 'stability', flag: '--stability', label: 'Stability', duration: '~60 сек', description: 'Деградация под серией запросов и большие выборки.' },
  { id: 'admin', flag: '--admin', label: 'Admin', duration: '~20 сек', description: 'Административные endpoints, нужны ADMIN_EMAIL и ADMIN_PASSWORD.' },
  { id: 'all', flag: '--all', label: 'All', duration: 'несколько мин', description: 'Полный прогон всех режимов и сводный отчет.' },
];

const MODE_BY_ID = new Map(MODES.map((mode) => [mode.id, mode]));
const REPORT_RE = /^(?:report-.+|full-report-.+)\.md$/;
const FINAL_STATUSES = new Set(['passed', 'completed_with_failures', 'error', 'cancelled']);
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ico', 'image/x-icon'],
]);

const jobs = new Map();
let currentJob = null;

function isRunning(job) {
  return job && !FINAL_STATUSES.has(job.status);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, details });
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400, cause: error }));
      }
    });
    req.on('error', reject);
  });
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('BASE_URL must use http or https'), { statusCode: 400 });
  }
  return parsed.toString().replace(/\/$/, '');
}

function sanitizeRunRequest(body) {
  const modeId = String(body.mode || 'smoke').trim().replace(/^--/, '');
  const mode = MODE_BY_ID.get(modeId);
  if (!mode) {
    throw Object.assign(new Error(`Unknown mode: ${modeId}`), { statusCode: 400 });
  }

  const slowMs = Number.parseInt(body.slowMs ?? DEFAULT_SLOW_MS, 10);
  if (!Number.isFinite(slowMs) || slowMs < 50 || slowMs > 120000) {
    throw Object.assign(new Error('SLOW_MS must be between 50 and 120000'), { statusCode: 400 });
  }

  const quiet = Boolean(body.quiet);
  const verbose = Boolean(body.verbose);
  if (quiet && verbose) {
    throw Object.assign(new Error('Choose either quiet or verbose output'), { statusCode: 400 });
  }

  return {
    mode,
    baseUrl: normalizeBaseUrl(body.baseUrl),
    slowMs,
    quiet,
    verbose,
    adminEmail: String(body.adminEmail || '').trim(),
    adminPassword: String(body.adminPassword || ''),
  };
}

function jobSnapshot(job, includeLogs = true) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    command: job.command,
    pid: job.pid || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    durationMs: job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : Date.now() - Date.parse(job.startedAt),
    exitCode: job.exitCode,
    signal: job.signal,
    result: job.result || null,
    reports: job.reports || [],
    config: job.config,
    logs: includeLogs ? job.log : undefined,
  };
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emit(job, event, payload) {
  for (const listener of job.clients) {
    listener(event, payload);
  }
}

function appendLog(job, stream, chunk) {
  const text = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
  if (!text) return;
  const entry = { time: new Date().toISOString(), stream, text };
  job.log.push(entry);
  job.logBytes += Buffer.byteLength(text, 'utf8');
  while (job.logBytes > MAX_LOG_BYTES && job.log.length > 1) {
    const removed = job.log.shift();
    job.logBytes -= Buffer.byteLength(removed.text, 'utf8');
  }
  emit(job, 'log', entry);
}

function attachJobEvents(req, res, job) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const listener = (event, payload) => {
    try {
      writeSse(res, event, payload);
    } catch (_) {
      job.clients.delete(listener);
    }
  };

  job.clients.add(listener);
  for (const entry of job.log) {
    listener('log', entry);
  }
  listener('status', jobSnapshot(job, false));

  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    job.clients.delete(listener);
  });
}

async function startJob(body) {
  if (isRunning(currentJob)) {
    throw Object.assign(new Error('A test run is already active'), { statusCode: 409 });
  }

  const run = sanitizeRunRequest(body);
  await fsp.mkdir(REPORT_DIR, { recursive: true });

  const id = randomUUID();
  const args = [path.join(ROOT, 'test-suite.js'), run.mode.flag];
  if (run.quiet) args.push('--quiet');
  if (run.verbose) args.push('--verbose');

  const job = {
    id,
    status: 'running',
    mode: run.mode.id,
    command: ['node', 'test-suite.js', run.mode.flag, ...(run.quiet ? ['--quiet'] : []), ...(run.verbose ? ['--verbose'] : [])],
    config: {
      baseUrl: run.baseUrl,
      slowMs: run.slowMs,
      quiet: run.quiet,
      verbose: run.verbose,
      adminEmailSet: Boolean(run.adminEmail),
      adminPasswordSet: Boolean(run.adminPassword),
    },
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    result: null,
    reports: [],
    log: [],
    logBytes: 0,
    clients: new Set(),
    child: null,
    cancelRequested: false,
  };

  const env = {
    ...process.env,
    BASE_URL: run.baseUrl,
    SLOW_MS: String(run.slowMs),
    NO_COLOR: '1',
    REPORT_DIR: 'reports',
  };
  if (run.adminEmail) env.ADMIN_EMAIL = run.adminEmail;
  if (run.adminPassword) env.ADMIN_PASSWORD = run.adminPassword;

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    windowsHide: true,
  });

  job.child = child;
  job.pid = child.pid;
  jobs.set(id, job);
  currentJob = job;

  appendLog(job, 'system', `Started ${job.command.join(' ')}\n`);
  child.stdout.on('data', (chunk) => appendLog(job, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendLog(job, 'stderr', chunk));
  child.on('error', (error) => appendLog(job, 'stderr', `${error.message}\n`));
  child.on('close', (code, signal) => {
    finalizeJob(job, code, signal).catch((error) => {
      appendLog(job, 'stderr', `${error.message}\n`);
      job.status = 'error';
      job.finishedAt = job.finishedAt || new Date().toISOString();
      emit(job, 'status', jobSnapshot(job, false));
    });
  });

  return job;
}

async function finalizeJob(job, code, signal) {
  if (job.finishedAt) return;

  job.exitCode = code;
  job.signal = signal;
  job.finishedAt = new Date().toISOString();
  job.child = null;

  const reports = await listReports();
  job.reports = reports
    .filter((report) => report.modifiedMs >= job.startedMs - 1500)
    .slice(0, 30);
  job.result = pickJobResult(job.mode, job.reports);

  if (job.cancelRequested) {
    job.status = 'cancelled';
  } else if (code !== 0) {
    job.status = 'error';
  } else if (job.result && job.result.fail > 0) {
    job.status = 'completed_with_failures';
  } else {
    job.status = 'passed';
  }

  appendLog(job, 'system', `Finished with status ${job.status}${code == null ? '' : `, exit code ${code}`}.\n`);
  if (currentJob && currentJob.id === job.id) {
    currentJob = null;
  }
  emit(job, 'status', jobSnapshot(job, false));
}

function pickJobResult(mode, reports) {
  if (!reports.length) return null;
  const preferred = mode === 'all'
    ? reports.find((report) => report.name.startsWith('full-report-'))
    : reports.find((report) => report.name.startsWith(`report-${mode}-`));
  const report = preferred || reports[0];
  return report.summary;
}

function stopJob(job) {
  if (!isRunning(job) || !job.child) return false;
  job.cancelRequested = true;
  appendLog(job, 'system', 'Stopping active run...\n');

  if (process.platform === 'win32' && job.pid) {
    execFile('taskkill', ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error && job.child) {
        job.child.kill('SIGTERM');
      }
    });
  } else {
    job.child.kill('SIGTERM');
    setTimeout(() => {
      if (isRunning(job) && job.child) job.child.kill('SIGKILL');
    }, 5000).unref();
  }
  return true;
}

function encodeReportId(relativePath) {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function decodeReportId(id) {
  return Buffer.from(id, 'base64url').toString('utf8');
}

function resolveReportPath(id) {
  let relativePath;
  try {
    relativePath = decodeReportId(id);
  } catch (_) {
    throw Object.assign(new Error('Invalid report id'), { statusCode: 404 });
  }

  const normalized = path.normalize(relativePath);
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw Object.assign(new Error('Invalid report path'), { statusCode: 404 });
  }

  const fullPath = path.resolve(ROOT, normalized);
  const dir = path.dirname(fullPath);
  const isAllowedDir = dir === ROOT || dir === REPORT_DIR;
  if (!isAllowedDir || !REPORT_RE.test(path.basename(fullPath))) {
    throw Object.assign(new Error('Report not found'), { statusCode: 404 });
  }
  return fullPath;
}

async function listReports() {
  const dirs = [...new Set([ROOT, REPORT_DIR])];
  const fullPaths = [];

  for (const dir of dirs) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && REPORT_RE.test(entry.name)) {
        fullPaths.push(path.join(dir, entry.name));
      }
    }
  }

  const reports = [];
  for (const fullPath of fullPaths) {
    const [stat, content] = await Promise.all([
      fsp.stat(fullPath),
      fsp.readFile(fullPath, 'utf8').catch(() => ''),
    ]);
    reports.push(buildReportMeta(fullPath, stat, content, false));
  }

  return reports.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

async function readReport(id) {
  const fullPath = resolveReportPath(id);
  const [stat, content] = await Promise.all([
    fsp.stat(fullPath),
    fsp.readFile(fullPath, 'utf8'),
  ]);
  const meta = buildReportMeta(fullPath, stat, content, true);
  return { ...meta, content };
}

function buildReportMeta(fullPath, stat, content, includeRows) {
  const relativePath = path.relative(ROOT, fullPath).split(path.sep).join('/');
  const rows = parseReportRows(content);
  return {
    id: encodeReportId(relativePath),
    name: path.basename(fullPath),
    relativePath,
    title: parseReportTitle(content) || path.basename(fullPath),
    summary: parseReportSummary(content, rows),
    rowCount: rows.length,
    rows: includeRows ? rows : undefined,
    size: stat.size,
    sizeLabel: formatBytes(stat.size),
    modifiedAt: stat.mtime.toISOString(),
    modifiedMs: stat.mtimeMs,
  };
}

function parseReportTitle(content) {
  const line = content.split(/\r?\n/).find((item) => item.startsWith('# '));
  return line ? stripMarkdown(line.replace(/^#\s+/, '')).trim() : '';
}

function parseReportSummary(content, rows) {
  const summaryLine = content
    .split(/\r?\n/)
    .find((line) => line.startsWith('## ') && /\d/.test(line) && (line.includes('Итог') || line.includes('Р') || line.includes('✅') || line.includes('вњ')));
  const numbers = summaryLine ? summaryLine.match(/\d+/g) : null;
  if (numbers && numbers.length >= 3) {
    const [pass, fail, warn] = numbers.map((value) => Number.parseInt(value, 10));
    return { pass, fail, warn, total: pass + fail + warn };
  }

  const summary = rows.reduce(
    (acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      acc.total++;
      return acc;
    },
    { pass: 0, fail: 0, warn: 0, unknown: 0, total: 0 }
  );
  return {
    pass: summary.pass || 0,
    fail: summary.fail || 0,
    warn: summary.warn || 0,
    total: summary.total,
  };
}

function parseReportRows(content) {
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => stripMarkdown(cell.trim()));
    if (cells.length < 7 || !/^\d+$/.test(cells[0])) continue;
    rows.push({
      index: Number.parseInt(cells[0], 10),
      result: cells[1],
      status: detectStatus(cells[1]),
      method: cells[2],
      endpoint: cells[3],
      expected: cells[4],
      actual: cells[5],
      details: cells.slice(6).join(' | '),
    });
  }
  return rows;
}

function detectStatus(value) {
  const text = String(value);
  if (text.includes('✅') || text.includes('вњ')) return 'pass';
  if (text.includes('❌') || text.includes('вќ')) return 'fail';
  if (text.includes('⚠') || text.includes('вљ')) return 'warn';
  return 'unknown';
}

function stripMarkdown(value) {
  return String(value).replace(/`/g, '').replace(/\*\*/g, '');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method not allowed');
    return;
  }

  const rawPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const fullPath = path.resolve(WEB_DIR, rawPath);
  if (!fullPath.startsWith(WEB_DIR + path.sep) && fullPath !== path.join(WEB_DIR, 'index.html')) {
    sendError(res, 404, 'Not found');
    return;
  }

  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) throw new Error('Not a file');
    const type = CONTENT_TYPES.get(path.extname(fullPath)) || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      'content-length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(fullPath).pipe(res);
  } catch (_) {
    sendError(res, 404, 'Not found');
  }
}

async function routeApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const resource = parts[1];

  if (req.method === 'GET' && resource === 'config') {
    sendJson(res, 200, {
      modes: MODES,
      defaults: {
        baseUrl: DEFAULT_BASE_URL,
        slowMs: DEFAULT_SLOW_MS,
        host: HOST,
        port: PORT,
      },
      currentJob: jobSnapshot(currentJob, false),
    });
    return;
  }

  if (req.method === 'GET' && resource === 'health') {
    sendJson(res, 200, {
      ok: true,
      node: process.version,
      cwd: ROOT,
      reportDir: REPORT_DIR,
    });
    return;
  }

  if (req.method === 'POST' && resource === 'run') {
    const body = await readJson(req);
    const job = await startJob(body);
    sendJson(res, 201, jobSnapshot(job, false));
    return;
  }

  if (resource === 'jobs') {
    await routeJobs(req, res, parts);
    return;
  }

  if (resource === 'reports') {
    await routeReports(req, res, parts);
    return;
  }

  sendError(res, 404, 'Not found');
}

async function routeJobs(req, res, parts) {
  if (req.method === 'GET' && parts[2] === 'current') {
    sendJson(res, 200, { job: jobSnapshot(currentJob, true) });
    return;
  }

  const id = parts[2];
  const job = id ? jobs.get(id) : null;
  if (!job) {
    sendError(res, 404, 'Job not found');
    return;
  }

  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, jobSnapshot(job, true));
    return;
  }

  if (req.method === 'GET' && parts[3] === 'events') {
    attachJobEvents(req, res, job);
    return;
  }

  if (req.method === 'DELETE' && parts.length === 3) {
    const stopped = stopJob(job);
    sendJson(res, 200, { stopped, job: jobSnapshot(job, false) });
    return;
  }

  sendError(res, 404, 'Not found');
}

async function routeReports(req, res, parts) {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, { reports: await listReports() });
    return;
  }

  const id = parts[2];
  if (!id) {
    sendError(res, 404, 'Report not found');
    return;
  }

  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, await readReport(id));
    return;
  }

  if (req.method === 'GET' && parts[3] === 'download') {
    const fullPath = resolveReportPath(id);
    const stat = await fsp.stat(fullPath);
    const name = path.basename(fullPath).replace(/"/g, '');
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  if (req.method === 'DELETE' && parts.length === 3) {
    const fullPath = resolveReportPath(id);
    await fsp.unlink(fullPath);
    sendJson(res, 200, { deleted: true });
    return;
  }

  sendError(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const handler = url.pathname.startsWith('/api/')
    ? routeApi(req, res, url)
    : serveStatic(req, res, url);

  Promise.resolve(handler).catch((error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, error.statusCode || 500, error.message || 'Internal server error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Psychohelp web dashboard: http://${HOST}:${PORT}`);
});
