import { useState } from 'react';

import { Empty, ErrorNote, Section, SkeletonRows } from '../components/page';
import { useI18n } from '../i18n';
import { useUsageByConsumer } from '../queries';
import { UsageShell, WindowPicker } from './usage-shell';
import { ByConsumerTable } from './usage-tables';

/**
 * 账本 · 按下游消费者（谁在花）。
 *
 * 这是「按钥匙聚合」一条查询自己的一页。它和「按上游」查的是同一张表的不同维度，
 * 但两次聚合各自都要把时间窗内的请求扫一遍——放在同一页上，想看其中一个的人会把另一个也扫了。
 */
export function UsageByConsumerPage() {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(30);
  const byConsumer = useUsageByConsumer(true, days);

  return (
    <UsageShell title={t('us.by_consumer_title')} description={t('us.by_consumer_desc')}>
      <WindowPicker days={days} onChange={setDays} />
      <Section bodyClassName="p-0">
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
    </UsageShell>
  );
}
