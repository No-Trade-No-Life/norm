import { useMemo } from 'react';

import { ErrorNote, Section } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useI18n } from '../i18n';
import { latency, percent, signedUsd, tokens, usd } from '../lib/format';
import { useFaucet, useMe } from '../queries';
import { UsageShell } from './usage-shell';

/**
 * 账本 · 总览：只回答「我现在有多少钱、花到哪里去了」。
 *
 * 这一页只发一条请求（`/account/me`）。余额、六块只增累计数、Token 三项、Gas/Token 构成与延迟
 * 都在这一条里一次取齐——它们是同一次扫描的结果，拆开只会多扫几遍。
 *
 * 明细、上游收入、账户流水与聚合各自是独立的一页：那些页背后的查询成本比这里高一个量级
 * （聚合要把时间窗内的请求全扫一遍），不该被「只想看一眼余额」的人顺带读掉。
 */
export function UsagePage() {
  const { t } = useI18n();
  const me = useMe(true);
  const faucet = useFaucet();

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
    <UsageShell title={t('us.title')} description={t('us.desc')}>
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

      {/*
        测试期的虚拟充值：虚线边框 + 右上角「测试期」徽标，让它在一屏黑白卡片里一眼就是「临时」的。
        按钮与结果/报错同在一行，报错不会掉到长列表末尾。
      */}
      <Section
        title={t('us.faucet_title')}
        description={t('us.faucet_desc')}
        className="border-dashed"
        actions={<Badge variant="outline">{t('us.faucet_badge')}</Badge>}
      >
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <Button onClick={() => faucet.mutate()} disabled={faucet.isPending}>
            {faucet.isPending ? t('us.faucet_pending') : t('us.faucet_action')}
          </Button>
          {faucet.isError ? <ErrorNote message={(faucet.error as Error).message} /> : null}
          {faucet.data ? (
            <p className="text-xs text-muted-foreground">
              {t('us.faucet_done', { amount: usd(faucet.data.credited_nanos) })}
              {' · '}
              {t('us.faucet_remaining', { amount: usd(faucet.data.remaining_nanos) })}
            </p>
          ) : null}
        </div>
      </Section>

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
    </UsageShell>
  );
}
