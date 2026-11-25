import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpIcon, Loader2Icon, ServerIcon, SquareIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, signedFetch } from '../api';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { errorText } from '../lib/error-text';
import { latency, usd } from '../lib/format';
import { useProviders } from '../queries';
import type { ChatChunk, Provider } from '../types';

type NormMeta = NonNullable<ChatChunk['norm']>;

export function PlaygroundPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  const providers = useProviders(true);

  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');

  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState('');
  const [meta, setMeta] = useState<NormMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const list = providers.data?.items ?? [];
  const provider: Provider | undefined = useMemo(
    () => list.find((item) => item.id === providerId) ?? list[0],
    [list, providerId],
  );

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
    if (!provider) return setError(t('pg.need_provider'));
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
      const response = await signedFetch({
        path: '/v1/chat/completions',
        method: 'POST',
        body,
        // 密钥在服务端：这里只说用哪条凭证。明文密钥从不出现在浏览器里。
        headers: { 'X-Norm-Provider': provider.id },
        signal: controller.signal,
      });

      if (!response.ok) {
        // 上游的错误体原样回来（这是设计：改写它只会让上游的报错更难查），
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
  }, [provider, model, prompt, queryClient, stream, t]);

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PageHeader
        title={t('pg.title')}
        description={t('pg.desc')}
        actions={
          <Badge variant="outline" className="font-mono text-[11px]">
            {identity.address.slice(0, 6)}…{identity.address.slice(-4)}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t('pg.provider')}</Label>
              {list.length === 0 ? (
                <Link to="/providers" className="flex h-8 items-center rounded-lg border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:text-foreground">
                  {t('pg.provider_none')}
                </Link>
              ) : (
                <Select
                  value={provider?.id ?? ''}
                  onValueChange={(value) => setProviderId(String(value))}
                  items={list.map((item) => ({ value: item.id, label: `${item.label} · ${item.key_hint}` }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {list.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label} · {item.key_hint}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t('pg.model')}</Label>
              <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={t('pg.model_placeholder')} spellCheck={false} />
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
              <Button onClick={() => void send()} disabled={list.length === 0}>
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
        {t('pg.fee')} <code className="text-foreground">{usd(meta.fee_micros)}</code>
      </span>
      <span>
        {t('pg.balance')} <code className="text-foreground">{usd(meta.balance_micros)}</code>
      </span>
      <span>
        {t('pg.latency')} <code className="text-foreground">{latency(meta.latency_ms)}</code>
      </span>
      {/* 只报事实：这次请求打到了哪台主机。是否可信交给上游渠道页的清单去说。 */}
      <span className="flex items-center gap-1">
        <ServerIcon className="size-3.5" />
        {t('pg.upstream_host')} <code className="text-foreground">{meta.host}</code>
      </span>
      {meta.fee_micros === 0 ? <span>{t('pg.fee_zero_failed')}</span> : null}
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
