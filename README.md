# Star Pizza API

Pitsa sayti uchun backend: Express 5 + PostgreSQL (Neon) + JWT, Swagger hujjatlari bilan.

- Production: https://starpizza-api.vercel.app
- Swagger: https://starpizza-api.vercel.app/docs
- OpenAPI: https://starpizza-api.vercel.app/openapi.json

## Lokal ishga tushirish

```bash
npm install
cp .env.example .env   # DATABASE_URL va boshqa qiymatlarni to'ldiring
npm start
```

Jadvallar birinchi `/api` so'rovida avtomatik yaratiladi, super admin esa `ADMIN_USERNAME` / `ADMIN_PASSWORD` dan olinadi.

## Muhit o'zgaruvchilari

| O'zgaruvchi | Tavsif |
|---|---|
| `DATABASE_URL` | Postgres ulanish satri (Vercel'da Neon integratsiyasi qo'shadi) |
| `JWT_SECRET` | JWT imzolash kaliti |
| `JWT_EXPIRES` | Token muddati, masalan `7d` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Birinchi ishga tushirishda yaratiladigan super admin |

## Deploy

- **Vercel** — `express` preset, `src/server.js` `app` ni eksport qiladi.
- **Render** — `render.yaml` tayyor (`DATABASE_URL` ni qo'lda kiriting).
