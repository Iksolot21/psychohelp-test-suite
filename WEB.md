# Веб-панель тест-сьюта

Локальный интерфейс запускается поверх существующего `test-suite.js` и не требует новых npm-зависимостей.

```bash
npm run web
```

По умолчанию сервер открывается на `http://127.0.0.1:3000`.

## GitHub Pages

В репозитории есть workflow `.github/workflows/pages.yml`, который публикует статическую оболочку из `public/` на GitHub Pages.

Важно: GitHub Pages не запускает Node.js-сервер. Кнопки запуска тестов, live-лог и история прогонов работают только при `npm run web` или на отдельном backend-хостинге.

## Что доступно

- запуск любого режима: `smoke`, `auth`, `api`, `ui`, `appointments`, `security`, `scenarios`, `chaos`, `edge`, `infra`, `authz`, `stability`, `admin`, `all`;
- настройка `BASE_URL`, `SLOW_MS`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`;
- флаги вывода `quiet` и `verbose`;
- live-лог через browser UI;
- остановка активного запуска;
- список Markdown-отчетов;
- просмотр итогов, фильтр `Pass / Fail / Warn`, поиск по строкам отчета;
- скачивание и удаление отчетов.

## Переменные сервера

```bash
PORT=3001 npm run web
HOST=0.0.0.0 npm run web
BASE_URL=https://staging.example.com npm run web
SLOW_MS=2500 npm run web
```

Веб-запуски складывают отчеты в `reports/`. Обычный CLI без `REPORT_DIR` сохраняет прежнее поведение.
