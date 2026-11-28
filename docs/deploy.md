# 部署

Norm 只有一个可部署物：一个 Cloudflare Worker（内含前端静态产物）加一个 D1。

## 一次性准备

```bash
pnpm install
pnpm exec wrangler d1 create norm   # 把返回的 database_id 填进 wrangler.jsonc
```

`wrangler.jsonc` 里 `routes` 已经钉好 `norm.ntnl.io`（`custom_domain: true`），
Cloudflare 会自动建好 DNS 记录与证书，不需要另外去 `flarectl` 加 CNAME。

## 持续部署（CI）

`main` 的每次合并由 `.github/workflows/release.yml` 上线，需要仓库里有两个 secret：

```bash
# 最小权限 token：Workers Scripts:Edit / Workers Routes:Edit / D1:Edit / Account Settings:Read
gh secret set CLOUDFLARE_API_TOKEN -R No-Trade-No-Life/norm
gh secret set CLOUDFLARE_ACCOUNT_ID -R No-Trade-No-Life/norm   # b831a34938a75457b5029d31cea13c25
```

缺这两个 secret 时 release 会**红**，而不是静默跳过——一次没上线的合并不该看起来像上线了。

还有一个 Worker secret 必须单独设置（它不是仓库 secret，是 Worker 的运行期密钥）：

```bash
# 32 字节 base64url。缺失时上游提供商创建与转发都会 500，所以它是最先要配的东西。
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | pnpm exec wrangler secret put NORM_MASTER_KEY --config wrangler.jsonc
```

本地开发把它写进 `.dev.vars`（已在 `.gitignore` 里）。轮换它等于让所有现有上游提供商密钥失效：
旧密文解不开，必须重录上游提供商或先跑一次重封迁移。

## 发布流程（CI 与本地一致）

1. `pnpm exec wrangler d1 migrations apply norm --remote` —— 先迁移，再上传代码
2. `pnpm build` —— 前端产物进 `dist/`
3. `pnpm attest` —— 算 `source_sha256`（`src/` 全量）与 `assets_sha256`（`dist/` 全量）
4. `wrangler deploy --var ATTEST_*:…` —— 把哈希作为 Worker 变量一起发布
5. `curl /api/v1/attestation` 自校验线上哈希与本次构建一致

没有 CI 凭据时，本地一条命令做同样的事（用的是本机 `wrangler login` 的 OAuth 凭据）：

```bash
pnpm release
```

## 可信发布怎么被验证

```bash
git clone https://github.com/No-Trade-No-Life/norm && cd norm
pnpm install && pnpm build && pnpm attest
# 把 source_sha256 / assets_sha256 与 https://norm.ntnl.io/api/v1/attestation 对照
```

哈希覆盖的是「相对路径 + 内容」的全量拼接，所以删文件、加文件、改内容都会变。
Workers 运行时本身由 Cloudflare 托管——这一层不在自证范围内，Norm 能证明的是
「我上传的字节等于这个 commit 构建出来的字节」。

## 冒烟

```bash
node scripts/e2e.mjs          # 本地：假上游提供商 + 真身份 + 本地 Worker，含消费者密钥用例
node scripts/smoke-prod.mjs   # 线上：真签名打真域名，覆盖上游提供商封装 / 消费者密钥 / 失败只收 Gas
```

`smoke-prod.mjs` 会在线上留下一个测试账户（输出里带 `TEST_ADDRESS=`），清理：

```bash
ADDR=<TEST_ADDRESS>
for t in consumers requests ledger providers principals; do
  pnpm exec wrangler d1 execute norm --remote --config wrangler.jsonc \
    --command "DELETE FROM $t WHERE address='$ADDR'"
done
# provider_models 没有外键，按这张账户名下的 provider 删：
pnpm exec wrangler d1 execute norm --remote --config wrangler.jsonc \
  --command "DELETE FROM provider_models WHERE provider_id IN (SELECT id FROM providers WHERE address='$ADDR')"
```

## 配置项（`wrangler.jsonc` 的 `vars`）

| 变量 | 默认 | 含义 |
|---|---|---|
| `MIN_BALANCE_NANOS` | `10000` | 转发面入口安全余额阈值（纳美元）；低于此值直接 402 拒单，0 D1 写、0 上游请求。动态 Gas 单价表在 `src/gas.ts` 中 |
| `SIGNATURE_WINDOW_SECONDS` | `60` | 签名时间窗（秒），超出窗口一律 `401 timestamp_out_of_window` |
| `TRUSTED_BASE_URLS` | 见文件 | 信任清单：精确主机名，逗号分隔 |
| `NORM_MASTER_KEY` | 无默认 | **Worker secret**，AES-256-GCM 封装上游提供商密钥用的 32 字节密钥 |

