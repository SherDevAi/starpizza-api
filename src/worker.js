// Ishchi (yetkazib beruvchi) paneli: filial buyurtmalarini oladi, yetkazadi va o'z statistikasini ko'radi.
// Oqim: new/preparing (bo'sh) --accept--> delivering --deliver--> delivered
//                                         delivering --release--> preparing (boshqa ishchi olishi uchun)
const express = require('express');
const { all, get, run } = require('./db');
const { auth, requireRole, wrap } = require('./middleware');
const { notFound, getOrder, listOrders } = require('./helpers');

const router = express.Router();
router.use(auth, requireRole('worker'));

/**
 * scope=available — filialdagi hali hech kim olmagan buyurtmalar (standart)
 * scope=mine      — menga biriktirilgan buyurtmalar (status bilan filtrlash mumkin)
 */
router.get('/orders', wrap(async (req, res) => {
  const { branch_id: branchId, id } = req.user;
  if (req.query.scope === 'mine')
    return res.json(await listOrders({ worker_id: id, status: req.query.status }, req.query.limit));
  res.json(await listOrders({ branch_id: branchId, worker_id: 'none', status: ['new', 'preparing'] }, req.query.limit));
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const o = await get('SELECT worker_id FROM orders WHERE id = $1 AND branch_id = $2', req.params.id, req.user.branch_id);
  // Boshqa ishchining buyurtmasini ko'rsatmaymiz
  if (!o || (o.worker_id && o.worker_id !== req.user.id)) return notFound(res, 'Buyurtma topilmadi');
  res.json(await getOrder(req.params.id));
}));

// Atomik o'zgartirish: shart bajarilmasa (masalan, boshqa ishchi allaqachon olgan) — 409
async function transition(req, res, sql, args, conflictMsg) {
  const exists = await get('SELECT id FROM orders WHERE id = $1 AND branch_id = $2', req.params.id, req.user.branch_id);
  if (!exists) return notFound(res, 'Buyurtma topilmadi');
  const r = await run(sql, ...args);
  if (!r.rowCount) return res.status(409).json({ error: conflictMsg });
  res.json(await getOrder(req.params.id));
}

// Buyurtmani olish (yetkazishga)
router.post('/orders/:id/accept', wrap((req, res) =>
  transition(req, res,
    `UPDATE orders SET worker_id = $1, status = 'delivering', accepted_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND branch_id = $3 AND worker_id IS NULL AND status IN ('new','preparing')`,
    [req.user.id, req.params.id, req.user.branch_id],
    'Buyurtmani olib bo\'lmaydi: boshqa ishchi olgan yoki holati mos emas')));

// Yetkazildi deb belgilash
router.post('/orders/:id/deliver', wrap((req, res) =>
  transition(req, res,
    `UPDATE orders SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND worker_id = $2 AND status = 'delivering'`,
    [req.params.id, req.user.id],
    'Faqat o\'zingiz yetkazayotgan ("delivering") buyurtmani yakunlash mumkin')));

// Buyurtmadan voz kechish — qayta navbatga qaytadi
router.post('/orders/:id/release', wrap((req, res) =>
  transition(req, res,
    `UPDATE orders SET status = 'preparing', worker_id = NULL, accepted_at = NULL
     WHERE id = $1 AND worker_id = $2 AND status = 'delivering'`,
    [req.params.id, req.user.id],
    'Faqat o\'zingiz yetkazayotgan buyurtmadan voz kechish mumkin')));

// Mening statistikam
router.get('/stats', wrap(async (req, res) => {
  const { id, branch_id: branchId } = req.user;
  const [me, last7Days, branch] = await Promise.all([
    get(
      `SELECT COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              COUNT(*) FILTER (WHERE status = 'delivering')::int AS delivering,
              COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= CURRENT_DATE)::int AS "deliveredToday",
              COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= CURRENT_DATE - 6)::int AS "deliveredLast7Days",
              COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0) AS "deliveredRevenue",
              AVG(CASE WHEN status = 'delivered' AND accepted_at IS NOT NULL THEN EXTRACT(EPOCH FROM (delivered_at - accepted_at)) / 60.0 END) AS "avgDeliveryMinutes"
       FROM orders WHERE worker_id = $1`, id),
    all(
      `SELECT delivered_at::date::text AS date, COUNT(*)::int AS delivered, COALESCE(SUM(total), 0) AS revenue
       FROM orders WHERE worker_id = $1 AND status = 'delivered' AND delivered_at >= CURRENT_DATE - 6
       GROUP BY delivered_at::date ORDER BY delivered_at::date`, id),
    get(
      `SELECT COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS "ordersToday",
              COUNT(*) FILTER (WHERE status IN ('new','preparing') AND worker_id IS NULL)::int AS waiting,
              COUNT(*) FILTER (WHERE status = 'delivering')::int AS delivering
       FROM orders WHERE branch_id = $1`, branchId),
  ]);
  res.json({ me, last7Days, branch });
}));

module.exports = router;
