import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const SIDEBAR_KEY = 'sidebar_state';
const BREAKPOINT = 768;

type SidebarValue = {
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  toggle: () => void;
  toggleCollapsed: () => void;
  /** <768px 时侧栏变抽屉，打开就是这个 modal 状态。 */
  mobileOpen: boolean;
  setMobileOpen: (value: boolean) => void;
};

const SidebarContext = createContext<SidebarValue | null>(null);

function readCookie(): boolean {
  const entry = document.cookie.split('; ').find((row) => row.startsWith(`${SIDEBAR_KEY}=`));
  return entry ? entry.split('=')[1] === 'collapsed' : false;
}

function writeCookie(collapsed: boolean): void {
  document.cookie = `${SIDEBAR_KEY}=${collapsed ? 'collapsed' : 'expanded'}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(readCookie);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(() => window.innerWidth < BREAKPOINT);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${BREAKPOINT - 1}px)`);
    const onChange = () => setIsMobile(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (isMobile) return;
    writeCookie(collapsed);
  }, [collapsed, isMobile]);

  const toggleCollapsed = useCallback(() => {
    if (isMobile) {
      setMobileOpen((prev) => !prev);
      return;
    }
    setCollapsed((prev) => !prev);
  }, [isMobile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCollapsed]);

  const value = useMemo<SidebarValue>(
    () => ({
      collapsed,
      setCollapsed,
      toggle: toggleCollapsed,
      toggleCollapsed,
      mobileOpen,
      setMobileOpen,
    }),
    [collapsed, toggleCollapsed, mobileOpen],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarValue {
  const value = useContext(SidebarContext);
  if (!value) throw new Error('useSidebar 必须在 SidebarProvider 内使用');
  return value;
}
