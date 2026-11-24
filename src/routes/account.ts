import { Hono } from 'hono';
import type { Env } from '../env';
import type { Principal } from '../auth';
import { findPrincipal, listCredentials } from '../store';

export const accountRoutes = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

accountRoutes.get('/me', async (c) => {
  const principal = await findPrincipal(c.env, c.get('principal').address);
  const credentials = await listCredentials(c.env, principal.address);
  const requests = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE address = ?')
    .bind(principal.address)
    .first<{ n: number }>();
  return c.json({
    address: principal.address,
    label: principal.label,
    balance_micros: principal.balance_micros,
    granted_micros: principal.granted_micros,
    spend_micros: principal.spend_micros,
    requests: requests?.n ?? 0,
    credentials: credentials.length,
    created_at: principal.created_at,
  });
});

accountRoutes.get('/usage', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM requests WHERE address = ? ORDER BY created_at DESC LIMIT ?',
  )
    .bind(c.get('principal').address, limit)
    .all();
  return c.json({ items: results });
});

accountRoutes.get('/ledger', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM ledger WHERE address = ? ORDER BY created_at DESC LIMIT ?',
  )
    .bind(c.get('principal').address, limit)
    .all();
  return c.json({ items: results });
});
