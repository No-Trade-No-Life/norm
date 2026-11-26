import { DownloadIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { consumerError } from '../api';
import { BillBar, type Bill } from '../components/call-bill';
import { ModelPicker } from '../components/model-picker';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { consumerResponse } from '../consumer-key';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { billFromHeaders, formatBytes } from '../lib/audio';
import { candidateModels } from '../lib/catalog';
import { useModelCatalog } from '../queries';

/** Qwen 的三代音色：清单问不到「有哪些音色」，所以给几个常见名字，再留一个手填。 */
const VOICES = ['Cherry', 'Serena', 'Ethan', 'Chelsie'];

/**
 * 语音合成：`POST /v1/audio/speech`，回 WAV 字节。
 *
 * 钱没法塞进音频里，所以账单挂在响应头上（`X-Norm-Fee-Nanos` 那一套）——这里把响应头
 * 读成账单条，与文本那条路共用一个组件。按字符（或按 token）计价，没有兜底价。
 */
export function SpeechPage() {
  const { t } = useI18n();
  const { identity: who } = useIdentity();
  const catalog = useModelCatalog(true);
  const options = useMemo(() => candidateModels(catalog.data, { output: 'audio' }), [catalog.data]);

  const [model, setModel] = useState('qwen3-tts-flash');
  const [voice, setVoice] = useState(VOICES[0]);
  const [text, setText] = useState('');
  const [clip, setClip] = useState<{ url: string; bytes: number } | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (options.length > 0) setModel((current) => (options.includes(current) ? current : options[0]));
  }, [options]);

  // blob URL 占着内存：换一段就释放上一段，离开页面也释放。
  const replaceClip = (next: { url: string; bytes: number } | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next?.url ?? null;
    setClip(next);
  };
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const speak = async () => {
    setError(null);
    if (!text.trim()) return setError(t('sp.need_text'));
    if (!model.trim()) return setError(t('sp.need_model'));
    if (!voice.trim()) return setError(t('sp.need_voice'));

    setRunning(true);
    setBill(null);
    replaceClip(null);

    try {
      const response = await consumerResponse({
        address: who.address,
        path: '/v1/audio/speech',
        method: 'POST',
        body: JSON.stringify({ input: text.trim(), model: model.trim(), voice: voice.trim() }),
      });
      if (!response.ok) throw await consumerError(response);

      const blob = await response.blob();
      replaceClip({ url: URL.createObjectURL(blob), bytes: blob.size });
      setBill(billFromHeaders(response.headers));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PageHeader
        title={t('sp.title')}
        description={t('sp.desc')}
        actions={<code className="text-[11px] text-muted-foreground">{t('sp.entry')}</code>}
      />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>{t('sp.text')}</Label>
              <span className="text-[11px] text-muted-foreground">{t('sp.count', { count: text.length })}</span>
            </div>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('sp.placeholder')}
              rows={6}
              className="min-h-32 resize-y"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void speak();
                }
              }}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ModelPicker
              value={model}
              onChange={setModel}
              options={options}
              placeholder={t('sp.model_placeholder')}
              status={
                catalog.isPending
                  ? t('tool.models_loading')
                  : catalog.isError
                    ? t('tool.models_failed')
                    : options.length > 0
                      ? t('sp.models_count', { count: options.length })
                      : t('sp.models_empty')
              }
            />
            <ModelPicker
              label={t('sp.voice')}
              value={voice}
              onChange={setVoice}
              options={VOICES}
              placeholder={t('sp.voice_placeholder')}
              status={t('sp.voice_hint')}
            />
          </div>

          {error ? <ErrorNote title={t('sp.failed')} message={error} /> : null}

          <div className="flex items-center justify-end">
            <Button onClick={() => void speak()} disabled={running}>
              {running ? <Loader2Icon className="animate-spin" /> : null}
              {running ? t('sp.running') : t('sp.run')}
            </Button>
          </div>
        </section>

        <section className="flex min-h-[26rem] flex-col rounded-xl border border-border bg-card lg:min-h-0">
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <h2 className="text-sm font-semibold">{t('sp.result')}</h2>
            {clip ? (
              <a
                href={clip.url}
                download="norm-speech.wav"
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[0.8rem] font-medium hover:bg-muted"
              >
                <DownloadIcon className="size-3.5" />
                {t('sp.download')}
              </a>
            ) : null}
          </header>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-3 py-3">
            {clip ? (
              <>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio controls src={clip.url} className="w-full" />
                <p className="text-[11px] text-muted-foreground">{t('sp.size', { size: formatBytes(clip.bytes) })}</p>
              </>
            ) : (
              <Empty className="w-full border-0">{running ? t('sp.running') : t('sp.empty')}</Empty>
            )}
          </div>
          <BillBar bill={bill} empty={t('tool.bill_empty')} />
        </section>
      </div>
    </div>
  );
}
