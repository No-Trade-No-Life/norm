import { ExternalLinkIcon } from 'lucide-react';

import { ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Button } from '../components/ui/button';
import { useI18n } from '../i18n';
import { useAttestation } from '../queries';

export function AttestationPage() {
  const { t } = useI18n();
  const attestation = useAttestation();
  const data = attestation.data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('at.title')} description={t('at.desc')} />

      {attestation.isError ? <ErrorNote title={t('at.load_failed')} message={(attestation.error as Error).message} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Section title={t('at.build_title')} bodyClassName="p-0">
          {attestation.isPending ? (
            <SkeletonRows rows={5} cols={2} />
          ) : (
            <dl className="divide-y divide-border text-sm">
              <Row label={t('at.commit')} value={data?.commit} mono />
              <Row label={t('at.built_at')} value={data?.built_at} mono />
              <Row label={t('at.source_sha')} value={data?.source_sha256} mono wrap />
              <Row label={t('at.assets_sha')} value={data?.assets_sha256} mono wrap />
              <Row
                label={t('at.run')}
                value={
                  data?.run_url ? (
                    <a className="inline-flex items-center gap-1 text-foreground underline underline-offset-2" href={data.run_url} target="_blank" rel="noreferrer">
                      {t('action.open_run')}
                      <ExternalLinkIcon className="size-3.5" />
                    </a>
                  ) : undefined
                }
              />
              <Row
                label={t('at.repo')}
                value={
                  data?.repository ? (
                    <a className="inline-flex items-center gap-1 text-foreground underline underline-offset-2" href={data.repository} target="_blank" rel="noreferrer">
                      {data.repository.replace('https://github.com/', '')}
                      <ExternalLinkIcon className="size-3.5" />
                    </a>
                  ) : undefined
                }
              />
            </dl>
          )}
        </Section>

        <div className="flex flex-col gap-4">
          <Section title={t('at.policy')} bodyClassName="p-0">
            <dl className="divide-y divide-border text-sm">
              <Row label={t('at.policy_logs')} value={data?.policy.logs} />
              <Row label={t('at.policy_storage')} value={data?.policy.storage} />
              <Row label={t('at.policy_keys')} value={data?.policy.keys} />
            </dl>
          </Section>

          <Section title={t('at.how_title')} bodyClassName="p-3">
            <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs leading-relaxed text-muted-foreground">
              <li>{t('at.how_1')}</li>
              <li>
                {t('at.how_2').split('pnpm i && pnpm build')[0]}
                <code className="rounded bg-muted px-1 py-0.5 text-foreground">pnpm i && pnpm build</code>
                {t('at.how_2').split('pnpm i && pnpm build')[1] ?? ''}
              </li>
              <li>{t('at.how_3')}</li>
              <li>{t('at.how_4')}</li>
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" render={<a href={data?.repository ?? '#'} target="_blank" rel="noreferrer" />}>
                {t('action.open_repo')}
                <ExternalLinkIcon />
              </Button>
              {data?.run_url ? (
                <Button variant="outline" size="sm" render={<a href={data.run_url} target="_blank" rel="noreferrer" />}>
                  {t('action.open_run')}
                  <ExternalLinkIcon />
                </Button>
              ) : null}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono, wrap }: { label: string; value?: React.ReactNode; mono?: boolean; wrap?: boolean }) {
  const { t } = useI18n();
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? 'min-w-0 flex-1 font-mono text-xs' : 'min-w-0 flex-1 text-xs'}>
        {empty ? (
          <span className="text-muted-foreground">{t('at.empty_value')}</span>
        ) : wrap ? (
          <span className="break-all">{value}</span>
        ) : (
          <span className="break-words">{value}</span>
        )}
      </dd>
    </div>
  );
}
