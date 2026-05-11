# Psychohelp Test Suite

[![CI](https://github.com/Iksolot21/psychohelp-test-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/Iksolot21/psychohelp-test-suite/actions/workflows/ci.yml)

Автоматизированная тест-сюита для сайта **Служба психологической помощи МПУ**.  
Покрывает API, UI, авторизацию, безопасность, конкурентность и инфраструктуру — **14 режимов, 200+ проверок** за один запуск.

**Стек:** Node.js 18+ · Playwright · Express · встроенный `fetch`
**Интерфейс:** веб-дашборд (браузер) + классический CLI.

---

## Быстрый старт

### Веб-дашборд (рекомендуется)

```bash
git clone https://github.com/Iksolot21/psychohelp-test-suite.git
cd psychohelp-test-suite

npm install
npx playwright install chromium

npm run web        # → http://localhost:3000
```

Откройте браузер, выберите режим, нажмите **Запустить** — вывод идёт в реальном времени.
История запусков сохраняется автоматически между сессиями.

### CLI (как раньше)

```bash
node test-suite.js --smoke   # убедиться что сайт живой (< 10 секунд)
node test-suite.js --all     # полный прогон всех тестов
```

---

## Требования

| Зависимость | Минимальная версия |
|---|---|
| Node.js | 18.0 |
| npm | 8.0 |

> Playwright скачивает Chromium автоматически при `npx playwright install chromium`.  
> Интернет-соединение нужно для первой установки; тесты работают только при доступном целевом сайте.

---

## Конфигурация

Через переменные окружения — никаких изменений в коде не требуется:

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BASE_URL` | `http://95.31.169.106` | URL сайта |
| `SLOW_MS` | `2000` | Порог медленного ответа (мс) |
| `ADMIN_EMAIL` | — | Email администратора для `--admin` |
| `ADMIN_PASSWORD` | — | Пароль администратора для `--admin` |
| `NO_COLOR=1` | — | Отключить цветной вывод в терминале |

Тест-аккаунты создаются автоматически при каждом запуске.

---

## Режимы запуска

### Через npm scripts

```bash
npm test              # полный прогон (--all)
npm run smoke         # быстрая проверка
npm run auth          # авторизация
npm run api           # все API-эндпоинты
npm run ui            # Playwright UI-тесты
npm run appointments  # запись на приём
npm run security      # безопасность
```

### Напрямую через node

```bash
node test-suite.js --smoke
node test-suite.js --auth
node test-suite.js --api
node test-suite.js --ui
node test-suite.js --appointments
node test-suite.js --security
node test-suite.js --scenarios
node test-suite.js --chaos
node test-suite.js --edge
node test-suite.js --infra
node test-suite.js --authz
node test-suite.js --stability
node test-suite.js --admin         # нужны ADMIN_EMAIL + ADMIN_PASSWORD
node test-suite.js --all
```

### Флаги вывода

```bash
node test-suite.js --all --quiet    # только упавшие и предупреждения
node test-suite.js --api --verbose  # каждый запрос с кодом и временем
```

### Другой сервер

```bash
BASE_URL=https://staging.example.com node test-suite.js --smoke
```

---

## Что проверяет каждый режим

### `--smoke` (~10 сек)
Быстрая проверка — всё ли живо перед полным прогоном.

- Все UI-страницы отвечают `200`: `/`, `/therapists`, `/news`, `/resources`, `/faq`
- Ключевые API-эндпоинты: `/api/therapists/`, `/api/articles/`, `/api/news/`, `/api/applications/university-statuses`
- `POST /api/users/register` → `201`
- `POST /api/users/logout` → `200/401`
- Предупреждение при ответе медленнее `SLOW_MS` мс

### `--auth` (~15 сек)
Полный флоу управления аккаунтом.

| Шаг | Эндпоинт | Проверка |
|---|---|---|
| Регистрация | `POST /users/register` | `201`, возвращает `id`, схема UserResponse |
| Сессия после регистрации | `GET /users/user` | `200` |
| Логаут | `POST /users/logout` | `200` |
| Сессия после логаута | `GET /users/user` | `401` |
| Логин | `POST /users/login` | `200` |
| Refresh токена | `POST /users/refresh` | `200/401` |
| Обновление профиля | `PUT /users/me` | `200` |
| Смена пароля | `POST /users/me/password` | `200` |
| Запрос сброса пароля | `POST /users/password-reset/request` | `200` |
| Неверный пароль | `POST /users/login` | `4xx` |
| Дублирующий email | `POST /users/register` | `4xx` |

### `--api` (~20 сек)
Покрытие всех эндпоинтов из `openapi.json` + пагинация.

- Публичные GET: therapists, articles, news, university-statuses
- Пагинация: `?skip=0&take=2`, `?skip=1000&take=10`, `?take=200` (лимит)
- Авторизованные GET: `/users/user`, `/appointments/`, `/applications/`
- Проверка схемы ответа через `openapi.json` (поля из `required`)
- CRUD appointments: create → get → cancel → проверка статуса
- CRUD applications: create → get → cancel
- 401 на всех защищённых эндпоинтах без токена

### `--appointments` (~30 сек)
Полный флоу записи на приём: API + UI через Playwright.

1. Регистрация тестового пользователя
2. Получение списка терапевтов
3. Создание записи `POST /appointments/create`
4. Проверка записи `GET /appointments/{id}`
5. Проверка появления в списке `GET /appointments/`
6. Отмена `PUT /appointments/{id}/cancel`
7. Проверка статуса `cancelled`
8. Создание заявки `POST /applications/`
9. Проверка и отмена заявки
10. UI: кнопка "Записаться" на странице терапевта
11. UI: раздел "Запись на сессию" в личном кабинете

### `--security` (~15 сек)
Базовые проверки безопасности.

- **401** на всех защищённых эндпоинтах без авторизации
- **422** на невалидных данных (пустые тела, неверный email/phone)
- **422** при превышении `maxLength` (first_name >50, password >64, last_name >50)
- **SQL-инъекции** в строковых полях: `' OR '1'='1`, `'; DROP TABLE users; --` и другие
- Невалидные UUID в path-параметрах → `422/404`

### `--scenarios` (~40 сек)
Комплексные поведенческие сценарии — проверяет не статусы, а логику системы.

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | Обновил профиль → GET → поля совпадают | Консистентность данных |
| 2 | Logout → старый cookie → запрос | 401, сессия инвалидирована |
| 3 | Сменил пароль → вход со старым | 4xx, старый пароль не работает |
| 4 | Cancel → повторный cancel | 4xx (не idempotent) или 200 (фиксируем) |
| 5 | user_B смотрит appointment user_A | 403/404 (изоляция) |
| 6 | Запись вчерашним числом | 422 |
| 7 | Запись на 2099 год | Фиксируем поведение |
| 8 | Два бронирования одного слота | Conflict или оба приняты — фиксируем |
| 9 | 20 неверных логинов подряд | 429 (rate limit) или нет — фиксируем |
| 10 | user_B смотрит заявку user_A | 403/404 (изоляция заявок) |
| 11 | Логин с несуществующим email | 401, а не 404 (защита от user enumeration) |

### `--chaos` (~60 сек)
Конкурентность и нагрузка через `Promise.all`.

| # | Проверка | Что ищем |
|---|---|---|
| 1 | 10 параллельных регистраций | Все должны 201 |
| 2 | 20 параллельных GET /therapists/ | p50 / p95 / p99 |
| 3 | 30 последовательных GET /therapists/ | Тренд деградации |
| 4 | 5 параллельных cancel одного appointment | Race condition — ровно 1 успех? |
| 5 | 5 пользователей читают свой профиль одновременно | Данные не перемешались |
| 6 | 5 регистраций с одним email параллельно | Только 1 аккаунт создан |
| 7 | 15 параллельных логинов одного пользователя | p50 / p95 |

### `--edge` (~30 сек)
Граничные значения и нестандартные входы.

- **Unicode в именах:** Emoji 🧠, Arabic محمد, Chinese 张伟, Greek, кириллица+латиница
- **Boundary: first_name** — ровно 50 символов (pass) / 51 (fail)
- **Boundary: last_name** — ровно 50 / 51 символов
- **Boundary: password** — 7 (fail) / 8 (pass) / 64 (pass) / 65 (fail)
- **Email с + тегом** — `user+tag@mail.com`
- **XSS** в first_name — `<script>alert(1)</script>` → если 201, ⚠️ проверь фронт
- **null** в обязательном поле → 422
- **Пустая строка `""`** в поле имени → 422
- **Пробелы `"   "`** в поле имени → 422 (или ⚠️ если приняты)
- **Перенос строки `\n`** в имени → 422 или ⚠️
- **venue: `javascript:alert(1)`** → 422 или ⚠️ XSS/SSRF-риск
- **venue: `file:///etc/passwd`** → 422 или ⚠️
- **cancel_reason** в 2000 символов → 200 или 422
- **problem_description** в 5000 символов → 200 или 422
- **phone_number** — 6 форматов: `+7(999)…`, `89991234567`, с пробелами, иностранный
- **PUT /users/me** — сравнение поведения: поле отсутствует vs `null` vs `""`
- **PATCH** вместо PUT, **DELETE** на read-only эндпоинт → 404/405
- **Content-Type: text/plain** на JSON эндпоинт → 415/422
- **Лишние поля** `is_admin: true, role: "admin"` → должны быть проигнорированы

### `--infra` (~10 сек)
Инфраструктурные и конфигурационные проверки.

**CORS:**
- `OPTIONS /api/therapists/` с `Origin: http://evil.com`
- Фиксирует `Access-Control-Allow-Origin`
- Если `*` или `evil.com` → ⚠️ КРИТИЧНО

**Stack trace leak:**
- Отправляет заведомо сломанные запросы, ожидает 500
- Сканирует тело ответа на: `Traceback`, `File "/"`, `/home/`, `/app/`, `node_modules`, `SyntaxError`
- Если найдено → ❌ КРИТИЧНО (утечка структуры сервера)

**Security-заголовки** (на `/` и `/api/therapists/`):
- `X-Content-Type-Options`
- `X-Frame-Options`
- `Strict-Transport-Security`
- `X-XSS-Protection`
- `Content-Security-Policy`
- `Referrer-Policy`

### `--authz` (~20 сек)
IDOR и privilege escalation — проверяет авторизационные границы между пользователями.

Создаёт двух реальных пользователей (user_A и user_B) и пробует:

| # | Действие | Ожидание |
|---|---|---|
| 1 | user_A читает профиль user_B по ID | 403/404 (не 200) |
| 2 | user_A назначает себе роль `admin` | 403 |
| 3 | Создание терапевта обычным пользователем | 403 |
| 4 | user_B отменяет запись user_A | 403/404 |
| 5 | user_A обновляет профиль user_B | 403/404 |
| 6 | user_A видит заявки user_B в списке | Не должен |

> Любой `200` на защищённом действии → ❌ КРИТИЧНО с описанием конкретного IDOR.

### `--stability` (~5 мин)
Долгосрочная стабильность и деградация под нагрузкой.

**Тренд деградации (500 запросов):**
- `GET /api/therapists/` 500 раз подряд, батчами по 100
- Выводит avg каждого батча прямо в терминал:
  ```
  1-100: 45ms  101-200: 47ms  201-300: 48ms  301-400: 51ms  401-500: 52ms
  ```
- Если последний батч медленнее первого на >50% → ⚠️

**Большие выборки `?take=10000`:**
- `GET /therapists/`, `/articles/`, `/news/`
- Фиксирует время и количество записей
- Если >3000 мс → ⚠️

**Чередование read/auth (50 пар):**
- `GET /therapists/` + `GET /users/user` × 50 итераций
- Avg и max времени, количество auth-ошибок

### `--admin` (~10 сек)
Административные эндпоинты — только при наличии `ADMIN_EMAIL` и `ADMIN_PASSWORD`.

- Логин под администратором
- Получение профиля администратора
- Список всех пользователей (ожидается `200` или `403`)
- Список всех заявок и записей (admin view)
- Попытка удалить несуществующего пользователя → `403/404/405`

### `--ui` (~40 сек)
Playwright в headless Chromium.

- Каждая страница загружается и содержит ожидаемый контент
- Битые изображения
- Навигационные ссылки присутствуют
- Кнопка "Войти" найдена на главной
- Имя терапевта отображается на его странице
- Кнопка "Записаться" найдена на странице терапевта
- Предупреждение при загрузке страницы медленнее `SLOW_MS` мс

### `--all` (~10-15 мин)
Запускает все 13 режимов последовательно (+ `--admin` если заданы env vars). Генерирует:
- Отдельный `report-{режим}-{дата}.md` после каждой секции
- Сводный `full-report-{дата}.md` со всеми секциями и итоговой таблицей
- Список тестовых пользователей, созданных за прогон

---

## Отчёты

После каждого запуска в корне проекта создаётся Markdown-файл:

```
report-smoke-2026-05-05_10-00.md
report-infra-2026-05-05_10-00.md
...
full-report-2026-05-05_10-00.md   ← только для --all
```

Формат таблицы:

| # | Рез | Метод | Эндпоинт | Ожид | Факт | Детали |
|---|---|---|---|---|---|---|
| 1 | ✅ | `POST` | /api/users/register | 201 | 201 | id=5a06a619… |
| 2 | ❌ | `GET` | /api/users/user/{id_B} (из сессии A) | 403/404 | 200 | КРИТИЧНО IDOR |
| 3 | ⚠️ | `OPTIONS` | /api/therapists/ (Origin: evil.com) | != evil.com | * | CORS открыт |

> Отчёты добавлены в `.gitignore` — они не попадут в репозиторий.

---

## CI / GitHub Actions

Workflow запускается:
- При каждом push и pull request в `main`/`master`
- Ежедневно в 09:00 МСК (06:00 UTC)
- Вручную через `workflow_dispatch` с выбором режима

Секреты (Settings → Secrets and variables → Actions):

| Секрет | Назначение |
|---|---|
| `BASE_URL` | URL сайта (если отличается от дефолта) |
| `SLOW_MS` | Порог медленного ответа |
| `ADMIN_EMAIL` | Для режима `--admin` |
| `ADMIN_PASSWORD` | Для режима `--admin` |
| `TELEGRAM_BOT_TOKEN` | Токен бота для уведомлений |
| `TELEGRAM_CHAT_ID` | ID чата/канала для уведомлений |

---

## Структура проекта

```
psychohelp-test-suite/
├── test-suite.js      # основной файл — все 14 режимов
├── openapi.json       # OpenAPI-схема API (для валидации ответов)
├── package.json
├── package-lock.json
├── .gitignore
├── LICENSE
├── README.md
└── reports/           # сюда попадают сгенерированные отчёты (gitignored)
    └── .gitkeep
```

---

## Добавление нового теста

Структура записи результата:

```js
rec(
  '/api/some/endpoint',  // название (отображается в отчёте)
  'POST',                // HTTP-метод
  200,                   // ожидаемый статус
  r.status,             // фактический статус
  r.status === 200,      // true → ✅, false → ❌, null → ⚠️ (фиксируем)
  'детали'              // опционально
);
```

Чтобы добавить новый режим — создайте функцию `runMyMode()` и добавьте её в `modeMap` и массив `modes` в `runAll()` в конце файла.

---

## Лицензия

[MIT](LICENSE)
