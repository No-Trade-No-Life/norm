import { Empty, ErrorNote, Section, SkeletonRows } from '../components/page';
import { useI18n } from '../i18n';
import { useUsage } from '../queries';
import { Pager, UsageShell, useCursorPages } from './usage-shell';
import { RequestTable } from './usage-tables';

/** 账本 · 消费明细：逐条请求，Gas 与 Token 分列。只请求这一页要的数据。 */
export function UsageRequestsPage() {
  const { t } = useI18n();
  const usage = useCursorPages<string>((cursor) => useUsage(true, cursor));

  return (
    <UsageShell title={t('us.requests_title')} description={t('us.requests_desc')}>
      <Section
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={
          <Pager
            page={usage.page}
            setPage={usage.setPage}
            hasNext={usage.hasNext}
            loading={usage.query.isFetching}
          />
        }
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
          <RequestTable rows={usage.rows} />
        )}
      </Section>
    </UsageShell>
  );
}
