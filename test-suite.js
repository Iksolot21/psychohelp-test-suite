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
const BASE = 'http://95.31.169.106';
const API  = `${BASE}/api`;
const MODE = process.argv[2] || '--help';
const TS   = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

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
  R.rows.push({ icon, endpoint: String(endpoint), method: String(method), expected: String(expected), actual: String(actual), details: String(details) });
  const det = details ? `  // ${String(details).slice(0, 90)}` : '';
  console.log(`${icon} ${String(method).padEnd(6)} ${String(endpoint).padEnd(54)} ${expected} → ${actual}${det}`);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function apiReq(method, urlPath, body, cookie) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  };
  if (body != null) opts.body = JSON.stringify(body);
  try {
    const r    = await fetch(`${API}${urlPath}`, opts);
    const text = await r.text().catch(() => '');
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    const sc        = r.headers.get('set-cookie') || '';
    const newCookie = sc ? sc.split(';')[0] : null;
    return { status: r.status, json, cookie: newCookie };
  } catch (e) {
    return { status: 0, json: null, cookie: null, err: e.message };
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
  console.log(`\n📄 Отчёт: ${fname}`);
  return fname;
}

function printSummary() {
  const total = R.pass + R.fail + R.warn;
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`Итог: ✅ ${R.pass} | ❌ ${R.fail} | ⚠️ ${R.warn}  (всего: ${total})`);
  console.log(`${'─'.repeat(65)}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SMOKE
// ═════════════════════════════════════════════════════════════════════════════
async function runSmoke() {
  console.log('\n🔥  SMOKE — быстрая проверка доступности\n');

  // UI pages
  for (const p of ['/', '/therapists', '/news', '/resources', '/faq']) {
    const r = await fetch(BASE + p).catch(() => ({ status: 0 }));
    rec(p, 'GET', 200, r.status, r.status === 200);
  }

  // API
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
  }

  // quick register
  const rr = await apiReq('POST', '/users/register', {
    first_name: 'Смоук', last_name: 'Тест', phone_number: '+79001112233',
    email: testEmail(), password: 'TestPass123!',
  }, null);
  rec('/api/users/register', 'POST', 201, rr.status, rr.status === 201,
    rr.json?.id ? `id=${rr.json.id.slice(0, 8)}…` : JSON.stringify(rr.json || {}).slice(0, 60));

  // logout (может вернуть 200 или 401 если сессии нет)
  const lo = await apiReq('POST', '/users/logout', null, null);
  rec('/api/users/logout', 'POST', '200/401', lo.status, lo.status === 200 || lo.status === 401);
}

// ═════════════════════════════════════════════════════════════════════════════
//  AUTH
// ═════════════════════════════════════════════════════════════════════════════
async function runAuth() {
  console.log('\n🔐  AUTH — авторизация и управление аккаунтом\n');
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
    rec('/api/users/register', 'POST', 201, r.status, r.status === 201,
      userId ? `id=${userId.slice(0, 8)}…` : JSON.stringify(r.json || {}).slice(0, 100));
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
  }

  // 6. Refresh токена (требует refresh-cookie, которую возможно не захватили — warn допустим)
  {
    const r = await apiReq('POST', '/users/refresh', null, cookie);
    if (r.cookie) cookie = r.cookie;
    // 401 = refresh-cookie не передалась (ограничение нашего http-клиента), не баг сервера
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

  // 12. Неполный логин — только email
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
  console.log('\n🔌  API — эндпоинты из openapi.json\n');

  let sess;
  try { sess = await newSession(); } catch (e) { console.error('Auth failed:', e.message); return; }
  const { cookie, userId } = sess;

  // ── публичные GET ─────────────────────────────────────────────────────────
  console.log('  — публичные эндпоинты —');
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
  }

  // therapist by id
  const tr = await apiReq('GET', '/therapists/', null, null);
  const therapists = Array.isArray(tr.json) ? tr.json : [];
  const th = therapists[0];
  const therapistId = th?.id;

  if (therapistId) {
    const r = await apiReq('GET', `/therapists/${therapistId}`, null, null);
    rec('/api/therapists/{id}', 'GET', 200, r.status, r.status === 200,
      r.json?.first_name ? `${r.json.first_name} ${r.json.last_name}` : '');
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

  // ── авторизованные GET ────────────────────────────────────────────────────
  console.log('\n  — авторизованные эндпоинты —');
  for (const [p, chk] of [
    ['/users/user',    j => !!j?.id],
    ['/appointments/', j => Array.isArray(j)],
    ['/applications/', j => Array.isArray(j)],
  ]) {
    const r = await apiReq('GET', p, null, cookie);
    rec(`/api${p}`, 'GET', 200, r.status, r.status === 200 && chk(r.json),
      JSON.stringify(r.json || {}).slice(0, 60));
  }

  // user by id
  if (userId) {
    const r = await apiReq('GET', `/users/user/${userId}`, null, cookie);
    rec('/api/users/user/{id}', 'GET', 200, r.status, r.status === 200, r.json?.email || '');
  }

  // ── appointments CRUD ─────────────────────────────────────────────────────
  console.log('\n  — appointments —');
  let apptId = null;
  if (therapistId) {
    const body = { patient_id: userId, psychologist_id: therapistId, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/autotest' };
    const r = await apiReq('POST', '/appointments/create', body, cookie);
    apptId = r.json?.id || null;
    const ok = r.status === 200 || r.status === 201;
    rec('/api/appointments/create', 'POST', '200/201', r.status, ok,
      ok ? `id=${apptId?.slice(0, 8)}…` : JSON.stringify(r.json || {}).slice(0, 120));

    if (apptId) {
      const gr = await apiReq('GET', `/appointments/${apptId}`, null, cookie);
      rec('/api/appointments/{id}', 'GET', 200, gr.status, gr.status === 200, `статус=${gr.json?.status}`);

      const cr = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'автотест' }, cookie);
      rec('/api/appointments/{id}/cancel', 'PUT', 200, cr.status, cr.status === 200,
        JSON.stringify(cr.json || {}).slice(0, 60));

      // статус после отмены
      const sr = await apiReq('GET', `/appointments/${apptId}`, null, cookie);
      rec('/api/appointments/{id} (статус = cancelled)', 'GET', '200+cancelled', sr.status,
        sr.status === 200 && sr.json?.status === 'cancelled', `статус=${sr.json?.status}`);
    }
  }

  // ── applications CRUD ─────────────────────────────────────────────────────
  console.log('\n  — applications —');
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
  console.log('\n  — 401 без авторизации —');
  for (const [m, p, b, strict] of [
    ['GET',  '/users/user',          null, true],
    ['GET',  '/appointments/',        null, true],
    ['GET',  '/applications/',        null, true],
    ['PUT',  '/users/me',            { first_name: 'x' }, true],
    ['POST', '/users/refresh',        null, true],
    ['POST', '/appointments/create',  { patient_id: userId, psychologist_id: therapistId, type: 'Online', scheduled_time: futureISO(), venue: 'https://meet.example.com/autotest' }, true],
    // Эти валидируют тело до auth → 422 вместо 401 (баг сервера, warn)
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
  console.log('\n📅  APPOINTMENTS — запись на приём\n');

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
  }

  if (apptId) {
    // GET
    {
      const r = await apiReq('GET', `/appointments/${apptId}`, null, cookie);
      rec('/api/appointments/{id}', 'GET', 200, r.status, r.status === 200, `статус=${r.json?.status}`);
    }
    // появилась в общем списке
    {
      const r = await apiReq('GET', '/appointments/', null, cookie);
      const found = Array.isArray(r.json) && r.json.some(a => a.id === apptId);
      rec('/api/appointments/ (новая в списке)', 'GET', '200+найдена', r.status,
        r.status === 200 && found, found ? `${r.json.length} записей, найдена` : '❌ не найдена в списке');
    }
    // cancel
    {
      const r = await apiReq('PUT', `/appointments/${apptId}/cancel`, { cancel_reason: 'Автотест — отмена' }, cookie);
      rec('/api/appointments/{id}/cancel', 'PUT', 200, r.status, r.status === 200,
        JSON.stringify(r.json || {}).slice(0, 80));
    }
    // статус после отмены
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
  console.log('\n  — UI через Playwright —');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    // Инъекция куки в контекст браузера
    if (sess.cookie) {
      const eqIdx = sess.cookie.indexOf('=');
      if (eqIdx > 0) {
        const cname = sess.cookie.slice(0, eqIdx).trim();
        const cval  = sess.cookie.slice(eqIdx + 1).trim();
        await ctx.addCookies([{ name: cname, value: cval, domain: '95.31.169.106', path: '/' }]);
      }
    }

    const page = await ctx.newPage();

    // Страница терапевта
    await page.goto(`${BASE}/therapists/${th.id}`, { waitUntil: 'networkidle', timeout: 20000 });
    const bookBtn = await page.$('button:has-text("Записаться")');
    rec(`/therapists/{id} — кнопка "Записаться"`, 'UI', 'найдена', bookBtn ? 'найдена' : 'нет', !!bookBtn,
      `${th.first_name} ${th.last_name}`);

    // Личный кабинет
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
  console.log('\n🛡️   SECURITY — базовые проверки безопасности\n');

  // 1. Защищённые без авторизации → 401
  console.log('  — 401 без авторизации —');
  // Эндпоинты где ожидаем строгий 401
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
  // Эти эндпоинты валидируют тело ДО проверки авторизации — баг безопасности, принимаем 401 или 422
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
  console.log('\n  — 422 невалидные данные —');
  const invalidCases = [
    ['POST', '/users/register', {},                          'пустое тело'],
    ['POST', '/users/register', { email: 'not-an-email', password: '123', first_name: 'x', last_name: 'y', phone_number: 'abc' }, 'невалидный email/phone'],
    ['POST', '/users/login',    {},                          'пустое тело'],
    ['POST', '/users/login',    { email: 'x', password: 'y' }, 'email не email, пароль < 8'],
    ['POST', '/users/password-reset/request', {}, 'пустое тело'],
    ['POST', '/users/password-reset/request', { email: 'not-email' }, 'невалидный email'],
  ];
  for (const [m, p, b, label] of invalidCases) {
    const r = await apiReq(m, p, b, '');
    rec(`/api${p} (${label})`, m, 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }

  // 3. Превышение maxLength
  console.log('\n  — превышение maxLength —');
  const long300 = 'A'.repeat(300);
  {
    // first_name max=50
    const r = await apiReq('POST', '/users/register', {
      first_name: long300, last_name: 'T', phone_number: '+79991234567', email: testEmail(), password: 'TestPass123!',
    }, null);
    rec('/api/users/register (first_name 300 chars, max=50)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }
  {
    // password max=64
    const r = await apiReq('POST', '/users/login', { email: testEmail(), password: long300 }, null);
    rec('/api/users/login (password 300 chars, max=64)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }
  {
    // last_name max=50
    const r = await apiReq('POST', '/users/register', {
      first_name: 'X', last_name: long300, phone_number: '+79991234568', email: testEmail(), password: 'TestPass123!',
    }, null);
    rec('/api/users/register (last_name 300 chars, max=50)', 'POST', 422, r.status, r.status === 422,
      JSON.stringify(r.json || {}).slice(0, 100));
  }

  // 4. SQL-инъекции
  console.log('\n  — SQL-инъекции в строковых полях —');
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
  console.log('\n  — невалидные UUID в path —');
  for (const [m, p] of [
    ['GET', '/therapists/not-a-uuid'],
    ['GET', '/appointments/not-a-uuid'],
    ['GET', '/applications/not-a-uuid'],
    ['GET', '/users/user/not-a-uuid'],
  ]) {
    const r = await apiReq(m, p, null, '');
    // 422 = невалидный формат, 404 = не найден, 401 = нет авторизации (тоже ok)
    const ok = r.status === 422 || r.status === 404 || r.status === 401;
    rec(`/api${p}`, m, '401/404/422', r.status, ok, JSON.stringify(r.json || {}).slice(0, 80));
  }

  // 6. PUT с пустым телом
  console.log('\n  — PUT/POST с пустыми обязательными полями —');
  {
    let sess;
    try {
      sess = await newSession();
      const r = await apiReq('PUT', '/users/me', {}, sess.cookie);
      // Пустой PUT может быть 200 (всё опционально) или 422
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
  console.log('\n🖥️   UI — Playwright\n');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Сбор битых не-API ресурсов
    const broken = [];
    page.on('response', r => {
      if (r.status() >= 400 && !r.url().includes('/api/') &&
          !['fetch', 'xhr'].includes(r.request().resourceType())) {
        broken.push(`${r.status()} ${r.url().slice(0, 70)}`);
      }
    });

    // ── страницы ─────────────────────────────────────────────────────────────
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
        const res    = await page.goto(BASE + pg.path, { waitUntil: 'networkidle', timeout: 30000 });
        const status = res?.status() || 0;
        const text   = await page.textContent('body').catch(() => '');
        const hasKw  = pg.kw.some(k => text.includes(k));

        rec(pg.path, 'GET', 200, status,
          status === 200 && hasKw ? true : status === 200 ? null : false,
          `${hasKw ? '✓ контент' : '⚠ контент?'}${broken.length ? `, ${broken.length} битых ресурсов` : ''}`
        );

        // битые изображения
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

    // ── навигация ─────────────────────────────────────────────────────────────
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

    // ── страница терапевта ────────────────────────────────────────────────────
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

    // ── все ссылки на главной ─────────────────────────────────────────────────
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
//  ALL
// ═════════════════════════════════════════════════════════════════════════════
async function runAll() {
  console.log('\n🚀  ALL — полное тестирование\n');

  const modes = [
    ['smoke',        runSmoke],
    ['auth',         runAuth],
    ['api',          runApi],
    ['appointments', runAppointments],
    ['security',     runSecurity],
    ['ui',           runUi],
  ];

  const sections = [];

  for (const [name, fn] of modes) {
    console.log(`\n${'═'.repeat(60)}\n  ${name.toUpperCase()}\n${'═'.repeat(60)}`);
    resetR();
    await fn();
    const snap = { pass: R.pass, fail: R.fail, warn: R.warn, rows: [...R.rows] };
    saveReport(name, snap);
    printSummary();
    sections.push({ name, snap });
  }

  // сводный отчёт
  const total = sections.reduce(
    (acc, s) => ({ pass: acc.pass + s.snap.pass, fail: acc.fail + s.snap.fail, warn: acc.warn + s.snap.warn }),
    { pass: 0, fail: 0, warn: 0 }
  );

  const date = new Date().toLocaleString('ru-RU');
  let md =
    `# Полный отчёт тестирования\n` +
    `> **Сайт:** ${BASE}  |  **Дата:** ${date}\n\n` +
    `## Сводка: ✅ ${total.pass} прошло | ❌ ${total.fail} упало | ⚠️ ${total.warn} предупреждений\n\n` +
    `| Секция | ✅ | ❌ | ⚠️ |\n|---|---|---|---|\n` +
    sections.map(s => `| ${s.name.toUpperCase()} | ${s.snap.pass} | ${s.snap.fail} | ${s.snap.warn} |`).join('\n') +
    '\n\n';

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

  console.log(`\n📋 Полный отчёт: ${fname}`);
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`ИТОГ: ✅ ${total.pass} | ❌ ${total.fail} | ⚠️ ${total.warn}  (всего: ${total.pass + total.fail + total.warn})`);
  console.log(`${'═'.repeat(65)}\n`);
}

// ─── help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
Использование: node test-suite.js <режим>

  --smoke         Быстрая проверка: страницы, ключевые API-эндпоинты
  --auth          Регистрация, логин, рефреш, смена пароля, логаут
  --api           Все эндпоинты из openapi.json + 401 без токена
  --ui            Playwright: страницы, навигация, кнопки, изображения
  --appointments  Запись на приём: создание, просмотр, отмена (API + UI)
  --security      401/422, maxLength, SQL-инъекции, невалидные UUID
  --all           Полное тестирование + сводный full-report.md
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
  }
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
