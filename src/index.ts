import { Hono } from 'hono';
import type { Env } from './env';
import { HttpError } from './http';
import { authenticate, type Principal } from './auth';
import { nowSeconds } from './ids';
import { publicRoutes } from './routes/public';
import { accountRoutes } from './routes/account';
import { credentialRoutes } from './routes/credentials';
import { relayRoutes } from './routes/relay';

type Variables = { principal: Principal };
type App = { Bindings: Env; Variables: Variables };

const app = new Hono<App>();

app.route('/api/v1', publicRoutes);

/** 登录只是「签名走通一次」：地址首次出现时由 authenticate 自动开户。 */
app.post('/api/v1/auth/login', async (c) => {
  const principal = await authenticate(c.req.raw, c.env);
  const row = await c.env.DB.prepare('SELECT balance_micros, created_at FROM principals WHERE address = ?')
    .bind(principal.address)
    .first<{ balance_micros: number; created_at: number }>();
  return c.json({
    address: principal.address,
    balance_micros: row?.balance_micros ?? 0,
    created: (row?.created_at ?? 0) >= nowSeconds() - 5,
  });
});

/**
 * 签名是这一族的唯一入口：用一个子应用承载全部受保护路由，
 * `/v1/*` 与 `/api/v1/*` 共用同一份鉴权与同一份处理器，避免出现"某条路径忘了验签"的分支。
 */
function protectedApp() {
  const signed = new Hono<App>();
  signed.use('*', async (c, next) => {
    c.set('principal', await authenticate(c.req.raw, c.env));
    await next();
  });
  signed.route('/account', accountRoutes);
  signed.route('/credentials', credentialRoutes);
  // relay 自己的路径就是完整的 `/chat/completions` 与 `/responses`，
  // 所以挂在根上：`/v1/chat/completions`、`/v1/responses`。
  signed.route('/', relayRoutes);
  return signed;
}

app.route('/api/v1', protectedApp());

/** OpenAI 兼容入口：`/v1/chat/completions` 直接落在 relayRoutes 的 `/chat/completions` 上。 */
app.route('/v1', protectedApp());

app.notFound((c) => c.json({ error: 'not_found', message: `没有这个接口：${new URL(c.req.url).pathname}` }, 404));

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: error.code, message: error.message }, error.status as 400);
  }
  console.error('norm error', error);
  return c.json({ error: 'internal_error', message: '服务内部错误' }, 500);
});

/** 静态资源与 SPA：Hash Router，所以只有 / 真正需要 index.html。 */
app.all('*', async (c) => {
  const { pathname } = new URL(c.req.url);
  if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
    return c.json({ error: 'not_found', message: `没有这个接口：${pathname}` }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
