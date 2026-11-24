import { useMemo, useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { when } from '../lib/format';
import { protocolLabel, trustLabel } from '../lib/labels';
import { useBaseUrls } from '../queries';
import type { BaseUrlGroup } from '../types';

type Filter = 'all' | 'trusted' | 'untrusted';

/**
 * 上游渠道看板：按 base_url 聚合。
 *
 * 这里不判「官方还是掺水」——只在端上一句事实：这个地址在不在信任清单里，
 * 以及它被多少条凭证用着、其中几条愿意挂到公开看板。判断留给读者。
 */
export function ProvenancePage() {
  const { t, lang } = useI18n();
  const baseUrls = useBaseUrls();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const items = baseUrls.data ?? [];
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (filter === 'trusted' && !item.trusted) return false;
        if (filter === 'untrusted' && item.trusted) return false;
        if (!query.trim()) return true;
        const needle = query.trim().toLowerCase();
        return item.base_url.toLowerCase().includes(needle) || item.host.includes(needle);
      }),
    [items, query, filter],
  );

  const untrusted = items.filter((item) => !item.trusted).length;

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
              placeholder={t('pv.col_base_url')}
              className="h-7 w-full text-xs sm:w-40"
            />
            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
              {(['all', 'trusted', 'untrusted'] as const).map((value) => (
                <Button
                  key={value}
                  size="xs"
                  variant={filter === value ? 'default' : 'ghost'}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all' ? t('pv.filter_all') : trustLabel(value === 'trusted', lang)}
                </Button>
              ))}
            </div>
            {untrusted > 0 ? (
              <Badge variant="outline">
                {untrusted} {t('trust.untrusted')}
              </Badge>
            ) : null}
          </div>
        }
      />

      {baseUrls.isError ? <ErrorNote title={t('pv.load_failed')} message={(baseUrls.error as Error).message} /> : null}

      <Section bodyClassName="p-0">
        {baseUrls.isPending ? (
          <SkeletonRows rows={5} cols={5} />
        ) : filtered.length === 0 ? (
          <Empty className="border-0">{t('pv.empty')}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pv.col_trust')}</TableHead>
                <TableHead className="min-w-32">{t('pv.col_base_url')}</TableHead>
                <TableHead className="hidden w-20 sm:table-cell">{t('pv.col_credentials')}</TableHead>
                <TableHead className="hidden w-20 sm:table-cell">{t('pv.col_public')}</TableHead>
                <TableHead className="hidden min-w-40 md:table-cell">{t('pv.col_protocols')}</TableHead>
                <TableHead className="hidden w-36 lg:table-cell">{t('pv.col_last_seen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => (
                <BaseUrlRow key={item.base_url} item={item} lang={lang} />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function BaseUrlRow({ item, lang }: { item: BaseUrlGroup; lang: 'zh' | 'en' }) {
  const { t } = useI18n();
  return (
    <TableRow className={item.trusted ? undefined : 'bg-muted/40'}>
      <TableCell>
        <Badge variant={item.trusted ? 'secondary' : 'outline'}>{trustLabel(item.trusted, lang)}</Badge>
      </TableCell>
      <TableCell>
        <span className="block max-w-72 truncate font-mono text-xs" title={item.base_url}>
          {item.base_url}
        </span>
        <span className="block text-[11px] text-muted-foreground">{item.host}</span>
        {/* 窄屏没有独立的计数列，把两个数字贴在这里，事实不能被藏起来。 */}
        <span className="block text-[11px] text-muted-foreground sm:hidden">
          {item.credentials} {t('pv.col_credentials')} · {item.public_listed} {t('pv.col_public')}
        </span>
      </TableCell>
      <TableCell className="hidden tabular-nums sm:table-cell">{item.credentials}</TableCell>
      <TableCell className="hidden tabular-nums sm:table-cell">{item.public_listed}</TableCell>
      <TableCell className="hidden md:table-cell">
        <div className="flex flex-wrap gap-1">
          {item.protocols.map((protocol) => (
            <Badge key={protocol} variant="outline" className="font-normal">
              {protocolLabel(protocol, lang)}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground tabular-nums lg:table-cell">
        {when(item.last_seen_at)}
      </TableCell>
    </TableRow>
  );
}
