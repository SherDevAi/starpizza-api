const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  max: Number(process.env.PG_POOL_MAX) || 5,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','superadmin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER NOT NULL REFERENCES categories(id),
  price_22 DOUBLE PRECISION NOT NULL,
  price_28 DOUBLE PRECISION NOT NULL,
  price_33 DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','delivered','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  size INTEGER NOT NULL CHECK (size IN (22,28,33)),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
`;

async function init() {
  await pool.query(SCHEMA);
  // Birinchi ishga tushirishda super admin yaratiladi
  await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'superadmin')
     ON CONFLICT (username) DO NOTHING`,
    [process.env.ADMIN_USERNAME || 'admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10)]
  );
}

// Serverless (Vercel) uchun: sxema birinchi so'rovda bir marta yaratiladi
let initPromise;
const ready = () => (initPromise ??= init().catch((e) => { initPromise = undefined; throw e; }));

const all = async (sql, ...args) => (await pool.query(sql, args)).rows;
const get = async (sql, ...args) => (await pool.query(sql, args)).rows[0];
const run = (sql, ...args) => pool.query(sql, args);

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, ready, all, get, run, transaction };
