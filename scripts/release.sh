#!/usr/bin/env bash
# 可信发布的本地版：算哈希 → 带哈希部署 → 上线后自校验哈希。
# CI 走的是同一套步骤（.github/workflows/release.yml）；这个脚本用于在没有 CI 凭据时
# 由人手动上线，或在本地复核线上跑的是不是这份代码。
set -euo pipefail

commit="$(git rev-parse HEAD)"
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

pnpm build
attestation="$(pnpm --silent attest)"
source_sha="$(printf '%s' "$attestation" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).source_sha256))')"
assets_sha="$(printf '%s' "$attestation" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).assets_sha256))')"

if [ -n "${SKIP_MIGRATIONS:-}" ]; then
  echo "跳过迁移（SKIP_MIGRATIONS 已设置）"
else
  pnpm exec wrangler d1 migrations apply norm --remote --config wrangler.jsonc
fi

pnpm exec wrangler deploy --config wrangler.jsonc \
  --var ATTEST_COMMIT:"$commit" \
  --var ATTEST_BUILT_AT:"$built_at" \
  --var ATTEST_SOURCE_SHA256:"$source_sha" \
  --var ATTEST_ASSETS_SHA256:"$assets_sha" \
  --var ATTEST_RUN_URL:"local release of $commit"

live="$(curl -sS --max-time 20 https://norm.ntnl.io/api/v1/attestation | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).source_sha256))')"
test "$live" = "$source_sha" || { echo "线上 source_sha256($live) 与本次构建($source_sha) 不一致" >&2; exit 1; }

echo
echo "已上线并自校验通过"
echo "  commit          $commit"
echo "  built_at        $built_at"
echo "  source_sha256   $source_sha"
echo "  assets_sha256   $assets_sha"
