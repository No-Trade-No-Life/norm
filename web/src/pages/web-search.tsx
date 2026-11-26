import { Loader2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { consumerError } from '../api';
import { BillBar, type Bill } from '../components/call-bill';
import { ModelPicker } from '../components/model-picker';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { consumerResponse } from '../consumer-key';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { candidateModels } from '../lib/catalog';
import { hostOfUrl, readSearchOutcome, type SearchOutcome } from '../lib/web-search';
import { useModelCatalog } from '../queries';

/**
 * 联网搜索：走 Responses 入口，请求里带一个 `web_search` 工具。
 *
 * 搜索是**上游自己的工具**，Norm 只负责把 `tools` 原样交出去（同方言直通不转换），
 * 再把出处从回包的 `url_citation` 注记里读出来。所以候选模型只取 `openai-responses`
 * 与 `deepseek` 那两条协议的上游——别的方言要么没有这个工具，要么桥接时会被丢掉。
 */
export function WebSearchPage() {
  const { t } = useI18n();
  const { identity } = useIdentity();
  const catalog = useModelCatalog(true);
  const options = useMemo(
    () => candidateModels(catalog.data, { protocols: ['openai-responses', 'deepseek'] }),
    [catalog.data],
  );

  const [model, setModel] = useState('');
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!model && options.length > 0) setModel(options[0]);
  }, [model, options]);

  const search = async () => {
    setError(null);
    if (!query.trim()) return setError(t('ws.need_query'));
    if (!model.trim()) return setError(t('ws.need_model'));

    setRunning(true);
    setOutcome(null);
    setBill(null);

    const body = JSON.stringify({
      model: model.trim(),
      input: query.trim(),
      tools: [{ type: 'web_search' }],
      stream: false,
    });

    try {
      const response = await consumerResponse({
        address: identity.address,
        path: '/v1/responses',
        method: 'POST',
        body,
      });
      if (!response.ok) throw await consumerError(response);

      const payload = (await response.json()) as { norm?: Bill };
      const result = readSearchOutcome(payload);
      setOutcome(result);
      if (payload.norm) setBill(payload.norm);
      if (!result.answer) setError(t('ws.empty_result'));
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

          <ModelPicker
            value={model}
            onChange={setModel}
            options={options}
            placeholder={t('ws.model_placeholder')}
            status={
              catalog.isPending
                ? t('tool.models_loading')
                : catalog.isError
                  ? t('tool.models_failed')
                  : options.length > 0
                    ? t('ws.models_count', { count: options.length })
                    : t('ws.no_model')
            }
          />

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
            <h2 className="text-sm font-semibold">{t('ws.answer')}</h2>
            {outcome?.queries.length ? (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-muted-foreground">{t('ws.queries')}</span>
                {outcome.queries.map((item) => (
                  <Badge key={item} variant="outline" className="font-mono text-[10px]">
                    {item}
                  </Badge>
                ))}
              </div>
            ) : null}
          </header>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {outcome?.answer ? (
              <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">{outcome.answer}</p>
            ) : (
              <Empty className="border-0">{running ? t('ws.running') : t('ws.empty')}</Empty>
            )}
          </div>

          {/* 出处单独一段：模型说了什么是一件事，它从哪儿读来的是另一件事。 */}
          {outcome ? (
            <div className="border-t border-border px-3 py-2">
              <p className="pb-1 text-[11px] font-semibold text-muted-foreground">{t('ws.sources')}</p>
              {outcome.sources.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {outcome.sources.map((source) => (
                    <li key={source.url} className="truncate text-[11px]">
                      <a href={source.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                        {source.title ?? hostOfUrl(source.url)}
                      </a>
                      <span className="pl-1.5 text-muted-foreground">{hostOfUrl(source.url)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-muted-foreground">{t('ws.no_sources')}</p>
              )}
            </div>
          ) : null}

          <BillBar bill={bill} empty={t('tool.bill_empty')} />
        </section>
      </div>
    </div>
  );
}
