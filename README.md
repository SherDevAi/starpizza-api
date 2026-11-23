# Star Pizza API

Pitsa tarmog'i uchun backend: Express 5 + PostgreSQL (Neon) + JWT, filiallar, ishchilar (kuryerlar), rasm yuklash va Swagger hujjatlari bilan.

- Production: https://starpizza-api.vercel.app
- Swagger: https://starpizza-api.vercel.app/docs
- OpenAPI: https://starpizza-api.vercel.app/openapi.json
- Qo'llanma: [docs/Pizza_API_qollanma.pdf](docs/Pizza_API_qollanma.pdf)

## Imkoniyatlar

- **Rollar:** `superadmin`, `branch_admin` (filial admini), `worker` (yetkazib beruvchi), `user` (mijoz)
- **Filiallar va xodimlar:** filiallar, filial adminlari, ishchilarni boshqarish va buyurtmalarni biriktirish
- **Mahsulotlar va logotip:** JSON URL yoki `multipart/form-data` orqali rasm yuklash (`/uploads`)
- **Statistika:** superadmin, filial admini va ishchi panellari uchun batafsil statistika

## Lokal ishga tushirish

```bash
npm install
cp .env.example .env   # DATABASE_URL va boshqa qiymatlarni to'ldiring
npm start
```

Jadvallar birinchi `/api` so'rovida avtomatik yaratiladi (va eski sxema bo'lsa yangilanadi), super admin esa `ADMIN_USERNAME` / `ADMIN_PASSWORD` dan olinadi.

## Muhit o'zgaruvchilari

| O'zgaruvchi | Tavsif |
|---|---|
| `DATABASE_URL` | Postgres ulanish satri (Vercel'da Neon integratsiyasi qo'shadi) |
| `JWT_SECRET` | JWT imzolash kaliti |
| `JWT_EXPIRES` | Token muddati, masalan `7d` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Birinchi ishga tushirishda yaratiladigan super admin |
| `UPLOAD_DIR` | Yuklangan rasmlar papkasi (standart: `uploads`) |
| `PUBLIC_URL` | Rasm linklari uchun tashqi URL (ixtiyoriy) |

## Deploy

- **Vercel** — `express` preset, `src/server.js` `app` ni eksport qiladi.
- **Render** — `render.yaml` tayyor (`DATABASE_URL` ni qo'lda kiriting).
