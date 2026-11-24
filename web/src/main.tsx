import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import { App } from './App';
import { I18nProvider } from './i18n';
import { IdentityProvider } from './identity-context';
import { SidebarProvider } from './sidebar';
import { ThemeProvider } from './theme';
import { TooltipProvider } from './components/ui/tooltip';
import { LOGO_DATA_URL } from './components/logo';
import './style.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

// Logo 与 favicon 同源：图形只写一份，页面上的和标签页上的一致。
const favicon = document.getElementById('app-favicon');
if (favicon instanceof HTMLLinkElement) favicon.href = LOGO_DATA_URL;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <IdentityProvider>
            <SidebarProvider>
              <TooltipProvider>
                <HashRouter>
                  <App />
                </HashRouter>
              </TooltipProvider>
            </SidebarProvider>
          </IdentityProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
