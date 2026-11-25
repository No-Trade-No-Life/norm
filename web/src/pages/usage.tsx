import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { latency, signedUsd, tokens, usd, when } from '../lib/format';
import { PER_PAGE, useLedger, useMe, useUsage } from '../queries';
import type { LedgerRow, RequestRow } from '../types';

export function UsagePage() {
  const { t } = useI18n();
  const me = useMe(true);
  const [requestPage, setRequestPage] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(0);
  const usage = useUsage(true, requestPage);
  const ledger = useLedger(true, ledgerPage);

  const requestRows = usage.data ?? [];
  const ledgerRows = ledger.data ?? [];

  // 后端只按 limit 返回，没有总数；页尾用「有没有下一页的行」判断，
  // 所以最后一页不会因为刚好 20 行而显示一个永远为空的下一页。
  const hasNextRequests = requestRows.length === PER_PAGE;
  const hasNextLedger = ledgerRows.length === PER_PAGE;

  const cards = useMemo(
    () => [
      { label: t('us.balance'), value: usd(me.data?.balance_micros), emphasis: true },
      { label: t('us.spend'), value: usd(me.data?.spend_micros) },
      { label: t('us.requests'), value: me.data ? String(me.data.requests) : '—' },
      { label: t('us.granted'), value: usd(me.data?.granted_micros) },
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
            <p className={card.emphasis ? 'mt-1 text-lg font-semibold tabular-nums' : 'mt-1 text-base font-medium tabular-nums'}>
              {me.isPending ? '—' : card.value}
            </p>
          </div>
        ))}
      </div>

      <Section
        title={t('us.requests_title')}
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={<Pager page={requestPage} setPage={setRequestPage} hasNext={hasNextRequests} loading={usage.isFetching} />}
      >
        {usage.isPending ? (
          <SkeletonRows rows={6} cols={7} />
        ) : usage.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(usage.error as Error).message} />
          </div>
        ) : requestRows.length === 0 ? (
          <Empty className="border-0">{t('us.requests_empty')}</Empty>
        ) : (
          <RequestTable rows={requestRows} />
        )}
      </Section>

      <Section
        title={t('us.ledger_title')}
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={<Pager page={ledgerPage} setPage={setLedgerPage} hasNext={hasNextLedger} loading={ledger.isFetching} />}
      >
        {ledger.isPending ? (
          <SkeletonRows rows={5} cols={5} />
        ) : ledger.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(ledger.error as Error).message} />
          </div>
        ) : ledgerRows.length === 0 ? (
          <Empty className="border-0">{t('us.ledger_empty')}</Empty>
        ) : (
          <LedgerTable rows={ledgerRows} />
        )}
      </Section>
    </div>
  );
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

function RequestTable({ rows }: { rows: RequestRow[] }) {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[8.5rem] sm:w-[9.5rem]">{t('us.col_time')}</TableHead>
          <TableHead className="w-28 sm:w-auto sm:min-w-32">{t('us.col_model')}</TableHead>
          <TableHead className="hidden w-16 sm:table-cell">{t('us.col_status')}</TableHead>
          <TableHead className="hidden w-20 text-right sm:table-cell">{t('us.col_latency')}</TableHead>
          <TableHead className="hidden w-24 text-right xl:table-cell">{t('us.col_tokens')}</TableHead>
          <TableHead className="w-[5.5rem] text-right">{t('us.col_fee')}</TableHead>
          <TableHead className="hidden w-48 xl:table-cell">{t('us.col_request_id')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="text-xs text-muted-foreground tabular-nums">{when(row.created_at)}</TableCell>
            <TableCell className="max-w-28 truncate font-mono text-xs sm:max-w-56" title={row.model}>
              {row.model || '—'}
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <StatusBadge status={row.status} statusCode={row.status_code} />
            </TableCell>
            <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">{latency(row.latency_ms)}</TableCell>
            <TableCell className="hidden text-right text-xs tabular-nums xl:table-cell">
              {tokens(row.prompt_tokens)} / {tokens(row.completion_tokens)}
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">{usd(row.fee_micros)}</TableCell>
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

function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[9.5rem]">{t('us.col_time')}</TableHead>
          <TableHead className="w-24 sm:w-48">{t('us.col_kind')}</TableHead>
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
            <TableCell className="text-right text-xs tabular-nums">{signedUsd(row.amount_micros)}</TableCell>
            <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">{usd(row.balance_after_micros)}</TableCell>
            <TableCell className="hidden lg:table-cell">
              <code className="text-[11px] text-muted-foreground">{row.request_id ?? '—'}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
