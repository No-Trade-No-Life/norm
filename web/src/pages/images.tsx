import { DownloadIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

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
import { candidateModels } from '../lib/catalog';
import { geminiBlockReason, readGeminiImages, type GeminiImage } from '../lib/gemini-image';
import { useModelCatalog } from '../queries';

/**
 * 图像生成：走 Gemini 的 `:generateContent` 入口，在 `generationConfig` 里要 IMAGE。
 *
 * 它是 Norm 现有入口里唯一一条能出图的路——`responseModalities` 是 Gemini 自己的字段，
 * 直通时原样交给上游，出图的字节随 `inlineData` 回来，一次响应就结束（不落库、不留档）。
 * 所以候选模型只有一种：**上游协议是 google-gemini、且自己声明了 image 输出**。筛不到
 * 就直说，不拿一个文本模型去撞一次注定失败的调用。
 */
export function ImagesPage() {
  const { t } = useI18n();
  const { identity } = useIdentity();
  const catalog = useModelCatalog(true);
  const options = useMemo(
    () => candidateModels(catalog.data, { protocols: ['google-gemini'], output: 'image' }),
    [catalog.data],
  );

  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [image, setImage] = useState<GeminiImage | null>(null);
  const [note, setNote] = useState('');
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // 清单里第一个能出图的模型就是默认值：别让人对着空框去记上游叫它什么。
  useEffect(() => {
    if (!model && options.length > 0) setModel(options[0]);
  }, [model, options]);

  const generate = async () => {
    setError(null);
    if (!prompt.trim()) return setError(t('im.need_prompt'));
    if (!model.trim()) return setError(t('im.need_model'));

    setRunning(true);
    setImage(null);
    setNote('');
    setBill(null);

    // 请求体是 Gemini 的原话：直通时 Norm 一个字段都不碰。
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt.trim() }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });

    try {
      const response = await consumerResponse({
        address: identity.address,
        path: `/v1/models/${encodeURIComponent(model.trim())}:generateContent`,
        method: 'POST',
        body,
      });
      if (!response.ok) throw await consumerError(response);

      const payload = (await response.json()) as { norm?: Bill };
      const result = readGeminiImages(payload);
      if (result.images.length > 0) setImage(result.images[0]);
      if (result.text) setNote(result.text);
      if (payload.norm) setBill(payload.norm);
      if (result.images.length === 0) {
        const blocked = geminiBlockReason(payload);
        setError(blocked ? t('im.blocked', { reason: blocked }) : t('im.empty_result'));
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const dataUrl = image ? `data:${image.mimeType};base64,${image.data}` : null;

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PageHeader
        title={t('im.title')}
        description={t('im.desc')}
        actions={<code className="text-[11px] text-muted-foreground">{t('im.entry')}</code>}
      />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('im.prompt')}</Label>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('im.prompt_placeholder')}
              rows={6}
              className="min-h-32 resize-y"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void generate();
                }
              }}
            />
          </div>

          <ModelPicker
            value={model}
            onChange={setModel}
            options={options}
            placeholder={t('im.model_placeholder')}
            status={
              catalog.isPending
                ? t('tool.models_loading')
                : catalog.isError
                  ? t('tool.models_failed')
                  : options.length > 0
                    ? t('im.models_count', { count: options.length })
                    : t('im.no_model')
            }
          />

          {/* 错误放在按钮上方：成功之后它离结果最近，失败时它离「再来一次」最近。 */}
          {error ? <ErrorNote title={t('im.failed')} message={error} /> : null}

          <div className="flex items-center justify-end">
            <Button onClick={() => void generate()} disabled={running}>
              {running ? <Loader2Icon className="animate-spin" /> : null}
              {running ? t('im.running') : t('im.run')}
            </Button>
          </div>
        </section>

        <section className="flex min-h-[26rem] flex-col rounded-xl border border-border bg-card lg:min-h-0">
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <h2 className="text-sm font-semibold">{t('im.result')}</h2>
            {dataUrl ? (
              <a
                href={dataUrl}
                download="norm-image.png"
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[0.8rem] font-medium hover:bg-muted"
              >
                <DownloadIcon className="size-3.5" />
                {t('im.download')}
              </a>
            ) : null}
          </header>
          <div className="flex flex-1 items-center justify-center overflow-auto p-3">
            {dataUrl ? (
              <div className="flex w-full flex-col items-center gap-2">
                <img src={dataUrl} alt={prompt} className="max-h-[32rem] w-auto max-w-full rounded-lg border border-border" />
                {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
              </div>
            ) : (
              <Empty className="border-0">{running ? t('im.running') : t('im.empty')}</Empty>
            )}
          </div>
          {/* 钱从响应里回来（非流式）：同一次往返里把账单交到手，没有事后回捞的接口。 */}
          <BillBar bill={bill} empty={t('tool.bill_empty')} />
        </section>
      </div>
    </div>
  );
}
