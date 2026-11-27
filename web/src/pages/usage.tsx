import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { latency, nusd, percent, safeHost, shortAddress, shortKey, signedUsd, tokens, usd, when } from '../lib/format';
import {
  PER_PAGE,
  useEarnings,
  useLedger,
  useMe,
  useUsage,
  useUsageByConsumer,
  useUsageByProvider,
} from '../queries';
import type { ConsumerUsage, EarningRow, LedgerRow, ProviderUsage, RequestRow } from '../types';

/**
 * 用量与账本。这一页按核对账单的顺序组织，并把 Gas 费（付给 Norm）与 Token 费（用户间价值转移）彻底分开：
 *
 *   1. 余额与六块只增累计数       —— 充值 + 抵扣券 + 累计供给 − Gas 支出 − 累计消费 − 提现
 *   2. Token 用量 / 费用构成 / 延迟 —— 区分付给 Norm 的 Gas 与用户之间的 Token 价值
 *   3. 消费请求记录               —— 逐条明细，Gas 与 Token 分列展示（自有上游的 Token 记成自转自）
 *   4. 上游 Token 收入            —— 他人调用你上游时直接转入你账户的 Token 价值明细
 *   5. 按钥匙 / 按上游提供商       —— 谁花的、花在哪（Gas / Token 分列）
 *   6. 账户流水                   —— 券、充值、提现的账户级变动
 */
