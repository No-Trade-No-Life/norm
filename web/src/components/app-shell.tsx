import {
  ChevronLeftIcon,
  FileCheck2Icon,
  InfoIcon,
  KeyRoundIcon,
  LanguagesIcon,
  PlugZapIcon,
  MenuIcon,
  MoonIcon,
  ReceiptTextIcon,
  ShieldCheckIcon,
  SunIcon,
  TerminalIcon,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { useI18n } from '../i18n';
import { useSidebar } from '../sidebar';
import { useTheme } from '../theme';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import type { CopyKey, Lang } from '../copy';
import { Logo } from './logo';
import { IdentityDialog } from './identity-dialog';

export type NavItem = { to: string; labelKey: CopyKey; icon: ReactNode };
export type NavGroup = { labelKey: CopyKey; items: NavItem[] };

function NavEntry({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { t } = useI18n();
  const label = t(item.labelKey);
  const link = (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center gap-2 rounded-lg px-2 text-sm whitespace-nowrap transition-colors',
          isActive ? 'bg-primary text-primary-foreground' : 'text-foreground/80 hover:bg-muted hover:text-foreground',
          collapsed && 'justify-center px-0',
        )
      }
    >
      <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{item.icon}</span>
      <span className={cn('shell__nav-label truncate', collapsed && 'sr-only')}>{label}</span>
    </NavLink>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarBody({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  const nav: NavGroup[] = [
    {
      labelKey: 'nav.group_main',
      items: [
        { to: '/', labelKey: 'nav.playground', icon: <TerminalIcon /> },
        { to: '/providers', labelKey: 'nav.providers', icon: <KeyRoundIcon /> },
        { to: '/consumers', labelKey: 'nav.consumers', icon: <PlugZapIcon /> },
        { to: '/usage', labelKey: 'nav.usage', icon: <ReceiptTextIcon /> },
      ],
    },
    {
      labelKey: 'nav.group_trust',
      items: [
        { to: '/provenance', labelKey: 'nav.provenance', icon: <ShieldCheckIcon /> },
        { to: '/attestation', labelKey: 'nav.attestation', icon: <FileCheck2Icon /> },
        { to: '/about', labelKey: 'nav.about', icon: <InfoIcon /> },
      ],
    },
  ];
  return (
    <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2" onClick={onNavigate}>
      {nav.map((group) => (
        <div key={group.labelKey} className="flex flex-col gap-0.5">
          <p className={cn('px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground', collapsed && 'sr-only')}>
            {t(group.labelKey)}
          </p>
          {group.items.map((item) => (
            <NavEntry key={item.to} item={item} collapsed={collapsed} />
          ))}
        </div>
      ))}
    </nav>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  return (
    <div className={cn('flex h-12 items-center gap-2 border-b border-border px-3', collapsed && 'justify-center px-0')}>
      <Logo className="size-7 shrink-0 text-foreground" />
      <div className={cn('min-w-0', collapsed && 'hidden')}>
        <p className="shell__brand-text truncate text-sm font-semibold leading-tight">{t('app.name')}</p>
        <p className="shell__brand-text truncate text-[10px] leading-tight text-muted-foreground">{t('app.tagline')}</p>
      </div>
    </div>
  );
}

function TopBar() {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useSidebar();

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={t('action.toggle_sidebar')}
      >
        <MenuIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" onClick={toggleCollapsed} aria-label={t('action.toggle_sidebar')}>
        <ChevronLeftIcon className={cn('transition-transform duration-200', collapsed && 'rotate-180')} />
      </Button>
      <div className="min-w-0 flex-1" />
      <IdentityDialog />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('common.language')} />}>
          <LanguagesIcon />
        </DropdownMenuTrigger>
        {/* Base UI 的分组部件必须真的待在 Group / RadioGroup 里：标签与选项直接挂在
            Content 下会抛 MenuGroupContext is missing，菜单一开整页就崩。 */}
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={lang} onValueChange={(value) => setLang(value as Lang)}>
              {/* 选完就收起来：这是个开关，不是一张要继续编辑的表单。 */}
              <DropdownMenuRadioItem value="zh" closeOnClick>
                {t('common.zh')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en" closeOnClick>
                {t('common.en')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('common.theme')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as 'light' | 'dark')}>
              <DropdownMenuRadioItem value="light" closeOnClick>
                {t('common.light')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" closeOnClick>
                {t('common.dark')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon-sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t('action.toggle_theme')}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </Button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { collapsed, mobileOpen, setMobileOpen } = useSidebar();
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, setMobileOpen]);

  return (
    <div className="shell" data-collapsed={collapsed && !mobileOpen}>
      <aside className="shell__sidebar">
        <Brand collapsed={collapsed} />
        <SidebarBody collapsed={collapsed} />
      </aside>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent className="fixed top-0 left-0 h-full w-64 max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-r p-0 sm:max-w-none">
          <DialogTitle className="sr-only">{t('nav.title')}</DialogTitle>
          <Brand collapsed={false} />
          <SidebarBody collapsed={false} onNavigate={() => setMobileOpen(false)} />
        </DialogContent>
      </Dialog>
      <div className="shell__main">
        <TopBar />
        <main className="shell__scroll">
          <div className="shell__page mx-auto w-full max-w-[1200px] p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
