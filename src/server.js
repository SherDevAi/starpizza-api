require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const swaggerUi = require('swagger-ui-express');
const routes = require('./routes');
const spec = require('./openapi');
const { ready } = require('./db');
const { UPLOAD_DIR, MAX_MB } = require('./upload');

// Vercel'da node_modules ichidagi statik fayllar berilmaydi, shuning uchun Swagger UI CDN'dan yuklanadi
const SWAGGER_CDN = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.2';

const app = express();
// nginx / Vercel / Render kabi proksi ortida to'g'ri protokol/host (rasm URL'lari uchun)
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Frontend baseURL oxirida '/' bo'lsa so'rov '//api/...' ga keladi — qo'sh slashni tekislaymiz
app.use((req, res, next) => {
  if (req.url.startsWith('//')) req.url = req.url.replace(/^\/+/, '/');
  next();
});

app.get('/', (req, res) => res.redirect('/docs'));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, {
  swaggerOptions: { persistAuthorization: true },
  customCssUrl: `${SWAGGER_CDN}/swagger-ui.css`,
  customJs: [`${SWAGGER_CDN}/swagger-ui-bundle.js`, `${SWAGGER_CDN}/swagger-ui-standalone-preset.js`],
}));
app.get('/openapi.json', (req, res) => res.json(spec));
// Yuklangan rasmlar. nosniff — brauzer faylni rasmdan boshqa narsa deb talqin qilmasin
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));
app.use('/api', async (req, res, next) => { await ready(); next(); }, routes);

app.use((req, res) => res.status(404).json({ error: 'Topilmadi' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON noto\'g\'ri' });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Rasm hajmi ${MAX_MB} MB dan oshmasligi kerak`
      : err.code === 'LIMIT_UNEXPECTED_FILE' ? `Kutilmagan fayl maydoni: "${err.field}"` : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  // Postgres: noto'g'ri formatdagi yoki juda katta id (masalan /products/abc)
  if (err.code === '22P02' || err.code === '22003') return res.status(400).json({ error: 'Parametr noto\'g\'ri' });
  console.error(err);
  res.status(500).json({ error: 'Server xatosi' });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`API: http://localhost:${PORT}/api  |  Docs: http://localhost:${PORT}/docs`));
}
