// Filial admini paneli: o'z filialining ishchilari, buyurtmalari va statistikasi.
// Ovqatlar (mahsulotlar) umumiy /api/products orqali yaratiladi — filial admini uchun branch_id avtomatik qo'yiladi.
const express = require('express');
const { all, get, run } = require('./db');
const { auth, requireRole, wrap } = require('./middleware');
const { bad, notFound, readNewUser, insertUser, updateStaff, getOrder, listOrders } = require('./helpers');

const router = express.Router();
router.use(auth, requireRole('branch_admin'));

const MINUTES = 'EXTRACT(EPOCH FROM (delivered_at - accepted_at)) / 60.0';

router.get('/', wrap(async (req, res) => {
  const b = await get('SELECT id, name, address, phone, created_at FROM branches WHERE id = $1', req.user.branch_id);
  const [workers, products] = await Promise.all([
    get("SELECT COUNT(*)::int AS n FROM users WHERE branch_id = $1 AND role = 'worker' AND active = TRUE", b.id),
    get('SELECT COUNT(*)::int AS n FROM products WHERE branch_id = $1', b.id),
  ]);
  res.json({ ...b, workers: workers.n, products: products.n });
}));

// ---------- Ishchilar ----------
const WORKER_COLS = 'id, username, full_name, phone, active, created_at';
const findWorker = (req) =>
  get(`SELECT ${WORKER_COLS} FROM users WHERE id = $1 AND branch_id = $2 AND role = 'worker'`, req.params.id, req.user.branch_id);

router.get('/workers', wrap(async (req, res) => {
  const rows = await all(
    `SELECT u.id, u.username, u.full_name, u.phone, u.active, u.created_at,
            COUNT(o.id) FILTER (WHERE o.status = 'delivering')::int AS delivering,
            COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered
     FROM users u LEFT JOIN orders o ON o.worker_id = u.id
     WHERE u.branch_id = $1 AND u.role = 'worker'
     GROUP BY u.id ORDER BY u.active DESC, u.full_name, u.username`,
    req.user.branch_id
  );
  res.json(rows.map((r) => ({ ...r, active: !!r.active })));
}));

router.post('/workers', wrap(async (req, res) => {
  const u = await readNewUser(req.body);
  if (u.error) return res.status(u.status || 400).json({ error: u.error });
  res.status(201).json(await insertUser(u.data, 'worker', req.user.branch_id));
}));

// full_name, phone, password, active (bloklash/ochish)
router.put('/workers/:id', wrap(async (req, res) => {
  const w = await findWorker(req);
  if (!w) return notFound(res, 'Ishchi topilmadi');
  res.json(await updateStaff(w.id, req.body));
}));

// Buyurtmasi bo'lmagan ishchini butunlay o'chiradi; bo'lsa — active=false qilish kerak (statistika saqlanadi)
router.delete('/workers/:id', wrap(async (req, res) => {
  const w = await findWorker(req);
  if (!w) return notFound(res, 'Ishchi topilmadi');
  if (await get('SELECT 1 FROM orders WHERE worker_id = $1 LIMIT 1', w.id))
    return res.status(409).json({ error: 'Ishchining buyurtmalari bor. O\'chirish o\'rniga PUT bilan active=false qiling' });
  await run('DELETE FROM users WHERE id = $1', w.id);
  res.status(204).end();
}));

// ---------- Buyurtmalar ----------
const findOrder = (req) => get('SELECT * FROM orders WHERE id = $1 AND branch_id = $2', req.params.id, req.user.branch_id);
const FINAL = ['delivered', 'cancelled'];

router.get('/orders', wrap(async (req, res) => {
  res.json(await listOrders({ branch_id: req.user.branch_id, status: req.query.status, worker_id: req.query.worker_id }, req.query.limit));
}));

router.get('/orders/:id', wrap(async (req, res) => {
  if (!(await findOrder(req))) return notFound(res, 'Buyurtma topilmadi');
  res.json(await getOrder(req.params.id));
}));

/**
 * Holatni o'zgartirish: new | preparing | delivered | cancelled.
 * "delivering" — faqat ishchi olganda yoki /assign orqali. new/preparing ga qaytarilsa ishchi bo'shatiladi.
 */
