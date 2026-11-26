import { Hono } from 'hono';
import type { Env } from './env';
import { HttpError } from './http';
import { authenticate, authenticateConsumer, type Identity, type Principal } from './auth';
import { availableNanos } from './store';
import { publicRoutes } from './routes/public';
import { pricingRoutes } from './routes/pricing';
import { accountRoutes } from './routes/account';
import { providerRoutes } from './routes/providers';
import { consumerRoutes } from './routes/consumers';
import { modelCatalogRoutes } from './routes/model-catalog';
import { modelRoutes } from './routes/models';
import { relayRoutes } from './routes/relay';

/**
 * 两个面各放一份身份：管理面是 `Identity`（地址 + 幂等键），转发面是 `Principal`
 * （地址 + 哪把下游 Token）。两者刻意不相互继承——转发面没有 nonce 可言。
 */
type Variables = { principal: Identity | Principal };
type App = { Bindings: Env; Variables: Variables };

const app = new Hono<App>();

app.route('/api/v1', publicRoutes);
// 价目表：账本要能被用户自己核算，所以它就是公开数据。
app.route('/api/v1/pricing', pricingRoutes);

/**
 * 登录只是「签名走通一次」：地址首次出现时由 authenticate 自动开户。
 *
 * 这条 POST 不需要幂等键，因为开户是行内幂等的：`principals` 的主键就是地址，
 * 授信那一条用 `WHERE voucher_nanos = 0` 兜住。重放既不会开出第二个账户，也不会
 * 再发一张券——`created` 只在这一**次**真的建了行时才是 true。
 */
app.post('/api/v1/auth/login', async (c) => {
  const principal = await authenticate(c.req.raw, c.env);
  // 余额不落库：它就是四块累计数的一个算式，接口现算。
  const row = await c.env.DB.prepare(
    'SELECT recharge_nanos, voucher_nanos, spend_nanos, withdraw_nanos, created_at FROM principals WHERE address = ?',
  )
    .bind(principal.address)
    .first<{ recharge_nanos: number; voucher_nanos: number; spend_nanos: number; withdraw_nanos: number; created_at: number }>();
  return c.json({
    address: principal.address,
    balance_nanos: row ? availableNanos(row) : 0,
    // 四块累计数一起回：开户给的是一张券，不是充值，这一点不该等翻流水才知道。
    recharge_nanos: row?.recharge_nanos ?? 0,
    voucher_nanos: row?.voucher_nanos ?? 0,
    spend_nanos: row?.spend_nanos ?? 0,
    withdraw_nanos: row?.withdraw_nanos ?? 0,
    created: principal.opened,
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
  // 模型总表：账户现在到底能调哪些模型，由管理面回答（不带下游 Token）。
  signed.route('/models', modelCatalogRoutes);
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
