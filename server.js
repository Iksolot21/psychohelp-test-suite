'use strict';

const express   = require('express');
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const app             = express();
const PORT            = process.env.WEB_PORT          || 3000;
const RUNS_DIR        = path.join(__dirname, 'runs');
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN   || '';
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID   || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
fs.mkdirSync(RUNS_DIR, { recursive: true });

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (!DASHBOARD_TOKEN) return next();
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/, '') || (req.query.token || '');
  if (tok === DASHBOARD_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized', requiresAuth: true });
});

// ─── Mode catalog ─────────────────────────────────────────────────────────────
const MODES = [
  { id: 'smoke',        icon: '🔥', est: '~10 сек',  cat: 'quick',      label: 'Smoke',        desc: 'Страницы и ключевые API живы' },
  { id: 'auth',         icon: '🔐', est: '~15 сек',  cat: 'quick',      label: 'Auth',         desc: 'Регистрация, логин, рефреш, смена пароля, логаут' },
  { id: 'api',          icon: '📡', est: '~20 сек',  cat: 'quick',      label: 'API',          desc: 'Все эндпоинты, пагинация, 401 без токена, схемы' },
  { id: 'appointments', icon: '📅', est: '~30 сек',  cat: 'functional', label: 'Appointments', desc: 'Запись на приём: создание, просмотр, отмена' },
  { id: 'scenarios',    icon: '🎭', est: '~40 сек',  cat: 'functional', label: 'Scenarios',    desc: 'Изоляция данных, rate limit, user enumeration' },
  { id: 'ui',           icon: '🖥', est: '~40 сек',  cat: 'functional', label: 'UI',           desc: 'Playwright: страницы, навигация, кнопки' },
  { id: 'security',     icon: '🛡', est: '~15 сек',  cat: 'security',   label: 'Security',     desc: '401/422, maxLength, SQL-инъекции, невалидные UUID' },
  { id: 'edge',         icon: '🔬', est: '~30 сек',  cat: 'security',   label: 'Edge',         desc: 'Unicode, XSS, null/empty/absent, форматы телефонов' },
  { id: 'infra',        icon: '🏗', est: '~10 сек',  cat: 'security',   label: 'Infra',        desc: 'CORS, stack trace leak, security-заголовки' },
  { id: 'authz',        icon: '🔒', est: '~20 сек',  cat: 'security',   label: 'AuthZ',        desc: 'IDOR и privilege escalation' },
  { id: 'chaos',        icon: '💥', est: '~60 сек',  cat: 'perf',       label: 'Chaos',        desc: '10× параллельных регистраций, race conditions, p50/p95' },
  { id: 'stability',    icon: '📊', est: '~5 мин',   cat: 'perf',       label: 'Stability',    desc: 'Тренд деградации 500 запросов, большие выборки' },
  { id: 'admin',        icon: '👑', est: '~10 сек',  cat: 'admin',      label: 'Admin',        desc: 'Административные эндпоинты (нужны ADMIN_EMAIL + ADMIN_PASSWORD)', requiresAdmin: true },
  { id: 'all',          icon: '🚀', est: '~15 мин',  cat: 'all',        label: 'All Modes',    desc: 'Запуск всех режимов + сводный full-report.md' },
];

const VALID_MODES = new Set(MODES.map(m => m.id));
const ALL_SECTIONS = ['smoke','auth','api','appointments','security','scenarios','chaos','edge','infra','authz','stability','ui','admin'];
const SECTION_RE   = /^\s+(SMOKE|AUTH|API|APPOINTMENTS|SECURITY|SCENARIOS|CHAOS|EDGE|INFRA|AUTHZ|STABILITY|UI|ADMIN)\s*$/;

