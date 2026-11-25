import { Hono } from 'hono';
import type { Env } from './env';
import { HttpError } from './http';
import { authenticate, authenticateConsumer, type Identity, type Principal } from './auth';
import { nowSeconds } from './ids';
import { publicRoutes } from './routes/public';
import { pricingRoutes } from './routes/pricing';
import { accountRoutes } from './routes/account';
import { providerRoutes } from './routes/providers';
import { consumerRoutes } from './routes/consumers';
import { modelRoutes } from './routes/models';
import { relayRoutes } from './routes/relay';

type Variables = { principal: Identity };
type App = { Bindings: Env; Variables: Variables };

const app = new Hono<App>();

app.route('/api/v1', publicRoutes);
// 价目表：账本要能被用户自己核算，所以它就是公开数据。
app.route('/api/v1/pricing', pricingRoutes);

/** 登录只是「签名走通一次」：地址首次出现时由 authenticate 自动开户。 */
app.post('/api/v1/auth/login', async (c) => {
  const principal = await authenticate(c.req.raw, c.env);
  const row = await c.env.DB.prepare('SELECT balance_nanos, created_at FROM principals WHERE address = ?')
    .bind(principal.address)
    .first<{ balance_nanos: number; created_at: number }>();
  return c.json({
    address: principal.address,
    balance_nanos: row?.balance_nanos ?? 0,
    created: (row?.created_at ?? 0) >= nowSeconds() - 5,
  });
});

/**
 * 管理面 `/api/v1/*`：只接受 Ed25519 签名。
 *
 * 账户、上游提供商、消费者密钥都是「浏览器里的人在操作」，所以一把下游密钥不该能
 * 凭空再铸一把下游密钥，也不该能撤销别人的上游提供商。
 */
function signedOnly() {
  const signed = new Hono<App>();
  signed.use('*', async (c, next) => {
    c.set('principal', await authenticate(c.req.raw, c.env));
    await next();
  });
  signed.route('/account', accountRoutes);
  signed.route('/providers', providerRoutes);
  signed.route('/consumers', consumerRoutes);
  return signed;
}

/**
 * 转发面 `/v1/*`：只接受下游消费者 Token（`sk-norm-…`），没有任何签名入口。
 *
 * 两条入口用前缀划开，而不是在同一前缀上再按路径分流——那样两个 `/*` 中间件
 * 会互相抢同一个请求，谁先跑取决于注册顺序，而这种顺序没人看得出来。
 *
 * relay 自己的路径就是完整的 `/chat/completions`，挂在根上，
 * 于是 `/v1/chat/completions` 直接落在 relayRoutes 上。
 *
 * 模型清单（`/v1/models`）挂在这里而不是管理面：它要用上游密钥，而密钥服务端才有。
 * 它不扣费，只回答「这个上游有哪些模型」。
 */
function relayOnly() {
  const relay = new Hono<App>();
  relay.use('*', async (c, next) => {
    c.set('principal', await authenticateConsumer(c.req.raw, c.env));
    await next();
  });
  relay.route('/models', modelRoutes);
  relay.route('/', relayRoutes);
  return relay;
}

app.route('/api/v1', signedOnly());
app.route('/v1', relayOnly());

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
