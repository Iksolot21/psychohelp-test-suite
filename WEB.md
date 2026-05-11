# Веб-панель тест-сьюта

Локальный интерфейс запускается поверх существующего `test-suite.js` и не требует новых npm-зависимостей.

```bash
npm run web
```

По умолчанию сервер открывается на `http://127.0.0.1:3000`.

## Production hosting

GitHub Pages для этого дашборда не подходит: он умеет отдавать только статические файлы и не запускает Node.js-сервер.

Для полноценной работы нужен backend-хостинг с Docker/Node.js. В репозитории есть:

- `Dockerfile` на официальном Playwright-образе;
- `render.yaml` для Render Blueprint;
- healthcheck `/healthz`;
- поддержка `$PORT` для PaaS-платформ;
- `RUNS_DIR=/app/runs` для истории запусков.

Минимальный вариант на Render:

1. New → Blueprint.
2. Выбрать репозиторий `Iksolot21/psychohelp-test-suite`.
3. Render подхватит `render.yaml`.
4. После создания сервиса открыть сгенерированный `DASHBOARD_TOKEN` в Environment и использовать его при входе в дашборд.

Для сохранения истории запусков между рестартами нужен persistent disk, смонтированный в `/app/runs`.

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