// ─── Test coverage catalog ─────────────────────────────────────────────────────
const COVERAGE = {
  smoke: { total: 13, checks: [
    { method:'GET',    endpoint:'/',                           what:'Главная страница открывается (200)' },
    { method:'GET',    endpoint:'/about',                      what:'Страница «О нас»' },
    { method:'GET',    endpoint:'/contacts',                   what:'Страница контактов' },
    { method:'GET',    endpoint:'/cabinet',                    what:'Личный кабинет (redirect или 200)' },
    { method:'GET',    endpoint:'/therapists',                 what:'Страница терапевтов' },
    { method:'GET',    endpoint:'/articles',                   what:'Страница статей' },
    { method:'GET',    endpoint:'/news',                       what:'Страница новостей' },
    { method:'GET',    endpoint:'/api/articles',               what:'API: список статей → 200, есть элементы' },
    { method:'GET',    endpoint:'/api/news',                   what:'API: список новостей → 200' },
    { method:'GET',    endpoint:'/api/therapists',             what:'API: список терапевтов → 200' },
    { method:'GET',    endpoint:'/api/users/user',             what:'Без сессии → 401' },
    { method:'POST',   endpoint:'/api/users/register',         what:'Быстрая регистрация → 201' },
    { method:'POST',   endpoint:'/api/users/logout',           what:'Logout → 200/401' },
  ]},
  auth: { total: 12, checks: [
    { method:'POST',   endpoint:'/api/users/register',              what:'Регистрация → 201, получаем id' },
    { method:'GET',    endpoint:'/api/users/user',                  what:'Сессия активна сразу после регистрации → 200' },
    { method:'POST',   endpoint:'/api/users/logout',                what:'Logout → 200' },
    { method:'GET',    endpoint:'/api/users/user',                  what:'Сессия закрыта после logout → 401' },
    { method:'POST',   endpoint:'/api/users/login',                 what:'Вход с верными данными → 200' },
    { method:'POST',   endpoint:'/api/users/refresh',               what:'Refresh без cookie → 401' },
    { method:'PUT',    endpoint:'/api/users/me',                    what:'Обновление профиля → 200' },
    { method:'POST',   endpoint:'/api/users/me/password',           what:'Смена пароля → 200' },
    { method:'POST',   endpoint:'/api/users/password-reset/request',what:'Запрос сброса пароля → 200' },
    { method:'POST',   endpoint:'/api/users/login',                 what:'Неверный пароль → 4xx' },
    { method:'POST',   endpoint:'/api/users/register',              what:'Дубль email → 422' },
    { method:'POST',   endpoint:'/api/users/login',                 what:'Без поля password → 422' },
  ]},
  api: { total: 11, checks: [
    { method:'GET',    endpoint:'/api/articles',          what:'Список статей, схема каждого элемента' },
    { method:'GET',    endpoint:'/api/articles?page=2',   what:'Пагинация: вторая страница' },
    { method:'GET',    endpoint:'/api/articles/{id}',     what:'Статья по ID, поле title присутствует' },
    { method:'GET',    endpoint:'/api/news',              what:'Список новостей, схема' },
    { method:'GET',    endpoint:'/api/news/{id}',         what:'Новость по ID' },
    { method:'GET',    endpoint:'/api/therapists',        what:'Список терапевтов, схема полей' },
    { method:'GET',    endpoint:'/api/appointments',      what:'Без токена → 401' },
    { method:'GET',    endpoint:'/api/users/user',        what:'Без токена → 401' },
    { method:'POST',   endpoint:'/api/users/register',    what:'Регистрация, проверка схемы ответа' },
    { method:'PUT',    endpoint:'/api/users/me',          what:'Обновление профиля, поля сохранены' },
    { method:'PUT',    endpoint:'/api/users/me (пустой)', what:'Пустой PUT → 200/422 (не 500)' },
  ]},
  appointments: { total: 9, checks: [
    { method:'GET',    endpoint:'/api/therapists',             what:'Получить therapist_id для записи' },
    { method:'POST',   endpoint:'/api/appointments',           what:'Создать запись → 201' },
    { method:'GET',    endpoint:'/api/appointments',           what:'Список моих записей → 200' },
    { method:'DELETE', endpoint:'/api/appointments/{id}',      what:'Отмена записи → 200' },
    { method:'POST',   endpoint:'/api/appointments',           what:'Неверный therapist_id → 4xx' },
    { method:'POST',   endpoint:'/api/appointments',           what:'Прошедшая дата → 4xx' },
    { method:'POST',   endpoint:'/api/applications',           what:'Создать заявку → 201' },
    { method:'GET',    endpoint:'/api/applications',           what:'Список заявок → 200' },
    { method:'DELETE', endpoint:'/api/applications/{id}',      what:'Отмена заявки → 200' },
  ]},
  scenarios: { total: 5, checks: [
    { method:'GET',    endpoint:'/api/appointments',   what:'Изоляция: User A не видит записи User B' },
    { method:'GET',    endpoint:'/api/applications',   what:'Изоляция: заявки изолированы между юзерами' },
    { method:'POST',   endpoint:'/api/users/register', what:'Rate limit: серия быстрых регистраций' },
    { method:'POST',   endpoint:'/api/users/login',    what:'User enumeration: ответ одинаков для несуществующего email' },
    { method:'POST',   endpoint:'/api/users/login',    what:'Timing attack: разница latency < 200 мс' },
  ]},
  ui: { total: 9, checks: [
    { method:'GET', endpoint:'/',            what:'Главная страница, нет JS-ошибок в консоли' },
    { method:'GET', endpoint:'/therapists',  what:'Страница терапевтов загружается' },
    { method:'GET', endpoint:'/articles',    what:'Страница статей загружается' },
    { method:'GET', endpoint:'/news',        what:'Страница новостей загружается' },
    { method:'GET', endpoint:'/cabinet',     what:'Кабинет после логина — нет редиректа на /login' },
    { method:'UI',  endpoint:'/cabinet',     what:'Блок "Запись на сессию" присутствует в DOM' },
    { method:'UI',  endpoint:'/cabinet',     what:'Имя пользователя отображается' },
    { method:'UI',  endpoint:'/*',           what:'Нет сломанных изображений (4xx на img src)' },
    { method:'UI',  endpoint:'/*',           what:'Нет JS-ошибок на всех посещённых страницах' },
  ]},
  security: { total: 9, checks: [
    { method:'GET',    endpoint:'/api/appointments',       what:'Без авторизации → 401' },
    { method:'GET',    endpoint:'/api/users/user',         what:'Без авторизации → 401' },
    { method:'POST',   endpoint:'/api/users/register',     what:'email > 255 символов → 4xx (не 500)' },
    { method:'POST',   endpoint:'/api/users/register',     what:'password > 255 символов → 4xx (не 500)' },
    { method:'POST',   endpoint:'/api/users/login',        what:'SQL-инъекция в email → 4xx (не 200/500)' },
    { method:'POST',   endpoint:'/api/users/login',        what:'SQL-инъекция в password → 4xx (не 200/500)' },
    { method:'GET',    endpoint:'/api/appointments/{uuid}',what:'Невалидный UUID → 404/422 (не 500)' },
    { method:'DELETE', endpoint:'/api/appointments/{uuid}',what:'Невалидный UUID → 404/422 (не 500)' },
    { method:'PUT',    endpoint:'/api/users/me',           what:'Пустой PUT → 200/422 (не 500)' },
  ]},
  edge: { total: 9, checks: [
    { method:'POST', endpoint:'/api/users/register', what:'Unicode имя (кириллица, эмодзи) → не 500' },
    { method:'POST', endpoint:'/api/users/register', what:'XSS в first_name → экранируется, не 500' },
    { method:'POST', endpoint:'/api/users/register', what:'first_name = null → 4xx' },
    { method:'POST', endpoint:'/api/users/register', what:'Поле email отсутствует → 422' },
    { method:'POST', endpoint:'/api/users/register', what:'Телефон: +7(999)888-77-66' },
    { method:'POST', endpoint:'/api/users/register', what:'Телефон: 89001234567' },
    { method:'POST', endpoint:'/api/users/register', what:'Телефон: +1234567890' },
    { method:'POST', endpoint:'/api/users/login',    what:'Пустой body → 422' },
    { method:'POST', endpoint:'/api/users/login',    what:'email = "" → 422/4xx' },
  ]},
  infra: { total: 5, checks: [
    { method:'GET', endpoint:'/',             what:'X-Frame-Options или CSP заголовок присутствует' },
    { method:'GET', endpoint:'/',             what:'X-Content-Type-Options: nosniff' },
    { method:'GET', endpoint:'/api/articles', what:'CORS: Access-Control-Allow-Origin настроен' },
    { method:'GET', endpoint:'/api/articles', what:'Нет X-Powered-By (не раскрываем стек)' },
    { method:'GET', endpoint:'/nonexistent',  what:'Stack trace не попадает в тело 404-ответа' },
  ]},
  authz: { total: 4, checks: [
    { method:'GET',    endpoint:'/api/appointments',      what:'User B не видит записи User A (IDOR)' },
    { method:'DELETE', endpoint:'/api/appointments/{A}',  what:'User B не может удалить запись User A → 403/404' },
    { method:'GET',    endpoint:'/api/users/{A_id}',      what:'Прямой доступ к профилю другого юзера → 403/404' },
    { method:'PUT',    endpoint:'/api/users/{A_id}',      what:'Изменение профиля другого юзера → 403/404' },
  ]},
  chaos: { total: 5, checks: [
    { method:'POST', endpoint:'/api/users/register', what:'10 параллельных регистраций — все 201, нет дублей' },
    { method:'POST', endpoint:'/api/appointments',   what:'Race condition: двойная запись на одно время' },
    { method:'GET',  endpoint:'/api/articles',       what:'p50 latency < SLOW_MS' },
    { method:'GET',  endpoint:'/api/therapists',     what:'p95 latency < SLOW_MS × 2' },
    { method:'POST', endpoint:'/api/users/login',    what:'p50 latency логина < SLOW_MS' },
  ]},
  stability: { total: 3, checks: [
    { method:'GET', endpoint:'/api/articles',   what:'500 запросов подряд — тренд времени ответа (деградация?)' },
    { method:'GET', endpoint:'/api/therapists', what:'Большая выборка — нет 500 и таймаута' },
    { method:'GET', endpoint:'/api/news',       what:'500 запросов — p50/p95/p99 статистика' },
  ]},
  admin: { total: 3, checks: [
    { method:'GET',    endpoint:'/api/admin/users',        what:'Список всех пользователей → 200' },
    { method:'GET',    endpoint:'/api/admin/appointments',  what:'Все записи всех юзеров → 200' },
    { method:'DELETE', endpoint:'/api/admin/users/{id}',   what:'Удаление тестового пользователя → 200' },
  ]},
  all: { total: 0, checks: [
    { method:'—', endpoint:'все режимы', what:'Последовательный запуск всех 13 режимов выше + сводный отчёт' },
  ]},
};

