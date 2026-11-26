import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RotateCwIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import type { Lang } from '../copy';
import { perMillion, when } from '../lib/format';
import { modalityLabel, protocolLabel, trustLabel } from '../lib/labels';
import { useModelCatalog } from '../queries';
import { PROTOCOLS, type CatalogModel, type CatalogProvider } from '../types';

const ALL = 'all';

/** 一次问多少条上游由服务端定；这里只把它写在「没问」的原因里。 */
const MAX_PROBES = 24;

/**
 * 窄屏藏掉哪一列。上游与协议都能从模型名下面那一行与落点推回来，
 * 而「谁有它」在模型名下面有一份完整的文字副本——事实不能被表宽挤掉。
 */
const COLUMN_CLASS: Record<string, string> = {
  official: 'hidden md:table-cell',
  providers: 'hidden md:table-cell',
  protocol: 'hidden lg:table-cell',
};

/** 输出里有非文本模态：这类模型根本走不了 chat completions，值得单独标出来。 */
const textOnly = (output: string[]): boolean => output.every((token) => token === 'text');

/**
 * 一侧的模态词。空数组 = 上游这一侧没说——不补默认值，也不按模型名猜。
 * `alert` 只给非文本输出用：能读图是能力，只能出图是「这个入口用不了」。
 */
function ModalityChips({ tokens, lang, alert }: { tokens: string[]; lang: Lang; alert?: boolean }) {
  const { t } = useI18n();
  if (tokens.length === 0) {
    return <span className="text-[11px] text-muted-foreground">{t('md.modalities_missing')}</span>;
  }
  return (
    <>
      {tokens.map((token) => (
        <Badge key={token} variant={alert ? 'destructive' : 'outline'} className="px-1.5 font-normal">
          {modalityLabel(token, lang)}
        </Badge>
      ))}
    </>
  );
}

/**
 * 模型列表：账户现在到底能调哪些模型。
 *
 * 一行 = 一个模型名。同一个名字被几条上游提供时合成一行，`providers` 列写清是谁——
 * 因为「能调」这件事在 Norm 里是 per 上游的：同一个 `gpt-4o-mini`，A 家有、B 家没有，
 * 或者 A 家的 key 已失效。所以这页只报事实：谁回了什么、哪几条这次没回、问在哪一刻。
 */
