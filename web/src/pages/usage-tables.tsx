import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { latency, nusd, percent, safeHost, shortAddress, shortKey, signedUsd, tokens, usd, when } from '../lib/format';
import type { ConsumerUsage, EarningRow, LedgerRow, ProviderUsage, RequestRow } from '../types';

/**
 * 账本的几张表。它们只吃数据、不发请求——数据由各自那一页去取。
 *
 * 拆开之后这里最容易犯错的一点是「为了显示上游名字而顺手拉一次聚合」：明细表曾经就是这么干的。
 * 现在名字跟着行一起回来（`/account/usage` 顺带 join 了 providers 的主键），一页 50 行就是
 * 50 行读，而不是一次全量 GROUP BY。
 */

function StatusBadge({ status, statusCode }: { status: string; statusCode: number | null }) {
  const ok = status === 'ok';
  return (
    <Badge variant={ok ? 'secondary' : 'destructive'} className="font-mono">
      {ok ? '200' : statusCode ? String(statusCode) : status}
    </Badge>
  );
}

/** 输入 / 命中 / 输出三个数并排：`11 / 0 / 3` 就是这次调用真正花掉的量。 */
export function TokenTriple({ input, cached, output }: { input: number; cached: number; output: number }) {
  // 缓存率就写在这三个数下面：它决定同样的活要花多少钱，是这一页最该被盯住的比值。
  return (
    <span className="font-mono text-xs tabular-nums">
      {tokens(input)} <span className="text-muted-foreground">/</span> {tokens(cached)}{' '}
      <span className="text-muted-foreground">/</span> {tokens(output)}
      <span className="ml-1 text-[11px] text-muted-foreground">{percent(cached, input)}</span>
    </span>
  );
}

/**
 * 音频那一行的用量：转写看覆盖了多久，合成看念了多少字。
 *
 * 按 token 计价的合成模型这两列都是 0——它的用量落在上面那三个 token 里，这里就不再多说一句。
 */
function AudioUsage({ ms, characters }: { ms: number; characters: number }) {
  const { t } = useI18n();
  if (ms === 0 && characters === 0) return null;
  return (
    <span className="block text-[11px] text-muted-foreground">
      {ms > 0 ? t('us.audio_ms', { value: (ms / 1000).toFixed(1) }) : t('us.audio_chars', { value: characters })}
    </span>
  );
}

