const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  max: Number(process.env.PG_POOL_MAX) || 5,
});

const ROLES = ['user', 'superadmin', 'branch_admin', 'worker'];
const ORDER_STATUSES = ['new', 'preparing', 'delivering', 'delivered', 'cancelled'];
const list = (arr) => arr.map((v) => `'${v}'`).join(',');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN (${list(ROLES)})),
  branch_id INTEGER REFERENCES branches(id),
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
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
  branch_id INTEGER REFERENCES branches(id),
  price_22 DOUBLE PRECISION NOT NULL,
  price_28 DOUBLE PRECISION NOT NULL,
  price_33 DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  branch_id INTEGER REFERENCES branches(id),
  worker_id INTEGER REFERENCES users(id),
  total DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(ORDER_STATUSES)})),
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
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
`;

// Eski (v1) PostgreSQL bazasini yangi (v2: filiallar va ishchilar) sxemasiga xavfsiz o'tkazish
const MIGRATE = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE products ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS worker_id INTEGER REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

DO $$
DECLARE c_name text;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%role%';
  IF c_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%branch_admin%'
  ) THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c_name);
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (${list(ROLES)}));
  END IF;

  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%';
  IF c_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%delivering%'
  ) THEN
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c_name);
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (${list(ORDER_STATUSES)}));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id, role);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_branch ON products(branch_id);
CREATE INDEX IF NOT EXISTS idx_orders_branch ON orders(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_worker ON orders(worker_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
`;

async function init() {
  await pool.query(SCHEMA);
  await pool.query(MIGRATE);
  // Birinchi ishga tushirishda super admin yaratiladi (yoki env bilan sinxronlanadi)
  await pool.query(
    `INSERT INTO users (username, password_hash, role, active) VALUES ($1, $2, 'superadmin', TRUE)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'superadmin', active = TRUE`,
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

module.exports = { pool, ready, all, get, run, transaction, ROLES, ORDER_STATUSES };
