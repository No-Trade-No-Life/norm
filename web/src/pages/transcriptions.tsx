import { CheckIcon, CopyIcon, FileAudioIcon, Loader2Icon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { consumerError } from '../api';
import { BillBar, type Bill } from '../components/call-bill';
import { ModelPicker } from '../components/model-picker';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { consumerResponse } from '../consumer-key';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { formatBytes } from '../lib/audio';
import { candidateModels } from '../lib/catalog';
import { useModelCatalog } from '../queries';

/** 上游那条 24 MiB 的硬限制（`413 audio_too_large`）：在选文件的这一刻就拦住，别等传完。 */
const MAX_BYTES = 24 * 1024 * 1024;

const LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko'] as const;

/**
 * 语音转写：`POST /v1/audio/transcriptions`，multipart，回一段文字。
 *
 * 转写按秒计价，价目表里没有的型号会在打出去之前被拒（`audio_model_unpriced`）——
 * 页面不做「猜一个近似型号」的兜底，猜错单位就是一笔错账。
 */
export function TranscriptionsPage() {
  const { t } = useI18n();
  const { identity } = useIdentity();
  const catalog = useModelCatalog(true);
  const options = useMemo(() => candidateModels(catalog.data, { input: 'audio' }), [catalog.data]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [model, setModel] = useState('qwen-audio-3.0-asr-flash');
  const [language, setLanguage] = useState<string>('auto');
  const [text, setText] = useState('');
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  // 清单里有音频输入的模型就跟着清单走；没有就留着手填的那个默认型号。
  useEffect(() => {
    if (options.length > 0) setModel((current) => (options.includes(current) ? current : options[0]));
  }, [options]);

  const pick = (next: File | null) => {
    if (next && next.size > MAX_BYTES) {
      setError(t('tr.too_large'));
      return;
    }
    setError(null);
    setFile(next);
  };

  const transcribe = async () => {
    setError(null);
    if (!file) return setError(t('tr.need_file'));
    if (!model.trim()) return setError(t('tr.need_model'));

    setRunning(true);
    setText('');
    setBill(null);

    // multipart 的边界由浏览器现生成：这里绝不能自己塞 Content-Type。
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('model', model.trim());
    if (language !== 'auto') form.append('language', language);

    try {
      const response = await consumerResponse({
        address: identity.address,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw await consumerError(response);

      const payload = (await response.json()) as { text?: string; norm?: Bill };
      setText(payload.text ?? '');
      if (payload.norm) setBill(payload.norm);
      if (!payload.text) setError(t('tr.empty_result'));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PageHeader
        title={t('tr.title')}
        description={t('tr.desc')}
        actions={<code className="text-[11px] text-muted-foreground">{t('tr.entry')}</code>}
      />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('tr.file')}</Label>
            <input
              ref={inputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(event) => pick(event.target.files?.[0] ?? null)}
            />
            {file ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-xs">
                <FileAudioIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
                <Button variant="ghost" size="icon-xs" aria-label={t('tr.clear')} onClick={() => pick(null)}>
                  <XIcon />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  pick(event.dataTransfer.files?.[0] ?? null);
                }}
                className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                <FileAudioIcon className="size-5" />
                <span>{t('tr.pick')}</span>
                <span className="text-[11px]">{t('tr.drop_hint')}</span>
              </button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ModelPicker
              value={model}
              onChange={setModel}
              options={options}
              placeholder={t('tr.model_placeholder')}
              status={
                catalog.isPending
                  ? t('tool.models_loading')
                  : catalog.isError
                    ? t('tool.models_failed')
                    : options.length > 0
                      ? t('tr.models_count', { count: options.length })
                      : t('tr.models_empty')
              }
            />
            <div className="flex flex-col gap-1.5">
              <Label>{t('tr.language')}</Label>
              <Select value={language} onValueChange={(next) => setLanguage(String(next))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code === 'auto' ? t('tr.lang_auto') : code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t('tr.language_hint')}</p>
            </div>
          </div>

          {error ? <ErrorNote title={t('tr.failed')} message={error} /> : null}

          <div className="flex items-center justify-end">
            <Button onClick={() => void transcribe()} disabled={running}>
              {running ? <Loader2Icon className="animate-spin" /> : null}
              {running ? t('tr.running') : t('tr.run')}
            </Button>
          </div>
        </section>

        <section className="flex min-h-[26rem] flex-col rounded-xl border border-border bg-card lg:min-h-0">
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <h2 className="text-sm font-semibold">{t('tr.text')}</h2>
            {text ? (
              <Button variant="ghost" size="xs" onClick={() => void copy()}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? t('action.copied') : t('action.copy')}
              </Button>
            ) : null}
          </header>
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {text ? (
              <pre className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">{text}</pre>
            ) : (
              <Empty className="border-0">{running ? t('tr.running') : t('tr.empty')}</Empty>
            )}
          </div>
          <BillBar bill={bill} empty={t('tool.bill_empty')} />
        </section>
      </div>
    </div>
  );
}
