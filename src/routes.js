const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run, transaction, ORDER_STATUSES } = require('./db');
const { signToken, auth, requireRole, superAdmin, wrap } = require('./middleware');
const { upload, resolveImage, removeLocal, publicUrl } = require('./upload');
const { bad, notFound, httpError, toNum, isNum, str, getOrder, listOrders } = require('./helpers');

const router = express.Router();
const SIZES = [22, 28, 33];

// ---------- AUTH ----------
router.post('/auth/register', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || username.trim().length < 3) return bad(res, 'username kamida 3 belgi');
  if (typeof password !== 'string' || password.length < 6) return bad(res, 'password kamida 6 belgi');
  const r = await get(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO NOTHING RETURNING id`,
    username.trim(), bcrypt.hashSync(password, 10));
  if (!r) return res.status(409).json({ error: 'Bu username band' });
  const user = { id: r.id, username: username.trim(), role: 'user', branch_id: null };
  res.status(201).json({ user, token: signToken(user) });
}));

// Hamma rollar (user, superadmin, branch_admin, worker) shu yerdan kiradi
router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = await get(
    `SELECT u.*, b.active AS branch_active
     FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.username = $1`,
    String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash))
    return res.status(401).json({ error: 'Username yoki parol noto\'g\'ri' });
  if (!u.active) return res.status(403).json({ error: 'Hisob bloklangan' });
  if (u.branch_id && !u.branch_active) return res.status(403).json({ error: 'Filial faol emas' });
  const user = { id: u.id, username: u.username, role: u.role, branch_id: u.branch_id };
  res.json({ user, token: signToken(user) });
}));

router.get('/auth/me', auth, wrap(async (req, res) => {
  const u = await get(
    `SELECT u.id, u.username, u.role, u.full_name, u.phone, u.created_at, u.branch_id, b.name AS branch_name
     FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.id = $1`,
    req.user.id);
  if (!u) return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
  const { branch_id, branch_name, ...rest } = u;
  res.json({ ...rest, branch: branch_id ? { id: branch_id, name: branch_name } : null });
}));

// ---------- CATEGORIES (umumiy, faqat superadmin boshqaradi) ----------
router.get('/categories', wrap(async (req, res) => {
  res.json(await all('SELECT id, name FROM categories ORDER BY name'));
}));

router.post('/categories', auth, superAdmin, wrap(async (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return bad(res, 'name majburiy');
  const r = await get('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id', name);
  if (!r) return res.status(409).json({ error: 'Bunday kategoriya bor' });
  res.status(201).json({ id: r.id, name });
}));

router.put('/categories/:id', auth, superAdmin, wrap(async (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return bad(res, 'name majburiy');
  const r = await run('UPDATE categories SET name = $1 WHERE id = $2', name, req.params.id);
  if (!r.rowCount) return notFound(res, 'Kategoriya topilmadi');
  res.json({ id: Number(req.params.id), name });
}));

router.delete('/categories/:id', auth, superAdmin, wrap(async (req, res) => {
  if (await get('SELECT 1 FROM products WHERE category_id = $1 LIMIT 1', req.params.id))
    return res.status(409).json({ error: 'Kategoriyada mahsulotlar bor, avval ularni o\'chiring' });
  const r = await run('DELETE FROM categories WHERE id = $1', req.params.id);
  if (!r.rowCount) return notFound(res, 'Kategoriya topilmadi');
  res.status(204).end();
}));

// ---------- PRODUCTS (filial ovqatlari) ----------
const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.image, p.description, p.category_id, c.name AS category,
         p.branch_id, b.name AS branch_name, p.price_22, p.price_28, p.price_33
  FROM products p
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN branches b ON b.id = p.branch_id`;

const shape = (req) => (p) => ({
  id: p.id,
  name: p.name,
  image: publicUrl(req, p.image),
  description: p.description,
  category: { id: p.category_id, name: p.category },
  branch: p.branch_id ? { id: p.branch_id, name: p.branch_name } : null,
  sizes: [
    { size: 22, price: p.price_22 },
    { size: 28, price: p.price_28 },
    { size: 33, price: p.price_33 },
  ],
});

const getProduct = (id) => get(`${PRODUCT_SELECT} WHERE p.id = $1`, id);

function readPrices(b) {
  let prices = b.prices;
  if (typeof prices === 'string') {
    try { prices = JSON.parse(prices); } catch { return { error: 'prices JSON noto\'g\'ri' }; }
  }
  prices = prices && typeof prices === 'object' ? { ...prices } : {};
  // form-data uchun tekis maydonlar ham qabul qilinadi: price_22, price_28, price_33
  for (const s of SIZES) if (prices[s] === undefined && b[`price_${s}`] !== undefined) prices[s] = b[`price_${s}`];
  return { prices };
}

async function readProductBody(req, partial = false) {
  const b = req.body || {};
  const { prices, error: pErr } = readPrices(b);
  if (pErr) return { error: pErr };
  const out = {};
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { error: 'name majburiy' };
    out.name = b.name.trim();
  }
  const img = resolveImage(req, 'image');
  if (img.error) return { error: img.error };
  if (img.value !== undefined) out.image = img.value;
  else if (!partial) out.image = '';
  if (!partial || b.description !== undefined) out.description = str(b.description);
  if (!partial || b.category_id !== undefined) {
    const categoryId = toNum(b.category_id);
    if (!Number.isInteger(categoryId) || !(await get('SELECT id FROM categories WHERE id = $1', categoryId)))
      return { error: 'category_id noto\'g\'ri' };
    out.category_id = categoryId;
  }
  // Filial: filial admini faqat o'z filialiga qo'shadi; superadmin branch_id ni ko'rsatadi
  if (req.user.role === 'branch_admin') {
    if (!partial) out.branch_id = req.user.branch_id;
  } else if (!partial || b.branch_id !== undefined) {
    const branchId = toNum(b.branch_id);
    if (!Number.isInteger(branchId) || !(await get('SELECT id FROM branches WHERE id = $1', branchId)))
      return { error: 'branch_id noto\'g\'ri' };
    out.branch_id = branchId;
  }
  for (const s of SIZES) {
    if (!partial || prices[s] !== undefined) {
      const price = toNum(prices[s]);
      if (!isNum(price)) return { error: `prices.${s} musbat son bo'lishi kerak` };
      out[`price_${s}`] = price;
    }
  }
  return { data: out };
}

