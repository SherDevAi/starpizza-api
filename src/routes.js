const express = require('express');
const bcrypt = require('bcryptjs');
const { all, get, run, transaction } = require('./db');
const { signToken, auth, superAdmin, wrap } = require('./middleware');

const router = express.Router();
const SIZES = [22, 28, 33];

const bad = (res, msg) => res.status(400).json({ error: msg });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

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
  const user = { id: r.id, username: username.trim(), role: 'user' };
  res.status(201).json({ user, token: signToken(user) });
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = await get('SELECT id, username, role, password_hash FROM users WHERE username = $1', String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash))
    return res.status(401).json({ error: 'Username yoki parol noto\'g\'ri' });
  const user = { id: u.id, username: u.username, role: u.role };
  res.json({ user, token: signToken(user) });
}));

router.get('/auth/me', auth, wrap(async (req, res) => {
  const u = await get('SELECT id, username, role, created_at FROM users WHERE id = $1', req.user.id);
  if (!u) return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
  res.json(u);
}));

// ---------- CATEGORIES ----------
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
  if (!r.rowCount) return res.status(404).json({ error: 'Kategoriya topilmadi' });
  res.json({ id: Number(req.params.id), name });
}));

router.delete('/categories/:id', auth, superAdmin, wrap(async (req, res) => {
  if (await get('SELECT 1 FROM products WHERE category_id = $1 LIMIT 1', req.params.id))
    return res.status(409).json({ error: 'Kategoriyada mahsulotlar bor, avval ularni o\'chiring' });
  const r = await run('DELETE FROM categories WHERE id = $1', req.params.id);
  if (!r.rowCount) return res.status(404).json({ error: 'Kategoriya topilmadi' });
  res.status(204).end();
}));

// ---------- PRODUCTS (card) ----------
const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.image, p.description, p.category_id, c.name AS category,
         p.price_22, p.price_28, p.price_33
  FROM products p JOIN categories c ON c.id = p.category_id`;

const shape = (p) => ({
  id: p.id,
  name: p.name,
  image: p.image,
  description: p.description,
  category: { id: p.category_id, name: p.category },
  sizes: [
    { size: 22, price: p.price_22 },
    { size: 28, price: p.price_28 },
    { size: 33, price: p.price_33 },
  ],
});

const getProduct = (id) => get(`${PRODUCT_SELECT} WHERE p.id = $1`, id);

async function readProductBody(body, partial = false) {
  const b = body || {};
  const prices = b.prices || {};
  const out = {};
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { error: 'name majburiy' };
    out.name = b.name.trim();
  }
  if (!partial || b.image !== undefined) out.image = String(b.image ?? '');
  if (!partial || b.description !== undefined) out.description = String(b.description ?? '');
  if (!partial || b.category_id !== undefined) {
    const cid = Number(b.category_id);
    if (!Number.isInteger(cid) || !(await get('SELECT id FROM categories WHERE id = $1', cid)))
      return { error: 'category_id noto\'g\'ri' };
    out.category_id = cid;
  }
  for (const s of SIZES) {
    if (!partial || prices[s] !== undefined) {
      if (!isNum(prices[s])) return { error: `prices.${s} musbat son bo'lishi kerak` };
      out[`price_${s}`] = prices[s];
    }
  }
  return { data: out };
}

router.get('/products', wrap(async (req, res) => {
  const where = [];
  const args = [];
  if (req.query.category_id) { args.push(req.query.category_id); where.push(`p.category_id = $${args.length}`); }
  if (req.query.search) { args.push(`%${req.query.search}%`); where.push(`p.name ILIKE $${args.length}`); }
  const sql = `${PRODUCT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC`;
  res.json((await all(sql, ...args)).map(shape));
}));

router.get('/products/:id', wrap(async (req, res) => {
  const p = await getProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi' });
  res.json(shape(p));
}));

router.post('/products', auth, superAdmin, wrap(async (req, res) => {
  const { data, error } = await readProductBody(req.body);
  if (error) return bad(res, error);
  const r = await get(
    `INSERT INTO products (name, image, description, category_id, price_22, price_28, price_33)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    data.name, data.image, data.description, data.category_id, data.price_22, data.price_28, data.price_33);
  res.status(201).json(shape(await getProduct(r.id)));
}));

router.put('/products/:id', auth, superAdmin, wrap(async (req, res) => {
  if (!(await get('SELECT id FROM products WHERE id = $1', req.params.id)))
    return res.status(404).json({ error: 'Mahsulot topilmadi' });
  const { data, error } = await readProductBody(req.body, true);
  if (error) return bad(res, error);
  const keys = Object.keys(data);
  if (keys.length) {
    await run(`UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
      ...keys.map((k) => data[k]), req.params.id);
  }
  res.json(shape(await getProduct(req.params.id)));
}));

