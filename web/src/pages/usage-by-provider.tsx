import { useState } from 'react';

import { Empty, ErrorNote, Section, SkeletonRows } from '../components/page';
import { useI18n } from '../i18n';
import { useUsageByProvider } from '../queries';
import { UsageShell, WindowPicker } from './usage-shell';
import { ByProviderTable } from './usage-tables';

/**
 * 账本 · 按上游提供商（钱花在哪）。
 *
 * 与「按钥匙」分成两页：两次聚合是两个查询，各自都要扫一遍时间窗。合成一页时，
 * 只想看「钱花在哪」的人也会把「谁在花」那一次扫描一并付掉。
 */
export function UsageByProviderPage() {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(30);
  const byProvider = useUsageByProvider(true, days);

  return (
    <UsageShell title={t('us.by_provider_title')} description={t('us.by_provider_desc')}>
      <WindowPicker days={days} onChange={setDays} />
      <Section bodyClassName="p-0">
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
    </UsageShell>
  );
}