// Validatsiya xatosida yuklangan faylni o'chirib, xato qaytaradi
const rejectUpload = (req, res, msg, status = 400) => {
  if (req.file) removeLocal(`/uploads/${req.file.filename}`);
  return res.status(status).json({ error: msg });
};

// Filial admini faqat o'z filiali mahsulotiga tegishi mumkin
const canEditProduct = (user, product) => user.role === 'superadmin' || product.branch_id === user.branch_id;

const productEditors = [auth, requireRole('superadmin', 'branch_admin')];

router.get('/products', wrap(async (req, res) => {
  const where = ['(b.active = TRUE OR p.branch_id IS NULL)'];
  const args = [];
  if (req.query.category_id) { args.push(req.query.category_id); where.push(`p.category_id = $${args.length}`); }
  if (req.query.branch_id) { args.push(req.query.branch_id); where.push(`p.branch_id = $${args.length}`); }
  if (req.query.search) { args.push(`%${req.query.search}%`); where.push(`p.name ILIKE $${args.length}`); }
  const sql = `${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.id DESC`;
  res.json((await all(sql, ...args)).map(shape(req)));
}));

router.get('/products/:id', wrap(async (req, res) => {
  const p = await getProduct(req.params.id);
  if (!p) return notFound(res, 'Mahsulot topilmadi');
  res.json(shape(req)(p));
}));

// Rasm: JSON'da "image" (link) yoki multipart/form-data'da "image" (fayl) / "image_url" (link)
router.post('/products', ...productEditors, upload.single('image'), wrap(async (req, res) => {
  const { data, error } = await readProductBody(req);
  if (error) return rejectUpload(req, res, error);
  const r = await get(
    `INSERT INTO products (name, image, description, category_id, branch_id, price_22, price_28, price_33)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    data.name, data.image, data.description, data.category_id, data.branch_id, data.price_22, data.price_28, data.price_33);
  res.status(201).json(shape(req)(await getProduct(r.id)));
}));

router.put('/products/:id', ...productEditors, upload.single('image'), wrap(async (req, res) => {
  const old = await get('SELECT image, branch_id FROM products WHERE id = $1', req.params.id);
  if (!old || !canEditProduct(req.user, old)) return rejectUpload(req, res, 'Mahsulot topilmadi', 404);
  const { data, error } = await readProductBody(req, true);
  if (error) return rejectUpload(req, res, error);
  const keys = Object.keys(data);
  if (keys.length) {
    await run(`UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
      ...keys.map((k) => data[k]), req.params.id);
  }
  if (data.image !== undefined && data.image !== old.image) removeLocal(old.image);
  res.json(shape(req)(await getProduct(req.params.id)));
}));

