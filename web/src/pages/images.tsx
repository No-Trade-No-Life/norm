import { DownloadIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { consumerError } from '../api';
import { BillBar, type Bill } from '../components/call-bill';
import { ModelPicker } from '../components/model-picker';
import { Empty, ErrorNote, PageHeader } from '../components/page';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { consumerResponse } from '../consumer-key';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { candidateModels } from '../lib/catalog';
import { geminiBlockReason, readGeminiImages, type GeminiImage } from '../lib/gemini-image';
import { readImageApiResponse } from '../lib/image-api';
import { useModelCatalog } from '../queries';

/** 一条能出图的路：线缆不同，但「给一句话、拿一张图」这件事是同一个。 */
type Wire = 'gemini' | 'openai';

/**
 * 图像生成：两条线缆。
 *
 *   gemini  走 `POST /v1/models/{model}:generateContent`，在 `generationConfig` 里要
 *           `responseModalities: ['TEXT','IMAGE']`。直通时这些字段原样交给上游，出图的字节
 *           随 `inlineData` 回来。候选 = 上游协议是 google-gemini、且自己声明了 image 输出。
 *
 *   openai  走 `POST /v1/images/generations`（OpenAI Images 的形状）。上游是 ChatGPT 订阅
 *           （`openai-oauth`）：那边没有 Images 端点，Norm 的一次请求会被说成一次
 *           `image_generation` 工具调用，图在事件流里回来——这一层在服务端（`src/images.ts`），
 *           页面看到的仍然是一次普通的 Images 往返。
 *
 * 两条都筛不到就直说，不拿一个文本模型去撞一次注定失败的调用。
 */
export function ImagesPage() {
  const { t } = useI18n();
  const { identity } = useIdentity();
  const catalog = useModelCatalog(true);

  // 两条线缆各自的候选：协议决定「这条路通不通」，模态决定「这个模型画不画」。
  const geminiModels = useMemo(
    () => candidateModels(catalog.data, { protocols: ['google-gemini'], output: 'image' }),
    [catalog.data],
  );
  const openaiModels = useMemo(
    () => candidateModels(catalog.data, { protocols: ['openai-oauth'], output: 'image' }),
    [catalog.data],
  );
  const targets = useMemo(
    () => [
      ...geminiModels.map((model) => ({ model, wire: 'gemini' as Wire })),
      ...openaiModels.map((model) => ({ model, wire: 'openai' as Wire })),
    ],
    [geminiModels, openaiModels],
  );
  const options = useMemo(() => targets.map((target) => target.model), [targets]);

  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('auto');
  const [image, setImage] = useState<GeminiImage | null>(null);
  const [note, setNote] = useState('');
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // 清单里第一个能出图的模型就是默认值：别让人对着空框去记上游叫它什么。
  useEffect(() => {
    if (!model && options.length > 0) setModel(options[0]);
  }, [model, options]);

  // 手填的模型名不在清单里时按 Gemini 处理：那是这个页面一直以来的默认路（直通会原话交回）。
  const wire: Wire = targets.find((target) => target.model === model)?.wire ?? 'gemini';

  const generate = async () => {
    setError(null);
    if (!prompt.trim()) return setError(t('im.need_prompt'));
    if (!model.trim()) return setError(t('im.need_model'));

    setRunning(true);
    setImage(null);
    setNote('');
    setBill(null);

    try {
      if (wire === 'openai') {
        // 一次调用画一张：`n` 不传，尺寸与质量按页面上的选择（默认 1K 方图、自动质量）。
        const response = await consumerResponse({
          address: identity.address,
          path: '/v1/images/generations',
          method: 'POST',
          body: JSON.stringify({ model: model.trim(), prompt: prompt.trim(), size, quality }),
        });
        if (!response.ok) throw await consumerError(response);
        const payload = (await response.json()) as { norm?: Bill };
        const result = readImageApiResponse(payload);
        if (result.images.length > 0) setImage(result.images[0]);
        if (result.revisedPrompt) setNote(result.revisedPrompt);
        if (payload.norm) setBill(payload.norm);
        if (result.images.length === 0) setError(t('im.empty_result'));
      } else {
        // 请求体是 Gemini 的原话：直通时 Norm 一个字段都不碰。
        const response = await consumerResponse({
          address: identity.address,
          path: `/v1/models/${encodeURIComponent(model.trim())}:generateContent`,
          method: 'POST',
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt.trim() }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
          }),
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
        actions={
          <code className="text-[11px] text-muted-foreground">
            {wire === 'openai' ? t('im.entry_openai') : t('im.entry')}
          </code>
        }
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

          {/* 尺寸与质量是 Images 那条线缆的字段：Gemini 那条只要一句「我要图」。 */}
          {wire === 'openai' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>{t('im.size')}</Label>
                <Select
                  value={size}
                  onValueChange={(next) => setSize(String(next))}
                  items={SIZES.map((value) => ({ value, label: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SIZES.map((value) => (
                      <SelectItem key={value} value={value}>
                        <span className="font-mono text-xs">{value}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('im.quality')}</Label>
                <Select
                  value={quality}
                  onValueChange={(next) => setQuality(String(next))}
                  items={QUALITIES.map((value) => ({ value, label: t(`im.quality_${value}` as 'im.quality_auto') }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUALITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`im.quality_${value}` as 'im.quality_auto')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

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
                download={`norm-image.${image?.mimeType === 'image/jpeg' ? 'jpg' : (image?.mimeType.split('/')[1] ?? 'png')}`}
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

/** 上游认的几种尺寸：1K 方图、两种 1K 竖横、2K 宽屏，以及让上游自己挑。 */
const SIZES = ['1024x1024', '1536x1024', '1024x1536', '2048x1152', 'auto'];

/** 质量三档 + auto：价目表按档收钱，`auto` 由上游决定（账单按它回显的档算）。 */
const QUALITIES = ['auto', 'low', 'medium', 'high'];