`ATTEST_*` 由发布流程用 `--var` 覆盖，不要手改。

## 不用点界面铸造一把最小权限 token

控制台页面本身就是 API 客户端：只要浏览器里已登录 Cloudflare，就能在同源上下文里直接调
`/api/v4/*` 铸造 token，省掉在「创建令牌」表单里逐个勾权限组的手工活。

前提：Chrome 以远程调试方式运行（Cybion 托管的那份就是
`--remote-debugging-port=9222 --user-data-dir=~/.cybion/browser`），且已登录 `dash.cloudflare.com`。

1. 在 `https://dash.cloudflare.com/profile/api-tokens` 页面的执行上下文里跑：

   ```js
   await (await fetch('/api/v4/user/tokens/permission_groups?per_page=200')).json()
   await (await fetch('/api/v4/zones?name=ntnl.io')).json()   // zone id
   ```

2. 用拿到的权限组 id 组策略（Norm 只需要四个）：

   | 用途 | 权限组 |
   |---|---|
   | 上传 Worker | Workers Scripts Write `e086da7e2179491d91ee5f35b3ca210a` + Workers Scripts Read `1a71c399035b4950a1bd1466bbe4f420` |
   | 迁移 D1 | D1 Write `09b2857d1c31407795e75e3fed8617a1` |
   | 读账户信息 | Account Settings Read `c1fde68c7bcc44588cbb6ddbc16d6480` |
   | 绑自定义域 | Workers Routes Write `28f4b596e7d643029c524985477ae49a`（zone 作用域） |

3. `POST /api/v4/user/tokens`，body 里两条 policy：account 作用域放前三个，zone 作用域放 Routes。
   响应里的 `result.value` 就是 token，**只出现这一次**。

4. 立刻写进仓库 secret，然后删掉本地副本：

   ```bash
   gh secret set CLOUDFLARE_API_TOKEN -R No-Trade-No-Life/norm < /tmp/token.txt
   gh secret set CLOUDFLARE_ACCOUNT_ID  -R No-Trade-No-Life/norm --body b831a34938a75457b5029d31cea13c25
   rm -f /tmp/token.txt
   ```

5. 用 `user/tokens/verify` 确认状态是 `active`，再跑一次 `gh workflow run release` 验证它真能部署。

已有同名 token（`norm-deploy-github-actions`）时不要重复铸造：先去
`/profile/api-tokens` 看它是否还在、是否未过期。`wrangler login` 的 OAuth 凭据**不能**代铸 token
（`/user/tokens` 对它返回 9109），这一步必须走浏览器里的会话。

## ChatGPT 订阅（`openai-oauth`）需要的一条代理

Cloudflare Worker 的 `fetch` 会在每个出站请求上盖 `cf-worker` / `cf-connecting-ip`，
`chatgpt.com` 见到就回 403（实测：同一条请求直连 200、从边缘出去 403、换成真实 IP 也一样）。
所以这条上游要一条 HTTP 代理：Norm 自己开 CONNECT 隧道，字节由代理重新发出，那些头不存在。
协议基址是钉死的官方地址，出口是这条上游的配置——两者互不干扰。

最小 CONNECT 代理（Node 22，二十几行，带 Basic 认证）：

```js
import { createServer, connect } from 'node:net';

const [user, pass] = [process.env.PX_USER, process.env.PX_PASS];
const want = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

createServer((client) => {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;                       // 头还没读完
    client.off('data', onData);
    const head = buf.subarray(0, end).toString('latin1');
    const rest = buf.subarray(end + 4);        // 头之后可能已经跟着隧道数据，不能丢
    const [method, target] = head.split('\r\n')[0].split(' ');
    const auth = /proxy-authorization:\s*(.+)/i.exec(head)?.[1].trim();
    if (method !== 'CONNECT' || auth !== want) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="px"\r\n\r\n');
      return;
    }
    const [host, port] = target.split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length > 0) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
  };
  client.on('data', onData);
  client.on('error', () => client.destroy());
}).listen(8888, '0.0.0.0', () => console.log('connect-proxy on 8888'));
```

放在一台公网机器上（端口走高端口、口令要有、安全组只开这一个口）：

```bash
PX_USER=norm PX_PASS=$(openssl rand -hex 12) node px.mjs
```

然后在 Norm 里新建上游提供商：协议选 `OpenAI OAuth（ChatGPT 订阅）`，**不用填 base_url**，
代理填 `http://norm:<口令>@<公网地址>:8888`，凭据用「连接 ChatGPT」走一遍授权。

只收 `http://` 代理；`https://` 代理要在隧道外再套一层 TLS，收益为零、路径多一条。