const activeRuns = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseResultLine(line) {
  const status = line.includes('✅') ? 'pass' : line.includes('❌') ? 'fail' : line.includes('⚠️') ? 'warn' : null;
  if (!status || !line.includes(' → ')) return null;
  const stripped  = line.replace(/^\s*(?:✅|❌|⚠️)\s*/, '').trim();
  const arrowIdx  = stripped.indexOf(' → ');
  if (arrowIdx === -1) return null;
  const beforeArrow = stripped.substring(0, arrowIdx).trim();
  const afterArrow  = stripped.substring(arrowIdx + 3).trim();
  const sp = beforeArrow.indexOf(' ');
  if (sp === -1) return null;
  const method = beforeArrow.substring(0, sp);
  const rest   = beforeArrow.substring(sp + 1).trim();
  const dsp    = rest.lastIndexOf('  ');
  const endpoint = dsp !== -1 ? rest.substring(0, dsp).trim() : rest.split(/\s+/).slice(0, -1).join(' ');
  const expected = dsp !== -1 ? rest.substring(dsp).trim()    : (rest.split(/\s+/).pop() || '');
  const slashIdx = afterArrow.indexOf('  //');
  const actual   = (slashIdx !== -1 ? afterArrow.substring(0, slashIdx) : afterArrow).trim();
  const details  = slashIdx !== -1 ? afterArrow.substring(slashIdx + 4).trim() : '';
  return { status, method, endpoint, expected, actual, details };
}

function parseSummary(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    const m = lines[i].match(/✅\s*(\d+).*?❌\s*(\d+).*?⚠️\s*(\d+)/);
    if (m) return { pass: +m[1], fail: +m[2], warn: +m[3] };
  }
  let pass = 0, fail = 0, warn = 0;
  for (const l of lines) {
    if (l.includes('✅')) pass++;
    else if (l.includes('❌')) fail++;
    else if (l.includes('⚠️')) warn++;
  }
  return { pass, fail, warn };
}

function persistRun(run) {
  const dir = path.join(RUNS_DIR, run.id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const meta = { id: run.id, mode: run.mode, startedAt: run.startedAt, endedAt: run.endedAt,
      status: run.status, exitCode: run.exitCode, pass: run.pass, fail: run.fail, warn: run.warn, config: run.config };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'output.txt'), run.lines.join('\n'));
  } catch (_) {}
}

async function sendTelegram(text, token, chat) {
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

function getRunData(runId) {
  const r = activeRuns.get(runId);
  if (r) return { meta: r, lines: r.lines };
  try {
    const dir   = path.join(RUNS_DIR, runId);
    const meta  = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const lines = fs.readFileSync(path.join(dir, 'output.txt'), 'utf8').split('\n');
    return { meta, lines };
  } catch (_) { return null; }
}

function getStructured(runId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, runId, 'results.json'), 'utf8'));
  } catch (_) { return null; }
}

// Загружает meta.json; если его нет (CLI-запуск) — реконструирует из results.json
function tryLoadRunMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, dir, 'meta.json'), 'utf8'));
  } catch (_) {}
  try {
    const r    = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, dir, 'results.json'), 'utf8'));
    const pass = (r.sections||[]).reduce((s,x)=>s+(x.pass||0),0);
    const fail = (r.sections||[]).reduce((s,x)=>s+(x.fail||0),0);
    const warn = (r.sections||[]).reduce((s,x)=>s+(x.warn||0),0);
    return { id: dir, mode: r.mode||'unknown', startedAt: r.startedAt||new Date(0).toISOString(),
      endedAt: r.startedAt||null, status: 'done', pass, fail, warn,
      config: { baseUrl: r.baseUrl||'' }, source: 'cli' };
  } catch(_) { return null; }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Shared report helpers ────────────────────────────────────────────────────
