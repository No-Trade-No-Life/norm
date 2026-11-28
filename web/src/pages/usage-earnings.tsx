import { Empty, ErrorNote, Section, SkeletonRows } from '../components/page';
import { useI18n } from '../i18n';
import { useEarnings } from '../queries';
import { Pager, UsageShell, useCursorPages } from './usage-shell';
import { EarningsTable } from './usage-tables';

/** 账本 · 上游收入：他人调用你上游时转入的 Token 价值，逐条可核。 */
export function UsageEarningsPage() {
  const { t } = useI18n();
  const earnings = useCursorPages<string>((cursor) => useEarnings(true, cursor));

  return (
    <UsageShell title={t('us.earnings_title')} description={t('us.earnings_desc')}>
      <Section
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={
          <Pager
            page={earnings.page}
            setPage={earnings.setPage}
            hasNext={earnings.hasNext}
            loading={earnings.query.isFetching}
          />
        }
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
    </UsageShell>
  );
}
