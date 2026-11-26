const jwt = require('jsonwebtoken');
const { get } = require('./db');

// Standart (ochiq) kalit yo'q: JWT_SECRET o'rnatilmasa, token berilmaydi va qabul qilinmaydi
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const noSecret = () => Object.assign(new Error('JWT_SECRET muhit o‘zgaruvchisi o‘rnatilmagan'), { status: 500 });

const signToken = (user) => {
  if (!JWT_SECRET) throw noSecret();
  return jwt.sign({ id: user.id, username: user.username, role: user.role, branch_id: user.branch_id ?? null }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });
};

function auth(req, res, next) {
  if (!JWT_SECRET) return res.status(500).json({ error: noSecret().message });
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Token talab qilinadi' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token yaroqsiz yoki muddati tugagan' });
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Rolni tokendan emas, bazadan tekshiradi: o'chirilgan/bloklangan ishchi yoki filial
 * eski tokeni bilan kira olmaydi. req.user yangilangan ma'lumot bilan almashtiriladi.
 */
const requireRole = (...roles) => wrap(async (req, res, next) => {
  const u = await get(
    `SELECT u.id, u.username, u.role, u.branch_id, u.active, b.active AS branch_active
     FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.id = $1`,
    req.user?.id
  );
  if (!u || !u.active) return res.status(401).json({ error: 'Hisob topilmadi yoki bloklangan' });
  if (!roles.includes(u.role)) return res.status(403).json({ error: 'Bu amal uchun ruxsat yo\'q' });
  if (['branch_admin', 'worker'].includes(u.role) && !u.branch_active)
    return res.status(403).json({ error: 'Filial faol emas' });
  req.user = { id: u.id, username: u.username, role: u.role, branch_id: u.branch_id };
  next();
});

const superAdmin = requireRole('superadmin');

module.exports = { signToken, auth, requireRole, superAdmin, wrap };
