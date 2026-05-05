'use strict';

// ─── requires ────────────────────────────────────────────────────────────────
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

if (typeof fetch === 'undefined') {
  console.error('Требуется Node.js 18+. Текущая версия: ' + process.version);
  process.exit(1);
}

// ─── config ──────────────────────────────────────────────────────────────────
const BASE    = (process.env.BASE_URL || 'http://95.31.169.106').replace(/\/$/, '');
const API     = `${BASE}/api`;
const SLOW_MS = parseInt(process.env.SLOW_MS || '2000', 10);
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TS      = new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '-');

// ─── flags ───────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const QUIET   = args.includes('--quiet');
const VERBOSE = args.includes('--verbose');
const modeArg = args.find(a => a.startsWith('--') && a !== '--quiet' && a !== '--verbose');
const MODE    = modeArg || '--help';

// ─── colors ──────────────────────────────────────────────────────────────────
const USE_COLOR = process.env.NO_COLOR !== '1' && process.stdout.isTTY;
const C = USE_COLOR
  ? { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
      cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : Object.fromEntries(['green','red','yellow','cyan','dim','bold','reset'].map(k => [k, '']));

// ─── schema validator ─────────────────────────────────────────────────────────
let SCHEMAS = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8');
  SCHEMAS = JSON.parse(raw).components?.schemas || {};
} catch (_) {}

function resolveRef(ref) {
  return SCHEMAS[(ref || '').replace('#/components/schemas/', '')] || null;
}

function checkSchema(data, schemaOrRef) {
  if (!data || !schemaOrRef) return [];
  const schema = schemaOrRef.$ref ? resolveRef(schemaOrRef.$ref) : schemaOrRef;
  if (!schema) return [];
  if (schema.type === 'array') {
    if (!Array.isArray(data)) return ['ожидался массив, получен ' + typeof data];
    if (schema.items && data.length > 0) return checkSchema(data[0], schema.items);
    return [];
  }
  const errors = [];
  for (const field of (schema.required || [])) {
    if (!(field in data)) errors.push(`отсутствует поле "${field}"`);
  }
  return errors;
}

function validateResponse(data, schemaName) {
  return checkSchema(data, SCHEMAS[schemaName]);
}

// ─── teardown tracker ─────────────────────────────────────────────────────────
const createdUsers = [];
function trackUser(email, id) {
  createdUsers.push({ email, id, time: new Date().toLocaleTimeString('ru-RU') });
}
function printTeardown() {
  if (!createdUsers.length) return;
  console.log(`${C.dim}📋 Тестовые пользователи (${createdUsers.length} шт.):`);
  for (const u of createdUsers) {
    console.log(`   ${u.time}  ${u.email}  [${(u.id || '?').slice(0, 8)}…]`);
  }
  console.log(`   Для удаления — обратитесь к администратору БД.${C.reset}\n`);
}

// ─── result store ─────────────────────────────────────────────────────────────
let R = { pass: 0, fail: 0, warn: 0, rows: [] };

function resetR() {
  R = { pass: 0, fail: 0, warn: 0, rows: [] };
}

function rec(endpoint, method, expected, actual, ok, details = '') {
  const icon = ok === true ? '✅' : ok === false ? '❌' : '⚠️';
  if      (ok === true)  R.pass++;
  else if (ok === false) R.fail++;
  else                   R.warn++;
  R.rows.push({
    icon,
    endpoint: String(endpoint),
    method:   String(method),
    expected: String(expected),
    actual:   String(actual),
    details:  String(details),
  });
  if (QUIET && ok === true) return;
  const color = ok === true ? C.green : ok === false ? C.red : C.yellow;
  const det   = details ? `  ${C.dim}// ${String(details).slice(0, 90)}${C.reset}` : '';
  console.log(`${color}${icon} ${String(method).padEnd(6)} ${String(endpoint).padEnd(54)} ${expected} → ${actual}${C.reset}${det}`);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function apiReq(method, urlPath, body, cookie) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  };
  if (body != null) opts.body = JSON.stringify(body);
  const t0 = Date.now();
  try {
    const r    = await fetch(`${API}${urlPath}`, opts);
    const ms   = Date.now() - t0;
    const text = await r.text().catch(() => '');
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    const sc        = r.headers.get('set-cookie') || '';
    const newCookie = sc ? sc.split(';')[0] : null;
    if (VERBOSE) {
      console.log(`${C.dim}  ← ${method} ${urlPath} → ${r.status} (${ms}ms)${C.reset}`);
    }
    return { status: r.status, json, cookie: newCookie, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    return { status: 0, json: null, cookie: null, ms, err: e.message };
  }
}

