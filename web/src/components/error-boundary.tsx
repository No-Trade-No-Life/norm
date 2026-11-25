import { Component, type ErrorInfo, type ReactNode } from 'react';

import { errorText } from '../lib/error-text';

/**
 * 最后一道网：渲染期抛异常时，用户至少能看见「出了什么」。
 *
 * 之前没有边界，一个对象被当成 React child 就会把整棵树拆掉——页面白掉或停在
 * 上一次的样子，看起来就是「点了没反应」。白屏比错误更难查，所以这里宁可难看。
 *
 * 文案不走 i18n：边界必须能在 I18nProvider 自己也崩掉时工作，所以它没有 hooks。
 */
class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('norm ui error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-16 max-w-xl rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        <p className="font-semibold">页面出错了 · The page crashed</p>
        <p className="mt-1 text-xs opacity-80">
          这不是网络问题，是界面自己抛了异常。
          <br />
          This is not a network problem — the UI itself threw.
        </p>
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-background/60 p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
          {errorText(this.state.error, 'unknown error')}
        </pre>
        <button
          type="button"
          className="mt-3 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10"
          onClick={() => window.location.reload()}
        >
          重新加载 · Reload
        </button>
      </div>
    );
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  return <Boundary>{children}</Boundary>;
}
