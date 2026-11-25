import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpIcon, ListIcon, Loader2Icon, PencilIcon, ServerIcon, SquareIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../api';
import { consumerResponse } from '../consumer-key';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { errorText } from '../lib/error-text';
import { latency, usd } from '../lib/format';
import { useModels } from '../queries';
import type { ChatChunk } from '../types';

type NormMeta = NonNullable<ChatChunk['norm']>;

export function PlaygroundPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { identity } = useIdentity();

  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');

  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState('');
  const [meta, setMeta] = useState<NormMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  // 模型清单由服务端代为去问（上游密钥在库里是密文），问的就是接下来会打到的那条：
  // 哪一条由服务端按「自有优先、公共池兜底、会话粘住」决定，这里不指定。
  const models = useModels(true);
  const modelList = useMemo(() => models.data?.data ?? [], [models.data]);
  // 手填模式：清单里有模型时默认让人从清单选，按笔形图标才切回自由输入。
  const [manualModel, setManualModel] = useState(false);
  const pickable = !manualModel && modelList.length > 0;

  /**
   * 清单读到而模型还空着，就填第一个。
   * 不是「猜用户要什么」，只是别让人对着空输入框去记这家上游管模型叫什么。
   */
  useEffect(() => {
    if (!model.trim() && modelList.length > 0) setModel(modelList[0].id);
  }, [model, modelList]);

  useEffect(() => {
    if (!outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const send = useCallback(async () => {
    setError(null);
    if (!model.trim()) return setError(t('pg.need_model'));
    if (!prompt.trim()) return setError(t('pg.need_prompt'));

    setOutput('');
    setMeta(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // body 只序列化一次：签名与发送共用这同一个字符串。
    const body = JSON.stringify({
      model: model.trim(),
      stream,
      messages: [{ role: 'user', content: prompt }],
    });

    try {
      const response = await consumerResponse({
        address: identity.address,
        path: '/v1/chat/completions',
        method: 'POST',
        body,
        // 推理接口只认下游 Token（不认签名），这把 Token 在本机现铸现用。
        // 上游提供商密钥在服务端，而且**不用指名**：Norm 自己挑，并把结果写进 norm.pool。
        signal: controller.signal,
      });

      if (!response.ok) {
        // 上游提供商的错误体原样回来（这是设计：改写它只会让上游提供商的报错更难查），
        // 所以这里的活儿是把它压成一句话——`error` 常常是一个对象，
        // 直接塞进 JSX 会让整页白屏，用户看到的就是「点了没反应」。
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          // 不是 JSON 就按纯文本用
        }
        throw new ApiError(response.status, 'relay_failed', errorText(parsed, `${response.status} ${response.statusText}`));
      }

      if (!stream) {
        const payload = (await response.json()) as ChatChunk & { choices?: Array<{ message?: { content?: string } }> };
        setOutput(payload.choices?.[0]?.message?.content ?? '');
        if (payload.norm) setMeta(payload.norm);
      } else if (response.body) {
        await consumeStream(response.body, {
          onDelta: (delta) => setOutput((prev) => prev + delta),
          onNorm: (payload) => setMeta(payload),
        });
      }
    } catch (caught) {
      if ((caught as Error).name === 'AbortError') {
        setError(null);
      } else {
        setError((caught as Error).message);
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
      void queryClient.invalidateQueries({ queryKey: ['ledger'] });
    }
  }, [identity.address, model, prompt, queryClient, stream, t]);

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PageHeader
        title={t('pg.title')}
        description={t('pg.desc')}
        actions={
          <div className="flex items-center gap-2">
            <Link to="/consumers" className="text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {t('pg.token_note')}
            </Link>
            <Badge variant="outline" className="font-mono text-[11px]">
              {identity.address.slice(0, 6)}…{identity.address.slice(-4)}
            </Badge>
          </div>
        }
      />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t('pg.routing')}</Label>
              {/* 上游不再由人挑：Norm 自己在「自己的上游 → 公共池」里选，并按会话粘住。 */}
              <Link
                to="/providers"
                className="flex h-8 items-center rounded-lg border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {t('pg.routing_hint')}
              </Link>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>{t('pg.model')}</Label>
                {/* 清单读不到、或上游没列出要用的那个模型时，随时能切回手填。 */}
                {pickable ? (
                  <Button variant="ghost" size="icon-sm" className="-my-1 size-6" aria-label={t('pg.model_manual')} onClick={() => setManualModel(true)}>
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : modelList.length > 0 ? (
                  <Button variant="ghost" size="icon-sm" className="-my-1 size-6" aria-label={t('pg.models_pick')} onClick={() => setManualModel(false)}>
                    <ListIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              {pickable ? (
                <Select
                  value={model}
                  onValueChange={(value) => setModel(String(value))}
                  items={[
                    ...modelList.map((item) => ({ value: item.id, label: item.id })),
                    ...(model && !modelList.some((item) => item.id === model) ? [{ value: model, label: model }] : []),
                  ]}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelList.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        <span className="font-mono text-xs">{item.id}</span>
                      </SelectItem>
                    ))}
                    {model && !modelList.some((item) => item.id === model) ? (
                      <SelectItem value={model}>
                        <span className="font-mono text-xs">{model}</span>
                      </SelectItem>
                    ) : null}
                    <SelectSeparator />
                    <SelectItem value="__manual__" onClick={() => setManualModel(true)}>
                      {t('pg.model_manual')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={t('pg.model_placeholder')} spellCheck={false} />
              )}
              {/* 清单读不到也照样能发：模型名可以手填，路由由服务端负责。 */}
              <p className="text-[11px] text-muted-foreground">
                {models.isPending
                  ? t('pg.models_loading')
                  : models.isError
                    ? t('pg.models_failed')
                    : modelList.length === 0
                      ? t('pg.models_empty')
                      : `${modelList.length} ${t('pg.models_count')} · ${t('pg.models_free')}`}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('pg.prompt')}</Label>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('pg.prompt_placeholder')}
              rows={6}
              className="min-h-32 resize-y"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </div>

          {/* 错误放在输入框正上方，不塞到输出末尾：数据量大时用户永远看不到列表尾部。 */}
          {error ? <ErrorNote title={t('pg.failed')} message={error} /> : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={stream} onCheckedChange={setStream} />
              {t('pg.stream')}
            </label>
            {running ? (
              <Button variant="outline" onClick={stop}>
                <SquareIcon />
                {t('action.stop')}
              </Button>
            ) : (
              <Button onClick={() => void send()}>
                <ArrowUpIcon />
                {t('action.send')}
              </Button>
            )}
          </div>
        </section>

        <section className="flex min-h-[26rem] flex-col rounded-xl border border-border bg-card lg:min-h-0">
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <h2 className="text-sm font-semibold">{t('pg.output')}</h2>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {running ? (
                <>
                  <Loader2Icon className="size-3 animate-spin" />
                  {t('pg.streaming')}
                </>
              ) : null}
            </span>
          </header>
          <div ref={outputRef} className="flex-1 overflow-y-auto px-3 py-3">
            {output ? (
              <pre className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">{output}</pre>
            ) : (
              <Empty className="border-0">{t('pg.output_empty')}</Empty>
            )}
          </div>
          <NormMetaBar meta={meta} />
        </section>
      </div>
    </div>
  );
}

function NormMetaBar({ meta }: { meta: NormMeta | null }) {
  const { t } = useI18n();
  if (!meta) {
    return <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">{t('pg.meta_empty')}</div>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        {t('pg.request_id')}
        <code className="text-foreground">{meta.request_id}</code>
      </span>
      <span>
        {t('pg.fee')} <code className="text-foreground">{usd(meta.fee_nanos)}</code>
      </span>
      <span>
        {t('pg.balance')} <code className="text-foreground">{usd(meta.balance_nanos)}</code>
      </span>
      <span>
        {t('pg.latency')} <code className="text-foreground">{latency(meta.latency_ms)}</code>
      </span>
      {/* 只报事实：这次请求打到了哪台主机。是否可信交给上游提供商页的清单去说。 */}
      <span className="flex items-center gap-1">
        <ServerIcon className="size-3.5" />
        {t('pg.provider_host')} <code className="text-foreground">{meta.host}</code>
      </span>
      {/* 池子里那条是站点付钱：账单上必须说清这一单有没有落到兜底上。 */}
      {meta.pool ? <Badge variant="outline">{t('pg.pool_badge')}</Badge> : null}
    </div>
  );
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  handlers: { onDelta: (delta: string) => void; onNorm: (meta: NormMeta) => void },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = (block: string) => {
    const payload = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!payload || payload === '[DONE]') return;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      return;
    }
    if (chunk.norm) handlers.onNorm(chunk.norm);
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) handlers.onDelta(delta);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      handleEvent(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) handleEvent(buffer);
}