export function UsagePage() {
  const { t } = useI18n();
  const me = useMe(true);
  const usage = useCursorPages<string>((cursor) => useUsage(true, cursor));
  const earnings = useCursorPages<string>((cursor) => useEarnings(true, cursor));
  const ledger = useCursorPages<number>((cursor) => useLedger(true, cursor));
  const byConsumer = useUsageByConsumer(true);
  const byProvider = useUsageByProvider(true);

  const tokens_ = me.data?.usage;
  const billed = me.data?.billed;
  const earned = me.data?.earned;

  // 余额是算出来的，六块累计数各自只增：充值 + 抵扣券 + 累计供给 − Gas 支出 − 累计消费 − 提现。
  // 累计供给与累计消费是同一把尺子的两端，差就是「你对其他用户的净值」：自己用自己的上游两边
  // 同增，净值不变；Gas 不在这条算式里，它是付给 Norm 的成本。
  const cards = useMemo(
    () => [
      { label: t('us.balance'), value: usd(me.data?.balance_nanos), emphasis: true, positive: false, note: null as string | null },
      { label: t('us.gas_spend'), value: usd(me.data?.gas_spend_nanos), emphasis: false, positive: false, note: t('us.gas_spend_note') },
      { label: t('us.token_spend'), value: usd(me.data?.token_spend_nanos), emphasis: false, positive: false, note: t('us.token_spend_note') },
      {
        label: t('us.earn'),
        value: me.data ? (me.data.earn_nanos > 0 ? signedUsd(me.data.earn_nanos) : usd(0)) : '—',
        emphasis: false,
        positive: (me.data?.earn_nanos ?? 0) > 0,
        note: t('us.earn_note'),
      },
      {
        label: t('us.net'),
        value: me.data
          ? me.data.net_supply_nanos === 0
            ? usd(0)
            : signedUsd(me.data.net_supply_nanos)
          : '—',
        emphasis: false,
        positive: (me.data?.net_supply_nanos ?? 0) > 0,
        note: t('us.net_note'),
      },
      { label: t('us.recharge'), value: usd(me.data?.recharge_nanos), emphasis: false, positive: false, note: null },
      { label: t('us.voucher'), value: usd(me.data?.voucher_nanos), emphasis: false, positive: false, note: t('us.voucher_note') },
      { label: t('us.withdraw'), value: usd(me.data?.withdraw_nanos), emphasis: false, positive: false, note: null },
      {
        label: t('us.requests'),
        value: me.data ? String(me.data.requests) : '—',
        emphasis: false,
        positive: false,
        note: earned && earned.requests > 0 ? t('us.served_note', { count: earned.requests }) : null,
      },
    ],
    [earned, me.data, t],
  );

  const tokenCards = useMemo(
    () => [
      { label: t('us.tokens_in'), value: tokens(tokens_?.input_tokens), sub: null as string | null },
      {
        label: t('us.tokens_cached'),
        value: tokens(tokens_?.cached_tokens),
        // 命中率是这一页最值得盯的数字：它决定同样的活要花多少钱。
        sub: tokens_ ? `${t('us.cache_share')} ${percent(tokens_.cached_tokens, tokens_.input_tokens)}` : null,
      },
      { label: t('us.tokens_out'), value: tokens(tokens_?.output_tokens), sub: null },
    ],
    [t, tokens_],
  );

  const moneyCards = useMemo(
    () => [
      { label: t('us.billed_gas'), value: usd(billed?.gas_billed_nanos ?? billed?.gas_fee_nanos), note: t('us.gas_note') },
      { label: t('us.billed_tokens'), value: usd(billed?.token_billed_nanos ?? billed?.token_nanos), note: t('us.billed_tokens_note') },
      {
        label: t('us.billed_unbilled'),
        value: usd(billed?.unbilled_nanos),
        // 正常情况这里是 0：余额不够时才会出现，需要如实展示。
        note: null as string | null,
      },
    ],
    [billed, t],
  );

  const latencyCards = useMemo(
    () => [
      // 体感：首字是「等多久」，总耗时是「这一笔要多久」。首字只对流式有值。
      { label: t('us.avg_ttft'), value: latency(me.data?.latency?.avg_first_token_ms), note: t('us.ttft_only_stream') },
      { label: t('us.avg_total'), value: latency(me.data?.latency?.avg_latency_ms), note: null as string | null },
    ],
    [me.data, t],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('us.title')} description={t('us.desc')} />

      {me.isError ? <ErrorNote title={t('common.error')} message={(me.error as Error).message} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{card.label}</p>
            <p
              className={
                card.emphasis
                  ? 'mt-1 text-lg font-semibold tabular-nums'
                  : card.positive
                    ? 'mt-1 text-base font-medium tabular-nums text-emerald-600 dark:text-emerald-400'
                    : 'mt-1 text-base font-medium tabular-nums'
              }
            >
              {me.isPending ? '—' : card.value}
            </p>
            {card.note ? <p className="text-[11px] text-muted-foreground">{card.note}</p> : null}
          </div>
        ))}
      </div>

      {/* 三项 token、两项分离费用（Gas / Token）与两项延迟分行排布，一眼看清结构。 */}
      <Section title={t('us.billed')} description={t('us.billed_desc')}>
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {tokenCards.map((card) => (
              <div key={card.label} className="rounded-lg border border-border/60 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{card.label}</p>
                <p className="mt-0.5 font-mono text-sm tabular-nums">{me.isPending ? '—' : card.value}</p>
                {card.sub ? <p className="text-[11px] text-muted-foreground">{card.sub}</p> : null}
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {moneyCards.map((card) => (
              <div key={card.label} className="rounded-lg border border-border/60 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{card.label}</p>
                <p className="mt-0.5 font-mono text-sm tabular-nums">{me.isPending ? '—' : card.value}</p>
                {card.note ? <p className="text-[11px] text-muted-foreground">{card.note}</p> : null}
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {latencyCards.map((card) => (
              <div key={card.label} className="rounded-lg border border-border/60 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{card.label}</p>
                <p className="mt-0.5 font-mono text-sm tabular-nums">{me.isPending ? '—' : card.value}</p>
                {card.note ? <p className="text-[11px] text-muted-foreground">{card.note}</p> : null}
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title={t('us.requests_title')}
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={<Pager page={usage.page} setPage={usage.setPage} hasNext={usage.hasNext} loading={usage.query.isFetching} />}
      >
        {usage.query.isPending ? (
          <SkeletonRows rows={6} cols={9} />
        ) : usage.query.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(usage.query.error as Error).message} />
          </div>
        ) : usage.rows.length === 0 ? (
          <Empty className="border-0">{t('us.requests_empty')}</Empty>
        ) : (
          <RequestTable rows={usage.rows} providers={byProvider.data ?? []} />
        )}
      </Section>

      <Section
        title={t('us.earnings_title')}
        description={t('us.earnings_desc')}
        bodyClassName="p-0"
        actions={<Pager page={earnings.page} setPage={earnings.setPage} hasNext={earnings.hasNext} loading={earnings.query.isFetching} />}
      >
        {earnings.query.isPending ? (
          <SkeletonRows rows={4} cols={6} />
        ) : earnings.query.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(earnings.query.error as Error).message} />
          </div>
        ) : earnings.rows.length === 0 ? (
          <Empty className="border-0">{t('us.earnings_empty')}</Empty>
        ) : (
          <EarningsTable rows={earnings.rows} />
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('us.by_consumer_title')} bodyClassName="p-0">
          {byConsumer.isPending ? (
            <SkeletonRows rows={3} cols={5} />
          ) : byConsumer.isError ? (
            <div className="p-3">
              <ErrorNote title={t('common.error')} message={(byConsumer.error as Error).message} />
            </div>
          ) : (byConsumer.data ?? []).length === 0 ? (
            <Empty className="border-0">{t('us.by_consumer_empty')}</Empty>
          ) : (
            <ByConsumerTable rows={byConsumer.data ?? []} />
          )}
        </Section>

        <Section title={t('us.by_provider_title')} bodyClassName="p-0">
          {byProvider.isPending ? (
            <SkeletonRows rows={3} cols={5} />
          ) : byProvider.isError ? (
            <div className="p-3">
              <ErrorNote title={t('common.error')} message={(byProvider.error as Error).message} />
            </div>
          ) : (byProvider.data ?? []).length === 0 ? (
            <Empty className="border-0">{t('us.by_provider_empty')}</Empty>
          ) : (
            <ByProviderTable rows={byProvider.data ?? []} />
          )}
        </Section>
      </div>

      <Section
        title={t('us.ledger_title')}
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={<Pager page={ledger.page} setPage={ledger.setPage} hasNext={ledger.hasNext} loading={ledger.query.isFetching} />}
      >
        {ledger.query.isPending ? (
          <SkeletonRows rows={5} cols={4} />
        ) : ledger.query.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(ledger.query.error as Error).message} />
          </div>
        ) : ledger.rows.length === 0 ? (
          <Empty className="border-0">{t('us.ledger_empty')}</Empty>
        ) : (
          <LedgerTable rows={ledger.rows} />
        )}
      </Section>
    </div>
  );
}

/**
 * 游标翻页：`cursors` 记下每一页的起点（第一页是 undefined），`page` 是当前页号。
 *
 * 为什么不用页码：账本只追加，用 OFFSET 翻页会在新行插入时把同一行显示两次或漏掉一行；
 * 游标翻页每次都从「上一页最后一行」继续往旧的方向走，看到的永远是稳定的历史。
 */
function useCursorPages<K extends string | number>(useRows: (cursor: K | undefined) => { data?: unknown[]; isPending: boolean; isError: boolean; error: unknown; isFetching: boolean }) {
  const [cursors, setCursors] = useState<Array<K | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const query = useRows(cursors[page]);
  const rows = (query.data ?? []) as never[];

  return {
    rows,
    page,
    query,
    // 取到满页就说明后面可能还有；不为了「下一页」按钮多打一次请求。
    hasNext: rows.length === PER_PAGE,
    setPage: (next: number) => {
      if (next < page) return setPage(next);
      const last = rows.at(-1) as Record<string, K> | undefined;
      if (!last) return;
      const cursor = (last.cursor ?? last.id) as K;
      setCursors((current) => [...current.slice(0, page + 1), cursor]);
      setPage(page + 1);
    },
  };
}

function Pager({
  page,
  setPage,
  hasNext,
  loading,
}: {
  page: number;
  setPage: (value: number) => void;
  hasNext: boolean;
  loading: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon-sm" disabled={page === 0 || loading} onClick={() => setPage(Math.max(0, page - 1))} aria-label={t('action.prev')}>
        <ChevronLeftIcon />
      </Button>
      <span className="min-w-14 text-center text-xs text-muted-foreground tabular-nums">
        {t('us.page', { page: page + 1 })}
      </span>
      <Button variant="ghost" size="icon-sm" disabled={!hasNext || loading} onClick={() => setPage(page + 1)} aria-label={t('action.next')}>
        <ChevronRightIcon />
      </Button>
    </div>
  );
}

function StatusBadge({ status, statusCode }: { status: string; statusCode: number | null }) {
  const ok = status === 'ok';
  return (
    <Badge variant={ok ? 'secondary' : 'destructive'} className="font-mono">
      {ok ? '200' : statusCode ? String(statusCode) : status}
    </Badge>
  );
}

/** 输入 / 命中 / 输出三个数并排：`11 / 0 / 3` 就是这次调用真正花掉的量。 */
function TokenTriple({ input, cached, output }: { input: number; cached: number; output: number }) {
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

function RequestTable({ rows, providers }: { rows: RequestRow[]; providers: ProviderUsage[] }) {
  const { t } = useI18n();
  const labelOf = useMemo(() => {
    const table = new Map<string, string>();
    for (const entry of providers) if (entry.provider_id) table.set(entry.provider_id, entry.provider_label ?? '');
    return table;
  }, [providers]);

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
                  {row.provider_id ? ` · ${labelOf.get(row.provider_id) || shortAddress(row.provider_id)}` : ''}
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

function EarningsTable({ rows }: { rows: EarningRow[] }) {
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

function ByConsumerTable({ rows }: { rows: ConsumerUsage[] }) {
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

function ByProviderTable({ rows }: { rows: ProviderUsage[] }) {
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

function LedgerTable({ rows }: { rows: LedgerRow[] }) {
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
