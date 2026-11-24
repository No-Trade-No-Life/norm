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
node scripts/e2e.mjs          # 本地：假上游 + 真身份 + 本地 Worker，40 项断言
node scripts/smoke-prod.mjs   # 线上：真签名打真域名，上游用一个故意失效的密钥（验"失败不扣费"）
```

`smoke-prod.mjs` 会在线上留下一个测试账户（输出里带 `TEST_ADDRESS=`），清理：

```bash
ADDR=<TEST_ADDRESS>
for t in requests ledger credentials nonces principals; do
  pnpm exec wrangler d1 execute norm --remote --config wrangler.jsonc \
    --command "DELETE FROM $t WHERE address='$ADDR'"
done
```

## 配置项（`wrangler.jsonc` 的 `vars`）

| 变量 | 默认 | 含义 |
|---|---|---|
| `REQUEST_FEE_MICROS` | `500` | 每次成功转发的隔离费（微美元） |
| `GRANT_MICROS` | `1000000` | 新地址的演示授信（微美元，即 $1） |
| `SIGNATURE_WINDOW_SECONDS` | `120` | 签名时间窗 |

`ATTEST_*` 由发布流程用 `--var` 覆盖，不要手改。
