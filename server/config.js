import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/**
 * Minimal .env loader. Node 20.6+ supports --env-file, but loading here keeps
 * `npm start` working without extra flags and never overrides real env vars.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const bool = (value, fallback) => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';
const jwtSecret = process.env.JWT_SECRET || (isProduction ? '' : 'development-only-insecure-secret');

if (isProduction && (!jwtSecret || jwtSecret === 'change-me-to-a-long-random-string')) {
  throw new Error('JWT_SECRET must be set to a strong unique value when NODE_ENV=production');
}

const databasePath = process.env.DATABASE_PATH || './data/test-generator.db';

export const config = {
  env,
  isProduction,
  port: int(process.env.PORT, 4000),
  databasePath: databasePath === ':memory:' ? ':memory:' : path.resolve(ROOT, databasePath),
  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    cookieName: 'dtg_token',
    cookieSecure: bool(process.env.COOKIE_SECURE, isProduction),
  },
  bootstrapAdmin: {
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'Admin@12345',
    name: process.env.ADMIN_NAME || 'System Administrator',
  },
  selection: {
    poolThreshold: int(process.env.SELECTION_POOL_THRESHOLD, 20000),
  },
  maxPageSize: int(process.env.MAX_PAGE_SIZE, 200),
  clientDist: path.join(ROOT, 'client', 'dist'),
};

export default config;
