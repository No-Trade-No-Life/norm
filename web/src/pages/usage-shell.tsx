import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { PageHeader } from '../components/page';
import { Button } from '../components/ui/button';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { PER_PAGE } from '../queries';

/**
 * 账本的五块，每块一条独立路由。
 *
 * 拆开的原因不是排版，是请求：这五块背后的成本差得很远——总览是一条聚合查询，明细/收入/流水
 * 是三次走主键的游标翻页，聚合则要把该账户在时间窗内的请求全扫一遍。放在同一页时，只想看一眼
 * 余额的人也会把全量聚合读一遍。现在打开哪一块，就只请求哪一块。
 */
export const USAGE_TABS = [
  { to: '/usage', labelKey: 'us.tab_overview' },
  { to: '/usage/requests', labelKey: 'us.tab_requests' },
  { to: '/usage/earnings', labelKey: 'us.tab_earnings' },
  { to: '/usage/ledger', labelKey: 'us.tab_ledger' },
  // 两张聚合各是一页：它们查的是两张不同的表（按钥匙 / 按上游），放在一起就是其中一张白算。
  { to: '/usage/by-consumer', labelKey: 'us.tab_by_consumer' },
  { to: '/usage/by-provider', labelKey: 'us.tab_by_provider' },
] as const;

/**
 * 聚合的时间窗。默认近 30 天：聚合要把窗口内的请求全扫一遍，默认全量等于每开一次页面
 * 就把整个历史读一遍——而「谁花的、花在哪」这类问题，一个季度以前的答案基本没人再看。
 */
export const WINDOWS = [
  { days: 7, labelKey: 'us.window_7' },
  { days: 30, labelKey: 'us.window_30' },
  { days: 90, labelKey: 'us.window_90' },
  { days: 0, labelKey: 'us.window_all' },
] as const;

/** 聚合页上的窗口选择器。窗口进查询 key：换窗口就是另一份数据，不能复用。 */
export function WindowPicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-xs text-muted-foreground">{t('us.window')}</span>
      {WINDOWS.map((option) => (
        <Button
          key={option.days}
          size="sm"
          variant={days === option.days ? 'default' : 'ghost'}
          onClick={() => onChange(option.days)}
        >
          {t(option.labelKey)}
        </Button>
      ))}
    </div>
  );
}

/** 账本各页共用的外壳：标题 + 分区导航。子页面只负责自己那一段数据与表格。 */
export function UsageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={description} />
      <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
        {USAGE_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            // 只有 /usage 需要精确匹配，否则它在 /usage/requests 上也会点亮。
            end={tab.to === '/usage'}
            className={({ isActive }) =>
              cn(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )
            }
          >
            {t(tab.labelKey)}
          </NavLink>
        ))}
      </nav>
      {children}
    </div>
  );
}

/**
 * 游标翻页：`cursors` 记下每一页的起点（第一页是 undefined），`page` 是当前页号。
 *
 * 为什么不用页码：账本只追加，用 OFFSET 翻页会在新行插入时把同一行显示两次或漏掉一行；
 * 游标翻页每次都从「上一页最后一行」继续往旧的方向走，看到的永远是稳定的历史。
 */
export function useCursorPages<K extends string | number>(
  useRows: (cursor: K | undefined) => {
    data?: unknown[];
    isPending: boolean;
    isError: boolean;
    error: unknown;
    isFetching: boolean;
  },
) {
  const [cursors, setCursors] = useState<Array<K | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const query = useRows(cursors[page]);
  const rows = (query.data ?? []) as never[];

  return {
    rows,
    page,
    query,
    // 取到满页就说明后面可能还有；不为了「下一页」按钮多打一次请求。
    hasNext: rows.length === PER_PAGE,
    setPage: (next: number) => {
      if (next < page) return setPage(next);
      const last = rows.at(-1) as Record<string, K> | undefined;
      if (!last) return;
      const cursor = (last.cursor ?? last.id) as K;
      setCursors((current) => [...current.slice(0, page + 1), cursor]);
      setPage(page + 1);
    },
  };
}

export function Pager({
  page,
  setPage,
  hasNext,
  loading,
}: {
  page: number;
  setPage: (value: number) => void;
  hasNext: boolean;
  loading: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={page === 0 || loading}
        onClick={() => setPage(Math.max(0, page - 1))}
        aria-label={t('action.prev')}
      >
        <ChevronLeftIcon />
      </Button>
      <span className="min-w-14 text-center text-xs text-muted-foreground tabular-nums">
        {t('us.page', { page: page + 1 })}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!hasNext || loading}
        onClick={() => setPage(page + 1)}
        aria-label={t('action.next')}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