router.delete('/products/:id', ...productEditors, wrap(async (req, res) => {
  const old = await get('SELECT image, branch_id FROM products WHERE id = $1', req.params.id);
  if (!old || !canEditProduct(req.user, old)) return notFound(res, 'Mahsulot topilmadi');
  if (await get('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', req.params.id))
    return res.status(409).json({ error: 'Bu mahsulot buyurtmalarda ishlatilgan, o\'chirib bo\'lmaydi' });
  await run('DELETE FROM products WHERE id = $1', req.params.id);
  removeLocal(old.image);
  res.status(204).end();
}));

// ---------- ORDERS (mijoz) ----------
router.post('/orders', auth, wrap(async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) return bad(res, 'items bo\'sh bo\'lmasligi kerak');
  const orderId = await transaction(async (client) => {
    let total = 0;
    let branchId;
    const rows = [];
    for (const it of items) {
      if (!SIZES.includes(it?.size)) throw httpError(400, 'size 22, 28 yoki 33 bo\'lishi kerak');
      if (!Number.isInteger(it.quantity) || it.quantity < 1) throw httpError(400, 'quantity >= 1 butun son');
      const pid = Number(it.product_id);
      const p = Number.isInteger(pid)
        ? (await client.query(
            'SELECT p.*, b.active AS branch_active FROM products p LEFT JOIN branches b ON b.id = p.branch_id WHERE p.id = $1',
            [pid]
          )).rows[0]
        : undefined;
      if (!p) throw httpError(400, `product_id ${it.product_id} topilmadi`);
      if (!p.branch_id) throw httpError(400, `"${p.name}" hech qaysi filialga biriktirilmagan`);
      if (!p.branch_active) throw httpError(400, `"${p.name}" filiali hozir ishlamayapti`);
      if (branchId === undefined) branchId = p.branch_id;
      else if (branchId !== p.branch_id) throw httpError(400, 'Bitta buyurtmadagi mahsulotlar bitta filialdan bo\'lishi kerak');
      const price = p[`price_${it.size}`];
      total += price * it.quantity;
      rows.push([p.id, it.size, it.quantity, price]);
    }
    const o = (await client.query(
      'INSERT INTO orders (user_id, branch_id, total, address, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.user.id, branchId, total, str(req.body.address), str(req.body.phone)]
    )).rows[0];
    for (const r of rows) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, size, quantity, price) VALUES ($1, $2, $3, $4, $5)',
        [o.id, ...r]
      );
    }
    return o.id;
  });
  res.status(201).json(await getOrder(orderId));
}));

router.get('/orders/my', auth, wrap(async (req, res) => {
  res.json(await listOrders({ user_id: req.user.id }, 500));
}));

router.get('/orders', auth, superAdmin, wrap(async (req, res) => {
  res.json(await listOrders({ status: req.query.status, branch_id: req.query.branch_id, worker_id: req.query.worker_id }, req.query.limit));
}));

router.patch('/orders/:id/status', auth, superAdmin, wrap(async (req, res) => {
  const status = req.body?.status;
  if (!ORDER_STATUSES.includes(status)) return bad(res, 'status noto\'g\'ri');
  const r = await run(
    `UPDATE orders SET status = $1, delivered_at = CASE WHEN $1 = 'delivered' THEN COALESCE(delivered_at, CURRENT_TIMESTAMP) ELSE delivered_at END
     WHERE id = $2`,
    status, req.params.id
  );
  if (!r.rowCount) return notFound(res, 'Buyurtma topilmadi');
  res.json(await getOrder(req.params.id));
}));

// ---------- PURCHASED ITEMS (sotib olingan tovarlar) ----------
router.get('/purchases', auth, wrap(async (req, res) => {
  const rows = await all(
    `SELECT p.id AS product_id, p.name, p.image, oi.size,
            SUM(oi.quantity)::int AS quantity, SUM(oi.quantity * oi.price) AS spent, MAX(o.created_at) AS last_purchased_at
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.user_id = $1 AND o.status != 'cancelled'
     GROUP BY p.id, oi.size ORDER BY last_purchased_at DESC`, req.user.id);
  res.json({
    totalSpent: rows.reduce((s, r) => s + r.spent, 0),
    items: rows.map((r) => ({ ...r, image: publicUrl(req, r.image) })),
  });
}));

