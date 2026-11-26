import { Component, type ErrorInfo, type ReactNode } from 'react';

import { errorText } from '../lib/error-text';

/**
 * 渲染期抛异常的兜底：用户至少能看见「出了什么」，而且不用整页重来。
 *
 * 挂两处，作用不同：
 *   - 每一条路由各挂一层（`App.tsx`）：一页崩了，侧栏与导航还在，换个页面继续用；
 *   - 最外层再挂一层（`main.tsx`）：连外壳或 Provider 一起崩时，还有最后一道网。
 *
 * 两个按钮对应两种坏法：`重试` 只把边界状态清掉、按当前数据重渲染（一次性的坏值多半
 * 会自己好，比如一份过期的接口响应）；`重新加载` 才是整页重来。
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10"
            onClick={() => this.setState({ error: null })}
          >
            重试 · Retry
          </button>
          <button
            type="button"
            className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10"
            onClick={() => window.location.reload()}
          >
            重新加载 · Reload
          </button>
          <span className="text-[11px] opacity-70">其他页面不受影响 · Other pages still work</span>
        </div>
      </div>
    );
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  return <Boundary>{children}</Boundary>;
}
