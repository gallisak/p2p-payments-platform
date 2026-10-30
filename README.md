# P2P Ledger — стартовий репозиторій

Це стартовий каркас для тестового завдання (`ТЗ_тестове_завдання_6`). Частина
сервісів уже працює, частина — лише каркас або TODO. Повний опис завдання —
у файлі ТЗ, який ви отримали окремо.

## Що вже працює

- `apps/ledger-service` — автентифікація (register/login/refresh) і базовий
  CRUD гаманців. Балансу гаманця бракує event sourcing — це частина завдання.
- `apps/frontend` — сторінки логіну, реєстрації та список гаманців (Next.js
  App Router, Server Component + API-роут-проксі для авторизації).

## Що ще НЕ реалізовано

- `apps/payments-service` — лише каркас контролера/DTO, бізнес-логіки саги
  переказу немає (`NotImplementedException`).
- `apps/notifications-service` — порожній Nest-проєкт, лише `/health`.
- Форма переказу, split-рахунки, admin-екран на фронтенді.

## Запуск

```bash
docker-compose up --build
```

- ledger-service: http://localhost:3001
- payments-service: http://localhost:3002
- notifications-service: http://localhost:3003
- frontend: http://localhost:3000

## Конфігурація

`docker compose up` не потребує жодних файлів: на чистому клоні стек стартує зі
значеннями для локальної розробки (префікс `dev-only`). Перед реальним
запуском їх треба замінити. Потрібен Docker Compose 2.24 або новіший.

`.env.example` — лише шаблони, Docker їх не читає. Кожне значення має одне місце:

| Що | Де | Як змінити |
|---|---|---|
| Спільні секрети, адмін, паролі БД | кореневий `.env` | `cp .env.example .env` |
| Ліміти, таймаути, курси FX | `apps/<сервіс>/.env` | `cp apps/<сервіс>/.env.example apps/<сервіс>/.env` |
| Адреси всередині Docker | `docker-compose.yml` | редагувати compose |

Значення з `environment` у compose мають пріоритет над `apps/<сервіс>/.env`,
тому секрети для Docker задаються в кореневому `.env`, а адреси — у compose.
Паролі БД застосовуються лише під час першого
створення тому: після зміни потрібен `docker compose down -v`. Те саме з
паролем адміна, бо адмін створюється один раз.

Для локальної розробки без Docker: скопіюйте `.env.example` → `.env` у
кожному сервісі, підніміть Postgres і Redis (`docker compose up -d ledger-db
payments-db notifications-db redis`), `npm install && npm run start:dev` у
потрібному сервісі.

## Тести

```bash
cd apps/ledger-service && npm test
```

Не всі тести в репозиторії однаково надійні — це навмисно, дивись ТЗ.