export function RequestTable({ rows }: { rows: RequestRow[] }) {
  const { t } = useI18n();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[8.5rem] sm:w-[9.5rem]">{t('us.col_time')}</TableHead>
          <TableHead className="w-28 sm:w-auto sm:min-w-32">{t('us.col_model')}</TableHead>
          <TableHead className="hidden w-16 sm:table-cell">{t('us.col_status')}</TableHead>
          <TableHead className="hidden w-20 text-right sm:table-cell">{t('us.col_latency')}</TableHead>
          <TableHead className="hidden w-32 text-right xl:table-cell">{t('us.col_tokens')}</TableHead>
          <TableHead className="w-[5.25rem] text-right">{t('us.col_total_cost')}</TableHead>
          <TableHead className="w-[5.5rem] text-right">{t('us.col_token_fee')}</TableHead>
          <TableHead className="w-[5.25rem] text-right">{t('us.col_gas')}</TableHead>
          <TableHead className="hidden w-24 text-right md:table-cell">{t('us.col_spend_after')}</TableHead>
          <TableHead className="hidden w-24 lg:table-cell">{t('us.col_provider_user')}</TableHead>
          <TableHead className="hidden min-w-52 xl:table-cell">{t('us.col_request_id')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const isOwn = row.provider_user === row.address;
          const isPool = Boolean(row.provider_user && row.provider_user !== row.address);
          const gasPaid = row.gas_billed_nanos ?? row.gas_fee_nanos;
          const tokenPaid = row.token_billed_nanos ?? row.token_nanos;
          return (
            <TableRow key={row.id}>
              <TableCell className="text-xs text-muted-foreground tabular-nums">{when(row.created_at)}</TableCell>
              <TableCell className="max-w-28 truncate sm:max-w-56">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-xs" title={row.model}>
                    {row.model || '—'}
                  </span>
                  {isPool ? (
                    <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                      {t('pg.pool_badge')}
                    </Badge>
                  ) : null}
                </div>
                {/* 第二行回答「打给哪台机器、走哪条上游提供商」——账本的一半意义在这里。 */}
                <span className="block truncate text-[11px] text-muted-foreground" title={row.base_url}>
                  {safeHost(row.base_url) || '—'}
                  {row.provider_id
                    ? ` · ${row.provider_label ?? shortAddress(row.provider_id)}`
                    : ''}
                </span>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <StatusBadge status={row.status} statusCode={row.status_code} />
              </TableCell>
              <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">
                {/* 首字是体感、总耗时是账单：分开显示，才看得出慢在哪一头。 */}
                <span className="block">{row.first_token_ms === null ? '—' : latency(row.first_token_ms)}</span>
                <span className="block text-[11px] text-muted-foreground">{latency(row.latency_ms)}</span>
              </TableCell>
              <TableCell className="hidden text-right xl:table-cell">
                <TokenTriple input={row.input_tokens} cached={row.cached_tokens} output={row.output_tokens} />
                <AudioUsage ms={row.audio_ms ?? 0} characters={row.audio_characters ?? 0} />
              </TableCell>
              {/* 总消费 / Token 费 / Gas 费分列展示：单笔归因一目了然（总消费 = Token 费 + Gas 费）。 */}
              <TableCell
                className="text-right text-xs font-medium tabular-nums"
                title={`${t('us.col_token_fee')} ${nusd(tokenPaid)} + ${t('us.col_gas')} ${nusd(gasPaid)}${row.unbilled_nanos > 0 ? ` (${t('us.billed_unbilled')} ${usd(row.unbilled_nanos)})` : ''}`}
              >
                {usd(row.fee_nanos)}
              </TableCell>
              <TableCell
                className="text-right text-xs tabular-nums"
                title={
                  isOwn && tokenPaid === 0
                    ? t('us.own_upstream_no_token')
                    : `${t('us.billed_tokens')}: ${nusd(tokenPaid)}${row.token_nanos > tokenPaid ? ` / ${nusd(row.token_nanos)}` : ''}`
                }
              >
                {isOwn && tokenPaid === 0 ? (
                  <span className="text-muted-foreground">
                    0 nUSD
                    <span className="ml-1 hidden text-[10px] sm:inline">{t('us.own_badge')}</span>
                  </span>
                ) : (
                  <span className={tokenPaid === 0 ? 'text-muted-foreground' : undefined}>{nusd(tokenPaid)}</span>
                )}
              </TableCell>
              <TableCell
                className="text-right text-xs tabular-nums text-muted-foreground"
                title={`${t('us.billed_gas')}: ${nusd(gasPaid)}${row.gas_fee_nanos > gasPaid ? ` / ${nusd(row.gas_fee_nanos)}` : ''}`}
              >
                {nusd(gasPaid)}
              </TableCell>
              <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground md:table-cell">
                {/* 累计消费：每一行自带「到这里一共花了多少」，不必去别处加总。 */}
                {usd(row.spend_after_nanos)}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {/* 上游持有者：自有上游标「本人」，公共池显示收 Token 费的对端公钥。 */}
                {isOwn ? (
                  <Badge variant="secondary" className="text-[10px] font-normal">
                    {t('us.self_user')}
                  </Badge>
                ) : (
                  <code className="text-[11px] text-muted-foreground" title={row.provider_user ?? ''}>
                    {shortKey(row.provider_user)}
                  </code>
                )}
              </TableCell>
              <TableCell className="hidden xl:table-cell">
                <code className="block text-[11px] text-muted-foreground" title={row.id}>
                  {row.id}
                </code>
                {/* 谁花的：消费者密钥的短样子；签名直连说明这次是人手动打的。 */}
                <span className="block text-[11px] text-muted-foreground">
                  {row.consumer_id ? shortAddress(row.consumer_id) : t('us.direct')}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function EarningsTable({ rows }: { rows: EarningRow[] }) {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[8.5rem] sm:w-[9.5rem]">{t('us.col_time')}</TableHead>
          <TableHead className="min-w-32">{t('us.col_model')}</TableHead>
          <TableHead className="hidden w-28 sm:table-cell">{t('us.col_caller')}</TableHead>
          <TableHead className="hidden w-32 text-right md:table-cell">{t('us.col_tokens')}</TableHead>
          <TableHead className="w-24 text-right">{t('us.col_earned')}</TableHead>
          <TableHead className="hidden w-24 text-right sm:table-cell">{t('us.col_earn_after')}</TableHead>
          <TableHead className="hidden min-w-52 xl:table-cell">{t('us.col_request_id')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="text-xs text-muted-foreground tabular-nums">{when(row.created_at)}</TableCell>
            <TableCell className="max-w-32 truncate sm:max-w-56">
              <span className="block truncate font-mono text-xs" title={row.model}>
                {row.model || '—'}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground" title={row.base_url}>
                {safeHost(row.base_url) || '—'}
                {row.provider_label ? ` · ${row.provider_label}` : row.provider_id ? ` · ${shortAddress(row.provider_id)}` : ''}
              </span>
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <code className="text-[11px] text-muted-foreground" title={row.consumer_address}>
                {shortKey(row.consumer_address)}
              </code>
            </TableCell>
            <TableCell className="hidden text-right md:table-cell">
              <TokenTriple input={row.input_tokens} cached={row.cached_tokens} output={row.output_tokens} />
            </TableCell>
            <TableCell className="text-right text-xs font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
              {signedUsd(row.token_billed_nanos)}
            </TableCell>
            <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground sm:table-cell">
              {usd(row.earn_after_nanos)}
            </TableCell>
            <TableCell className="hidden xl:table-cell">
              <code className="text-[11px] text-muted-foreground" title={row.id}>
                {row.id}
              </code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ByConsumerTable({ rows }: { rows: ConsumerUsage[] }) {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('us.col_consumer')}</TableHead>
          <TableHead className="w-14 text-right">{t('us.col_calls')}</TableHead>
          <TableHead className="hidden w-28 text-right sm:table-cell">{t('us.col_tokens')}</TableHead>
          <TableHead className="w-20 text-right">{t('us.col_gas')}</TableHead>
          <TableHead className="w-20 text-right">{t('us.col_token_fee')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.consumer_id ?? 'none'}>
            <TableCell className="max-w-36 truncate">
              <span className="text-xs">{row.consumer_name ?? t('us.direct')}</span>
              {row.key_hint ? <span className="block font-mono text-[11px] text-muted-foreground">{row.key_hint}</span> : null}
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{row.requests}</TableCell>
            <TableCell className="hidden text-right sm:table-cell">
              <TokenTriple input={row.input_tokens} cached={row.cached_tokens} output={row.output_tokens} />
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{usd(row.gas_fee_nanos)}</TableCell>
            <TableCell className={`text-right text-xs tabular-nums ${row.token_nanos === 0 ? 'text-muted-foreground' : ''}`}>
              {usd(row.token_nanos)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ByProviderTable({ rows }: { rows: ProviderUsage[] }) {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('us.col_provider')}</TableHead>
          <TableHead className="w-14 text-right">{t('us.col_calls')}</TableHead>
          <TableHead className="hidden w-28 text-right sm:table-cell">{t('us.col_tokens')}</TableHead>
          <TableHead className="w-20 text-right">{t('us.col_gas')}</TableHead>
          <TableHead className="w-20 text-right">{t('us.col_token_fee')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.provider_id ?? 'none'}>
            <TableCell className="max-w-36 truncate">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs">{row.provider_label ?? shortAddress(row.provider_id ?? '')}</span>
                <Badge variant={row.is_own ? 'secondary' : 'outline'} className="h-4 px-1 text-[10px] font-normal">
                  {row.is_own ? t('us.own_badge') : t('pg.pool_badge')}
                </Badge>
              </div>
              <span className="block font-mono text-[11px] text-muted-foreground">{row.provider_id ?? '—'}</span>
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{row.requests}</TableCell>
            <TableCell className="hidden text-right sm:table-cell">
              <TokenTriple input={row.input_tokens} cached={row.cached_tokens} output={row.output_tokens} />
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{usd(row.gas_fee_nanos)}</TableCell>
            <TableCell
              className={`text-right text-xs tabular-nums ${row.token_nanos === 0 ? 'text-muted-foreground' : ''}`}
              title={row.is_own ? t('us.own_upstream_no_token') : undefined}
            >
              {usd(row.token_nanos)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 账户级流水三种类型：券、充值、提现。 */
const KIND_LABEL: Record<LedgerRow['kind'], (t: (key: never) => string) => string> = {
  voucher: (t) => t('us.ledger_voucher' as never),
  recharge: (t) => t('us.ledger_recharge' as never),
  withdraw: (t) => t('us.ledger_withdraw' as never),
};

export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[9.5rem]">{t('us.col_time')}</TableHead>
          <TableHead className="w-24 sm:w-40">{t('us.col_kind')}</TableHead>
          <TableHead className="w-24 text-right">{t('us.col_amount')}</TableHead>
          <TableHead className="hidden w-28 text-right sm:table-cell">{t('us.col_balance_after')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="text-xs text-muted-foreground tabular-nums">{when(row.created_at)}</TableCell>
            <TableCell>
              {/* 账本只剩进项三类：没有「扣费」那种需要压暗的行了。 */}
              <Badge variant="outline" className="whitespace-nowrap">
                <span className="sm:hidden">{row.kind}</span>
                <span className="hidden sm:inline">{KIND_LABEL[row.kind](t)}</span>
              </Badge>
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{signedUsd(row.amount_nanos)}</TableCell>
            <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">{usd(row.available_after_nanos)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
