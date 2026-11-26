import { ServerIcon } from 'lucide-react';

import { useI18n } from '../i18n';
import { latency, usd } from '../lib/format';
import type { Bill } from '../types';
import { Badge } from './ui/badge';

export type { Bill };

/**
 * 一次调用的账单条。所有工具页共用这一条，因为它回答的是同一组问题：
 * 这一笔的 request_id、Gas 与 Token 各多少、余下多少、多快、打到了哪台主机。
 */
export function BillBar({ bill, empty }: { bill: Bill | null; empty: string }) {
  const { t } = useI18n();
  if (!bill) {
    return <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">{empty}</div>;
  }

  const gas = bill.gas_billed_nanos ?? bill.gas_fee_nanos ?? null;
  const token = bill.token_billed_nanos ?? bill.token_nanos ?? null;
  const audio = bill.audio_ms ?? 0;
  const characters = bill.audio_characters ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      {bill.request_id ? (
        <span className="flex items-center gap-1">
          {t('pg.request_id')}
          <code className="text-foreground">{bill.request_id}</code>
        </span>
      ) : null}
      {gas !== null ? (
        <span>
          {t('pg.gas_fee')} <code className="text-foreground">{usd(gas)}</code>
        </span>
      ) : null}
      {token !== null ? (
        <span>
          {t('pg.token_fee')}{' '}
          <code className={token > 0 ? 'text-foreground' : 'text-muted-foreground'}>{usd(token)}</code>{' '}
          <span className="text-[10px]">
            ({bill.pool ? t('pg.token_to_provider') : bill.pool === false ? t('pg.token_own') : t('bill.partial')})
          </span>
        </span>
      ) : null}
      {audio > 0 ? (
        <span>
          {t('bill.audio')} <code className="text-foreground">{`${(audio / 1000).toFixed(1)} s`}</code>
        </span>
      ) : null}
      {characters > 0 ? (
        <span>
          {t('bill.characters')} <code className="text-foreground">{characters}</code>
        </span>
      ) : null}
      {bill.balance_nanos !== null && bill.balance_nanos !== undefined ? (
        <span>
          {t('pg.balance')} <code className="text-foreground">{usd(bill.balance_nanos)}</code>
        </span>
      ) : null}
      {bill.latency_ms !== null && bill.latency_ms !== undefined ? (
        <span>
          {t('pg.latency')} <code className="text-foreground">{latency(bill.latency_ms)}</code>
        </span>
      ) : null}
      {bill.host ? (
        <span className="flex items-center gap-1">
          <ServerIcon className="size-3.5" />
          {t('pg.provider_host')} <code className="text-foreground">{bill.host}</code>
        </span>
      ) : null}
      {bill.pool ? <Badge variant="outline">{t('pg.pool_badge')}</Badge> : null}
    </div>
  );
}

/** 把转发面 `norm` 对象（或它的子集）转成账单条的形状。 */
export function billOf(meta: Partial<Bill> | null | undefined): Bill | null {
  return meta ? (meta as Bill) : null;
}
