// Filiallarni boshqarish — superadmin. Ro'yxat esa hamma uchun ochiq (mijoz filial tanlaydi).
const express = require('express');
const { all, get, run, transaction } = require('./db');
const { auth, superAdmin, wrap } = require('./middleware');
const { bad, notFound, toBool, str, readNewUser, insertUser, updateStaff } = require('./helpers');

const router = express.Router();

const BRANCH_SELECT = `
  SELECT b.id, b.name, b.address, b.phone, b.active, b.created_at,
         (SELECT COUNT(*)::int FROM users w WHERE w.branch_id = b.id AND w.role = 'worker' AND w.active = TRUE) AS workers,
         (SELECT COUNT(*)::int FROM products p WHERE p.branch_id = b.id) AS products
  FROM branches b`;

const branchAdmins = (id) =>
  all("SELECT id, username, full_name, phone, active FROM users WHERE branch_id = $1 AND role = 'branch_admin' ORDER BY id", id);

async function fullBranch(id) {
  const b = await get(`${BRANCH_SELECT} WHERE b.id = $1`, id);
  return b && { ...b, active: !!b.active, admins: await branchAdmins(id) };
}

// Ochiq: faol filiallar ro'yxati (mijozlar uchun)
router.get('/branches', wrap(async (req, res) => {
  res.json(await all('SELECT id, name, address, phone FROM branches WHERE active = TRUE ORDER BY name'));
}));

// Superadmin: barcha filiallar (faol bo'lmaganlari ham), adminlari bilan
router.get('/branches/all', auth, superAdmin, wrap(async (req, res) => {
  const [rows, admins] = await Promise.all([
    all(`${BRANCH_SELECT} ORDER BY b.id`),
    all("SELECT id, branch_id, username, full_name, phone, active FROM users WHERE role = 'branch_admin' ORDER BY id"),
  ]);
  const byBranch = new Map();
  for (const { branch_id, ...a } of admins) {
    if (!byBranch.has(branch_id)) byBranch.set(branch_id, []);
    byBranch.get(branch_id).push(a);
  }
  res.json(rows.map((b) => ({ ...b, active: !!b.active, admins: byBranch.get(b.id) || [] })));
}));

router.get('/branches/:id', auth, superAdmin, wrap(async (req, res) => {
  const b = await fullBranch(req.params.id);
  if (!b) return notFound(res, 'Filial topilmadi');
  res.json(b);
}));

/**
 * Filial yaratish. Ixtiyoriy "admin": { username, password, full_name, phone } —
 * shu bilan birga filial admini hisobi ham yaratiladi.
 */
router.post('/branches', auth, superAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  if (!name) return bad(res, 'name majburiy');
  if (await get('SELECT id FROM branches WHERE name = $1', name))
    return res.status(409).json({ error: 'Bunday nomli filial bor' });
  let admin;
  if (b.admin) {
    admin = await readNewUser(b.admin);
    if (admin.error) return res.status(admin.status || 400).json({ error: `admin: ${admin.error}` });
  }
  const id = await transaction(async (client) => {
    const r = await client.query(
      'INSERT INTO branches (name, address, phone) VALUES ($1, $2, $3) RETURNING id',
      [name, str(b.address), str(b.phone)]
    );
    const branchId = r.rows[0].id;
    if (admin) await insertUser(admin.data, 'branch_admin', branchId, client);
    return branchId;
  });
  res.status(201).json(await fullBranch(id));
}));

router.put('/branches/:id', auth, superAdmin, wrap(async (req, res) => {
  if (!(await get('SELECT id FROM branches WHERE id = $1', req.params.id))) return notFound(res, 'Filial topilmadi');
  const b = req.body || {};
  const set = {};
  if (b.name !== undefined) {
    set.name = str(b.name);
    if (!set.name) return bad(res, 'name bo\'sh bo\'lmasligi kerak');
    if (await get('SELECT id FROM branches WHERE name = $1 AND id != $2', set.name, req.params.id))
      return res.status(409).json({ error: 'Bunday nomli filial bor' });
  }
  if (b.address !== undefined) set.address = str(b.address);
  if (b.phone !== undefined) set.phone = str(b.phone);
  if (b.active !== undefined) {
    const active = toBool(b.active);
    if (active === undefined) return bad(res, 'active true/false bo\'lishi kerak');
    set.active = active;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await run(
      `UPDATE branches SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
      ...keys.map((k) => set[k]), req.params.id
    );
  }
  res.json(await fullBranch(req.params.id));
}));

// Bo'sh filialni o'chiradi. Buyurtma/mahsulot/xodimi bor filialni o'chirib bo'lmaydi — active=false qiling.
router.delete('/branches/:id', auth, superAdmin, wrap(async (req, res) => {
  const id = req.params.id;
  if (!(await get('SELECT id FROM branches WHERE id = $1', id))) return notFound(res, 'Filial topilmadi');
  const used =
    (await get('SELECT 1 FROM orders WHERE branch_id = $1 LIMIT 1', id)) ||
    (await get('SELECT 1 FROM products WHERE branch_id = $1 LIMIT 1', id)) ||
    (await get('SELECT 1 FROM users WHERE branch_id = $1 LIMIT 1', id));
  if (used)
    return res.status(409).json({ error: 'Filialda buyurtma, mahsulot yoki xodim bor. O\'chirish o\'rniga PUT bilan active=false qiling' });
  await run('DELETE FROM branches WHERE id = $1', id);
  res.status(204).end();
}));

// Filialga qo'shimcha admin qo'shish
router.post('/branches/:id/admins', auth, superAdmin, wrap(async (req, res) => {
  if (!(await get('SELECT id FROM branches WHERE id = $1', req.params.id))) return notFound(res, 'Filial topilmadi');
  const u = await readNewUser(req.body);
  if (u.error) return res.status(u.status || 400).json({ error: u.error });
  res.status(201).json(await insertUser(u.data, 'branch_admin', Number(req.params.id)));
}));

// Filial adminini bloklash/ochish yoki parolini almashtirish
router.put('/branches/:id/admins/:userId', auth, superAdmin, wrap(async (req, res) => {
  const u = await get(
    "SELECT id FROM users WHERE id = $1 AND branch_id = $2 AND role = 'branch_admin'",
    req.params.userId, req.params.id
  );
  if (!u) return notFound(res, 'Filial admini topilmadi');
  await updateStaff(u.id, req.body);
  res.json(await get('SELECT id, username, full_name, phone, active FROM users WHERE id = $1', u.id));
}));

module.exports = router;