// ---------- LOGO ----------
const getLogo = async () => (await get("SELECT value FROM settings WHERE key = 'logo'"))?.value ?? null;

router.get('/logo', wrap(async (req, res) => {
  const logo = await getLogo();
  res.json({ logo: logo ? publicUrl(req, logo) : null });
}));

// JSON'da "logo" (link) yoki multipart/form-data'da "logo" (fayl) / "logo_url" (link)
router.put('/logo', auth, superAdmin, upload.single('logo'), wrap(async (req, res) => {
  const { value, error } = resolveImage(req, 'logo');
  if (error) return rejectUpload(req, res, error);
  if (!value) return rejectUpload(req, res, 'logo (fayl yoki link) majburiy');
  const old = await getLogo();
  await run(
    "INSERT INTO settings (key, value) VALUES ('logo', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    value
  );
  if (old !== value) removeLocal(old);
  res.json({ logo: publicUrl(req, value) });
}));

router.delete('/logo', auth, superAdmin, wrap(async (req, res) => {
  removeLocal(await getLogo());
  await run("DELETE FROM settings WHERE key = 'logo'");
  res.status(204).end();
}));

// ---------- STATISTICS (super admin) ----------
router.get('/admin/stats', auth, superAdmin, wrap(async (req, res) => {
  const live = "status != 'cancelled'";
  const [totals, ordersByStatus, byBranch, topProducts, salesBySize, salesByCategory, last7Days] = await Promise.all([
    get(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE role = 'user') AS users,
      (SELECT COUNT(*)::int FROM branches WHERE active = TRUE) AS branches,
      (SELECT COUNT(*)::int FROM users WHERE role = 'worker' AND active = TRUE) AS workers,
      (SELECT COUNT(*)::int FROM products) AS products,
      (SELECT COUNT(*)::int FROM categories) AS categories,
      (SELECT COUNT(*)::int FROM orders) AS orders,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE ${live}) AS revenue,
      (SELECT COALESCE(AVG(total),0) FROM orders WHERE ${live}) AS "averageOrder"`),
    all('SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status'),
    all(
      `SELECT b.id, b.name, b.active,
              COUNT(o.id)::int AS orders,
              COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered,
              COUNT(o.id) FILTER (WHERE o.status IN ('new','preparing','delivering'))::int AS "inProgress",
              COALESCE(SUM(o.total) FILTER (WHERE o.status != 'cancelled'), 0) AS revenue,
              (SELECT COUNT(*)::int FROM users w WHERE w.branch_id = b.id AND w.role = 'worker' AND w.active = TRUE) AS workers
       FROM branches b LEFT JOIN orders o ON o.branch_id = b.id
       GROUP BY b.id ORDER BY revenue DESC`),
    all(
      `SELECT p.id, p.name, SUM(oi.quantity)::int AS sold, SUM(oi.quantity * oi.price) AS revenue
       FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN orders o ON o.id = oi.order_id
       WHERE o.${live} GROUP BY p.id ORDER BY sold DESC LIMIT 5`),
    all(
      `SELECT oi.size, SUM(oi.quantity)::int AS sold FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.${live} GROUP BY oi.size ORDER BY oi.size`),
    all(
      `SELECT c.name AS category, SUM(oi.quantity)::int AS sold, SUM(oi.quantity * oi.price) AS revenue
       FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN categories c ON c.id = p.category_id
       JOIN orders o ON o.id = oi.order_id WHERE o.${live} GROUP BY c.id ORDER BY revenue DESC`),
    all(
      `SELECT created_at::date::text AS date, COUNT(*)::int AS orders, COALESCE(SUM(total),0) AS revenue
       FROM orders WHERE ${live} AND created_at >= CURRENT_DATE - 6
       GROUP BY created_at::date ORDER BY created_at::date`),
  ]);
  res.json({ totals, ordersByStatus, byBranch, topProducts, salesBySize, salesByCategory, last7Days });
}));

router.use(require('./branches'));
router.use('/branch', require('./branch'));
router.use('/worker', require('./worker'));

module.exports = router;