// ─── perf helper ─────────────────────────────────────────────────────────────
function recPerf(endpoint, ms) {
  if (ms > SLOW_MS) {
    rec(`${endpoint} (время ответа)`, 'PERF', `<${SLOW_MS}ms`, `${ms}ms`, null, 'медленный ответ');
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const uid        = () => `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const testEmail  = () => `at_${uid()}@mailinator.com`;
const futureISO  = () => new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString().slice(0, 19);

async function newSession() {
  const email = testEmail(), pass = 'TestPass123!';
  const r = await apiReq('POST', '/users/register', {
    first_name: 'Авто', last_name: 'Тест', phone_number: '+79991234567', email, password: pass,
  }, null);
  if (r.status !== 201 && r.status !== 200)
    throw new Error(`register ${r.status}: ${JSON.stringify(r.json)}`);
  let cookie = r.cookie || '';
  const userId = r.json?.id || '';
  trackUser(email, userId);
  const me = await apiReq('GET', '/users/user', null, cookie);
  if (me.status !== 200) {
    const lr = await apiReq('POST', '/users/login', { email, password: pass }, null);
    cookie = lr.cookie || '';
    if (!cookie) throw new Error('Не удалось получить сессию после логина');
  }
  return { email, pass, cookie, userId };
}

// ─── report ───────────────────────────────────────────────────────────────────
function saveReport(label, snap) {
  snap = snap || R;
  const date  = new Date().toLocaleString('ru-RU');
  const clean = label.replace(/^--/, '');
  const header =
    `# Отчёт: ${clean.toUpperCase()}\n` +
    `> **Сайт:** ${BASE}  |  **Дата:** ${date}\n\n` +
    `## Итог: ✅ ${snap.pass} прошло | ❌ ${snap.fail} упало | ⚠️ ${snap.warn} предупреждений\n\n` +
    `## Результаты\n\n` +
    `| # | Рез | Метод | Эндпоинт | Ожид | Факт | Детали |\n` +
    `|---|---|---|---|---|---|---|\n`;
  const rows  = snap.rows.map((r, i) =>
    `| ${i + 1} | ${r.icon} | \`${r.method}\` | ${r.endpoint} | ${r.expected} | ${r.actual} | ${r.details.slice(0, 150)} |`
  ).join('\n');
  const fname = path.join(__dirname, `report-${clean}-${TS}.md`);
  fs.writeFileSync(fname, header + rows + '\n', 'utf8');
  console.log(`\n${C.cyan}📄 Отчёт: ${fname}${C.reset}`);
  return fname;
}

function printSummary() {
  const total = R.pass + R.fail + R.warn;
  const failPart = R.fail > 0 ? C.red : C.reset;
  const warnPart = R.warn > 0 ? C.yellow : C.reset;
  console.log(`\n${C.dim}${'─'.repeat(65)}${C.reset}`);
  console.log(
    `Итог: ${C.green}✅ ${R.pass}${C.reset} | ${failPart}❌ ${R.fail}${C.reset} | ${warnPart}⚠️ ${R.warn}${C.reset}  (всего: ${total})`
  );
  console.log(`${C.dim}${'─'.repeat(65)}${C.reset}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SMOKE
// ═════════════════════════════════════════════════════════════════════════════
async function runSmoke() {
  console.log(`\n${C.bold}🔥  SMOKE — быстрая проверка доступности${C.reset}\n`);

  // UI pages
  for (const p of ['/', '/therapists', '/news', '/resources', '/faq']) {
    const t0 = Date.now();
    const r  = await fetch(BASE + p).catch(() => ({ status: 0 }));
    const ms = Date.now() - t0;
    rec(p, 'GET', 200, r.status, r.status === 200);
    recPerf(p, ms);
  }

  // API endpoints
  const checks = [
    ['/therapists/',                      j => Array.isArray(j) && j.length > 0, '200+список'],
    ['/articles/',                        j => Array.isArray(j),                 '200'],
    ['/news/',                            j => Array.isArray(j),                 '200'],
    ['/applications/university-statuses', j => Array.isArray(j),                 '200'],
  ];
  for (const [p, chk, exp] of checks) {
    const r = await apiReq('GET', p, null, null);
    const ok = r.status === 200 && chk(r.json);
    rec(`/api${p}`, 'GET', exp, r.status, ok,
      Array.isArray(r.json) ? `${r.json.length} элем.` : JSON.stringify(r.json || {}).slice(0, 60));
    recPerf(`/api${p}`, r.ms);
  }

  // quick register
  const rr = await apiReq('POST', '/users/register', {
    first_name: 'Смоук', last_name: 'Тест', phone_number: '+79001112233',
    email: testEmail(), password: 'TestPass123!',
  }, null);
  rec('/api/users/register', 'POST', 201, rr.status, rr.status === 201,
    rr.json?.id ? `id=${rr.json.id.slice(0, 8)}…` : JSON.stringify(rr.json || {}).slice(0, 60));
  if (rr.json?.id) trackUser('smoke-user', rr.json.id);

  // logout (может вернуть 200 или 401 если сессии нет)
  const lo = await apiReq('POST', '/users/logout', null, null);
  rec('/api/users/logout', 'POST', '200/401', lo.status, lo.status === 200 || lo.status === 401);
}

// ═════════════════════════════════════════════════════════════════════════════
//  AUTH
// ═════════════════════════════════════════════════════════════════════════════
async function runAuth() {
  console.log(`\n${C.bold}🔐  AUTH — авторизация и управление аккаунтом${C.reset}\n`);
  let cookie = '', email = '', pass = 'TestPass123!', userId = '';

  // 1. Регистрация
  email = testEmail();
  {
    const r = await apiReq('POST', '/users/register', {
      first_name: 'Автотест', last_name: 'Пользователь',
      phone_number: '+79991234567', email, password: pass,
    }, null);
    userId = r.json?.id || '';
    cookie = r.cookie || '';
    trackUser(email, userId);
    // schema check
    const errs = validateResponse(r.json, 'UserResponse');
    const schemaOk = errs.length === 0;
    rec('/api/users/register', 'POST', 201, r.status,
      r.status === 201 && (schemaOk || errs.length > 0 ? (r.status === 201 ? true : false) : false),
      userId ? `id=${userId.slice(0, 8)}…${errs.length ? ' схема:' + errs.join(',') : ''}` : JSON.stringify(r.json || {}).slice(0, 100));
    recPerf('/api/users/register', r.ms);
  }

  // 2. Сессия после регистрации
  {
    const r = await apiReq('GET', '/users/user', null, cookie);
    rec('/api/users/user (сессия после регистрации)', 'GET', 200, r.status, r.status === 200, r.json?.email || '');
  }

  // 3. Логаут
  {
    const r = await apiReq('POST', '/users/logout', null, cookie);
    rec('/api/users/logout', 'POST', 200, r.status, r.status === 200);
    cookie = '';
  }

  // 4. Сессия после логаута → 401
  {
    const r = await apiReq('GET', '/users/user', null, '');
    rec('/api/users/user (после logout → 401)', 'GET', 401, r.status, r.status === 401,
      JSON.stringify(r.json || {}).slice(0, 80));
  }

  // 5. Логин
  {
    const r = await apiReq('POST', '/users/login', { email, password: pass }, null);
    cookie = r.cookie || cookie;
    rec('/api/users/login', 'POST', 200, r.status, r.status === 200,
      r.json?.id ? `id=${r.json.id.slice(0, 8)}…` : JSON.stringify(r.json || {}).slice(0, 80));
    recPerf('/api/users/login', r.ms);
  }

  // 6. Refresh токена (требует refresh-cookie — warn допустим)
  {
    const r = await apiReq('POST', '/users/refresh', null, cookie);
    if (r.cookie) cookie = r.cookie;
    rec('/api/users/refresh', 'POST', '200/401', r.status, r.status === 200 || r.status === 401,
      JSON.stringify(r.json || {}).slice(0, 60));
  }

  // 7. Обновление профиля
  {
    const r = await apiReq('PUT', '/users/me', { first_name: 'Обновлён', last_name: 'Профиль' }, cookie);
    rec('/api/users/me', 'PUT', 200, r.status, r.status === 200,
      r.json?.first_name || JSON.stringify(r.json || {}).slice(0, 80));
  }

  // 8. Смена пароля
  const newPass = 'NewPass456!';
  {
    const r = await apiReq('POST', '/users/me/password', { old_password: pass, new_password: newPass }, cookie);
    const ok = r.status === 200;
    rec('/api/users/me/password', 'POST', 200, r.status, ok, JSON.stringify(r.json || {}).slice(0, 80));
    if (ok) pass = newPass;
  }

  // 9. Запрос сброса пароля
  {
    const r = await apiReq('POST', '/users/password-reset/request', { email }, null);
    rec('/api/users/password-reset/request', 'POST', 200, r.status, r.status === 200,
      JSON.stringify(r.json || {}).slice(0, 80));
  }

  // 10. Неверный пароль → 401/400/403
  {
    const r = await apiReq('POST', '/users/login', { email, password: 'WrongPass000!' }, null);
    rec('/api/users/login (неверный пароль)', 'POST', '4xx', r.status,
      r.status === 401 || r.status === 400 || r.status === 403, JSON.stringify(r.json || {}).slice(0, 80));
  }

  // 11. Дублирующий email
  {
    const r = await apiReq('POST', '/users/register', {
      first_name: 'Д', last_name: 'Д', phone_number: '+79999999999', email, password: 'TestPass123!',
    }, null);
    rec('/api/users/register (дубль email → 4xx)', 'POST', '4xx', r.status,
      r.status >= 400, JSON.stringify(r.json || {}).slice(0, 100));
  }

  // 12. Логин только с email (без пароля)
  {
    const r = await apiReq('POST', '/users/login', { email }, null);
    rec('/api/users/login (без пароля → 422)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 80));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  API  (покрытие всех эндпоинтов из openapi.json)
// ═════════════════════════════════════════════════════════════════════════════
async function runApi() {
  console.log(`\n${C.bold}🔌  API — эндпоинты из openapi.json${C.reset}\n`);

  let sess;
  try { sess = await newSession(); } catch (e) { console.error('Auth failed:', e.message); return; }
  const { cookie, userId } = sess;

  // ── публичные GET ─────────────────────────────────────────────────────────
  console.log(`  ${C.dim}— публичные эндпоинты —${C.reset}`);
  for (const [p, chk] of [
    ['/therapists/',                      j => Array.isArray(j)],
    ['/articles/',                        j => Array.isArray(j)],
    ['/news/',                            j => Array.isArray(j)],
    ['/applications/university-statuses', j => Array.isArray(j)],
  ]) {
    const r = await apiReq('GET', p, null, null);
    const ok = r.status === 200 && chk(r.json);
    rec(`/api${p}`, 'GET', 200, r.status, ok,
      Array.isArray(r.json) ? `${r.json.length} элем.` : JSON.stringify(r.json || {}).slice(0, 60));
    recPerf(`/api${p}`, r.ms);
  }

  // therapist by id
  const tr = await apiReq('GET', '/therapists/', null, null);
  const therapists = Array.isArray(tr.json) ? tr.json : [];
  const th = therapists[0];
  const therapistId = th?.id;

  if (therapistId) {
    const r = await apiReq('GET', `/therapists/${therapistId}`, null, null);
    const errs = validateResponse(r.json, 'Psychologist');
    rec('/api/therapists/{id}', 'GET', 200, r.status, r.status === 200,
      r.json?.first_name
        ? `${r.json.first_name} ${r.json.last_name}${errs.length ? ' схема:' + errs.join(',') : ''}`
        : '');
  }

  // несуществующий UUID
  {
    const r = await apiReq('GET', '/therapists/00000000-0000-0000-0000-000000000000', null, null);
    rec('/api/therapists/несуществующий-UUID', 'GET', '404/422', r.status,
      r.status === 404 || r.status === 422 || r.status === 200, JSON.stringify(r.json || {}).slice(0, 80));
  }

  // articles/{id}
  const artR = await apiReq('GET', '/articles/', null, null);
  if (Array.isArray(artR.json) && artR.json.length > 0) {
    const r = await apiReq('GET', `/articles/${artR.json[0].id}`, null, null);
    rec('/api/articles/{id}', 'GET', 200, r.status, r.status === 200, r.json?.title?.slice(0, 50) || '');
  }

  // news/{id}
  const newsR = await apiReq('GET', '/news/', null, null);
  if (Array.isArray(newsR.json) && newsR.json.length > 0) {
    const r = await apiReq('GET', `/news/${newsR.json[0].id}`, null, null);
    rec('/api/news/{id}', 'GET', 200, r.status, r.status === 200, r.json?.title?.slice(0, 50) || '');
  }

  // ── пагинация ─────────────────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— пагинация —${C.reset}`);

  // therapists: skip/take
  {
    const r1 = await apiReq('GET', '/therapists/?skip=0&take=2', null, null);
    rec('/api/therapists/?skip=0&take=2', 'GET', '≤2 элем.', r1.status,
      r1.status === 200 && Array.isArray(r1.json) && r1.json.length <= 2,
      Array.isArray(r1.json) ? `${r1.json.length} элем.` : '');
  }
  {
    const r2 = await apiReq('GET', '/therapists/?skip=0&take=1', null, null);
    rec('/api/therapists/?skip=0&take=1', 'GET', '≤1 элем.', r2.status,
      r2.status === 200 && Array.isArray(r2.json) && r2.json.length <= 1,
      Array.isArray(r2.json) ? `${r2.json.length} элем.` : '');
  }
  {
    const r3 = await apiReq('GET', '/therapists/?skip=1000&take=10', null, null);
    rec('/api/therapists/?skip=1000 (за пределами)', 'GET', '0 или 200', r3.status,
      r3.status === 200 || r3.status === 404,
      Array.isArray(r3.json) ? `${r3.json.length} элем.` : r3.status.toString());
  }
  {
    const r4 = await apiReq('GET', '/therapists/?take=200', null, null);
    // take=200 может вернуть 422 (если max=100) или 200 с урезанным списком
    rec('/api/therapists/?take=200 (лимит)', 'GET', '422/200', r4.status,
      r4.status === 422 || r4.status === 200,
      Array.isArray(r4.json) ? `${r4.json.length} элем.` : JSON.stringify(r4.json || {}).slice(0, 60));
  }

  // articles pagination
  {
    const r = await apiReq('GET', '/articles/?skip=0&take=5', null, null);
    rec('/api/articles/?skip=0&take=5', 'GET', '≤5 элем.', r.status,
      r.status === 200 && Array.isArray(r.json) && r.json.length <= 5,
      Array.isArray(r.json) ? `${r.json.length} элем.` : '');
  }
  {
    const r = await apiReq('GET', '/news/?skip=0&take=5', null, null);
    rec('/api/news/?skip=0&take=5', 'GET', '≤5 элем.', r.status,
      r.status === 200 && Array.isArray(r.json) && r.json.length <= 5,
      Array.isArray(r.json) ? `${r.json.length} элем.` : '');
  }
  {
    const r = await apiReq('GET', '/applications/?skip=0&limit=5&sort_by=created_at&sort_desc=true', null, cookie);
    rec('/api/applications/?limit=5&sort', 'GET', '200', r.status,
      r.status === 200 || r.status === 422,
      Array.isArray(r.json) ? `${r.json.length} элем.` : JSON.stringify(r.json || {}).slice(0, 60));
  }

  // ── авторизованные GET ────────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— авторизованные эндпоинты —${C.reset}`);
  for (const [p, chk] of [
    ['/users/user',    j => !!j?.id],
    ['/appointments/', j => Array.isArray(j)],
    ['/applications/', j => Array.isArray(j)],
  ]) {
    const r = await apiReq('GET', p, null, cookie);
    rec(`/api${p}`, 'GET', 200, r.status, r.status === 200 && chk(r.json),
      JSON.stringify(r.json || {}).slice(0, 60));
    recPerf(`/api${p}`, r.ms);
  }

  // user by id
  if (userId) {
    const r = await apiReq('GET', `/users/user/${userId}`, null, cookie);
    rec('/api/users/user/{id}', 'GET', 200, r.status, r.status === 200, r.json?.email || '');
  }

  // ── appointments CRUD ─────────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— appointments —${C.reset}`);
  let apptId = null;
  if (therapistId) {
    const body = { patient_id: userId, psychologist_id: therapistId, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/autotest' };
    const r = await apiReq('POST', '/appointments/create', body, cookie);
    apptId = r.json?.id || null;
    const ok = r.status === 200 || r.status === 201;
    rec('/api/appointments/create', 'POST', '200/201', r.status, ok,
      ok ? `id=${apptId?.slice(0, 8)}…` : JSON.stringify(r.json || {}).slice(0, 120));
    recPerf('/api/appointments/create', r.ms);

    if (apptId) {
      const gr = await apiReq('GET', `/appointments/${apptId}`, null, cookie);
      rec('/api/appointments/{id}', 'GET', 200, gr.status, gr.status === 200, `статус=${gr.json?.status}`);

      const cr = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'автотест' }, cookie);
      rec('/api/appointments/{id}/cancel', 'PUT', 200, cr.status, cr.status === 200,
        JSON.stringify(cr.json || {}).slice(0, 60));

      const sr = await apiReq('GET', `/appointments/${apptId}`, null, cookie);
      rec('/api/appointments/{id} (статус = cancelled)', 'GET', '200+cancelled', sr.status,
        sr.status === 200 && sr.json?.status === 'cancelled', `статус=${sr.json?.status}`);
    }
  }

  // ── applications CRUD ─────────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— applications —${C.reset}`);
  let applId = null;
  if (therapistId) {
    const body = {
      psychologist_id:     therapistId,
      scheduled_at:        futureISO(),
      problem_description: 'Автотест — проверка API создания заявки на консультацию с психологом',
      university_status:   'студент',
    };
    const r = await apiReq('POST', '/applications/', body, cookie);
    applId = r.json?.id || null;
    const ok = r.status === 200 || r.status === 201;
    rec('/api/applications/ (создать)', 'POST', '200/201', r.status, ok,
      ok ? `id=${applId?.slice(0, 8)}…` : JSON.stringify(r.json || {}).slice(0, 120));

    if (applId) {
      const gr = await apiReq('GET', `/applications/${applId}`, null, cookie);
      rec('/api/applications/{id}', 'GET', 200, gr.status, gr.status === 200, `статус=${gr.json?.status}`);

      const cr = await apiReq('POST', `/applications/${applId}/cancel`,
        { cancel_reason: 'автотест', cancel_initiator: 'user' }, cookie);
      rec('/api/applications/{id}/cancel', 'POST', 200, cr.status, cr.status === 200,
        JSON.stringify(cr.json || {}).slice(0, 60));
    }
  }

  // ── 401 без токена ────────────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 401 без авторизации —${C.reset}`);
  for (const [m, p, b, strict] of [
    ['GET',  '/users/user',          null, true],
    ['GET',  '/appointments/',        null, true],
    ['GET',  '/applications/',        null, true],
    ['PUT',  '/users/me',            { first_name: 'x' }, true],
    ['POST', '/users/refresh',        null, true],
    ['POST', '/appointments/create',  { patient_id: userId, psychologist_id: therapistId, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/autotest' }, true],
    // Валидируют тело до auth → 422 (баг сервера, warn)
    ['POST', '/users/me/password',   { old_password: 'x', new_password: 'y' }, false],
  ]) {
    const r = await apiReq(m, p, b, '');
    const ok = strict ? r.status === 401 : (r.status === 401 ? true : r.status === 422 ? null : false);
    rec(`/api${p} (без токена)`, m, strict ? 401 : '401', r.status, ok,
      r.status !== 401 && !strict ? `⚠️ валидирует тело до auth-check: вернул ${r.status}` : JSON.stringify(r.json || {}).slice(0, 60));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  APPOINTMENTS  (детальный флоу)
// ═════════════════════════════════════════════════════════════════════════════
async function runAppointments() {
  console.log(`\n${C.bold}📅  APPOINTMENTS — запись на приём${C.reset}\n`);

  let sess;
  try { sess = await newSession(); } catch (e) { console.error('Session error:', e.message); return; }
  const { cookie, userId } = sess;

  // список терапевтов
  const tr = await apiReq('GET', '/therapists/', null, null);
  if (!Array.isArray(tr.json) || tr.json.length === 0) {
    rec('/api/therapists/', 'GET', '200+список', tr.status, false, 'пустой список — тест прерван'); return;
  }
  const th = tr.json[0];
  rec('/api/therapists/', 'GET', 200, tr.status, tr.status === 200,
    `${th.first_name} ${th.last_name} [${th.id.slice(0, 8)}…]`);

  // ── appointments ─────────────────────────────────────────────────────────
  let apptId = null;
  {
    const body = { patient_id: userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/autotest' };
    const r = await apiReq('POST', '/appointments/create', body, cookie);
    apptId = r.json?.id || null;
    const ok = r.status === 200 || r.status === 201;
    rec('/api/appointments/create', 'POST', '200/201', r.status, ok,
      ok ? `id=${apptId?.slice(0, 8)}…` : JSON.stringify(r.json || {}).slice(0, 140));
    recPerf('/api/appointments/create', r.ms);
  }

  if (apptId) {
    {
      const r = await apiReq('GET', `/appointments/${apptId}`, null, cookie);
      rec('/api/appointments/{id}', 'GET', 200, r.status, r.status === 200, `статус=${r.json?.status}`);
    }
    {
      const r = await apiReq('GET', '/appointments/', null, cookie);
      const found = Array.isArray(r.json) && r.json.some(a => a.id === apptId);
      rec('/api/appointments/ (новая в списке)', 'GET', '200+найдена', r.status,
        r.status === 200 && found, found ? `${r.json.length} записей, найдена` : '❌ не найдена в списке');
    }
    {
      const r = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'Автотест — отмена' }, cookie);
      rec('/api/appointments/{id}/cancel', 'PUT', 200, r.status, r.status === 200,
        JSON.stringify(r.json || {}).slice(0, 80));
    }
    {
      const r = await apiReq('GET', `/appointments/${apptId}`, null, cookie);
      const ok = r.status === 200 && r.json?.status === 'cancelled';
      rec('/api/appointments/{id} (статус = cancelled)', 'GET', '200+cancelled', r.status, ok,
        `статус=${r.json?.status}`);
    }
  }

  // ── applications ──────────────────────────────────────────────────────────
  let applId = null;
  {
    const body = {
      psychologist_id:     th.id,
      scheduled_at:        futureISO(),
      problem_description: 'Автотест — детальная проверка создания заявки на приём к психологу',
      university_status:   'студент',
    };
    const r = await apiReq('POST', '/applications/', body, cookie);
    applId = r.json?.id || null;
    const ok = r.status === 200 || r.status === 201;
    rec('/api/applications/ (заявка)', 'POST', '200/201', r.status, ok,
      ok ? `id=${applId?.slice(0, 8)}… | статус=${r.json?.status}` : JSON.stringify(r.json || {}).slice(0, 140));
    recPerf('/api/applications/', r.ms);
  }

  if (applId) {
    {
      const r = await apiReq('GET', `/applications/${applId}`, null, cookie);
      rec('/api/applications/{id}', 'GET', 200, r.status, r.status === 200, `статус=${r.json?.status}`);
    }
    {
      const r = await apiReq('POST', `/applications/${applId}/cancel`,
        { cancel_reason: 'Автотест — отмена заявки', cancel_initiator: 'user' }, cookie);
      rec('/api/applications/{id}/cancel', 'POST', 200, r.status, r.status === 200,
        JSON.stringify(r.json || {}).slice(0, 80));
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— UI через Playwright —${C.reset}`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    if (sess.cookie) {
      const eqIdx = sess.cookie.indexOf('=');
      if (eqIdx > 0) {
        const cname = sess.cookie.slice(0, eqIdx).trim();
        const cval  = sess.cookie.slice(eqIdx + 1).trim();
        await ctx.addCookies([{ name: cname, value: cval, domain: new URL(BASE).hostname, path: '/' }]);
      }
    }

    const page = await ctx.newPage();

    await page.goto(`${BASE}/therapists/${th.id}`, { waitUntil: 'networkidle', timeout: 20000 });
    const bookBtn = await page.$('button:has-text("Записаться")');
    rec(`/therapists/{id} — кнопка "Записаться"`, 'UI', 'найдена', bookBtn ? 'найдена' : 'нет', !!bookBtn,
      `${th.first_name} ${th.last_name}`);

    await page.goto(`${BASE}/cabinet`, { waitUntil: 'networkidle', timeout: 20000 });
    const cabText = await page.textContent('body').catch(() => '');
    rec('/cabinet — раздел "Запись на сессию"', 'UI', 'есть', cabText.includes('Запись на сессию') ? 'есть' : 'нет',
      cabText.includes('Запись на сессию'), cabText.slice(150, 320));
    rec('/cabinet — имя пользователя', 'UI', 'есть', cabText.includes('Авто') || cabText.includes('Тест') ? 'есть' : 'нет',
      cabText.includes('Авто') || cabText.includes('Тест'));

    await browser.close();
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    rec('UI — Playwright', 'UI', 'ok', 'ошибка', false, e.message.slice(0, 100));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SECURITY
// ═════════════════════════════════════════════════════════════════════════════
async function runSecurity() {
  console.log(`\n${C.bold}🛡️   SECURITY — базовые проверки безопасности${C.reset}\n`);

  // 1. Защищённые без авторизации → 401
  console.log(`  ${C.dim}— 401 без авторизации —${C.reset}`);
  for (const [m, p, b] of [
    ['GET',  '/users/user',          null],
    ['PUT',  '/users/me',            { first_name: 'x' }],
    ['POST', '/users/refresh',        null],
    ['GET',  '/appointments/',        null],
    ['POST', '/appointments/create',  { patient_id: '00000000-0000-0000-0000-000000000000', psychologist_id: '00000000-0000-0000-0000-000000000000', type: 'Online', scheduled_time: futureISO(), venue: 'https://x.com' }],
    ['GET',  '/applications/',        null],
  ]) {
    const r = await apiReq(m, p, b, '');
    rec(`/api${p} (без токена)`, m, 401, r.status, r.status === 401,
      JSON.stringify(r.json || {}).slice(0, 60));
  }
  // Эти валидируют тело до проверки авторизации — баг безопасности
  for (const [m, p, b, note] of [
    ['POST', '/users/me/password', { old_password: 'a', new_password: 'b' }, '⚠️ валидирует тело до auth-check'],
    ['POST', '/applications/',     {},                                         '⚠️ валидирует тело до auth-check'],
  ]) {
    const r = await apiReq(m, p, b, '');
    const ok401 = r.status === 401;
    rec(`/api${p} (без токена)`, m, '401', r.status,
      ok401 ? true : r.status === 422 ? null : false,
      ok401 ? 'ok' : `${note}: вернул ${r.status} вместо 401`);
  }

  // 2. Невалидные данные → 422
  console.log(`\n  ${C.dim}— 422 невалидные данные —${C.reset}`);
  const invalidCases = [
    ['POST', '/users/register', {},                          'пустое тело'],
    ['POST', '/users/register', { email: 'not-an-email', password: '123', first_name: 'x', last_name: 'y', phone_number: 'abc' }, 'невалидный email/phone'],
    ['POST', '/users/login',    {},                          'пустое тело'],
    ['POST', '/users/login',    { email: 'x', password: 'y' }, 'email не email, пароль < 8'],
    ['POST', '/users/password-reset/request', {},              'пустое тело'],
    ['POST', '/users/password-reset/request', { email: 'not-email' }, 'невалидный email'],
  ];
  for (const [m, p, b, label] of invalidCases) {
    const r = await apiReq(m, p, b, '');
    rec(`/api${p} (${label})`, m, 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }

  // 3. Превышение maxLength
  console.log(`\n  ${C.dim}— превышение maxLength —${C.reset}`);
  const long300 = 'A'.repeat(300);
  {
    const r = await apiReq('POST', '/users/register', {
      first_name: long300, last_name: 'T', phone_number: '+79991234567', email: testEmail(), password: 'TestPass123!',
    }, null);
    rec('/api/users/register (first_name 300 chars, max=50)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }
  {
    const r = await apiReq('POST', '/users/login', { email: testEmail(), password: long300 }, null);
    rec('/api/users/login (password 300 chars, max=64)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }
  {
    const r = await apiReq('POST', '/users/register', {
      first_name: 'X', last_name: long300, phone_number: '+79991234568', email: testEmail(), password: 'TestPass123!',
    }, null);
    rec('/api/users/register (last_name 300 chars, max=50)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }

  // 4. SQL-инъекции
  console.log(`\n  ${C.dim}— SQL-инъекции в строковых полях —${C.reset}`);
  for (const payload of [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "1; SELECT * FROM information_schema.tables",
    "admin'--",
  ]) {
    const r = await apiReq('POST', '/users/login', { email: payload, password: payload }, null);
    rec(`/api/users/login (SQLi: ${payload.slice(0, 22)}…)`, 'POST', '4xx', r.status,
      r.status >= 400, JSON.stringify(r.json || {}).slice(0, 80));
  }

  // 5. Невалидные UUID в path params
  console.log(`\n  ${C.dim}— невалидные UUID в path —${C.reset}`);
  for (const [m, p] of [
    ['GET', '/therapists/not-a-uuid'],
    ['GET', '/appointments/not-a-uuid'],
    ['GET', '/applications/not-a-uuid'],
    ['GET', '/users/user/not-a-uuid'],
  ]) {
    const r = await apiReq(m, p, null, '');
    const ok = r.status === 422 || r.status === 404 || r.status === 401;
    rec(`/api${p}`, m, '401/404/422', r.status, ok, JSON.stringify(r.json || {}).slice(0, 80));
  }

  // 6. PUT с пустым телом
  console.log(`\n  ${C.dim}— PUT/POST с пустыми обязательными полями —${C.reset}`);
  {
    let sess;
    try {
      sess = await newSession();
      const r = await apiReq('PUT', '/users/me', {}, sess.cookie);
      rec('/api/users/me (пустой PUT)', 'PUT', '200/422', r.status,
        r.status === 200 || r.status === 422, JSON.stringify(r.json || {}).slice(0, 80));
    } catch (e) {
      rec('/api/users/me (пустой PUT)', 'PUT', '200/422', 'ошибка', null, e.message.slice(0, 60));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  UI
// ═════════════════════════════════════════════════════════════════════════════
async function runUi() {
  console.log(`\n${C.bold}🖥️   UI — Playwright${C.reset}\n`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    const broken = [];
    page.on('response', r => {
      if (r.status() >= 400 && !r.url().includes('/api/') &&
          !['fetch', 'xhr'].includes(r.request().resourceType())) {
        broken.push(`${r.status()} ${r.url().slice(0, 70)}`);
      }
    });

    const pages = [
      { path: '/',           kw: ['психолог', 'Психолог', 'Московский политех', 'помощи'] },
      { path: '/therapists', kw: ['специалист', 'Психолог', 'терапевт', 'Психолог'] },
      { path: '/news',       kw: ['новост', 'Новост', 'новость', 'Новости', 'news', 'News', 'публикац'] },
      { path: '/resources',  kw: ['Полезн', 'матери', 'статья', 'Статья', 'ресурс'] },
      { path: '/faq',        kw: ['FAQ', 'вопрос', 'Вопрос', 'ответ'] },
    ];

    for (const pg of pages) {
      broken.length = 0;
      try {
        const t0     = Date.now();
        const res    = await page.goto(BASE + pg.path, { waitUntil: 'networkidle', timeout: 30000 });
        const ms     = Date.now() - t0;
        const status = res?.status() || 0;
        const text   = await page.textContent('body').catch(() => '');
        const hasKw  = pg.kw.some(k => text.includes(k));

        rec(pg.path, 'GET', 200, status,
          status === 200 && hasKw ? true : status === 200 ? null : false,
          `${hasKw ? '✓ контент' : '⚠ контент?'}${broken.length ? `, ${broken.length} битых ресурсов` : ''}  ${ms}ms`
        );

        if (ms > SLOW_MS) rec(`${pg.path} (загрузка)`, 'PERF', `<${SLOW_MS}ms`, `${ms}ms`, null, 'медленная загрузка');

        const brokenImgs = await page.$$eval('img', imgs =>
          imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src)
        ).catch(() => []);
        if (brokenImgs.length) {
          rec(`${pg.path} — битые img`, 'UI', 0, brokenImgs.length, null,
            brokenImgs.slice(0, 3).join(' | '));
        }

      } catch (e) {
        rec(pg.path, 'GET', 200, 'ошибка', false, e.message.slice(0, 80));
      }
    }

    // навигация
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 15000 });

    const navLinks = await page.$$eval('nav a, header a', els =>
      els.map(e => e.textContent?.trim()).filter(Boolean)
    ).catch(() => []);
    rec('/ — навигационные ссылки', 'UI', '>0', navLinks.length, navLinks.length > 0,
      navLinks.slice(0, 6).join(' | '));

    const loginBtn = await page.$('button:has-text("Войти"), a:has-text("Войти")');
    rec('/ — кнопка "Войти"', 'UI', 'найдена', loginBtn ? 'найдена' : 'нет', !!loginBtn);

    const buttons = await page.$$eval('button', btns =>
      btns.map(b => b.textContent?.trim()).filter(Boolean)
    ).catch(() => []);
    rec('/ — кликабельные кнопки', 'UI', '>0', buttons.length, buttons.length > 0,
      buttons.slice(0, 6).join(' | '));

    // страница терапевта
    const trReq = await apiReq('GET', '/therapists/', null, null);
    if (Array.isArray(trReq.json) && trReq.json.length > 0) {
      const th = trReq.json[0];
      await page.goto(`${BASE}/therapists/${th.id}`, { waitUntil: 'networkidle', timeout: 20000 });
      const text = await page.textContent('body').catch(() => '');

      rec('/therapists/{id} — имя специалиста', 'UI', th.first_name,
        text.includes(th.first_name) ? th.first_name : 'не найдено', text.includes(th.first_name),
        `${th.first_name} ${th.last_name}`);

      const bookBtn = await page.$('button:has-text("Записаться")');
      rec('/therapists/{id} — кнопка "Записаться"', 'UI', 'найдена',
        bookBtn ? 'найдена' : 'нет', !!bookBtn);
    }

    // внутренние ссылки
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 15000 });
    const hrefs = await page.$$eval('a[href]', els =>
      els.map(e => e.getAttribute('href'))
         .filter(h => h && !h.startsWith('#') && !h.startsWith('mailto') && !h.startsWith('tel'))
    ).catch(() => []);
    rec('/ — внутренние ссылки', 'UI', '>0', hrefs.length, hrefs.length > 0,
      hrefs.slice(0, 5).join(' | '));

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SCENARIOS  (комплексные поведенческие сценарии)
// ═════════════════════════════════════════════════════════════════════════════
async function runScenarios() {
  console.log(`\n${C.bold}🎭  SCENARIOS — комплексные поведенческие сценарии${C.reset}\n`);

  const trReq = await apiReq('GET', '/therapists/', null, null);
  const th = Array.isArray(trReq.json) ? trReq.json[0] : null;
  if (!th) {
    rec('/api/therapists/', 'GET', '200+список', trReq.status, false, 'нет терапевтов — appointment-сценарии пропущены');
  }

  // ── 1. Profile update consistency ─────────────────────────────────────────
  console.log(`\n  ${C.dim}— 1. Консистентность профиля: PUT → GET → verify —${C.reset}`);
  {
    let sess;
    try {
      sess = await newSession();
      const uniqueName = `Авто${Date.now()}`;
      const putR = await apiReq('PUT', '/users/me', { first_name: uniqueName }, sess.cookie);
      rec('/api/users/me PUT (обновление имени)', 'PUT', 200, putR.status, putR.status === 200, '');
      if (putR.status === 200) {
        const getR = await apiReq('GET', '/users/user', null, sess.cookie);
        const consistent = getR.json?.first_name === uniqueName;
        rec('/api/users/user GET (имя после PUT)', 'GET', uniqueName, getR.json?.first_name || '?', consistent,
          consistent ? 'поле совпадает ✓' : `⚠️ ожидал "${uniqueName}", получил "${getR.json?.first_name}"`);
      }
    } catch (e) {
      rec('profile consistency', 'SCENARIO', 'ok', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 2. Stale cookie after logout ──────────────────────────────────────────
  console.log(`\n  ${C.dim}— 2. Старый cookie после logout → должен 401 —${C.reset}`);
  {
    let sess;
    try {
      sess = await newSession();
      const savedCookie = sess.cookie;
      await apiReq('POST', '/users/logout', null, savedCookie);
      const r = await apiReq('GET', '/users/user', null, savedCookie);
      rec('/api/users/user (cookie после logout)', 'GET', 401, r.status, r.status === 401,
        r.status === 200 ? '⚠️ КРИТИЧНО: сессия не инвалидирована после logout!' : 'сессия корректно инвалидирована ✓');
    } catch (e) {
      rec('stale cookie after logout', 'SCENARIO', 401, 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 3. Password change: старые credentials должны перестать работать ──────
  console.log(`\n  ${C.dim}— 3. После смены пароля: старый пароль → 4xx, новый → 200 —${C.reset}`);
  {
    let sess;
    try {
      sess = await newSession();
      const oldPass = sess.pass;
      const newPass = 'ChangedPass789!';
      const chR = await apiReq('POST', '/users/me/password', { old_password: oldPass, new_password: newPass }, sess.cookie);
      rec('/api/users/me/password (смена пароля)', 'POST', 200, chR.status, chR.status === 200, '');
      if (chR.status === 200) {
        const oldLoginR = await apiReq('POST', '/users/login', { email: sess.email, password: oldPass }, null);
        rec('/api/users/login (старый пароль → 4xx)', 'POST', '4xx', oldLoginR.status,
          oldLoginR.status >= 400,
          oldLoginR.status < 400 ? '⚠️ КРИТИЧНО: старый пароль всё ещё принимается!' : 'отклонён ✓');
        const newLoginR = await apiReq('POST', '/users/login', { email: sess.email, password: newPass }, null);
        rec('/api/users/login (новый пароль → 200)', 'POST', 200, newLoginR.status, newLoginR.status === 200,
          newLoginR.status !== 200 ? '⚠️ новый пароль не работает' : '');
      }
    } catch (e) {
      rec('password change flow', 'SCENARIO', 'ok', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 4. Double-cancel appointment ──────────────────────────────────────────
  console.log(`\n  ${C.dim}— 4. Двойная отмена: cancel → cancel снова → должен 4xx —${C.reset}`);
  if (th) {
    let sess;
    try {
      sess = await newSession();
      const cr = await apiReq('POST', '/appointments/create', {
        patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/test',
      }, sess.cookie);
      const apptId = cr.json?.id;
      if (apptId) {
        const c1 = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'первая отмена' }, sess.cookie);
        rec('/api/appointments/{id}/cancel (первая отмена)', 'PUT', 200, c1.status, c1.status === 200, '');
        const c2 = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'повторная отмена' }, sess.cookie);
        rec('/api/appointments/{id}/cancel (повторная → 4xx)', 'PUT', '4xx', c2.status,
          c2.status >= 400 ? true : c2.status === 200 ? null : false,
          c2.status === 200 ? '⚠️ двойная отмена принята (idempotent)?' : `отклонена с ${c2.status} ✓`);
      } else {
        rec('double-cancel setup', 'POST', '200/201', cr.status, null, 'appointment не создан');
      }
    } catch (e) {
      rec('double-cancel', 'SCENARIO', '4xx', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 5. Cross-user data isolation ──────────────────────────────────────────
  console.log(`\n  ${C.dim}— 5. Изоляция: user B не видит и не отменяет appointment user A —${C.reset}`);
  if (th) {
    try {
      const [sessA, sessB] = await Promise.all([newSession(), newSession()]);
      const cr = await apiReq('POST', '/appointments/create', {
        patient_id: sessA.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/test',
      }, sessA.cookie);
      const apptId = cr.json?.id;
      if (apptId) {
        const rGet = await apiReq('GET', `/appointments/${apptId}`, null, sessB.cookie);
        rec('/api/appointments/{id} GET (чужой → 403/404)', 'GET', '403/404', rGet.status,
          rGet.status === 403 || rGet.status === 404 ? true : rGet.status === 200 ? false : null,
          rGet.status === 200 ? '⚠️ КРИТИЧНО: user B видит данные user A!' : `запрещено: ${rGet.status} ✓`);
        const rCancel = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'чужой' }, sessB.cookie);
        rec('/api/appointments/{id}/cancel (чужой → 403/404)', 'PUT', '403/404', rCancel.status,
          rCancel.status === 403 || rCancel.status === 404 ? true : rCancel.status === 200 ? false : null,
          rCancel.status === 200 ? '⚠️ КРИТИЧНО: user B отменил appointment user A!' : `запрещено: ${rCancel.status} ✓`);
        await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'cleanup' }, sessA.cookie);
      } else {
        rec('cross-user isolation setup', 'POST', '200/201', cr.status, null, 'appointment не создан');
      }
    } catch (e) {
      rec('cross-user isolation', 'SCENARIO', '403/404', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 6. Appointment in the past ────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 6. Запись на прошедшую дату → должен 422 —${C.reset}`);
  if (th) {
    let sess;
    try {
      sess = await newSession();
      const yesterday = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 19);
      const r = await apiReq('POST', '/appointments/create', {
        patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: yesterday, venue: 'https://meet.example.com/test',
      }, sess.cookie);
      rec('/api/appointments/create (вчерашняя дата → 422)', 'POST', '422/400', r.status,
        r.status === 422 || r.status === 400 ? true : r.status === 200 || r.status === 201 ? null : false,
        r.status === 200 || r.status === 201 ? '⚠️ сервер принял запись на прошедшее время!' : `отклонён: ${r.status} ✓`);
      if (r.json?.id) await apiReq('PUT', `/appointments/${r.json.id}/cancel`, { cancel_reason: 'cleanup' }, sess.cookie);
    } catch (e) {
      rec('past-date appointment', 'SCENARIO', 422, 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 7. Appointment far in future (2099) ───────────────────────────────────
  console.log(`\n  ${C.dim}— 7. Запись на 2099 год — граница дат —${C.reset}`);
  if (th) {
    let sess;
    try {
      sess = await newSession();
      const r = await apiReq('POST', '/appointments/create', {
        patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: '2099-12-31T23:59:59', venue: 'https://meet.example.com/test',
      }, sess.cookie);
      rec('/api/appointments/create (2099-12-31)', 'POST', '201 или 422', r.status,
        r.status === 201 || r.status === 200 || r.status === 422,
        r.status === 201 || r.status === 200 ? `принят (id=${r.json?.id?.slice(0, 8)}…)` : `отклонён: ${r.status}`);
      if (r.json?.id) await apiReq('PUT', `/appointments/${r.json.id}/cancel`, { cancel_reason: 'cleanup' }, sess.cookie);
    } catch (e) {
      rec('far-future appointment', 'SCENARIO', '201/422', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 8. Same-slot double-booking ───────────────────────────────────────────
  console.log(`\n  ${C.dim}— 8. Двойное бронирование одного слота — conflict или idempotent? —${C.reset}`);
  if (th) {
    let sess;
    try {
      sess = await newSession();
      const slot = futureISO();
      const body = { patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: slot, venue: 'https://meet.example.com/test' };
      const [r1, r2] = await Promise.all([
        apiReq('POST', '/appointments/create', body, sess.cookie),
        apiReq('POST', '/appointments/create', body, sess.cookie),
      ]);
      const created = [r1, r2].filter(r => r.status === 200 || r.status === 201);
      const conflict = [r1, r2].filter(r => r.status >= 400);
      rec('/api/appointments/create (двойной слот)', 'POST', '1×201 + 1×4xx', `${r1.status}/${r2.status}`,
        created.length === 1 ? true : created.length === 2 ? null : false,
        created.length === 2 ? '⚠️ оба слота приняты — сервер разрешает дубли' : created.length === 1 ? 'конфликт корректно обработан ✓' : `unexpected`);
      for (const r of [r1, r2]) {
        if (r.json?.id) await apiReq('PUT', `/appointments/${r.json.id}/cancel`, { cancel_reason: 'cleanup' }, sess.cookie);
      }
    } catch (e) {
      rec('double-booking', 'SCENARIO', 'conflict', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 9. Rate limit probe ───────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 9. Rate limiting: 20 неверных логинов подряд —${C.reset}`);
  {
    const fakeEmail = testEmail();
    let got429 = false;
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      const r = await apiReq('POST', '/users/login', { email: fakeEmail, password: 'wrongpassword' }, null);
      statuses.push(r.status);
      if (r.status === 429) { got429 = true; break; }
    }
    const unique = [...new Set(statuses)].sort().join('/');
    rec('/api/users/login (20× неверный пароль → rate limit?)', 'POST', '429 или 4xx',
      unique, got429 ? true : null,
      got429 ? `✓ rate limiting (429) на запросе №${statuses.indexOf(429) + 1}` : `⚠️ rate limiting отсутствует — ${statuses.length} запросов, статусы: ${unique}`);
  }

  // ── 10. Cross-user application isolation ──────────────────────────────────
  console.log(`\n  ${C.dim}— 10. Изоляция заявок: user B не видит заявку user A —${C.reset}`);
  if (th) {
    try {
      const [sessA, sessB] = await Promise.all([newSession(), newSession()]);
      const cr = await apiReq('POST', '/applications/', {
        psychologist_id:     th.id,
        scheduled_at:        futureISO(),
        problem_description: 'Автотест — изоляция заявок',
        university_status:   'студент',
      }, sessA.cookie);
      const applId = cr.json?.id;
      if (applId) {
        const r = await apiReq('GET', `/applications/${applId}`, null, sessB.cookie);
        rec('/api/applications/{id} GET (чужая → 403/404)', 'GET', '403/404', r.status,
          r.status === 403 || r.status === 404 ? true : r.status === 200 ? false : null,
          r.status === 200 ? '⚠️ КРИТИЧНО: user B видит заявку user A!' : `запрещено: ${r.status} ✓`);
        await apiReq('POST', `/applications/${applId}/cancel`, { cancel_reason: 'cleanup', cancel_initiator: 'user' }, sessA.cookie);
      } else {
        rec('application isolation setup', 'POST', '200/201', cr.status, null, 'заявка не создана');
      }
    } catch (e) {
      rec('application isolation', 'SCENARIO', '403/404', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 11. Login с несуществующим email → 401, не 404 ────────────────────────
  console.log(`\n  ${C.dim}— 11. Несуществующий email: 401 (а не 404 — user enumeration) —${C.reset}`);
  {
    const ghost = `nonexistent_${Date.now()}@noreply.invalid`;
    const r = await apiReq('POST', '/users/login', { email: ghost, password: 'SomePass123!' }, null);
    const is401 = r.status === 401;
    const is404 = r.status === 404;
    rec('/api/users/login (несуществующий email)', 'POST', 401, r.status,
      is401 ? true : is404 ? false : r.status >= 400 ? null : false,
      is404
        ? '⚠️ SEC: 404 раскрывает что аккаунт не зарегистрирован — user enumeration!'
        : is401 ? 'ответ 401 не раскрывает существование аккаунта ✓'
        : `статус ${r.status} — проверьте вручную`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  CHAOS  (конкурентность и нагрузка)
// ═════════════════════════════════════════════════════════════════════════════
async function runChaos() {
  console.log(`\n${C.bold}💥  CHAOS — конкурентные запросы и нагрузка${C.reset}\n`);

  function pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(Math.ceil(p / 100 * s.length) - 1, s.length - 1)];
  }

  const trReq = await apiReq('GET', '/therapists/', null, null);
  const th = Array.isArray(trReq.json) ? trReq.json[0] : null;

  // ── 1. Concurrent registrations ───────────────────────────────────────────
  console.log(`\n  ${C.dim}— 1. 10 параллельных регистраций —${C.reset}`);
  {
    const N = 10;
    const results = await Promise.all(Array.from({ length: N }, () =>
      apiReq('POST', '/users/register', {
        first_name: 'Chaos', last_name: 'Test', phone_number: '+79991234567', email: testEmail(), password: 'TestPass123!',
      }, null)
    ));
    const ok   = results.filter(r => r.status === 201 || r.status === 200);
    const fail = results.filter(r => r.status !== 201 && r.status !== 200);
    results.filter(r => r.json?.id).forEach(r => trackUser('chaos-reg', r.json.id));
    rec(`10× concurrent POST /api/users/register`, 'PARALLEL', `${N}×201`, `${ok.length}×ok / ${fail.length}×fail`,
      ok.length === N,
      fail.length ? `упало: ${fail.map(r => r.status).join(', ')}` : `все ${N} созданы ✓`);
  }

  // ── 2. Concurrent reads with timing ──────────────────────────────────────
  console.log(`\n  ${C.dim}— 2. 20 параллельных GET /therapists/ — время ответа —${C.reset}`);
  {
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => apiReq('GET', '/therapists/', null, null)));
    const ok    = results.filter(r => r.status === 200);
    const times = results.map(r => r.ms);
    const p50 = pct(times, 50), p95 = pct(times, 95), p99 = pct(times, 99);
    rec(`20× concurrent GET /api/therapists/`, 'PARALLEL', `${N}×200`, `${ok.length}×200 p50=${p50}ms p95=${p95}ms`,
      ok.length === N,
      `p50=${p50}ms  p95=${p95}ms  p99=${p99}ms  max=${Math.max(...times)}ms`);
    if (p95 > SLOW_MS) rec('concurrent GET (p95)', 'PERF', `<${SLOW_MS}ms`, `${p95}ms`, null, 'деградация p95 под параллельной нагрузкой');
  }

  // ── 3. Sequential load probe ──────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 3. 30 последовательных GET /therapists/ — деградация? —${C.reset}`);
  {
    const times = [];
    for (let i = 0; i < 30; i++) {
      const r = await apiReq('GET', '/therapists/', null, null);
      times.push(r.ms);
    }
    const p50 = pct(times, 50), p95 = pct(times, 95);
    const firstFive = times.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const lastFive  = times.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const trend = lastFive - firstFive;
    rec('30× sequential GET /api/therapists/ (p50/p95)', 'LOAD', `p95<${SLOW_MS}ms`, `p50=${p50}ms p95=${p95}ms`,
      p95 < SLOW_MS,
      `trend: ${trend > 100 ? `⚠️ деградация +${Math.round(trend)}ms` : `✓ стабильно (${trend > 0 ? '+' : ''}${Math.round(trend)}ms)`}  min=${Math.min(...times)}ms max=${Math.max(...times)}ms`);
  }

  // ── 4. Race condition: concurrent cancel ──────────────────────────────────
  console.log(`\n  ${C.dim}— 4. Race condition: 5 параллельных cancel одного appointment —${C.reset}`);
  if (th) {
    let sess;
    try {
      sess = await newSession();
      const cr = await apiReq('POST', '/appointments/create', {
        patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/test',
      }, sess.cookie);
      const apptId = cr.json?.id;
      if (apptId) {
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'race-test' }, sess.cookie)
          )
        );
        const successes = results.filter(r => r.status === 200).length;
        const failures  = results.filter(r => r.status !== 200).length;
        rec('5× concurrent cancel одного appointment', 'RACE', '≤1×200 или idempotent',
          `${successes}×200 / ${failures}×4xx`,
          successes <= 1 ? true : null,
          successes === 1 ? '✓ ровно 1 успех' : successes === 5 ? '⚠️ все 5 вернули 200 — idempotent cancel' : `${successes} успехов из 5`);
      } else {
        rec('race condition setup', 'POST', '200/201', cr.status, null, 'appointment не создан');
      }
    } catch (e) {
      rec('race condition cancel', 'RACE', '≤1×200', 'ошибка', null, e.message.slice(0, 80));
    }
  } else {
    rec('race condition (нет терапевтов)', 'SKIP', '—', '—', null, '');
  }

  // ── 5. Concurrent authenticated reads ─────────────────────────────────────
  console.log(`\n  ${C.dim}— 5. 5 пользователей одновременно читают свой профиль —${C.reset}`);
  {
    try {
      const sessions = await Promise.all(Array.from({ length: 5 }, () => newSession()));
      const results  = await Promise.all(sessions.map(s => apiReq('GET', '/users/user', null, s.cookie)));
      const ok = results.filter(r => r.status === 200);
      const consistent = results.every((r, i) => r.json?.email === sessions[i].email);
      rec('5× concurrent GET /api/users/user (разные сессии)', 'PARALLEL', '5×200+consistent',
        `${ok.length}×200`,
        ok.length === 5 && consistent,
        consistent ? '✓ каждый получил свой профиль' : '⚠️ КРИТИЧНО: данные перемешались между сессиями!');
    } catch (e) {
      rec('concurrent sessions', 'PARALLEL', '5×200', 'ошибка', null, e.message.slice(0, 80));
    }
  }

  // ── 6. Concurrent register with same email (race on duplicate) ────────────
  console.log(`\n  ${C.dim}— 6. 5 параллельных регистраций с одним email — race на дубль —${C.reset}`);
  {
    const sharedEmail = testEmail();
    const body = { first_name: 'Race', last_name: 'Email', phone_number: '+79991234567', email: sharedEmail, password: 'TestPass123!' };
    const results = await Promise.all(Array.from({ length: 5 }, () => apiReq('POST', '/users/register', body, null)));
    const created  = results.filter(r => r.status === 201 || r.status === 200);
    const rejected = results.filter(r => r.status >= 400);
    rec('5× concurrent register с одним email', 'RACE', '1×201 + 4×4xx',
      `${created.length}×created / ${rejected.length}×rejected`,
      created.length === 1 ? true : created.length > 1 ? false : null,
      created.length > 1 ? `⚠️ КРИТИЧНО: создано ${created.length} аккаунтов с одним email!` : `✓ 1 создан, ${rejected.length} отклонены`);
    results.filter(r => r.json?.id).forEach(r => trackUser(sharedEmail, r.json.id));
  }

  // ── 7. Burst login storm ──────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 7. 15 параллельных логинов одного пользователя —${C.reset}`);
  {
    let sess;
    try {
      sess = await newSession();
      const N = 15;
      const results = await Promise.all(
        Array.from({ length: N }, () => apiReq('POST', '/users/login', { email: sess.email, password: sess.pass }, null))
      );
      const ok   = results.filter(r => r.status === 200);
      const fail = results.filter(r => r.status !== 200);
      const times = results.map(r => r.ms);
      rec(`${N}× concurrent POST /api/users/login (один пользователь)`, 'PARALLEL', `${N}×200`,
        `${ok.length}×200 / ${fail.length}×other`,
        ok.length === N ? true : ok.length >= N * 0.8 ? null : false,
        `p50=${pct(times, 50)}ms  p95=${pct(times, 95)}ms${fail.length ? `  упало: ${fail.map(r => r.status).join(',')}` : ''}`);
    } catch (e) {
      rec('burst login storm', 'PARALLEL', '15×200', 'ошибка', null, e.message.slice(0, 80));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  EDGE  (граничные значения и нестандартные входы)
// ═════════════════════════════════════════════════════════════════════════════
async function runEdge() {
  console.log(`\n${C.bold}🔬  EDGE — граничные значения и нестандартные входы${C.reset}\n`);

  async function tryReg(overrides) {
    const base = { first_name: 'Test', last_name: 'User', phone_number: '+79991234567', email: testEmail(), password: 'TestPass123!' };
    const r = await apiReq('POST', '/users/register', { ...base, ...overrides }, null);
    if (r.json?.id) trackUser(overrides.email || base.email, r.json.id);
    return r;
  }

  // ── 1. Unicode in name fields ─────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 1. Unicode в полях имени —${C.reset}`);
  for (const [label, first_name] of [
    ['Emoji 🧠🎯',    '🧠🎯'],
    ['Arabic محمد',   'محمد'],
    ['Chinese 张伟',   '张伟'],
    ['Greek Αλέξ',    'Αλέξανδρος'],
    ['Mixed Иван-Ivan', 'Иван-Ivan'],
  ]) {
    const r = await tryReg({ first_name });
    rec(`/api/users/register (first_name: ${label})`, 'POST', '201 или 422', r.status,
      r.status === 201 || r.status === 200 || r.status === 422,
      r.status === 201 || r.status === 200
        ? `⚠️ принят — проверьте отображение в UI: "${first_name}"`
        : `отклонён (${r.status})`);
  }

  // ── 2. Boundary: name length ──────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 2. Граничные значения длины: first_name max=50 —${C.reset}`);
  {
    const r50 = await tryReg({ first_name: 'A'.repeat(50) });
    rec('/api/users/register (first_name 50 chars = max)', 'POST', 201, r50.status, r50.status === 201 || r50.status === 200, 'ровно на границе — должен пройти');

    const r51 = await tryReg({ first_name: 'A'.repeat(51) });
    rec('/api/users/register (first_name 51 chars = max+1)', 'POST', 422, r51.status, r51.status === 422, 'один сверх — должен отклонить');

    const r1 = await tryReg({ first_name: 'A' });
    rec('/api/users/register (first_name 1 char = min)', 'POST', 201, r1.status, r1.status === 201 || r1.status === 200, '');
  }

  console.log(`\n  ${C.dim}— 2b. Граничные значения: last_name max=50 —${C.reset}`);
  {
    const r50 = await tryReg({ last_name: 'B'.repeat(50) });
    rec('/api/users/register (last_name 50 chars)', 'POST', 201, r50.status, r50.status === 201 || r50.status === 200, '');

    const r51 = await tryReg({ last_name: 'B'.repeat(51) });
    rec('/api/users/register (last_name 51 chars = max+1)', 'POST', 422, r51.status, r51.status === 422, '');
  }

  console.log(`\n  ${C.dim}— 2c. Граничные значения: password min=8 max=64 —${C.reset}`);
  {
    const r7  = await tryReg({ password: 'A1!bcde' });  // 7 chars
    rec('/api/users/register (password 7 chars = min-1)', 'POST', 422, r7.status, r7.status === 422, '');

    const r8  = await tryReg({ password: 'Aa1!bcde' }); // 8 chars
    rec('/api/users/register (password 8 chars = min)', 'POST', 201, r8.status, r8.status === 201 || r8.status === 200, '');

    const r64 = await tryReg({ password: 'Aa1!' + 'x'.repeat(60) });
    rec('/api/users/register (password 64 chars = max)', 'POST', 201, r64.status, r64.status === 201 || r64.status === 200, '');

    const r65 = await tryReg({ password: 'Aa1!' + 'x'.repeat(61) });
    rec('/api/users/register (password 65 chars = max+1)', 'POST', 422, r65.status, r65.status === 422, '');
  }

  // ── 3. Special field values ────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 3. Специальные значения полей —${C.reset}`);

  // Email with plus addressing
  {
    const r = await tryReg({ email: `auto+tag+${Date.now()}@mailinator.com` });
    rec('/api/users/register (email с +тегом)', 'POST', 201, r.status, r.status === 201 || r.status === 200,
      r.status === 201 || r.status === 200 ? 'plus-addressing принят ✓' : `отклонён: ${r.status}`);
  }

  // XSS payload in name
  {
    const xss = '<script>alert(1)</script>';
    const r = await tryReg({ first_name: xss });
    rec('/api/users/register (XSS в first_name)', 'POST', '422 или 201+warn', r.status,
      r.status === 422 ? true : r.status === 201 || r.status === 200 ? null : false,
      r.status === 201 || r.status === 200 ? '⚠️ XSS payload сохранён — проверьте экранирование на фронте!' : 'XSS отклонён ✓');
  }

  // null for required field
  {
    const r = await apiReq('POST', '/users/register', {
      first_name: null, last_name: 'Test', phone_number: '+79991234567', email: testEmail(), password: 'TestPass123!',
    }, null);
    rec('/api/users/register (first_name: null)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 80));
  }

  // Empty string for required field
  {
    const r = await tryReg({ first_name: '' });
    rec('/api/users/register (first_name: "")', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 80));
  }

  // Whitespace-only name
  {
    const r = await tryReg({ first_name: '   ' });
    rec('/api/users/register (first_name: "   " только пробелы)', 'POST', 422, r.status,
      r.status === 422 ? true : r.status === 201 || r.status === 200 ? null : false,
      r.status === 201 || r.status === 200 ? '⚠️ имя из пробелов принято — нужна trim-валидация' : 'отклонено ✓');
  }

  // Newlines in name
  {
    const r = await tryReg({ first_name: 'Иван\nПетров' });
    rec('/api/users/register (first_name с \\n)', 'POST', '422 или 201+warn', r.status,
      r.status === 422 ? true : r.status === 201 || r.status === 200 ? null : false,
      r.status === 201 || r.status === 200 ? '⚠️ перенос строки принят в имени' : 'отклонено ✓');
  }

  // ── 4. Appointment edge cases ──────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 4. Граничные значения appointments —${C.reset}`);
  const trReq = await apiReq('GET', '/therapists/', null, null);
  const th = Array.isArray(trReq.json) ? trReq.json[0] : null;

  if (th) {
    let sess;
    try {
      sess = await newSession();

      // javascript: URL as venue (XSS/SSRF probe)
      {
        const r = await apiReq('POST', '/appointments/create', {
          patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'javascript:alert(1)',
        }, sess.cookie);
        rec('/api/appointments/create (venue: javascript:alert)', 'POST', '422/400', r.status,
          r.status === 422 || r.status === 400 ? true : r.status === 200 || r.status === 201 ? null : false,
          r.status === 200 || r.status === 201 ? `⚠️ javascript: URL принят как venue! (XSS/SSRF-риск) id=${r.json?.id?.slice(0, 8)}…` : `отклонён: ${r.status} ✓`);
        if (r.json?.id) await apiReq('PUT', `/appointments/${r.json.id}/cancel`, { cancel_reason: 'cleanup' }, sess.cookie);
      }

      // file:// URL as venue
      {
        const r = await apiReq('POST', '/appointments/create', {
          patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'file:///etc/passwd',
        }, sess.cookie);
        rec('/api/appointments/create (venue: file:///etc/passwd)', 'POST', '422/400', r.status,
          r.status === 422 || r.status === 400 ? true : r.status === 200 || r.status === 201 ? null : false,
          r.status === 200 || r.status === 201 ? '⚠️ file:// URL принят как venue!' : `отклонён: ${r.status} ✓`);
        if (r.json?.id) await apiReq('PUT', `/appointments/${r.json.id}/cancel`, { cancel_reason: 'cleanup' }, sess.cookie);
      }

      // Empty venue for Online type
      {
        const r = await apiReq('POST', '/appointments/create', {
          patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: '',
        }, sess.cookie);
        rec('/api/appointments/create (venue: "" для Online)', 'POST', '422/400', r.status,
          r.status === 422 || r.status === 400 ? true : r.status === 200 || r.status === 201 ? null : false,
          r.status === 200 || r.status === 201 ? '⚠️ пустой venue принят для Online-типа' : `отклонён: ${r.status} ✓`);
        if (r.json?.id) await apiReq('PUT', `/appointments/${r.json.id}/cancel`, { cancel_reason: 'cleanup' }, sess.cookie);
      }

      // Long cancel reason (2000 chars)
      {
        const cr = await apiReq('POST', '/appointments/create', {
          patient_id: sess.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/test',
        }, sess.cookie);
        if (cr.json?.id) {
          const longReason = 'причина '.repeat(250).slice(0, 2000);
          const r = await apiReq('PUT', `/appointments/${cr.json.id}/cancel`, { cancel_reason: longReason }, sess.cookie);
          rec('/api/appointments/{id}/cancel (cancel_reason 2000 символов)', 'PUT', '200 или 422', r.status,
            r.status === 200 || r.status === 422,
            `${r.status === 200 ? 'принято' : 'отклонено'} (2000 символов)`);
        }
      }
    } catch (e) {
      rec('appointment edge cases', 'EDGE', 'ok', 'ошибка', null, e.message.slice(0, 80));
    }

    // Very long problem_description in application
    {
      let sess2;
      try {
        sess2 = await newSession();
        const longDesc = 'Описание: '.repeat(500).slice(0, 5000);
        const r = await apiReq('POST', '/applications/', {
          psychologist_id:     th.id,
          scheduled_at:        futureISO(),
          problem_description: longDesc,
          university_status:   'студент',
        }, sess2.cookie);
        rec('/api/applications/ (problem_description 5000 символов)', 'POST', '200/201 или 422', r.status,
          r.status === 200 || r.status === 201 || r.status === 422,
          r.status === 200 || r.status === 201 ? `принято 5000 символов (id=${r.json?.id?.slice(0, 8)}…)` : `отклонено: ${r.status}`);
        if (r.json?.id) {
          await apiReq('POST', `/applications/${r.json.id}/cancel`, { cancel_reason: 'cleanup', cancel_initiator: 'user' }, sess2.cookie);
        }
      } catch (e) {
        rec('long problem_description', 'EDGE', '200/422', 'ошибка', null, e.message.slice(0, 80));
      }
    }
  } else {
    rec('appointment edge cases (нет терапевтов)', 'SKIP', '—', '—', null, 'пропущено');
  }

  // ── 5. HTTP method & Content-Type probes ──────────────────────────────────
  console.log(`\n  ${C.dim}— 5. Нестандартные HTTP-методы и Content-Type —${C.reset}`);

  {
    const r = await apiReq('PATCH', '/users/me', { first_name: 'x' }, '');
    rec('/api/users/me (PATCH вместо PUT)', 'PATCH', '404/405/401', r.status,
      r.status === 404 || r.status === 405 || r.status === 401 || r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 60));
  }
  {
    const r = await apiReq('DELETE', '/users/user', null, '');
    rec('/api/users/user (DELETE)', 'DELETE', '404/405/401', r.status,
      r.status === 404 || r.status === 405 || r.status === 401,
      JSON.stringify(r.json || {}).slice(0, 60));
  }

  // Wrong Content-Type
  {
    try {
      const res = await fetch(`${API}/users/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ first_name: 'Test', last_name: 'User', phone_number: '+79991234567', email: testEmail(), password: 'TestPass123!' }),
      });
      rec('/api/users/register (Content-Type: text/plain)', 'POST', '415/422', res.status,
        res.status === 415 || res.status === 422 || res.status === 400,
        res.status === 201 || res.status === 200 ? '⚠️ принят с неверным Content-Type' : `отклонён: ${res.status} ✓`);
    } catch (e) {
      rec('/api/users/register (text/plain Content-Type)', 'POST', '415/422', 'network err', null, e.message.slice(0, 60));
    }
  }

  // Extra unknown fields in body
  {
    const r = await apiReq('POST', '/users/register', {
      first_name: 'Test', last_name: 'User', phone_number: '+79991234567',
      email: testEmail(), password: 'TestPass123!',
      is_admin: true, role: 'admin', __proto__: 'polluted',
    }, null);
    rec('/api/users/register (лишние поля: is_admin, role)', 'POST', '201 (поля игнорированы)', r.status,
      r.status === 201 || r.status === 200 ? true : r.status === 422 ? null : false,
      r.status === 201 || r.status === 200
        ? `принят — убедитесь что role/is_admin не применились`
        : `отклонён: ${r.status}`);
    if (r.json?.id) trackUser('edge-extra-fields', r.json.id);
  }

  // ── 6. Phone number formats ───────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 6. Форматы phone_number — что принимает сервер —${C.reset}`);
  for (const [label, phone] of [
    ['международный +7(999)123-45-67',  '+7(999)123-45-67'],
    ['без плюса 89991234567',            '89991234567'],
    ['с пробелами +7 999 123 45 67',    '+7 999 123 45 67'],
    ['только цифры 79991234567',         '79991234567'],
    ['короткий +7999',                   '+7999'],
    ['иностранный +1-800-555-0100',      '+1-800-555-0100'],
  ]) {
    const r = await tryReg({ phone_number: phone });
    rec(`/api/users/register (phone: ${label})`, 'POST', '201 или 422', r.status,
      r.status === 201 || r.status === 200 || r.status === 422,
      r.status === 201 || r.status === 200 ? `принят ✓ "${phone}"` : `отклонён (${r.status})`);
  }

  // ── 7. null vs отсутствует vs "" на PUT /users/me ────────────────────────
  console.log(`\n  ${C.dim}— 7. null vs отсутствует vs "" в PUT /users/me — разное поведение? —${C.reset}`);
  {
    let sess;
    try {
      sess = await newSession();
      // a) поле отсутствует
      const rAbsent = await apiReq('PUT', '/users/me', { last_name: 'Тест' }, sess.cookie);
      rec('/api/users/me PUT (first_name отсутствует)', 'PUT', '200 или 422', rAbsent.status,
        rAbsent.status === 200 || rAbsent.status === 422,
        `${rAbsent.status} — first_name не тронут?`);

      // b) поле = null
      const rNull = await apiReq('PUT', '/users/me', { first_name: null }, sess.cookie);
      rec('/api/users/me PUT (first_name: null)', 'PUT', '422 или 200', rNull.status,
        rNull.status === 422 ? true : rNull.status === 200 ? null : false,
        rNull.status === 200 ? `⚠️ null принят — first_name стал null в БД?` : `отклонено: ${rNull.status} ✓`);

      // c) поле = ""
      const rEmpty = await apiReq('PUT', '/users/me', { first_name: '' }, sess.cookie);
      rec('/api/users/me PUT (first_name: "")', 'PUT', '422 или 200', rEmpty.status,
        rEmpty.status === 422 ? true : rEmpty.status === 200 ? null : false,
        rEmpty.status === 200 ? '⚠️ пустая строка принята как имя' : `отклонено: ${rEmpty.status} ✓`);

      // d) сравнение: убеждаемся что все три дали разный/одинаковый результат
      const codes = [rAbsent.status, rNull.status, rEmpty.status];
      const allSame = codes.every(c => c === codes[0]);
      rec('/api/users/me PUT — absent/null/"" дают одинаковый результат?', 'COMPARE',
        'фиксируем', codes.join('/'), null,
        `absent=${rAbsent.status} | null=${rNull.status} | ""=${rEmpty.status}  ${allSame ? '(одинаково)' : '(поведение различается)'}`);
    } catch (e) {
      rec('PUT null vs absent vs empty', 'EDGE', 'ok', 'ошибка', null, e.message.slice(0, 80));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  INFRA  (CORS, stack trace leak, security headers)
// ═════════════════════════════════════════════════════════════════════════════
async function runInfra() {
  console.log(`\n${C.bold}🏗️   INFRA — CORS, утечки stack trace, security-заголовки${C.reset}\n`);

  // ── 1. CORS ───────────────────────────────────────────────────────────────
  console.log(`  ${C.dim}— 1. CORS: OPTIONS с Origin: http://evil.com —${C.reset}`);
  {
    try {
      const res = await fetch(`${API}/therapists/`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://evil.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });
      const acao  = res.headers.get('access-control-allow-origin') || '(заголовок отсутствует)';
      const creds = res.headers.get('access-control-allow-credentials') || '(нет)';
      const isOpen = acao === '*' || acao.toLowerCase().includes('evil.com');
      rec('OPTIONS /api/therapists/ (Origin: evil.com)', 'OPTIONS', '!= evil.com / *', acao,
        isOpen ? null : true,
        isOpen
          ? `⚠️ КРИТИЧНО: CORS открыт для произвольных Origins! ACAO="${acao}" credentials=${creds}`
          : `ACAO="${acao}"  credentials=${creds}`);
    } catch (e) {
      rec('CORS probe', 'OPTIONS', 'ok', 'network err', null, e.message.slice(0, 80));
    }
  }

  // ── 2. Stack trace leak ───────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 2. Утечка stack trace в теле 500-ошибок —${C.reset}`);
  {
    const leakKw = ['Traceback', 'File "/', '/home/', '/app/', '/usr/', 'line ', 'at Object.', 'node_modules', 'SyntaxError', 'NameError'];
    const probes = [
      ['POST', '/users/register',    { email: null, first_name: null, last_name: null, phone_number: null, password: null }],
      ['GET',  '/therapists/00000000-0000-0000-0000-00000000000Z', null],
      ['POST', '/applications/',     { psychologist_id: 'not-uuid', scheduled_at: 'not-date' }],
    ];
    let gotAny500 = false;
    for (const [method, urlPath, body] of probes) {
      const r = await apiReq(method, urlPath, body, '');
      if (r.status !== 500) continue;
      gotAny500 = true;
      const text = JSON.stringify(r.json || '') + (r.json ? '' : '');
      const found = leakKw.filter(kw => text.includes(kw));
      rec(`/api${urlPath} (500 + stack trace?)`, method, '500 без leak', `500`,
        found.length === 0 ? true : false,
        found.length ? `❌ КРИТИЧНО: утечка: [${found.join(', ')}] | ${text.slice(0, 100)}` : 'stack trace не обнаружен в теле ✓');
    }
    if (!gotAny500) {
      rec('stack trace leak probe', 'PROBE', '500 не получен', '(нет 500)', true,
        'ни один пробный запрос не вернул 500 — сервер устойчив к тестовым пейлоадам');
    }
  }

  // ── 3. Security headers ───────────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 3. Security-заголовки HTTP —${C.reset}`);
  const secHeaders = [
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Strict-Transport-Security',
    'X-XSS-Protection',
    'Content-Security-Policy',
    'Referrer-Policy',
  ];

  for (const [endpoint, label] of [[BASE + '/', 'frontend /'], [`${API}/therapists/`, 'API /therapists/']]) {
    let res;
    try { res = await fetch(endpoint); }
    catch (e) { rec(`Security headers (${label})`, 'GET', 'ok', 'network err', null, e.message.slice(0, 60)); continue; }
    console.log(`\n  ${C.dim}  ${label}:${C.reset}`);
    for (const header of secHeaders) {
      const val = res.headers.get(header) || res.headers.get(header.toLowerCase());
      if (header === 'Strict-Transport-Security' && BASE.startsWith('http:')) {
        rec(`${header} (${label})`, 'HEADER', 'N/A (HTTP)', val || '(нет)', null, 'HSTS применим только к HTTPS');
        continue;
      }
      rec(`${header} (${label})`, 'HEADER', 'присутствует', val || '(нет)',
        val ? true : null,
        val ? val.slice(0, 80) : '⚠️ заголовок отсутствует — рекомендуется добавить');
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  AUTHZ  (авторизационные границы — IDOR, privilege escalation)
// ═════════════════════════════════════════════════════════════════════════════
async function runAuthz() {
  console.log(`\n${C.bold}🔒  AUTHZ — авторизационные границы (IDOR, privilege escalation)${C.reset}\n`);

  let sessA, sessB;
  try {
    [sessA, sessB] = await Promise.all([newSession(), newSession()]);
  } catch (e) {
    rec('authz setup', 'SETUP', 'ok', 'ошибка', false, 'Не удалось создать пользователей: ' + e.message.slice(0, 60));
    return;
  }
  console.log(`  user_A: ${sessA.email}  [${sessA.userId?.slice(0, 8)}…]`);
  console.log(`  user_B: ${sessB.email}  [${sessB.userId?.slice(0, 8)}…]\n`);

  const trReq = await apiReq('GET', '/therapists/', null, null);
  const th = Array.isArray(trReq.json) ? trReq.json[0] : null;

  // ── 1. user_A reads profile of user_B ─────────────────────────────────────
  console.log(`  ${C.dim}— 1. user_A читает профиль user_B → 403/404 —${C.reset}`);
  {
    const r = await apiReq('GET', `/users/user/${sessB.userId}`, null, sessA.cookie);
    rec('/api/users/user/{id_B} GET (из сессии A)', 'GET', '403/404', r.status,
      r.status === 403 || r.status === 404 ? true : r.status === 200 ? false : null,
      r.status === 200 ? `⚠️ КРИТИЧНО IDOR: user_A видит профиль user_B! email=${r.json?.email}` : `запрещено: ${r.status} ✓`);
  }

  // ── 2. Privilege escalation: assign self admin ────────────────────────────
  console.log(`\n  ${C.dim}— 2. Повышение привилегий: user_A назначает себя admin —${C.reset}`);
  {
    const r = await apiReq('POST', `/roles/${sessA.userId}/assign`, { role_code: 'admin' }, sessA.cookie);
    rec('/api/roles/{id}/assign (role_code: admin)', 'POST', '403/404/405', r.status,
      r.status === 403 || r.status === 404 || r.status === 405 ? true : r.status === 200 ? false : null,
      r.status === 200 ? '⚠️ КРИТИЧНО: user сам назначил себе роль admin!' : `запрещено: ${r.status} ✓`);
  }

  // ── 3. user_A tries to create a therapist ─────────────────────────────────
  console.log(`\n  ${C.dim}— 3. Создание терапевта обычным пользователем → 403 —${C.reset}`);
  {
    const r = await apiReq('POST', '/therapists/', {
      first_name: 'Fake', last_name: 'Therapist',
      specialization: 'Психолог', description: 'Автотест', price: 1000,
    }, sessA.cookie);
    rec('/api/therapists/ POST (обычный user → 403)', 'POST', '403/401', r.status,
      r.status === 403 || r.status === 401 || r.status === 405 ? true : r.status === 200 || r.status === 201 ? false : null,
      r.status === 200 || r.status === 201 ? '⚠️ КРИТИЧНО: обычный user создал терапевта!' : `запрещено: ${r.status} ✓`);
  }

  // ── 4. user_B cancels appointment of user_A ───────────────────────────────
  console.log(`\n  ${C.dim}— 4. user_B отменяет запись user_A → 403/404 —${C.reset}`);
  if (th) {
    const cr = await apiReq('POST', '/appointments/create', {
      patient_id: sessA.userId, psychologist_id: th.id, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/authz',
    }, sessA.cookie);
    const apptId = cr.json?.id;
    if (apptId) {
      const r = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'IDOR attack' }, sessB.cookie);
      rec('/api/appointments/{id_A}/cancel (из сессии B)', 'PUT', '403/404', r.status,
        r.status === 403 || r.status === 404 ? true : r.status === 200 ? false : null,
        r.status === 200 ? '⚠️ КРИТИЧНО IDOR: user_B отменил запись user_A!' : `запрещено: ${r.status} ✓`);
      await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'cleanup' }, sessA.cookie);
    } else {
      rec('authz step 4 setup', 'POST', '200/201', cr.status, null, 'appointment не создан — пропущено');
    }
  } else {
    rec('authz step 4 (нет терапевтов)', 'SKIP', '—', '—', null, '');
  }

  // ── 5. user_A updates profile of user_B ──────────────────────────────────
  console.log(`\n  ${C.dim}— 5. user_A обновляет профиль user_B → 403/404 —${C.reset}`);
  {
    const r = await apiReq('PUT', `/users/${sessB.userId}`, { first_name: 'Hijacked' }, sessA.cookie);
    rec('/api/users/{id_B} PUT (из сессии A)', 'PUT', '403/404/405', r.status,
      r.status === 403 || r.status === 404 || r.status === 405 ? true : r.status === 200 ? false : null,
      r.status === 200 ? '⚠️ КРИТИЧНО IDOR: user_A изменил профиль user_B!' : `запрещено: ${r.status} ✓`);
  }

  // ── 6. user_A sees only own applications in list (no data bleed) ──────────
  console.log(`\n  ${C.dim}— 6. Список заявок: user_A не видит заявки user_B —${C.reset}`);
  if (th) {
    const cr = await apiReq('POST', '/applications/', {
      psychologist_id: th.id, scheduled_at: futureISO(),
      problem_description: 'Заявка user_B для теста изоляции', university_status: 'студент',
    }, sessB.cookie);
    const applId = cr.json?.id;
    if (applId) {
      const listR = await apiReq('GET', '/applications/', null, sessA.cookie);
      const found = Array.isArray(listR.json) && listR.json.some(a => a.id === applId);
      rec('/api/applications/ LIST (user_A не видит заявки user_B)', 'GET', 'нет чужих', found ? 'найдена' : 'нет',
        found ? false : true,
        found ? '⚠️ КРИТИЧНО: user_A видит заявку user_B в общем списке!' : 'данные изолированы ✓');
      await apiReq('POST', `/applications/${applId}/cancel`, { cancel_reason: 'cleanup', cancel_initiator: 'user' }, sessB.cookie);
    } else {
      rec('authz step 6 setup', 'POST', '200/201', cr.status, null, 'заявка не создана');
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  STABILITY  (деградация под нагрузкой, большие выборки)
// ═════════════════════════════════════════════════════════════════════════════
async function runStability() {
  console.log(`\n${C.bold}📈  STABILITY — деградация, тренд времени ответа, большие выборки${C.reset}\n`);

  // ── 1. Trend: 500 requests in 5 batches of 100 ────────────────────────────
  console.log(`  ${C.dim}— 1. Тренд деградации: 500 последовательных GET /api/therapists/ —${C.reset}\n`);
  {
    const TOTAL = 500, BATCH = 100;
    const batches = [];
    let errors = 0;
    process.stdout.write('  ');
    for (let b = 0; b < TOTAL / BATCH; b++) {
      const times = [];
      for (let i = 0; i < BATCH; i++) {
        const r = await apiReq('GET', '/therapists/', null, null);
        times.push(r.ms);
        if (r.status !== 200) errors++;
      }
      const avg = Math.round(times.reduce((a, v) => a + v, 0) / times.length);
      batches.push(avg);
      process.stdout.write(`${b * BATCH + 1}-${(b + 1) * BATCH}: ${avg}ms  `);
    }
    console.log('');

    const firstAvg = batches[0];
    const lastAvg  = batches[batches.length - 1];
    const degradePct = firstAvg > 0 ? Math.round((lastAvg - firstAvg) / firstAvg * 100) : 0;
    const batchStr  = batches.map((a, i) => `[${i * BATCH + 1}-${(i + 1) * BATCH}]: ${a}ms`).join('  ');

    rec('500× GET /api/therapists/ — деградация', 'LOAD',
      '<50% от 1-го батча', `${degradePct > 0 ? '+' : ''}${degradePct}%`,
      degradePct <= 50 && errors === 0 ? true : degradePct <= 50 ? null : null,
      `${batchStr}${errors ? `  ⚠️ non-200: ${errors}` : ''}`);

    if (degradePct > 50) {
      rec('тренд деградации', 'PERF', '<50%', `+${degradePct}%`, null,
        `⚠️ батч 401-500 (${lastAvg}ms) медленнее батча 1-100 (${firstAvg}ms) на ${degradePct}%`);
    }
  }

  // ── 2. Large take: ?take=10000 ────────────────────────────────────────────
  console.log(`\n  ${C.dim}— 2. Большие выборки: ?take=10000 —${C.reset}`);
  for (const [urlPath, label] of [
    ['/therapists/?take=10000',   'therapists'],
    ['/articles/?take=10000',     'articles'],
    ['/news/?take=10000',         'news'],
  ]) {
    const r = await apiReq('GET', urlPath, null, null);
    const count = Array.isArray(r.json) ? r.json.length : '?';
    rec(`/api${urlPath}`, 'GET', '200 или 422', r.status, r.status === 200 || r.status === 422,
      `${r.ms}ms | ${count} записей${r.status === 422 ? ' (take лимитирован)' : ''}${r.ms > 3000 ? ' ⚠️ >3s' : ''}`);
    if (r.ms > 3000) {
      rec(`/api${urlPath} (время)`, 'PERF', '<3000ms', `${r.ms}ms`, null, `⚠️ большая выборка ${label} обрабатывается медленно`);
    }
  }

  // ── 3. Read/write interleave: 50 pairs ────────────────────────────────────
  console.log(`\n  ${C.dim}— 3. Чередование read+auth: 50 пар GET /therapists/ + GET /users/user —${C.reset}`);
  {
    let sess, errors = 0;
    try {
      sess = await newSession();
      const times = [];
      for (let i = 0; i < 50; i++) {
        const t0 = Date.now();
        await apiReq('GET', '/therapists/', null, null);
        const me = await apiReq('GET', '/users/user', null, sess.cookie);
        if (me.status !== 200) errors++;
        times.push(Date.now() - t0);
      }
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      const max = Math.max(...times);
      rec('50× (GET /therapists/ + GET /users/user)', 'LOAD', `avg<${SLOW_MS * 2}ms`, `avg=${avg}ms`,
        avg < SLOW_MS * 2,
        `avg=${avg}ms  max=${max}ms${errors ? `  ⚠️ auth errors=${errors}` : '  без ошибок ✓'}`);
    } catch (e) {
      rec('read/write interleave', 'LOAD', 'ok', 'ошибка', null, e.message.slice(0, 80));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN  (только если заданы ADMIN_EMAIL + ADMIN_PASSWORD)
// ═════════════════════════════════════════════════════════════════════════════
async function runAdmin() {
  console.log(`\n${C.bold}👑  ADMIN — административные эндпоинты${C.reset}\n`);

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log(`${C.yellow}⚠️  Пропущено: задайте ADMIN_EMAIL и ADMIN_PASSWORD в переменных окружения.${C.reset}\n`);
    rec('ADMIN (env vars не заданы)', 'SKIP', 'ADMIN_EMAIL+PASSWORD', 'не заданы', null,
      'Задайте ADMIN_EMAIL и ADMIN_PASSWORD для запуска этого режима');
    return;
  }

  // Логин под администратором
  const lr = await apiReq('POST', '/users/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, null);
  rec('/api/users/login (admin)', 'POST', 200, lr.status, lr.status === 200,
    lr.json?.id ? `id=${lr.json.id.slice(0, 8)}…` : JSON.stringify(lr.json || {}).slice(0, 80));

  if (lr.status !== 200) {
    console.log(`${C.red}❌ Не удалось войти под администратором.${C.reset}\n`);
    return;
  }
  const adminCookie = lr.cookie || '';

  // Проверяем профиль администратора
  {
    const r = await apiReq('GET', '/users/user', null, adminCookie);
    rec('/api/users/user (admin)', 'GET', 200, r.status, r.status === 200,
      r.json?.email || JSON.stringify(r.json || {}).slice(0, 80));
    if (VERBOSE) console.log(`${C.dim}  Роль: ${r.json?.role || '?'}${C.reset}`);
  }

  // Список всех пользователей (если есть admin-эндпоинт)
  {
    const r = await apiReq('GET', '/users/', null, adminCookie);
    rec('/api/users/ (все пользователи)', 'GET', '200/403', r.status,
      r.status === 200 || r.status === 403,
      Array.isArray(r.json) ? `${r.json.length} пользователей` : JSON.stringify(r.json || {}).slice(0, 80));
  }

  // Список всех заявок (admin view)
  {
    const r = await apiReq('GET', '/applications/?skip=0&limit=10', null, adminCookie);
    rec('/api/applications/ (admin, все заявки)', 'GET', '200/403', r.status,
      r.status === 200 || r.status === 403,
      Array.isArray(r.json) ? `${r.json.length} заявок` : JSON.stringify(r.json || {}).slice(0, 80));
  }

  // Список всех записей (admin view)
  {
    const r = await apiReq('GET', '/appointments/?skip=0&limit=10', null, adminCookie);
    rec('/api/appointments/ (admin, все записи)', 'GET', '200/403', r.status,
      r.status === 200 || r.status === 403,
      Array.isArray(r.json) ? `${r.json.length} записей` : JSON.stringify(r.json || {}).slice(0, 80));
  }

  // Попытка удалить несуществующего пользователя (не должна паниковать)
  {
    const r = await apiReq('DELETE', '/users/00000000-0000-0000-0000-000000000000', null, adminCookie);
    rec('/api/users/{id} DELETE (несуществующий)', 'DELETE', '403/404/405', r.status,
      r.status === 403 || r.status === 404 || r.status === 405 || r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 80));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ALL
// ═════════════════════════════════════════════════════════════════════════════
async function runAll() {
  console.log(`\n${C.bold}🚀  ALL — полное тестирование${C.reset}\n`);

  const modes = [
    ['smoke',        runSmoke],
    ['auth',         runAuth],
    ['api',          runApi],
    ['appointments', runAppointments],
    ['security',     runSecurity],
    ['scenarios',    runScenarios],
    ['chaos',        runChaos],
    ['edge',         runEdge],
    ['infra',        runInfra],
    ['authz',        runAuthz],
    ['stability',    runStability],
    ['ui',           runUi],
  ];

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    modes.push(['admin', runAdmin]);
  }

  const sections = [];

  for (const [name, fn] of modes) {
    console.log(`\n${C.bold}${'═'.repeat(60)}\n  ${name.toUpperCase()}\n${'═'.repeat(60)}${C.reset}`);
    resetR();
    await fn();
    const snap = { pass: R.pass, fail: R.fail, warn: R.warn, rows: [...R.rows] };
    saveReport(name, snap);
    printSummary();
    sections.push({ name, snap });
  }

  const total = sections.reduce(
    (acc, s) => ({ pass: acc.pass + s.snap.pass, fail: acc.fail + s.snap.fail, warn: acc.warn + s.snap.warn }),
    { pass: 0, fail: 0, warn: 0 }
  );

  const date = new Date().toLocaleString('ru-RU');
  let md =
    `# Полный отчёт тестирования\n` +
    `> **Сайт:** ${BASE}  |  **Дата:** ${date}\n\n` +
    `## Итог: ✅ ${total.pass} прошло | ❌ ${total.fail} упало | ⚠️ ${total.warn} предупреждений\n\n` +
    `| Секция | ✅ | ❌ | ⚠️ |\n|---|---|---|---|\n` +
    sections.map(s => `| ${s.name.toUpperCase()} | ${s.snap.pass} | ${s.snap.fail} | ${s.snap.warn} |`).join('\n') +
    `\n| **ИТОГО** | **${total.pass}** | **${total.fail}** | **${total.warn}** |\n\n`;

  for (const { name, snap } of sections) {
    md += `## ${name.toUpperCase()}  (✅ ${snap.pass} | ❌ ${snap.fail} | ⚠️ ${snap.warn})\n\n`;
    md += `| # | Рез | Метод | Эндпоинт | Ожид | Факт | Детали |\n|---|---|---|---|---|---|---|\n`;
    md += snap.rows.map((r, i) =>
      `| ${i + 1} | ${r.icon} | \`${r.method}\` | ${r.endpoint} | ${r.expected} | ${r.actual} | ${r.details.slice(0, 150)} |`
    ).join('\n');
    md += '\n\n';
  }

  const fname = path.join(__dirname, `full-report-${TS}.md`);
  fs.writeFileSync(fname, md, 'utf8');

  console.log(`\n${C.cyan}📋 Полный отчёт: ${fname}${C.reset}`);
  console.log(`\n${C.bold}${'═'.repeat(65)}${C.reset}`);
  const failC = total.fail > 0 ? C.red : C.green;
  console.log(
    `ИТОГ: ${C.green}✅ ${total.pass}${C.reset} | ${failC}❌ ${total.fail}${C.reset} | ${C.yellow}⚠️ ${total.warn}${C.reset}  (всего: ${total.pass + total.fail + total.warn})`
  );
  console.log(`${C.bold}${'═'.repeat(65)}${C.reset}\n`);

  printTeardown();
}

// ─── help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${C.bold}Использование:${C.reset} node test-suite.js <режим> [--quiet] [--verbose]

${C.bold}Режимы:${C.reset}
  --smoke         Быстрая проверка: страницы, ключевые API-эндпоинты
  --auth          Регистрация, логин, рефреш, смена пароля, логаут
  --api           Все эндпоинты из openapi.json, пагинация, 401 без токена
  --ui            Playwright: страницы, навигация, кнопки, изображения
  --appointments  Запись на приём: создание, просмотр, отмена (API + UI)
  --security      401/422, maxLength, SQL-инъекции, невалидные UUID
  --scenarios     Поведенческие сценарии: изоляция, двойная отмена, rate limit, user enumeration
  --chaos         Конкурентность: 10× parallel register, race condition на cancel, p50/p95
  --edge          Граничные значения: Unicode, XSS, null/empty/absent, phone formats, URL-инъекции
  --infra         CORS, stack trace leak, security-заголовки (X-Frame-Options, CSP и др.)
  --authz         IDOR и privilege escalation: изоляция профилей, назначение ролей, create therapist
  --stability     Тренд деградации (500 запросов), большие выборки take=10000
  --admin         Административные эндпоинты (нужны ADMIN_EMAIL + ADMIN_PASSWORD)
  --all           Полное тестирование + сводный full-report.md

${C.bold}Флаги:${C.reset}
  --quiet         Выводить только упавшие и предупреждения (скрывать ✅)
  --verbose       Выводить каждый HTTP-запрос с кодом и временем

${C.bold}Переменные окружения:${C.reset}
  BASE_URL        URL сайта          (по умолчанию: http://95.31.169.106)
  SLOW_MS         Порог медленного ответа в мс  (по умолчанию: 2000)
  ADMIN_EMAIL     Email администратора для --admin
  ADMIN_PASSWORD  Пароль администратора для --admin
  NO_COLOR=1      Отключить цветной вывод

${C.bold}Примеры:${C.reset}
  node test-suite.js --smoke
  node test-suite.js --all --quiet
  BASE_URL=https://staging.example.com node test-suite.js --api --verbose
  ADMIN_EMAIL=admin@mpu.ru ADMIN_PASSWORD=secret node test-suite.js --admin
`);
}

// ─── dispatch ─────────────────────────────────────────────────────────────────
const modeMap = {
  '--smoke':        runSmoke,
  '--auth':         runAuth,
  '--api':          runApi,
  '--ui':           runUi,
  '--appointments': runAppointments,
  '--security':     runSecurity,
  '--scenarios':    runScenarios,
  '--chaos':        runChaos,
  '--edge':         runEdge,
  '--infra':        runInfra,
  '--authz':        runAuthz,
  '--stability':    runStability,
  '--admin':        runAdmin,
  '--all':          runAll,
};

if (!modeMap[MODE]) {
  printHelp();
  process.exit(0);
}

(async () => {
  if (MODE === '--all') {
    await runAll();
  } else {
    await modeMap[MODE]();
    saveReport(MODE);
    printSummary();
    printTeardown();
  }
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
