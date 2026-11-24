import { useMemo, useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { when } from '../lib/format';
import { sourceLabel } from '../lib/labels';
import { useProvenance } from '../queries';
import type { ProvenanceItem } from '../types';

type Verdict = 'all' | 'watered' | 'ok';

export function ProvenancePage() {
  const { t, lang } = useI18n();
  const provenance = useProvenance();
  const [verdict, setVerdict] = useState<Verdict>('all');
  const [query, setQuery] = useState('');

  const items = provenance.data ?? [];
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        const verified = item.provenance?.verified === true;
        if (verdict === 'watered' && verified) return false;
        if (verdict === 'ok' && !verified) return false;
        if (!query.trim()) return true;
        const needle = query.trim().toLowerCase();
        return (
          item.label.toLowerCase().includes(needle) ||
          item.base_url.toLowerCase().includes(needle) ||
          item.provider.toLowerCase().includes(needle)
        );
      }),
    [items, query, verdict],
  );

  const wateredCount = items.filter((item) => item.provenance?.verified !== true).length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('pv.title')}
        description={t('pv.desc')}
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('pv.col_label')}
              className="h-7 w-full text-xs sm:w-40"
            />
            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
              {(['all', 'watered', 'ok'] as const).map((value) => (
                <Button
                  key={value}
                  size="xs"
                  variant={verdict === value ? 'default' : 'ghost'}
                  onClick={() => setVerdict(value)}
                >
                  {value === 'all' ? t('pv.filter_all') : value === 'watered' ? t('pv.watered') : t('pv.ok')}
                </Button>
              ))}
            </div>
            {wateredCount > 0 ? (
              <Badge variant="destructive">
                {wateredCount} {t('pv.watered')}
              </Badge>
            ) : null}
          </div>
        }
      />

      {provenance.isError ? <ErrorNote title={t('pv.load_failed')} message={(provenance.error as Error).message} /> : null}

      <Section bodyClassName="p-0">
        {provenance.isPending ? (
          <SkeletonRows rows={5} cols={6} />
        ) : filtered.length === 0 ? (
          <Empty className="border-0">{t('pv.empty')}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pv.col_verdict')}</TableHead>
                <TableHead>{t('pv.col_label')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('pv.col_source')}</TableHead>
                <TableHead className="hidden min-w-32 sm:table-cell lg:min-w-44">{t('pv.col_base_url')}</TableHead>
                <TableHead className="hidden w-20 lg:table-cell">{t('pv.col_host')}</TableHead>
                <TableHead className="hidden w-24 lg:table-cell">{t('pv.col_prefix')}</TableHead>
                <TableHead className="w-32 lg:hidden">{t('pv.col_signals')}</TableHead>
                <TableHead className="hidden w-28 xl:table-cell">{t('pv.col_probe')}</TableHead>
                <TableHead className="hidden w-36 lg:table-cell">{t('pv.col_checked')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => (
                <ProvenanceRow key={item.id} item={item} lang={lang} />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function SignalCell({ hit }: { hit: boolean | null }) {
  const { t } = useI18n();
  if (hit === null) return <span className="text-xs text-muted-foreground">{t('pv.unknown')}</span>;
  return <Badge variant={hit ? 'secondary' : 'outline'}>{hit ? t('pv.hit') : t('pv.miss')}</Badge>;
}

function CompactSignal({ label, hit }: { label: string; hit: boolean | null }) {
  if (hit === null) return <span className="text-[11px] text-muted-foreground">{label} ?</span>;
  return (
    <span className={hit ? 'text-[11px] text-foreground' : 'text-[11px] text-destructive'}>
      {label} {hit ? '✓' : '✗'}
    </span>
  );
}

function ProvenanceRow({ item, lang }: { item: ProvenanceItem; lang: 'zh' | 'en' }) {
  const { t } = useI18n();
  const detail = item.provenance;
  const verified = detail?.verified === true;
  return (
    <TableRow className={verified ? undefined : 'bg-destructive/5'}>
      <TableCell>
        <Badge variant={verified ? 'secondary' : 'destructive'}>{verified ? t('pv.ok') : t('pv.watered')}</Badge>
      </TableCell>
      <TableCell className="font-medium">
        <span className="block max-w-40 truncate" title={item.label}>
          {item.label}
        </span>
        <span className="block font-mono text-[11px] text-muted-foreground">{item.key_hint}</span>
        {/* 手机上没有 base_url 列，host 就贴在这里——掺水的依据不能被藏起来。 */}
        <span className="block max-w-32 truncate text-[11px] text-muted-foreground sm:hidden" title={item.base_url}>
          {detail?.host ?? '—'}
        </span>
      </TableCell>
      <TableCell className="hidden text-xs lg:table-cell">{sourceLabel(item.declared_source, lang)}</TableCell>
      <TableCell className="hidden max-w-64 sm:table-cell">
        <span className="block truncate font-mono text-xs" title={item.base_url}>
          {item.base_url}
        </span>
        <span className="block text-[11px] text-muted-foreground">{detail?.host ?? '—'}</span>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <SignalCell hit={detail?.checks?.host ?? null} />
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <SignalCell hit={detail?.checks?.key_prefix ?? null} />
      </TableCell>
      <TableCell className="lg:hidden">
        <div className="flex flex-wrap gap-1">
          <CompactSignal label="host" hit={detail?.checks?.host ?? null} />
          <CompactSignal label="prefix" hit={detail?.checks?.key_prefix ?? null} />
        </div>
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        <SignalCell hit={detail?.checks?.models_probe ?? null} />
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground tabular-nums lg:table-cell">
        {when(detail?.checked_at)}
        <span className="sr-only">{detail?.note}</span>
      </TableCell>
    </TableRow>
  );
}