router.delete('/products/:id', auth, superAdmin, wrap(async (req, res) => {
  if (await get('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', req.params.id))
    return res.status(409).json({ error: 'Bu mahsulot buyurtmalarda ishlatilgan, o\'chirib bo\'lmaydi' });
  const r = await run('DELETE FROM products WHERE id = $1', req.params.id);
  if (!r.rowCount) return res.status(404).json({ error: 'Mahsulot topilmadi' });
  res.status(204).end();
}));

// ---------- ORDERS ----------
router.post('/orders', auth, wrap(async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) return bad(res, 'items bo\'sh bo\'lmasligi kerak');
  const order = await transaction(async (client) => {
    let total = 0;
    const rows = [];
    for (const it of items) {
      if (!SIZES.includes(it.size)) throw Object.assign(new Error('size 22, 28 yoki 33 bo\'lishi kerak'), { status: 400 });
      if (!Number.isInteger(it.quantity) || it.quantity < 1) throw Object.assign(new Error('quantity >= 1 butun son'), { status: 400 });
      const pid = Number(it.product_id);
      const p = Number.isInteger(pid)
        ? (await client.query('SELECT id, price_22, price_28, price_33 FROM products WHERE id = $1', [pid])).rows[0]
        : undefined;
      if (!p) throw Object.assign(new Error(`product_id ${it.product_id} topilmadi`), { status: 400 });
      const price = p[`price_${it.size}`];
      total += price * it.quantity;
      rows.push([p.id, it.size, it.quantity, price]);
    }
    const o = (await client.query('INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING id', [req.user.id, total])).rows[0];
    for (const r of rows) {
      await client.query('INSERT INTO order_items (order_id, product_id, size, quantity, price) VALUES ($1, $2, $3, $4, $5)', [o.id, ...r]);
    }
    return o.id;
  });
  res.status(201).json(await getOrder(order));
}));

// Buyurtmalar va ularning tarkibi ikki so'rovda olinadi
async function loadOrders(where, ...args) {
  const orders = await all(
    `SELECT o.id, o.user_id, u.username, o.total, o.status, o.created_at
     FROM orders o JOIN users u ON u.id = o.user_id ${where} ORDER BY o.id DESC`, ...args);
  if (!orders.length) return orders;
  const items = await all(
    `SELECT oi.order_id, oi.product_id, p.name, oi.size, oi.quantity, oi.price
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ANY($1) ORDER BY oi.id`, orders.map((o) => o.id));
  for (const o of orders) o.items = [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  for (const { order_id, ...it } of items) byId.get(order_id).items.push(it);
  return orders;
}

const getOrder = async (id) => (await loadOrders('WHERE o.id = $1', id))[0] || null;

router.get('/orders/my', auth, wrap(async (req, res) => {
  res.json(await loadOrders('WHERE o.user_id = $1', req.user.id));
}));

router.get('/orders', auth, superAdmin, wrap(async (req, res) => {
  res.json(await loadOrders(''));
}));

router.patch('/orders/:id/status', auth, superAdmin, wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['new', 'preparing', 'delivered', 'cancelled'].includes(status)) return bad(res, 'status noto\'g\'ri');
  const r = await run('UPDATE orders SET status = $1 WHERE id = $2', status, req.params.id);
  if (!r.rowCount) return res.status(404).json({ error: 'Buyurtma topilmadi' });
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
    items: rows,
  });
}));

// ---------- LOGO ----------
router.get('/logo', wrap(async (req, res) => {
  const r = await get("SELECT value FROM settings WHERE key = 'logo'");
  res.json({ logo: r ? r.value : null });
}));

router.put('/logo', auth, superAdmin, wrap(async (req, res) => {
  const logo = req.body?.logo;
  if (typeof logo !== 'string' || !logo.trim()) return bad(res, 'logo (URL) majburiy');
  await run("INSERT INTO settings (key, value) VALUES ('logo', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    logo.trim());
  res.json({ logo: logo.trim() });
}));

router.delete('/logo', auth, superAdmin, wrap(async (req, res) => {
  await run("DELETE FROM settings WHERE key = 'logo'");
  res.status(204).end();
}));

// ---------- STATISTICS (super admin) ----------
router.get('/admin/stats', auth, superAdmin, wrap(async (req, res) => {
  const live = "status != 'cancelled'";
  const [totals, ordersByStatus, topProducts, salesBySize, salesByCategory, last7Days] = await Promise.all([
    get(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE role = 'user') AS users,
      (SELECT COUNT(*)::int FROM products) AS products,
      (SELECT COUNT(*)::int FROM categories) AS categories,
      (SELECT COUNT(*)::int FROM orders) AS orders,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE ${live}) AS revenue,
      (SELECT COALESCE(AVG(total),0) FROM orders WHERE ${live}) AS "averageOrder"`),
    all('SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status'),
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
  res.json({ totals, ordersByStatus, topProducts, salesBySize, salesByCategory, last7Days });
}));

module.exports = router;
