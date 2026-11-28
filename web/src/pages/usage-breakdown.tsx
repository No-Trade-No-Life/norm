import { useState } from 'react';

import { Empty, ErrorNote, Section, SkeletonRows } from '../components/page';
import { Button } from '../components/ui/button';
import { useI18n } from '../i18n';
import { useUsageByConsumer, useUsageByProvider } from '../queries';
import { UsageShell } from './usage-shell';
import { ByConsumerTable, ByProviderTable } from './usage-tables';

/**
 * 聚合的时间窗。默认近 30 天：聚合要把窗口内的请求全扫一遍，默认全量等于每开一次页面
 * 就把整个历史读一遍——而「谁花的、花在哪」这类问题，一个季度以前的答案基本没人再看。
 */
const WINDOWS = [
  { days: 7, labelKey: 'us.window_7' },
  { days: 30, labelKey: 'us.window_30' },
  { days: 90, labelKey: 'us.window_90' },
  { days: 0, labelKey: 'us.window_all' },
] as const;

/** 账本 · 聚合：谁花的（按钥匙）、花在哪（按上游）。这一页是唯一会扫时间窗的地方。 */
export function UsageBreakdownPage() {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(30);
  const byConsumer = useUsageByConsumer(true, days);
  const byProvider = useUsageByProvider(true, days);

  return (
    <UsageShell title={t('us.breakdown_title')} description={t('us.breakdown_desc')}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">{t('us.window')}</span>
        {WINDOWS.map((option) => (
          <Button
            key={option.days}
            size="sm"
            variant={days === option.days ? 'default' : 'ghost'}
            onClick={() => setDays(option.days)}
          >
            {t(option.labelKey)}
          </Button>
        ))}
      </div>

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
    </UsageShell>
  );
}
