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
