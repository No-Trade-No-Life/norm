import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpIcon, CopyIcon, Loader2Icon, MessageSquarePlusIcon, SquareIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { consumerError } from '../api';
import { BillBar, type Bill } from '../components/call-bill';
import { ModelPicker } from '../components/model-picker';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { consumerResponse } from '../consumer-key';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { readChatStream } from '../lib/chat-stream';
import { errorText } from '../lib/error-text';
import { useModels } from '../queries';

/**
 * 一段对话里的一条消息。`reasoning` 单独放：推理模型的「思考」不该混进正文，
 * 但也不该丢掉——它确实是上游产出的字。
 */
type Turn = { id: string; role: 'user' | 'assistant'; content: string; reasoning: string };

const newId = () => crypto.randomUUID();

/**
 * 多轮对话：一轮一轮聊下去，每轮都把整段历史发给同一条上游。
 *
 * 这个页面是原来的 Playground：单发的 prompt 变成累积的消息，别的不变——推理接口只认
 * 下游 Token（本机现铸）、上游由服务端选、每轮各自记账。请求头带一个稳定的 `thread-id`，
 * 让这段会话钉在同一条上游上（保护提示词缓存），换会话就换一个 id。
 */
export function ChatPage() {
  const { t } = useI18n();
  const { identity } = useIdentity();
  const queryClient = useQueryClient();

  // 模型清单由服务端代为去问（上游密钥在库里是密文），问的就是接下来会打到的那条：
  // 哪一条由服务端按「自有优先、公共池兜底、会话粘住」决定，这里不指定。
  const models = useModels(true);
  const options = useMemo(() => (models.data?.data ?? []).map((item) => item.id), [models.data]);

  const [model, setModel] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [stream, setStream] = useState(true);
  const [running, setRunning] = useState(false);
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState(newId);
  const [copied, setCopied] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 清单读到而模型还空着，就填第一个：别让人对着空输入框去记上游管模型叫什么。
  useEffect(() => {
    if (!model.trim() && options.length > 0) setModel(options[0]);
  }, [model, options]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns]);

  const patch = useCallback((id: string, next: Partial<Turn>) => {
    setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...next } : turn)));
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const reset = useCallback(() => {
    stop();
    setTurns([]);
    setBill(null);
    setError(null);
    // 换会话就换亲和键：上一段的缓存与选址都不该跟到新的一段上。
    setConversation(newId());
  }, [stop]);

  const send = useCallback(async () => {
    setError(null);
    if (!model.trim()) return setError(t('pg.need_model'));
    if (!input.trim()) return setError(t('pg.need_prompt'));

    const asked = input.trim();
    const question: Turn = { id: newId(), role: 'user', content: asked, reasoning: '' };
    const answerId = newId();
    const history = [...turns, question];

    setInput('');
    setBill(null);
    setRunning(true);
    setTurns([...history, { id: answerId, role: 'assistant', content: '', reasoning: '' }]);

    const controller = new AbortController();
    abortRef.current = controller;

    // body 只序列化一次：签名与发送共用这同一个字符串。
    const body = JSON.stringify({
      model: model.trim(),
      stream,
      messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
    });

    try {
      const response = await consumerResponse({
        address: identity.address,
        path: '/v1/chat/completions',
        method: 'POST',
        body,
        // 会话亲和：同一段对话里每一轮都钉在同一条上游上。
        headers: { 'thread-id': conversation },
        signal: controller.signal,
      });
      if (!response.ok) throw await consumerError(response);

      if (!stream) {
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: unknown;
          norm?: Bill;
        };
        if (payload.error) throw new Error(errorText(payload.error, t('pg.empty_stream')));
        const answer = payload.choices?.[0]?.message?.content ?? '';
        patch(answerId, { content: answer });
        if (payload.norm) setBill(payload.norm);
        if (!answer) setError(t('pg.empty_stream'));
      } else if (response.body) {
        // 本地攒一份：`patch` 是异步的，收尾时要判断「到底有没有出过字」，不能读状态。
        let content = '';
        let reasoning = '';
        let failed = false;
        await readChatStream(response.body, {
          onDelta: (delta, kind) => {
            if (kind === 'reasoning') {
              reasoning += delta;
              patch(answerId, { reasoning });
            } else {
              content += delta;
              patch(answerId, { content });
            }
          },
          onBill: (meta) => setBill(meta),
          onError: (message) => {
            failed = true;
            setError(message);
          },
        });
        // 200、没有错、也没有一个字：把这件事说出来，不要留一个空框让人猜。
        if (!content && !reasoning && !failed) setError(t('pg.empty_stream'));
        if (!content && !reasoning) {
          setTurns((current) => current.filter((turn) => turn.id !== answerId));
        }
      }
    } catch (caught) {
      if ((caught as Error).name === 'AbortError') {
        setError(null);
      } else {
        setError((caught as Error).message);
        // 这一轮什么都没拿到：把空壳摘掉，别在对话里留一条空白气泡。
        setTurns((current) => {
          const answer = current.find((turn) => turn.id === answerId);
          if (answer && (answer.content || answer.reasoning)) return current;
          return current.filter((turn) => turn.id !== answerId);
        });
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
      void queryClient.invalidateQueries({ queryKey: ['earnings'] });
      void queryClient.invalidateQueries({ queryKey: ['ledger'] });
    }
  }, [conversation, identity.address, input, model, patch, queryClient, stream, t, turns]);

  const copyTurn = async (turn: Turn) => {
    await navigator.clipboard.writeText(turn.content);
    setCopied(turn.id);
    window.setTimeout(() => setCopied(null), 1500);
  };

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
            <Button variant="outline" size="sm" onClick={reset} disabled={turns.length === 0 && !running}>
              <MessageSquarePlusIcon />
              {t('pg.new')}
            </Button>
          </div>
        }
      />

      <section className="flex min-h-[32rem] flex-1 flex-col rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <h2 className="text-sm font-semibold">{t('pg.conversation')}</h2>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {turns.length > 0 ? <span>{t('pg.turn_count', { count: Math.ceil(turns.length / 2) })}</span> : null}
            <code className="font-mono">{conversation.slice(0, 8)}</code>
            {running ? (
              <span className="flex items-center gap-1.5">
                <Loader2Icon className="size-3 animate-spin" />
                {t('pg.streaming')}
              </span>
            ) : null}
          </span>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {turns.length === 0 ? (
              <Empty className="border-0">{t('pg.empty_thread')}</Empty>
            ) : (
              turns.map((turn) => (
                <div key={turn.id} className={turn.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div
                    className={
                      turn.role === 'user'
                        ? 'max-w-[85%] rounded-xl bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground'
                        : 'max-w-[85%] rounded-xl bg-muted px-3 py-2 text-[13px] leading-relaxed'
                    }
                  >
                    {turn.reasoning ? (
                      <details className="mb-1.5">
                        <summary className="cursor-pointer text-[11px] text-muted-foreground">{t('pg.reasoning')}</summary>
                        <pre className="mt-1 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">{turn.reasoning}</pre>
                      </details>
                    ) : null}
                    {turn.content ? (
                      <pre className="break-words whitespace-pre-wrap">{turn.content}</pre>
                    ) : (
                      <span className="text-muted-foreground">{running ? t('pg.streaming') : t('common.none')}</span>
                    )}
                    {turn.role === 'assistant' && turn.content ? (
                      <div className="mt-1 flex justify-end">
                        <Button variant="ghost" size="icon-xs" aria-label={t('action.copy')} onClick={() => void copyTurn(turn)}>
                          <CopyIcon className={copied === turn.id ? 'text-foreground' : undefined} />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 账单跟着这一轮走：上一轮的 request_id 停在旁边，下一轮开始前它还看得见。 */}
        <BillBar bill={bill} empty={t('pg.meta_empty')} />

        <div className="border-t border-border p-3">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <ModelPicker
                value={model}
                onChange={setModel}
                options={options}
                placeholder={t('pg.model_placeholder')}
                status={
                  models.isPending
                    ? t('pg.models_loading')
                    : models.isError
                      ? t('pg.models_failed')
                      : options.length > 0
                        ? `${options.length} ${t('pg.models_count')} · ${t('pg.models_free')}`
                        : t('pg.models_empty')
                }
              />
              <div className="flex flex-col gap-1.5">
                <Label>{t('pg.routing')}</Label>
                {/* 上游不由人挑：Norm 自己在「自己的上游 → 公共池」里选，并按会话粘住。 */}
                <Link
                  to="/providers"
                  className="flex h-8 items-center rounded-lg border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('pg.routing_hint')}
                </Link>
                <p className="text-[11px] text-muted-foreground">{t('pg.affinity_hint')}</p>
              </div>
            </div>

            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('pg.prompt_placeholder')}
              rows={3}
              className="min-h-20 resize-y"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void send();
                }
              }}
            />

            {/* 错误放在输入框正上方，不塞到对话末尾：数据量大时用户永远看不到尾部。 */}
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
          </div>
        </div>
      </section>
    </div>
  );
}
