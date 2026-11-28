import { Empty, ErrorNote, Section, SkeletonRows } from '../components/page';
import { useI18n } from '../i18n';
import { useLedger } from '../queries';
import { Pager, UsageShell, useCursorPages } from './usage-shell';
import { LedgerTable } from './usage-tables';

/** 账本 · 账户流水：券、充值、提现，只记账户级进项。 */
export function UsageLedgerPage() {
  const { t } = useI18n();
  const ledger = useCursorPages<number>((cursor) => useLedger(true, cursor));

  return (
    <UsageShell title={t('us.ledger_title')} description={t('us.ledger_desc')}>
      <Section
        description={t('us.page_of_hint')}
        bodyClassName="p-0"
        actions={
          <Pager
            page={ledger.page}
            setPage={ledger.setPage}
            hasNext={ledger.hasNext}
            loading={ledger.query.isFetching}
          />
        }
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
    </UsageShell>
  );
}
