import type { ReactNode } from 'react';

import { errorText } from '../lib/error-text';
import { cn } from '../lib/utils';

/** 页面骨架：标题一行、说明一行，下面是内容。所有页统一这个节奏。 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card', className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2.5">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  );
}

/** 空态：虚线框内一行说明。固定高度，避免空表把页面撑得忽高忽低。 */
export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-24 items-center justify-center border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground', className)}>
      {children}
    </div>
  );
}

/** 错误：一律放在它描述的内容正上方，绝不塞到列表末尾。 */
/**
 * 错误条。`message` 收 unknown 而不是 string：调用方拿到的常常是 provider 原样回来的
 * 错误体（对象），这里兜一次，谁都不许把对象交给 React。
 */
export function ErrorNote({ title, message }: { title?: string; message: unknown }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {title ? <p className="font-semibold">{title}</p> : null}
      <p className="break-words whitespace-pre-wrap">{errorText(message, '—')}</p>
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }).map((__, colIndex) => (
            <div key={colIndex} className="h-3 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ))}
    </div>
  );
}