const REPORT_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;font-size:14px}
.wrap{max-width:1200px;margin:0 auto;padding:24px}
h1{font-size:22px;color:#f0f6fc;margin-bottom:4px}
h2{font-size:15px;color:#f0f6fc;margin:20px 0 10px;padding-bottom:6px;border-bottom:1px solid #21262d}
.meta{font-size:12px;color:#484f58;margin-bottom:20px}
.stats{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.stat{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px 24px;text-align:center;min-width:100px}
.stat .n{font-size:32px;font-weight:800;font-family:monospace;line-height:1}
.stat .l{font-size:10px;color:#484f58;text-transform:uppercase;letter-spacing:.05em;margin-top:3px}
.stat-pass{border-color:rgba(63,185,80,.25)}.stat-pass .n{color:#3fb950}
.stat-fail{border-color:rgba(248,81,73,.25)}.stat-fail .n{color:#f85149}
.stat-warn{border-color:rgba(210,153,34,.25)}.stat-warn .n{color:#d29922}
.filters{margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap}
.filters button{background:#161b22;border:1px solid #21262d;color:#c9d1d9;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;transition:all .1s}
.filters button.active{background:#21262d;color:#f0f6fc;border-color:#484f58}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px}
th{text-align:left;padding:7px 10px;border-bottom:2px solid #21262d;color:#484f58;font-size:10px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;position:sticky;top:0;background:#161b22}
td{padding:6px 10px;border-bottom:1px solid #0d1117;vertical-align:top}
tr:hover td{background:#161b22}
code{font-family:monospace;font-size:11px;background:#0d1117;padding:1px 5px;border-radius:3px}
.endpoint{word-break:break-all;max-width:320px;font-family:monospace;font-size:11px}
.dc{color:#888;font-size:11px;max-width:260px;word-break:break-word;overflow-wrap:anywhere}
.dc-full{max-width:none}
.row-pass td:nth-child(2){color:#3fb950}
.row-fail td:nth-child(2){color:#f85149}
.row-warn td:nth-child(2){color:#d29922}
tr[hidden]{display:none}
details{border:1px solid #21262d;border-radius:8px;margin-bottom:10px;overflow:hidden}
details summary{padding:10px 14px;cursor:pointer;user-select:none;font-weight:600;font-size:13px;color:#f0f6fc;list-style:none;display:flex;align-items:center;gap:8px;background:#161b22}
details[open]>summary{border-bottom:1px solid #21262d}
.ss{display:flex;gap:10px;margin-left:auto;font-family:monospace;font-size:11px}
.ssp{color:#3fb950}.ssf{color:#f85149}.ssw{color:#d29922}
.cfg{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:14px 16px;margin-bottom:16px;display:grid;grid-template-columns:140px 1fr;gap:4px 12px;font-size:12px}
.cfg dt{color:#484f58;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding-top:2px}
.cfg dd{font-family:monospace}
.raw{font-family:monospace;font-size:11px;line-height:1.6;padding:12px;background:#010409;max-height:500px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.ok-banner{text-align:center;padding:40px;color:#3fb950;font-size:20px;font-weight:600}
.sec-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(121,192,255,.1);color:#79c0ff;font-family:monospace}
.type-badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;margin-left:auto;flex-shrink:0}
.tb-summary{background:rgba(121,192,255,.1);color:#79c0ff}.tb-standard{background:rgba(63,185,80,.1);color:#3fb950}.tb-full{background:rgba(188,140,255,.1);color:#bc8cff}
.report-nav{display:flex;gap:8px;margin-bottom:16px}
.report-nav a{background:#161b22;border:1px solid #21262d;color:#c9d1d9;padding:5px 12px;border-radius:6px;font-size:12px;text-decoration:none;transition:border-color .1s}
.report-nav a:hover{border-color:#484f58;color:#f0f6fc}
.report-nav a.cur{background:#21262d;color:#f0f6fc;border-color:#484f58}
`;

function htmlPage(type, mode, runId, content) {
  const links = ['summary','standard','full'].map(t =>
    `<a href="?type=${t}"${t===type?' class="cur"':''}>${
      t==='summary'?'📋 Краткий':t==='standard'?'📊 Стандартный':'📰 Подробный'
    }</a>`
  ).join('');
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(type==='summary'?'Краткий':type==='full'?'Подробный':'Стандартный')} отчёт: ${esc(mode.toUpperCase())}</title>
<style>${REPORT_CSS}</style>
</head><body><div class="wrap">
<div class="report-nav">${links}<a href="?type=${type}&download" style="margin-left:auto">⬇ Скачать HTML</a><a href="report.md?download">📝 Скачать MD</a></div>
${content}
</div></body></html>`;
}

// ─── Summary: только статистика + упавшие ────────────────────────────────────
function generateSummaryHtml(meta, structured, lines, runId) {
  const date = new Date(meta.startedAt).toLocaleString('ru-RU');
  const dur  = meta.endedAt ? ((new Date(meta.endedAt)-new Date(meta.startedAt))/1000).toFixed(0)+'с' : '—';
  const { pass, fail, warn } = meta;
  let sectTable = '', problemRows = '';

  if (structured) {
    if (structured.sections.length > 1) {
      sectTable = `<h2>По разделам</h2><table><thead><tr>
        <th>Раздел</th><th>✅ Прошло</th><th>❌ Упало</th><th>⚠️ Пред.</th></tr></thead><tbody>` +
        structured.sections.map(s => {
          const ic = s.fail>0?'❌':s.warn>0?'⚠️':'✅';
          return `<tr><td><span class="sec-badge">${ic} ${esc(s.name)}</span></td>
            <td style="color:#3fb950;font-family:monospace">${s.pass}</td>
            <td style="color:#f85149;font-family:monospace">${s.fail}</td>
            <td style="color:#d29922;font-family:monospace">${s.warn}</td></tr>`;
        }).join('') + '</tbody></table>';
    }
    const bad = structured.sections.flatMap(s =>
      s.rows.filter(r => r.status !== 'pass').map(r => ({ ...r, _sec: s.name })));
    if (bad.length) {
      problemRows = `<h2>${fail>0?`❌ Упавшие и предупреждения (${bad.length})`:`⚠️ Предупреждения (${bad.length})`}</h2>
        <table><thead><tr><th>Рез</th><th>Раздел</th><th>Метод</th><th>Эндпоинт</th><th>Ожид</th><th>Факт</th><th>Детали</th></tr></thead><tbody>` +
        bad.map(r => {
          const ic = r.status==='fail'?'❌':'⚠️';
          return `<tr class="row-${r.status}"><td>${ic}</td><td><span class="sec-badge">${esc(r._sec)}</span></td>
            <td><code>${esc(r.method)}</code></td><td class="endpoint">${esc(r.endpoint)}</td>
            <td><code>${esc(r.expected)}</code></td><td><code>${esc(r.actual)}</code></td>
            <td class="dc">${esc(r.details)}</td></tr>`;
        }).join('') + '</tbody></table>';
    }
  } else {
    const bad = lines.map(l => parseResultLine(l)).filter(r => r && r.status !== 'pass');
    if (bad.length) {
      problemRows = `<h2>❌ Проблемы</h2><table><thead><tr>
        <th>Рез</th><th>Метод</th><th>Эндпоинт</th><th>Ожид</th><th>Факт</th><th>Детали</th></tr></thead><tbody>` +
        bad.map(r => `<tr class="row-${r.status}"><td>${r.status==='fail'?'❌':'⚠️'}</td>
          <td><code>${esc(r.method)}</code></td><td class="endpoint">${esc(r.endpoint)}</td>
          <td><code>${esc(r.expected)}</code></td><td><code>${esc(r.actual)}</code></td>
          <td class="dc">${esc(r.details)}</td></tr>`).join('') + '</tbody></table>';
    }
  }

  return htmlPage('summary', meta.mode, runId, `
    <h1>📋 Краткий отчёт: ${esc(meta.mode.toUpperCase())}</h1>
    <p class="meta">Сайт: ${esc(meta.config?.baseUrl||'—')} · Дата: ${esc(date)} · Длительность: ${esc(dur)}</p>
    <div class="stats">
      <div class="stat stat-pass"><div class="n">${pass}</div><div class="l">Прошло</div></div>
      <div class="stat stat-fail"><div class="n">${fail}</div><div class="l">Упало</div></div>
      <div class="stat stat-warn"><div class="n">${warn}</div><div class="l">Пред.</div></div>
    </div>
    ${fail===0&&warn===0?'<div class="ok-banner">✅ Все тесты прошли успешно</div>':''}
    ${sectTable}${problemRows}`);
}

// ─── Standard: все тесты с фильтрами ─────────────────────────────────────────
function generateStandardHtml(meta, structured, lines, runId) {
  const date = new Date(meta.startedAt).toLocaleString('ru-RU');
  const dur  = meta.endedAt ? ((new Date(meta.endedAt)-new Date(meta.startedAt))/1000).toFixed(0)+'с' : '—';
  const { pass, fail, warn } = meta;
  let idx = 0, body = '';

  const makeRow = (r, secName) => {
    idx++;
    const ic = r.status==='pass'?'✅':r.status==='fail'?'❌':'⚠️';
    return `<tr class="row-${r.status}" data-status="${r.status}">
      <td style="color:#484f58;font-size:10px">${idx}</td><td>${ic}</td>
      ${secName?`<td><span class="sec-badge">${esc(secName)}</span></td>`:''}
      <td><code>${esc(r.method)}</code></td><td class="endpoint">${esc(r.endpoint)}</td>
      <td><code>${esc(r.expected)}</code></td><td><code>${esc(r.actual)}</code></td>
      <td class="dc">${esc(r.details)}</td></tr>`;
  };

  const multiSec = structured && structured.sections.length > 1;
  if (structured) {
    for (const s of structured.sections) {
      if (multiSec) body += `<tr><td colspan="9" style="background:#0d1117;padding:6px 10px;color:#79c0ff;font-size:11px;font-weight:600">${s.name.toUpperCase()} — ✅${s.pass} ❌${s.fail} ⚠️${s.warn}</td></tr>`;
      for (const r of s.rows) body += makeRow(r, multiSec ? null : null);
    }
  } else {
    for (const line of lines) { const r = parseResultLine(line); if (r) body += makeRow(r, null); }
  }

  const thSec = multiSec ? '' : '';
  return htmlPage('standard', meta.mode, runId, `
    <h1>📊 Стандартный отчёт: ${esc(meta.mode.toUpperCase())}</h1>
    <p class="meta">Сайт: ${esc(meta.config?.baseUrl||'—')} · Дата: ${esc(date)} · Длительность: ${esc(dur)}</p>
    <div class="stats">
      <div class="stat stat-pass"><div class="n">${pass}</div><div class="l">Прошло</div></div>
      <div class="stat stat-fail"><div class="n">${fail}</div><div class="l">Упало</div></div>
      <div class="stat stat-warn"><div class="n">${warn}</div><div class="l">Пред.</div></div>
    </div>
    <div class="filters">
      <button class="active" onclick="f('all',this)">Все (${idx})</button>
      <button onclick="f('fail',this)">❌ Упали (${fail})</button>
      <button onclick="f('warn',this)">⚠️ Пред. (${warn})</button>
      <button onclick="f('pass',this)">✅ Прошли (${pass})</button>
    </div>
    <table><thead><tr><th>#</th><th>Рез</th><th>Метод</th><th>Эндпоинт</th><th>Ожидалось</th><th>Факт</th><th>Детали</th></tr></thead>
    <tbody>${body}</tbody></table>
    <script>function f(t,b){document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('tr[data-status]').forEach(tr=>{tr.hidden=t!=='all'&&tr.dataset.status!==t;});}</script>`);
}

// ─── Full: разделы + конфиг + вывод ──────────────────────────────────────────
function generateFullHtml(meta, structured, lines, runId) {
  const date = new Date(meta.startedAt).toLocaleString('ru-RU');
  const dur  = meta.endedAt ? ((new Date(meta.endedAt)-new Date(meta.startedAt))/1000).toFixed(0)+'с' : '—';
  const { pass, fail, warn } = meta;

  const configBox = `<div class="cfg">
    <dt>Сайт</dt><dd>${esc(meta.config?.baseUrl||'—')}</dd>
    <dt>Режим</dt><dd>${esc(meta.mode)}</dd>
    <dt>SLOW_MS</dt><dd>${esc(meta.config?.slowMs||'2000')} мс</dd>
    <dt>Дата</dt><dd>${esc(date)}</dd>
    <dt>Длительность</dt><dd>${esc(dur)}</dd>
  </div>`;

  let secHtml = '';
  if (structured) {
    for (const s of structured.sections) {
      const ic = s.fail>0?'❌':s.warn>0?'⚠️':'✅';
      const rows = s.rows.map((r,i) => {
        const icon = r.status==='pass'?'✅':r.status==='fail'?'❌':'⚠️';
        return `<tr class="row-${r.status}" data-status="${r.status}">
          <td style="color:#484f58;font-size:10px">${i+1}</td><td>${icon}</td>
          <td><code>${esc(r.method)}</code></td><td class="endpoint">${esc(r.endpoint)}</td>
          <td><code>${esc(r.expected)}</code></td><td><code>${esc(r.actual)}</code></td>
          <td class="dc dc-full">${esc(r.details)}</td></tr>`;
      }).join('');
      secHtml += `<details ${s.fail>0?'open':''}>
        <summary>${ic} ${esc(s.name.toUpperCase())}
          <span class="ss"><span class="ssp">✅ ${s.pass}</span><span class="ssf">❌ ${s.fail}</span><span class="ssw">⚠️ ${s.warn}</span></span>
        </summary>
        <div style="overflow-x:auto"><table>
          <thead><tr><th>#</th><th>Рез</th><th>Метод</th><th>Эндпоинт</th><th>Ожидалось</th><th>Факт</th><th>Детали</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </details>`;
    }
    if (structured.createdUsers?.length) {
      const urows = structured.createdUsers.map(u =>
        `<tr><td style="color:#484f58">${esc(u.time||'')}</td>
         <td style="font-family:monospace">${esc(u.email||'')}</td>
         <td style="font-family:monospace;color:#484f58">${esc(u.id||'')}</td></tr>`
      ).join('');
      secHtml += `<details><summary>👥 Тестовые пользователи (${structured.createdUsers.length})</summary>
        <table><thead><tr><th>Время</th><th>Email</th><th>ID</th></tr></thead><tbody>${urows}</tbody></table>
      </details>`;
    }
  } else {
    secHtml = '<p style="color:#484f58;padding:12px">Нет структурированных данных. Запустите тест заново для полного отчёта.</p>';
  }

  const rawHtml = lines.length ? `<details>
    <summary>🖥 Сырой вывод (${lines.length} строк)</summary>
    <div class="raw">${lines.map(l=>esc(l)).join('\n')}</div>
  </details>` : '';

  return htmlPage('full', meta.mode, runId, `
    <h1>📰 Подробный отчёт: ${esc(meta.mode.toUpperCase())}</h1>
    <p class="meta">Дата: ${esc(date)}</p>
    <div class="stats">
      <div class="stat stat-pass"><div class="n">${pass}</div><div class="l">Прошло</div></div>
      <div class="stat stat-fail"><div class="n">${fail}</div><div class="l">Упало</div></div>
      <div class="stat stat-warn"><div class="n">${warn}</div><div class="l">Пред.</div></div>
    </div>
    <h2>Конфигурация</h2>${configBox}
    <h2>Результаты по разделам</h2>${secHtml}
    <h2>Терминал</h2>${rawHtml}`);
}

// legacy stub (used by old compare fallback)
function generateHtmlReport(meta, lines) {
  const date = new Date(meta.startedAt).toLocaleString('ru-RU');
  const dur  = meta.endedAt
    ? ((new Date(meta.endedAt) - new Date(meta.startedAt)) / 1000).toFixed(0) + 'с'
    : '—';
  const rows = [];
  let idx = 0;
  for (const line of lines) {
    const r = parseResultLine(line);
    if (!r) continue;
    idx++;
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⚠️';
    rows.push(`<tr class="row-${r.status}" data-status="${r.status}">
      <td style="color:#484f58">${idx}</td><td>${icon}</td>
      <td><code>${esc(r.method)}</code></td>
      <td>${esc(r.endpoint)}</td>
      <td><code>${esc(r.expected)}</code></td>
      <td><code>${esc(r.actual)}</code></td>
      <td style="color:#888;font-size:11px">${esc(r.details)}</td>
    </tr>`);
  }
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report: ${esc(meta.mode.toUpperCase())} · ${esc(date)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,Segoe UI,system-ui,sans-serif;font-size:14px;padding:24px}
h1{font-size:22px;color:#f0f6fc;margin-bottom:4px}
.meta{font-size:12px;color:#484f58;margin-bottom:16px}
.stats{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.stat{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:10px 20px;text-align:center;min-width:90px}
.stat .n{font-size:28px;font-weight:800;font-family:monospace}
.stat .l{font-size:11px;color:#484f58;text-transform:uppercase}
.stat-pass{border-color:rgba(63,185,80,.25)}.stat-pass .n{color:#3fb950}
.stat-fail{border-color:rgba(248,81,73,.25)}.stat-fail .n{color:#f85149}
.stat-warn{border-color:rgba(210,153,34,.25)}.stat-warn .n{color:#d29922}
.filters{margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap}
.filters button{background:#161b22;border:1px solid #21262d;color:#c9d1d9;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;transition:all .1s}
.filters button:hover{border-color:#484f58}
.filters button.active{background:#21262d;color:#f0f6fc;border-color:#484f58}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:8px 10px;border-bottom:2px solid #21262d;color:#484f58;font-size:11px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid #0d1117;vertical-align:top}
tr:hover td{background:#161b22}
code{font-family:monospace;font-size:11px;background:#0d1117;padding:1px 5px;border-radius:3px}
.row-pass td:nth-child(2){color:#3fb950}
.row-fail td:nth-child(2){color:#f85149}
.row-warn td:nth-child(2){color:#d29922}
tr[hidden]{display:none}
</style></head>
<body>
<h1>🧪 Test Report: ${esc(meta.mode.toUpperCase())}</h1>
<p class="meta">Сайт: ${esc(meta.config?.baseUrl||'—')} · Дата: ${esc(date)} · Длительность: ${esc(dur)}</p>
<div class="stats">
  <div class="stat stat-pass"><div class="n">${meta.pass}</div><div class="l">Прошло</div></div>
  <div class="stat stat-fail"><div class="n">${meta.fail}</div><div class="l">Упало</div></div>
  <div class="stat stat-warn"><div class="n">${meta.warn}</div><div class="l">Пред.</div></div>
</div>
<div class="filters">
  <button class="active" onclick="f('all',this)">Все (${idx})</button>
  <button onclick="f('fail',this)">❌ Упали (${meta.fail})</button>
  <button onclick="f('warn',this)">⚠️ Предупреждения (${meta.warn})</button>
  <button onclick="f('pass',this)">✅ Прошли (${meta.pass})</button>
</div>
<table>
<thead><tr><th>#</th><th>Рез</th><th>Метод</th><th>Эндпоинт</th><th>Ожидалось</th><th>Факт</th><th>Детали</th></tr></thead>
<tbody>${rows.join('')}</tbody>
</table>
<script>function f(t,b){document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('tr[data-status]').forEach(tr=>{tr.hidden=t!=='all'&&tr.dataset.status!==t});}</script>
</body></html>`;
}

// ─── Run factory ──────────────────────────────────────────────────────────────
function createRun(mode, config = {}, res) {
  if (!VALID_MODES.has(mode)) return res.status(400).json({ error: 'Неизвестный режим: ' + mode });
  if (mode === 'admin' && (!config.adminEmail || !config.adminPassword))
    return res.status(400).json({ error: 'Режим admin требует ADMIN_EMAIL и ADMIN_PASSWORD' });

  const runId = crypto.randomBytes(8).toString('hex');
  const env   = { ...process.env, NO_COLOR: '1', REPORT_DIR: path.join(RUNS_DIR, runId) };
  if (config.baseUrl)       env.BASE_URL       = String(config.baseUrl).trim();
  if (config.slowMs)        env.SLOW_MS        = String(Math.max(100, +config.slowMs || 2000));
  if (config.adminEmail)    env.ADMIN_EMAIL    = String(config.adminEmail).trim();
  if (config.adminPassword) env.ADMIN_PASSWORD = String(config.adminPassword);

  const args = [`--${mode}`];
  if (config.quiet)   args.push('--quiet');
  if (config.verbose) args.push('--verbose');

  const child = spawn(process.execPath, [path.join(__dirname, 'test-suite.js'), ...args],
    { cwd: __dirname, env, windowsHide: true });

  const lines = [];
  const sectionTracker = { current: null, index: 0, total: mode === 'all' ? ALL_SECTIONS.length : 0 };

  const run = {
    id: runId, mode, startedAt: new Date().toISOString(), endedAt: null,
    status: 'running', exitCode: null, pass: 0, fail: 0, warn: 0,
    config: { baseUrl: env.BASE_URL || 'http://95.31.169.106', slowMs: env.SLOW_MS || '2000' },
    lines, child, listeners: [],
    tgToken: config.telegramToken || TG_TOKEN,
    tgChat:  config.telegramChat  || TG_CHAT,
  };
  activeRuns.set(runId, run);

  function broadcast(msg) { for (const fn of run.listeners) fn(msg); }

  child.stdout.on('data', chunk => {
    for (const raw of chunk.toString().split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      lines.push(line);
      const msg = { line };
      if (mode === 'all') {
        const sm = line.match(SECTION_RE);
        if (sm) {
          const sec = sm[1].toLowerCase();
          sectionTracker.current = sec;
          sectionTracker.index   = ALL_SECTIONS.indexOf(sec) + 1;
          msg.section      = sec;
          msg.sectionIndex = sectionTracker.index;
          msg.totalSections = sectionTracker.total;
        }
      }
      broadcast(msg);
    }
  });

  child.stderr.on('data', chunk => {
    const line = '[ERR] ' + chunk.toString().replace(/\r?\n/g, ' ').trim();
    if (!line.trim()) return;
    lines.push(line);
    broadcast({ line });
  });

  child.on('close', code => {
    run.exitCode = code;
    run.endedAt  = new Date().toISOString();
    run.status   = run.status === 'running' ? 'done' : run.status;
    const s = parseSummary(lines);
    run.pass = s.pass; run.fail = s.fail; run.warn = s.warn;
    broadcast({ done: true, pass: run.pass, fail: run.fail, warn: run.warn });
    persistRun(run);
    if (run.tgToken && run.tgChat) {
      const dur  = ((new Date(run.endedAt) - new Date(run.startedAt)) / 1000).toFixed(0);
      const icon = run.fail > 0 ? '❌' : '✅';
      sendTelegram(
        `${icon} <b>Тест завершён: ${run.mode}</b>\n\n` +
        `✅ ${run.pass} | ❌ ${run.fail} | ⚠️ ${run.warn}\n\n` +
        `Сайт: <code>${run.config.baseUrl}</code>\nДлительность: ${dur}с`,
        run.tgToken, run.tgChat
      );
    }
  });

  res.json({ runId });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/modes',    (_req, res) => res.json(MODES));
app.get('/api/coverage', (_req, res) => res.json(COVERAGE));

app.get('/api/analytics', (_req, res) => {
  const runsMap = {};
  const add = meta => {
    if (meta.status === 'running') return;
    const m = meta.mode || 'unknown';
    if (!runsMap[m]) runsMap[m] = [];
    runsMap[m].push({
      id: meta.id, pass: meta.pass||0, fail: meta.fail||0, warn: meta.warn||0,
      status: meta.status, startedAt: meta.startedAt, endedAt: meta.endedAt,
      duration: meta.endedAt ? new Date(meta.endedAt)-new Date(meta.startedAt) : null,
    });
  };
  for (const [, r] of activeRuns) add(r);
  try {
    for (const dir of fs.readdirSync(RUNS_DIR)) {
      if (activeRuns.has(dir)) continue;
      const meta = tryLoadRunMeta(dir);
      if (meta) add(meta);
    }
  } catch(_) {}
  for (const m of Object.keys(runsMap)) {
    runsMap[m].sort((a,b) => new Date(a.startedAt)-new Date(b.startedAt));
    runsMap[m] = runsMap[m].slice(-30);
  }
  res.json(runsMap);
});

app.get('/api/analytics/failures', (_req, res) => {
  const counts = {};
  try {
    for (const dir of fs.readdirSync(RUNS_DIR)) {
      const s = getStructured(dir);
      if (!s) continue;
      for (const sec of (s.sections||[])) {
        for (const row of (sec.rows||[])) {
          const key = `${row.method}\t${row.endpoint}`;
          if (!counts[key]) counts[key] = { method: row.method, endpoint: row.endpoint, pass:0, fail:0, warn:0 };
          counts[key][row.status === 'pass' ? 'pass' : row.status === 'fail' ? 'fail' : 'warn']++;
        }
      }
    }
  } catch(_) {}
  const list = Object.values(counts)
    .filter(e => e.fail > 0)
    .map(e => ({ ...e, total: e.pass+e.fail+e.warn,
      failRate: Math.round(e.fail/(e.pass+e.fail+e.warn)*100) }))
    .sort((a,b) => b.fail - a.fail || b.failRate - a.failRate)
    .slice(0, 15);
  res.json(list);
});

app.get('/api/analytics/actuals', (_req, res) => {
  const byMode = {};
  try {
    const entries = fs.readdirSync(RUNS_DIR)
      .map(dir => { const m = tryLoadRunMeta(dir); return m ? { dir, meta: m } : null; })
      .filter(Boolean)
      .sort((a,b) => new Date(b.meta.startedAt)-new Date(a.meta.startedAt));
    for (const { dir, meta } of entries) {
      if (byMode[meta.mode]) continue;
      const s = getStructured(dir);
      if (!s) continue;
      byMode[meta.mode] = {
        startedAt: meta.startedAt,
        checks: s.sections.flatMap(sec => (sec.rows||[]).map(r => ({
          method: r.method, endpoint: r.endpoint,
          what: r.details || r.expected, status: r.status,
        }))),
      };
    }
  } catch(_) {}
  res.json(byMode);
});

app.get('/api/status', (_req, res) => res.json({
  telegram: !!(TG_TOKEN && TG_CHAT),
  auth:     !!DASHBOARD_TOKEN,
  port:     PORT,
}));

app.post('/api/run', (req, res) => {
  const { mode, config = {} } = req.body || {};
  createRun(mode, config, res);
});

app.get('/api/stream/:runId', (req, res) => {
  const run = activeRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  for (const line of run.lines) send({ line });
  if (run.status !== 'running') {
    send({ done: true, pass: run.pass, fail: run.fail, warn: run.warn });
    return res.end();
  }
  const listener = msg => { send(msg); if (msg.done) res.end(); };
  run.listeners.push(listener);
  req.on('close', () => { run.listeners = run.listeners.filter(l => l !== listener); });
});

app.delete('/api/run/:runId', (req, res) => {
  const run = activeRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (run.status !== 'running') return res.json({ status: run.status });
  try {
    run.child.kill();
    run.status  = 'cancelled';
    run.endedAt = new Date().toISOString();
    persistRun(run);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/runs', (_req, res) => {
  const result = [];
  for (const [, r] of activeRuns) {
    result.push({ id: r.id, mode: r.mode, startedAt: r.startedAt, endedAt: r.endedAt,
      status: r.status, pass: r.pass, fail: r.fail, warn: r.warn });
  }
  try {
    for (const dir of fs.readdirSync(RUNS_DIR)) {
      if (activeRuns.has(dir)) continue;
      const meta = tryLoadRunMeta(dir);
      if (meta) result.push(meta);
    }
  } catch (_) {}
  result.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(result.slice(0, 100));
});

app.get('/api/runs/:runId/output', (req, res) => {
  const data = getRunData(req.params.runId);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json({ lines: data.lines, ...data.meta });
});

app.get('/api/runs/:runId/report.html', (req, res) => {
  const { runId } = req.params;
  const type = ['summary', 'standard', 'full'].includes(req.query.type) ? req.query.type : 'standard';
  const data = getRunData(runId);
  const structured = getStructured(runId);
  if (!data) return res.status(404).send('<h1>Not found</h1>');
  if (req.query.download !== undefined) {
    res.setHeader('Content-Disposition', `attachment; filename="report-${data.meta.mode}-${type}-${data.meta.startedAt.slice(0,10)}.html"`);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (type === 'summary') res.send(generateSummaryHtml(data.meta, structured, data.lines, runId));
  else if (type === 'full') res.send(generateFullHtml(data.meta, structured, data.lines, runId));
  else res.send(generateStandardHtml(data.meta, structured, data.lines, runId));
});

app.get('/api/runs/:runId/results.json', (req, res) => {
  const { runId } = req.params;
  const structured = getStructured(runId);
  const data = getRunData(runId);
  if (!data) return res.status(404).json({ error: 'Not found' });
  if (req.query.download !== undefined) {
    res.setHeader('Content-Disposition', `attachment; filename="results-${data.meta.mode}-${data.meta.startedAt.slice(0,10)}.json"`);
  }
  res.json(structured || { error: 'No structured results available', meta: data.meta });
});

app.get('/api/runs/:runId/report.md', (req, res) => {
  const { runId } = req.params;
  const runDir = path.join(RUNS_DIR, runId);
  if (!fs.existsSync(runDir)) return res.status(404).send('Not found');
  const mdFile = fs.readdirSync(runDir).find(f => f.endsWith('.md'));
  if (!mdFile) return res.status(404).send('No markdown report for this run');
  const data = getRunData(runId);
  if (req.query.download !== undefined) {
    const name = data ? `report-${data.meta.mode}-${data.meta.startedAt.slice(0,10)}.md` : mdFile;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(path.join(runDir, mdFile), 'utf8'));
});

app.post('/api/runs/:runId/rerun', (req, res) => {
  const data = getRunData(req.params.runId);
  if (!data) return res.status(404).json({ error: 'Not found' });
  createRun(data.meta.mode, { ...data.meta.config, ...(req.body || {}) }, res);
});

app.get('/api/compare', (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ error: 'Provide ?a=runId&b=runId' });
  const dA = getRunData(a), dB = getRunData(b);
  if (!dA || !dB) return res.status(404).json({ error: 'One or both runs not found' });

  const toMap = lines => {
    const map = new Map();
    for (const l of lines) { const r = parseResultLine(l); if (r) map.set(`${r.method} ${r.endpoint}`, r); }
    return map;
  };
  const mapA = toMap(dA.lines), mapB = toMap(dB.lines);
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const ORDER = { changed: 0, added: 1, removed: 1, unchanged: 2 };
  const changes = [...keys].map(key => {
    const ra = mapA.get(key), rb = mapB.get(key);
    const type = !ra ? 'added' : !rb ? 'removed' : ra.status === rb.status ? 'unchanged' : 'changed';
    return { key, type, a: ra || null, b: rb || null };
  }).sort((x, y) => ORDER[x.type] - ORDER[y.type] || x.key.localeCompare(y.key));

  res.json({
    runA: { id: a, mode: dA.meta.mode, startedAt: dA.meta.startedAt, pass: dA.meta.pass, fail: dA.meta.fail, warn: dA.meta.warn },
    runB: { id: b, mode: dB.meta.mode, startedAt: dB.meta.startedAt, pass: dB.meta.pass, fail: dB.meta.fail, warn: dB.meta.warn },
    changes,
    summary: {
      changed:   changes.filter(c => c.type === 'changed').length,
      added:     changes.filter(c => c.type === 'added').length,
      removed:   changes.filter(c => c.type === 'removed').length,
      unchanged: changes.filter(c => c.type === 'unchanged').length,
    },
  });
});

app.delete('/api/runs/:runId', (req, res) => {
  const { runId } = req.params;
  if (activeRuns.has(runId) && activeRuns.get(runId).status === 'running')
    return res.status(400).json({ error: 'Cannot delete a running test' });
  activeRuns.delete(runId);
  try { fs.rmSync(path.join(RUNS_DIR, runId), { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  🌐  Psychohelp Test Dashboard\n  →  http://localhost:${PORT}\n`);
});