export function ModelsPage() {
  const { t, lang } = useI18n();
  const catalog = useModelCatalog(true);

  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState(ALL);
  const [protocolFilter, setProtocolFilter] = useState(ALL);
  /** 输入模态：只列这次真的有人声明过的，免得给一排点了必然空的下拉项。 */
  const [modalityFilter, setModalityFilter] = useState(ALL);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'id', desc: false }]);

  const providers = useMemo(() => catalog.data?.providers ?? [], [catalog.data]);
  const models = useMemo(() => catalog.data?.models ?? [], [catalog.data]);
  const byId = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  /** 一行模型 → 提供它的那几条上游（撤销后可能缺一条，缺了就当没有）。 */
  const servingOf = (model: CatalogModel): CatalogProvider[] =>
    model.providers.map((id) => byId.get(id)).filter((provider): provider is CatalogProvider => provider !== undefined);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter((model) => {
      if (providerFilter !== ALL && !model.providers.includes(providerFilter)) return false;
      const serving = servingOf(model);
      if (protocolFilter !== ALL && !serving.some((provider) => provider.protocol === protocolFilter)) return false;
      // 没声明模态的行不进任何模态筛选：不知道不等于能。
      if (modalityFilter !== ALL && !(model.modalities?.input.includes(modalityFilter) ?? false)) return false;
      if (!needle) return true;
      return (
        model.id.toLowerCase().includes(needle) ||
        serving.some((provider) => provider.label.toLowerCase().includes(needle))
      );
    });
    // servingOf 只读 byId 与 model，跟着 byId 走即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, byId, providerFilter, protocolFilter, modalityFilter, query]);

  /** 筛选项：这一批数据里出现过的输入模态，按名字排。 */
  const inputModalities = useMemo(() => {
    const seen = new Set<string>();
    for (const model of models) for (const token of model.modalities?.input ?? []) seen.add(token);
    return [...seen].sort();
  }, [models]);

  const columns = useMemo<ColumnDef<CatalogModel>[]>(
    () => [
      {
        id: 'id',
        accessorFn: (model) => model.id,
        header: t('md.col_model'),
        cell: ({ row }) => {
          const serving = servingOf(row.original);
          return (
            <>
              <span className="block max-w-72 truncate font-mono text-xs md:max-w-[28rem]" title={row.original.id}>
                {row.original.id}
              </span>
              {/* 窄屏的上游列藏起来了，这里补一份文字副本。 */}
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground md:hidden">
                {serving.map((provider) => provider.label).join(' · ')}
              </span>
            </>
          );
        },
      },
      {
        id: 'official',
        header: t('md.col_official'),
        enableSorting: false,
        cell: ({ row }) => {
          const official = row.original.official;
          if (!official) return <span className="text-xs text-muted-foreground">{t('md.official_missing')}</span>;
          // 表里只放两个最常比的数（输入 / 输出），缓存价留在 title 里：
          // 这一列是锚点，不是账单。
          return (
            <span
              className="whitespace-nowrap font-mono text-xs tabular-nums"
              title={[
                t('md.official_hint', {
                  match: official.match,
                  input: perMillion(official.input),
                  cached: perMillion(official.cached),
                  output: perMillion(official.output),
                }),
                // 按时段计价的上游（DeepSeek）：单元格里是高峰价，低谷价写在这里。
                official.off_peak
                  ? t('md.official_off_peak', {
                      input: perMillion(official.off_peak.input),
                      cached: perMillion(official.off_peak.cached),
                      output: perMillion(official.off_peak.output),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join('\n')}
            >
              {perMillion(official.input)} / {perMillion(official.output)}
            </span>
          );
        },
      },
      {
        id: 'modalities',
        header: t('md.col_modalities'),
        enableSorting: false,
        cell: ({ row }) => {
          const modalities = row.original.modalities;
          if (!modalities) {
            return (
              <span className="text-xs text-muted-foreground" title={t('md.modalities_missing_hint')}>
                {t('md.modalities_missing')}
              </span>
            );
          }
          // 声明数与警告都写在悬停里：表格是扫一眼用的，句子放不进一格。
          const alert = !textOnly(modalities.output);
          const detail = [
            t('md.modalities_declared', { declared: modalities.declared, total: row.original.providers.length }),
            t('md.modalities_source'),
            alert ? t('md.modalities_output_warning') : null,
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <div className="flex flex-wrap items-center gap-1" title={detail}>
              <ModalityChips tokens={modalities.input} lang={lang} />
              <span className="text-xs text-muted-foreground">→</span>
              <ModalityChips tokens={modalities.output} lang={lang} alert={alert} />
            </div>
          );
        },
      },
      {
        id: 'providers',
        accessorFn: (model) => model.providers.length,
        header: t('md.col_providers'),
        cell: ({ row }) => {
          const serving = servingOf(row.original);
          const shown = serving.slice(0, 2);
          const rest = serving.length - shown.length;
          const detail = serving.map((provider) => `${provider.label} · ${provider.host}`).join('\n');
          return (
            <div className="flex flex-wrap items-center gap-1">
              {shown.map((provider) => (
                <Badge key={provider.id} variant="secondary" className="max-w-44 truncate font-normal" title={detail}>
                  {provider.label}
                </Badge>
              ))}
              {rest > 0 ? (
                <Badge variant="outline" className="font-normal" title={detail}>
                  +{rest}
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'protocol',
        accessorFn: (model) => servingOf(model)[0]?.protocol ?? '',
        header: t('md.col_protocol'),
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {[...new Set(servingOf(row.original).map((provider) => provider.protocol))].map((protocol) => (
              <Badge key={protocol} variant="outline" className="font-normal">
                {protocolLabel(protocol, lang)}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: 'trust',
        header: t('md.col_trust'),
        enableSorting: false,
        cell: ({ row }) => {
          const serving = servingOf(row.original);
          const trusted = serving.filter((provider) => provider.trusted).length;
          if (serving.length > 0 && trusted === serving.length) {
            return <Badge variant="secondary">{trustLabel(true, lang)}</Badge>;
          }
          if (trusted === 0) return <Badge variant="outline">{trustLabel(false, lang)}</Badge>;
          return (
            <Badge variant="outline" title={t('md.trust_mixed_hint', { trusted, off: serving.length - trusted })}>
              {t('md.trust_mixed')}
            </Badge>
          );
        },
      },
    ],
    // servingOf 跟着 byId 走；t / lang 变了要重渲染文案。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, lang, t],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  });

  // 只数真的给出了清单的上游：失败的那几条在下面的「探测情况」里另说。
  const answered = providers.filter((provider) => provider.ok === true).length;
  // 没给出清单的：上游拒了、打不通、密钥解不开，以及这次没问的（禁用 / 超出上限）。
  const problems = providers.filter((provider) => provider.ok !== true);
  const noProvider = catalog.data !== undefined && providers.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('md.title')}
        description={t('md.desc')}
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('md.search')}
              className="h-7 w-full text-xs sm:w-52"
              spellCheck={false}
            />
            <Select value={providerFilter} onValueChange={(value) => setProviderFilter(String(value))}>
              <SelectTrigger size="sm" className="w-full text-xs sm:w-40" aria-label={t('md.filter_provider')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('md.filter_all_providers')}</SelectItem>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={protocolFilter} onValueChange={(value) => setProtocolFilter(String(value))}>
              <SelectTrigger size="sm" className="w-full text-xs sm:w-36" aria-label={t('md.filter_protocol')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('md.filter_all_protocols')}</SelectItem>
                {PROTOCOLS.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {protocolLabel(protocol, lang)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={modalityFilter} onValueChange={(value) => setModalityFilter(String(value))}>
              <SelectTrigger size="sm" className="w-full text-xs sm:w-32" aria-label={t('md.filter_modality_in')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('md.filter_all_modalities')}</SelectItem>
                {inputModalities.map((modality) => (
                  <SelectItem key={modality} value={modality}>
                    {modalityLabel(modality, lang)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={catalog.isFetching}
              onClick={() => void catalog.refetch()}
              aria-label={t('action.refresh')}
            >
              <RotateCwIcon className={catalog.isFetching ? 'animate-spin' : undefined} />
              {t('action.refresh')}
            </Button>
          </div>
        }
      />

      {catalog.isError ? <ErrorNote title={t('md.load_failed')} message={(catalog.error as Error).message} /> : null}

      {problems.length > 0 ? (
        <Section title={t('md.probes_title')} description={t('md.probes_desc')} bodyClassName="p-0">
          <ul className="divide-y divide-border">
            {problems.map((provider) => (
              <li key={provider.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-xs">
                <Badge variant={provider.probed ? 'destructive' : 'outline'} className="font-normal">
                  {t(provider.probed ? 'md.probe_failed' : 'md.probe_unasked')}
                </Badge>
                <span className="max-w-40 truncate font-medium" title={provider.label}>
                  {provider.label}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{provider.host}</span>
                <Badge variant="outline" className="font-normal">
                  {protocolLabel(provider.protocol, lang)}
                </Badge>
                {provider.scope === 'pool' ? (
                  <Badge variant="secondary" className="font-normal">
                    {t('md.pool')}
                  </Badge>
                ) : null}
                <span
                  className={`min-w-0 flex-1 truncate ${provider.probed ? 'text-destructive' : 'text-muted-foreground'}`}
                  title={provider.error ?? undefined}
                >
                  {provider.error ??
                    (provider.enabled === 0
                      ? t('md.probe_disabled')
                      : t('md.probe_skipped', { max: MAX_PROBES }))}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        description={
          catalog.data
            ? t('md.summary', { models: rows.length, providers: answered, time: when(catalog.data.fetched_at) })
            : undefined
        }
        bodyClassName="p-0"
        actions={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
              aria-label={t('action.prev')}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="min-w-14 text-center text-xs text-muted-foreground tabular-nums">
              {t('md.page', { page: table.getState().pagination.pageIndex + 1 })}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
              aria-label={t('action.next')}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        }
      >
        {catalog.isPending ? (
          <SkeletonRows rows={8} cols={4} />
        ) : noProvider ? (
          <Empty className="border-0">
            <span>
              {t('md.empty_no_provider')}{' '}
              <Link to="/providers" className="underline underline-offset-2 hover:text-foreground">
                {t('nav.providers')}
              </Link>
            </span>
          </Empty>
        ) : models.length === 0 ? (
          <Empty className="border-0">{t('md.empty_no_model')}</Empty>
        ) : rows.length === 0 ? (
          <Empty className="border-0">
            <span className="flex flex-col items-center gap-2">
              <span>{t('md.empty_filtered')}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setProviderFilter(ALL);
                  setProtocolFilter(ALL);
                  setModalityFilter(ALL);
                }}
              >
                {t('md.clear_filters')}
              </Button>
            </span>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id} className={COLUMN_CLASS[header.column.id]}>
                      {header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getIsSorted() === 'asc' ? (
                            <ArrowUpIcon className="size-3" />
                          ) : header.column.getIsSorted() === 'desc' ? (
                            <ArrowDownIcon className="size-3" />
                          ) : (
                            <ArrowUpDownIcon className="size-3 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={COLUMN_CLASS[cell.column.id]}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
