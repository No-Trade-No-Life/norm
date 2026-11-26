import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/app-shell';
import { ErrorBoundary } from './components/error-boundary';
import { ErrorNote } from './components/page';
import { useIdentity } from './identity-context';
import { useLogin } from './queries';
import { useI18n } from './i18n';
import { AboutPage } from './pages/about';
import { AttestationPage } from './pages/attestation';
import { ConsumersPage } from './pages/consumers';
import { ModelsPage } from './pages/models';
import { ProvidersPage } from './pages/providers';
import { PlaygroundPage } from './pages/playground';
import { ProvenancePage } from './pages/provenance';
import { UsagePage } from './pages/usage';

/**
 * 身份就位后才允许发签名请求；登录失败时把错误留在页面顶部，
 * 不做「悄悄重试」——用户需要知道自己的地址没能开户。
 */
export function App() {
  const { t } = useI18n();
  const { identity } = useIdentity();
  const queryClient = useQueryClient();
  const login = useLogin(true, identity.address);

  useEffect(() => {
    // 换身份后旧账号的数据一律作废，不能串到新地址上。
    void queryClient.invalidateQueries();
  }, [identity.address, queryClient]);

  if (login.isPending) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <span className="size-5 animate-pulse rounded-full bg-primary/40" />
          <span>{t('common.loading')}</span>
        </div>
      </main>
    );
  }

  if (login.isError) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <div className="w-full max-w-md space-y-3">
          <ErrorNote title={t('common.error')} message={(login.error as Error).message} />
          <button
            type="button"
            onClick={() => void login.refetch()}
            className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            {t('action.retry')}
          </button>
        </div>
      </main>
    );
  }

  return (
    <AppShell>
      {/* 一页崩了不该把外壳一起带走：每条路由各自兜底，侧栏与导航还在，换个页面继续用。 */}
      <Routes>
        {ROUTES.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={<ErrorBoundary>{route.element}</ErrorBoundary>}
          />
        ))}
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </AppShell>
  );
}

/**
 * 路由表：路径与页面在这里一一对应。
 *
 * 拿它建成一张表而不是写一串 `<Route>`，是为了让「每条路由都有一层边界」是结构上的事实——
 * 增一条路由时不可能忘记挂边界。
 */
const ROUTES: Array<{ path: string; element: ReactNode }> = [
  { path: '/', element: <PlaygroundPage /> },
  { path: '/providers', element: <ProvidersPage /> },
  { path: '/models', element: <ModelsPage /> },
  { path: '/consumers', element: <ConsumersPage /> },
  { path: '/usage', element: <UsagePage /> },
  { path: '/provenance', element: <ProvenancePage /> },
  { path: '/attestation', element: <AttestationPage /> },
  { path: '/about', element: <AboutPage /> },
];