router.patch('/orders/:id/status', wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['new', 'preparing', 'delivered', 'cancelled'].includes(status))
    return bad(res, 'status: new, preparing, delivered yoki cancelled (ishchiga berish uchun /assign)');
  const o = await findOrder(req);
  if (!o) return notFound(res, 'Buyurtma topilmadi');
  if (FINAL.includes(o.status)) return res.status(409).json({ error: `Buyurtma allaqachon "${o.status}"` });
  if (status === 'delivered' && !o.worker_id) return bad(res, 'Avval buyurtmani ishchiga bering (/assign)');
  if (['new', 'preparing'].includes(status)) {
    await run('UPDATE orders SET status = $1, worker_id = NULL, accepted_at = NULL WHERE id = $2', status, o.id);
  } else {
    await run(
      `UPDATE orders SET status = $1, delivered_at = CASE WHEN $1 = 'delivered' THEN COALESCE(delivered_at, CURRENT_TIMESTAMP) ELSE delivered_at END WHERE id = $2`,
      status, o.id
    );
  }
  res.json(await getOrder(o.id));
}));

// Buyurtmani ishchiga biriktirish (holat "delivering" bo'ladi)
router.patch('/orders/:id/assign', wrap(async (req, res) => {
  const o = await findOrder(req);
  if (!o) return notFound(res, 'Buyurtma topilmadi');
  if (FINAL.includes(o.status)) return res.status(409).json({ error: `Buyurtma allaqachon "${o.status}"` });
  const w = await get(
    "SELECT id FROM users WHERE id = $1 AND branch_id = $2 AND role = 'worker' AND active = TRUE",
    req.body?.worker_id, req.user.branch_id
  );
  if (!w) return bad(res, 'worker_id: shu filialning faol ishchisi bo\'lishi kerak');
  await run("UPDATE orders SET worker_id = $1, status = 'delivering', accepted_at = CURRENT_TIMESTAMP WHERE id = $2", w.id, o.id);
  res.json(await getOrder(o.id));
}));

// ---------- Statistika ----------
router.get('/stats', wrap(async (req, res) => {
  const id = req.user.branch_id;
  const [totals, today, ordersByStatus, last7Days, workers, topProducts] = await Promise.all([
    get(
      `SELECT COUNT(*)::int AS orders,
              COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE status IN ('new','preparing') AND worker_id IS NULL)::int AS waiting,
              COUNT(*) FILTER (WHERE status = 'delivering')::int AS delivering,
              COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) AS revenue,
              COALESCE(AVG(total) FILTER (WHERE status != 'cancelled'), 0) AS "averageOrder",
              AVG(CASE WHEN status = 'delivered' AND accepted_at IS NOT NULL THEN ${MINUTES} END) AS "avgDeliveryMinutes"
       FROM orders WHERE branch_id = $1`, id),
    get(
      `SELECT COUNT(*)::int AS orders,
              COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) AS revenue
       FROM orders WHERE branch_id = $1 AND created_at >= CURRENT_DATE`, id),
    all('SELECT status, COUNT(*)::int AS count FROM orders WHERE branch_id = $1 GROUP BY status', id),
    all(
      `SELECT created_at::date::text AS date, COUNT(*)::int AS orders,
              COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) AS revenue
       FROM orders WHERE branch_id = $1 AND created_at >= CURRENT_DATE - 6
       GROUP BY created_at::date ORDER BY created_at::date`, id),
    all(
      `SELECT u.id, u.username, u.full_name, u.active,
              COUNT(o.id) FILTER (WHERE o.status = 'delivering')::int AS delivering,
              COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered,
              COUNT(o.id) FILTER (WHERE o.status = 'delivered' AND o.delivered_at >= CURRENT_DATE)::int AS "deliveredToday",
              COALESCE(SUM(o.total) FILTER (WHERE o.status = 'delivered'), 0) AS "deliveredRevenue",
              AVG(CASE WHEN o.status = 'delivered' AND o.accepted_at IS NOT NULL THEN EXTRACT(EPOCH FROM (o.delivered_at - o.accepted_at)) / 60.0 END) AS "avgDeliveryMinutes"
       FROM users u LEFT JOIN orders o ON o.worker_id = u.id
       WHERE u.branch_id = $1 AND u.role = 'worker'
       GROUP BY u.id ORDER BY delivered DESC`, id),
    all(
      `SELECT p.id, p.name, SUM(oi.quantity)::int AS sold, SUM(oi.quantity * oi.price) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
       WHERE o.branch_id = $1 AND o.status != 'cancelled' GROUP BY p.id ORDER BY sold DESC LIMIT 5`, id),
  ]);
  res.json({
    totals,
    today,
    ordersByStatus,
    last7Days,
    workers: workers.map((w) => ({ ...w, active: !!w.active })),
    topProducts,
  });
}));

module.exports = router;
