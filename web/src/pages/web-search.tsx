import { Loader2Icon } from 'lucide-react';
import { useState } from 'react';

import { consumerError } from '../api';
import { BillBar, type Bill } from '../components/call-bill';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { consumerResponse } from '../consumer-key';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { hostOfUrl, readSearchOutcome, type SearchOutcome } from '../lib/web-search';

/** 下游能选的两条搜索协议：一条直连搜索引擎，一条把宿主模型 + web_search 包成搜索。 */
const SOURCES = ['deepseek', 'openai'] as const;

type SearchSourceName = (typeof SOURCES)[number];

/**
 * 联网搜索：`POST /v1/web-search`，一条**独立端点**。
 *
 * 这里没有「模型」可挑，因为搜索不挑型号：`deepseek` 那条直连 Search API，根本不跑模型；
 * `openai` 那条的宿主模型是上游部署时定下的，不是调用方的参数。能选的是**走哪条搜索协议**，
 * 于是页面把原来的模型下拉换成一个来源下拉，并在下面说清这一条是怎么搜的。
 *
 * 回包也是 Norm 自己的信封（`sources[]`），不再是某家上游的 Responses 体——所以右边这一
 * 栏画的是「这次命中了哪几页」，而不是让模型复述的一段话。
 */
export function WebSearchPage() {
  const { t } = useI18n();
  const { identity } = useIdentity();

  const [source, setSource] = useState<SearchSourceName>('deepseek');
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const search = async () => {
    setError(null);
    if (!query.trim()) return setError(t('ws.need_query'));

    setRunning(true);
    setOutcome(null);
    setBill(null);

    try {
      const response = await consumerResponse({
        address: identity.address,
        path: '/v1/web-search',
        method: 'POST',
        body: JSON.stringify({ source, query: query.trim() }),
      });
      if (!response.ok) throw await consumerError(response);

      const payload = (await response.json()) as { norm?: Bill };
      const result = readSearchOutcome(payload);
      setOutcome(result);
      if (payload.norm) setBill(payload.norm);
      if (result.sources.length === 0) setError(t('ws.empty_result'));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PageHeader
        title={t('ws.title')}
        description={t('ws.desc')}
        actions={<code className="text-[11px] text-muted-foreground">{t('ws.entry')}</code>}
      />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('ws.query')}</Label>
            <Textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('ws.query_placeholder')}
              rows={5}
              className="min-h-24 resize-y"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void search();
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('ws.source')}</Label>
            <Select
              value={source}
              onValueChange={(next) => setSource(String(next) as SearchSourceName)}
              items={SOURCES.map((item) => ({ value: item, label: t(`ws.source_${item}`) }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`ws.source_${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t(`ws.source_hint_${source}`)}</p>
          </div>

          {error ? <ErrorNote title={t('ws.failed')} message={error} /> : null}

          <div className="flex items-center justify-end">
            <Button onClick={() => void search()} disabled={running}>
              {running ? <Loader2Icon className="animate-spin" /> : null}
              {running ? t('ws.running') : t('ws.run')}
            </Button>
          </div>
        </section>

        <section className="flex min-h-[26rem] flex-col rounded-xl border border-border bg-card lg:min-h-0">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <h2 className="text-sm font-semibold">{t('ws.results')}</h2>
            {outcome?.source ? (
              <Badge variant="outline" className="font-mono text-[10px]">
                {outcome.source}
              </Badge>
            ) : null}
          </header>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {outcome && outcome.sources.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border">
                {outcome.sources.map((item) => (
                  <li key={item.url} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[13px] leading-snug break-words underline-offset-4 hover:underline"
                    >
                      {item.title ?? hostOfUrl(item.url)}
                    </a>
                    <span className="truncate font-mono text-[10px] text-muted-foreground">{hostOfUrl(item.url)}</span>
                    {item.snippet ? (
                      <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">{item.snippet}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty className="border-0">{running ? t('ws.running') : t('ws.empty')}</Empty>
            )}
          </div>

          <BillBar bill={bill} empty={t('tool.bill_empty')} />
        </section>
      </div>
    </div>
  );
}
