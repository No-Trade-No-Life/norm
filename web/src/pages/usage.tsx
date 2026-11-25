import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { latency, percent, safeHost, shortAddress, signedUsd, tokens, usd, when } from '../lib/format';
import {
  PER_PAGE,
  useLedger,
  useMe,
  usePricing,
  useUsage,
  useUsageByConsumer,
  useUsageByProvider,
} from '../queries';
import type { ConsumerUsage, LedgerRow, Pricing, ProviderUsage, RequestRow } from '../types';

/**
 * 用量与账本。这一页的顺序就是一个人核对账单的顺序：
 *
 *   1. 余额与累计花费           —— 我欠多少、花了多少
 *   2. 三项 token 与费用构成     —— 钱花在什么上（输入 / 缓存命中 / 输出 / 服务费）
 *   3. 请求记录                 —— 逐条明细，每条都能回到一次调用
 *   4. 按钥匙 / 按上游提供商          —— 谁花的、花在哪
 *   5. 记账流水                 —— 余额是怎么一步步变到现在的
 *   6. 价目表                   —— 价格是公开的，谁都能自己重算一遍
 */
export function UsagePage() {
  const { t } = useI18n();
  const me = useMe(true);
  const usage = useCursorPages<string>((cursor) => useUsage(true, cursor));
  const ledger = useCursorPages<number>((cursor) => useLedger(true, cursor));
  const byConsumer = useUsageByConsumer(true);
  const byProvider = useUsageByProvider(true);
  const pricing = usePricing();

  const tokens_ = me.data?.usage;
  const billed = me.data?.billed;

  const cards = useMemo(
    () => [
      { label: t('us.balance'), value: usd(me.data?.balance_nanos), emphasis: true },
      { label: t('us.spend'), value: usd(me.data?.spend_nanos) },
      { label: t('us.requests'), value: me.data ? String(me.data.requests) : '—' },
      { label: t('us.granted'), value: usd(me.data?.granted_nanos) },
    ],
    [me.data, t],
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
      { label: t('us.billed_gas'), value: usd(billed?.gas_fee_nanos), note: t('us.gas_note') },
      { label: t('us.billed_tokens'), value: usd(billed?.token_nanos), note: null },
      {
        label: t('us.billed_unbilled'),
        value: usd(billed?.unbilled_nanos),
        // 正常情况这里是 0：余额不够时才会出现，而那不是一件好事，所以要能被看见。
        note: null,
      },
      // 体感：首字是「等多久」，总耗时是「这一笔要多久」。首字只对流式有值。
      { label: t('us.avg_ttft'), value: latency(me.data?.latency?.avg_first_token_ms), note: t('us.ttft_only_stream') },
      { label: t('us.avg_total'), value: latency(me.data?.latency?.avg_latency_ms), note: null },
    ],
    [billed, me.data, t],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('us.title')} description={t('us.desc')} />

      {me.isError ? <ErrorNote title={t('common.error')} message={(me.error as Error).message} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{card.label}</p>
            <p className={card.emphasis ? 'mt-1 text-lg font-semibold tabular-nums' : 'mt-1 text-base font-medium tabular-nums'}>
              {me.isPending ? '—' : card.value}
            </p>
          </div>
        ))}
      </div>

      {/* 三项 token 与两项费用并排：一眼就能看出「贵在输出」还是「贵在没命中缓存」。 */}
      <Section title={t('us.billed')} description={t('us.gas_note')}>
        <div className="grid gap-3 sm:grid-cols-3">
          {tokenCards.map((card) => (
            <div key={card.label} className="rounded-lg border border-border/60 px-3 py-2">
              <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{card.label}</p>
              <p className="mt-0.5 font-mono text-sm tabular-nums">{me.isPending ? '—' : card.value}</p>
              {card.sub ? <p className="text-[11px] text-muted-foreground">{card.sub}</p> : null}
            </div>
          ))}
          {moneyCards.map((card) => (
            <div key={card.label} className="rounded-lg border border-border/60 px-3 py-2">
              <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{card.label}</p>
              <p className="mt-0.5 font-mono text-sm tabular-nums">{me.isPending ? '—' : card.value}</p>
              {card.note ? <p className="text-[11px] text-muted-foreground">{card.note}</p> : null}
            </div>
          ))}
        </div>
      </Section>

      <Section
        title={t('us.requests_title')}
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={<Pager page={usage.page} setPage={usage.setPage} hasNext={usage.hasNext} loading={usage.query.isFetching} />}
      >
        {usage.query.isPending ? (
          <SkeletonRows rows={6} cols={7} />
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('us.by_consumer_title')} bodyClassName="p-0">
          {byConsumer.isPending ? (
            <SkeletonRows rows={3} cols={4} />
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
            <SkeletonRows rows={3} cols={4} />
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
          <SkeletonRows rows={5} cols={5} />
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

      <Section title={t('us.pricing_title')} description={t('us.pricing_note')} bodyClassName="p-0">
        {pricing.isPending ? (
          <SkeletonRows rows={4} cols={4} />
        ) : pricing.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(pricing.error as Error).message} />
          </div>
        ) : pricing.data ? (
          <PricingTable pricing={pricing.data} />
        ) : null}
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
          <TableHead className="w-[5.5rem] text-right">{t('us.col_fee')}</TableHead>
          <TableHead className="hidden min-w-56 xl:table-cell">{t('us.col_request_id')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="text-xs text-muted-foreground tabular-nums">{when(row.created_at)}</TableCell>
            <TableCell className="max-w-28 truncate sm:max-w-56">
              <span className="block truncate font-mono text-xs" title={row.model}>
                {row.model || '—'}
              </span>
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
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums" title={`${t('us.billed_gas')} ${usd(row.gas_fee_nanos)} + ${t('us.billed_tokens')} ${usd(row.token_nanos)}`}>
              {usd(row.fee_nanos)}
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
          <TableHead className="w-16 text-right">{t('us.col_calls')}</TableHead>
          <TableHead className="w-28 text-right">{t('us.col_tokens')}</TableHead>
          <TableHead className="w-20 text-right">{t('us.col_fee')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.consumer_id ?? 'none'}>
            <TableCell className="max-w-40 truncate">
              <span className="text-xs">{row.consumer_name ?? t('us.direct')}</span>
              {row.key_hint ? <span className="block font-mono text-[11px] text-muted-foreground">{row.key_hint}</span> : null}
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{row.requests}</TableCell>
            <TableCell className="text-right">
              <TokenTriple input={row.input_tokens} cached={row.cached_tokens} output={row.output_tokens} />
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{usd(row.fee_nanos)}</TableCell>
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
          <TableHead className="w-16 text-right">{t('us.col_calls')}</TableHead>
          <TableHead className="w-28 text-right">{t('us.col_tokens')}</TableHead>
          <TableHead className="w-20 text-right">{t('us.col_fee')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.provider_id ?? 'none'}>
            <TableCell className="max-w-40 truncate">
              <span className="text-xs">{row.provider_label ?? shortAddress(row.provider_id ?? '')}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">{row.provider_id ?? '—'}</span>
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{row.requests}</TableCell>
            <TableCell className="text-right">
              <TokenTriple input={row.input_tokens} cached={row.cached_tokens} output={row.output_tokens} />
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{usd(row.fee_nanos)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

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
          <TableHead className="hidden min-w-48 lg:table-cell">{t('us.col_request_id')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="text-xs text-muted-foreground tabular-nums">{when(row.created_at)}</TableCell>
            <TableCell>
              <Badge variant={row.kind === 'grant' ? 'outline' : 'secondary'} className="whitespace-nowrap">
                <span className="sm:hidden">{row.kind === 'grant' ? t('us.kind_grant') : t('us.kind_charge')}</span>
                <span className="hidden sm:inline">{row.kind === 'grant' ? t('us.ledger_grant') : t('us.ledger_charges')}</span>
              </Badge>
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{signedUsd(row.amount_nanos)}</TableCell>
            <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">{usd(row.balance_after_nanos)}</TableCell>
            <TableCell className="hidden lg:table-cell">
              <code className="text-[11px] text-muted-foreground">{row.request_id ?? '—'}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 价目表：纳美元 / 每百万 token。放在页面末尾，是因为它是「核对」而不是「日常」。 */
function PricingTable({ pricing }: { pricing: Pricing }) {
  const { t } = useI18n();
  const rows = [{ match: t('us.pricing_default'), ...pricing.default }, ...pricing.models];
  return (
    <ul className="divide-y divide-border">
      <li className="flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        <span>{t('us.col_match')}</span>
        <span className="tabular-nums">{t('us.col_price')}</span>
      </li>
      {rows.map((row) => (
        <li key={row.match} className="flex items-center justify-between gap-3 px-3 py-1.5">
          <code className="truncate text-xs">{row.match}</code>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {usd(row.input)} / {usd(row.cached)} / {usd(row.output)}
          </span>
        </li>
      ))}
    </ul>
  );
}
