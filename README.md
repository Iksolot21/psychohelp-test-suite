# Psychohelp Test Suite

Автоматизированная тест-сюита для сайта **Служба психологической помощи МПУ**.  
Покрывает API, UI, авторизацию, запись на приём и безопасность — 96 проверок за один запуск.

**Стек:** Node.js 18+ · Playwright · встроенный `fetch`  
**Без дополнительных тест-фреймворков** — только Playwright для браузерных тестов.

---

## Быстрый старт

```bash
git clone https://github.com/<your-username>/psychohelp-test-suite.git
cd psychohelp-test-suite

npm install
npx playwright install chromium

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

Откройте `test-suite.js` и измените константы в начале файла:

```js
const BASE = 'http://95.31.169.106';   // URL сайта
const API  = `${BASE}/api`;            // URL API (обычно не менять)
```

Больше ничего настраивать не нужно — тест-аккаунты создаются автоматически при каждом запуске.

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
node test-suite.js --all
```

---

## Что проверяет каждый режим

### `--smoke` (~10 сек)
Быстрая проверка — всё ли живо перед полным прогоном.

- Все UI-страницы отвечают `200`: `/`, `/therapists`, `/news`, `/resources`, `/faq`
- Ключевые API-эндпоинты: `/api/therapists/`, `/api/articles/`, `/api/news/`, `/api/applications/university-statuses`
- `POST /api/users/register` → `201`
- `POST /api/users/logout` → `200/401`

### `--auth` (~15 сек)
Полный флоу управления аккаунтом.

| Шаг | Эндпоинт | Проверка |
|---|---|---|
| Регистрация | `POST /users/register` | `201`, возвращает `id` |
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
Покрытие всех эндпоинтов из `openapi.json`.

- Публичные GET: therapists, articles, news, university-statuses
- Авторизованные GET: `/users/user`, `/appointments/`, `/applications/`
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

### `--ui` (~40 сек)
Playwright в headless Chromium.

- Каждая страница загружается и содержит ожидаемый контент
- Битые изображения
- Навигационные ссылки присутствуют
- Кнопка "Войти" найдена на главной
- Имя терапевта отображается на его странице
- Кнопка "Записаться" найдена на странице терапевта

### `--all` (~2-3 мин)
Запускает все режимы последовательно. Генерирует:
- Отдельный `report-{режим}-{дата}.md` после каждой секции
- Сводный `full-report-{дата}.md` со всеми секциями и итоговой таблицей

---

## Отчёты

После каждого запуска в корне проекта создаётся Markdown-файл:

```
report-smoke-2026-05-04_17-34.md
report-auth-2026-05-04_17-34.md
...
full-report-2026-05-04_17-34.md   ← только для --all
```

Формат таблицы:

| # | Рез | Метод | Эндпоинт | Ожид | Факт | Детали |
|---|---|---|---|---|---|---|
| 1 | ✅ | `POST` | /api/users/register | 201 | 201 | id=5a06a619… |
| 2 | ❌ | `POST` | /api/users/password-reset/request | 200 | 500 | email-сервер не настроен |
| 3 | ⚠️ | `POST` | /api/users/me/password (без токена) | 401 | 422 | валидирует тело до auth-check |

> Отчёты добавлены в `.gitignore` — они не попадут в репозиторий.

---

## Результаты последнего прогона

> Прогон от 04.05.2026 на `http://95.31.169.106`

```
SMOKE        ✅ 11  ❌  0  ⚠️  0
AUTH         ✅ 11  ❌  1  ⚠️  0
API          ✅ 23  ❌  0  ⚠️  1
APPOINTMENTS ✅ 12  ❌  0  ⚠️  0
SECURITY     ✅ 24  ❌  0  ⚠️  2
UI           ✅ 10  ❌  0  ⚠️  1
─────────────────────────────────
ИТОГО        ✅ 91  ❌  1  ⚠️  4  (96 проверок)
```

### Найденные баги

| # | Тип | Эндпоинт | Описание |
|---|---|---|---|
| 1 | ❌ BUG | `POST /api/users/password-reset/request` | Сервер возвращает `500` — не настроен SMTP для отправки письма |
| 2 | ⚠️ SEC | `POST /api/users/me/password` | Валидация тела происходит **до** проверки авторизации → возвращает `422` вместо `401` без токена. Утечка информации о структуре API |
| 3 | ⚠️ SEC | `POST /api/applications/` | Та же проблема: `422` без токена вместо `401` |
| 4 | ⚠️ INFO | `/news` UI | Страница загружается, но в базе нет ни одной новости — наполнение контентом |

---

## Структура проекта

```
psychohelp-test-suite/
├── test-suite.js      # основной файл — все тесты
├── openapi.json       # OpenAPI-схема API (для справки)
├── package.json
├── package-lock.json
├── .gitignore
├── LICENSE
├── README.md
└── reports/           # сюда попадают сгенерированные отчёты (gitignored)
    └── .gitkeep
```

> Отчёты генерируются в корень проекта рядом с `test-suite.js`.  
> Папка `reports/` зарезервирована на будущее — можно перенести туда вывод, изменив путь в `saveReport()`.

---

## Добавление нового теста

Структура записи результата:

```js
rec(
  '/api/some/endpoint',  // название (отображается в отчёте)
  'POST',                // HTTP-метод
  200,                   // ожидаемый статус
  r.status,             // фактический статус
  r.status === 200,      // true → ✅, false → ❌, null → ⚠️
  'детали'              // опционально
);
```

Чтобы добавить новый режим — создайте функцию `runMyMode()` и добавьте её в объект `modeMap` в конце файла.

---

## Лицензия

[MIT](LICENSE)
