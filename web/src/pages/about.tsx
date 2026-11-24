import { PageHeader } from '../components/page';
import { useI18n } from '../i18n';
import type { CopyKey } from '../copy';

const PROMISES: Array<{ title: CopyKey; body: CopyKey }> = [
  { title: 'ab.p1_title', body: 'ab.p1_body' },
  { title: 'ab.p2_title', body: 'ab.p2_body' },
  { title: 'ab.p3_title', body: 'ab.p3_body' },
  { title: 'ab.p4_title', body: 'ab.p4_body' },
  { title: 'ab.p5_title', body: 'ab.p5_body' },
];

const NOT_DOING: CopyKey[] = ['ab.not_1', 'ab.not_2', 'ab.not_3'];

export function AboutPage() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('ab.title')} description={t('ab.lead')} />

      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {PROMISES.map((promise, index) => (
          <li key={promise.title} className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground tabular-nums">
                {index + 1}
              </span>
              <h2 className="text-sm font-semibold">{t(promise.title)}</h2>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t(promise.body)}</p>
          </li>
        ))}
      </ol>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-3">
          <h2 className="text-sm font-semibold">{t('ab.fee_title')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('ab.fee_body')}</p>
        </section>
        <section className="rounded-xl border border-dashed border-border p-3">
          <h2 className="text-sm font-semibold">{t('ab.not_title')}</h2>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {NOT_DOING.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
