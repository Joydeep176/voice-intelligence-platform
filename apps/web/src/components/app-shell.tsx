import {
  AudioWaveform,
  FolderOpen,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldAlert,
  Upload,
  Workflow,
} from 'lucide-react';
import { type CSSProperties, type ReactNode, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WORKSPACE_LABEL } from '@/lib/config';
import { Link, type Route, useRoute } from '@/lib/router';
import { cn } from 'cn';
import { SystemStatus } from './system-status';
import { ThemeToggle } from './theme-toggle';

const NAV = [
  {
    to: '/',
    label: 'Overview',
    icon: LayoutDashboard,
    match: (r: Route) => r.name === 'dashboard',
  },
  {
    to: '/recordings',
    label: 'Recordings',
    icon: FolderOpen,
    match: (r: Route) => r.name === 'recordings' || r.name === 'recording',
  },
  {
    to: '/pipeline',
    label: 'Pipeline',
    icon: Workflow,
    match: (r: Route) => r.name === 'pipeline',
  },
  {
    to: '/recordings/new',
    label: 'Upload',
    icon: Upload,
    match: (r: Route) => r.name === 'upload',
  },
] as const;

const SIDEBAR_KEY = 'vip-sidebar';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Storage unavailable (private mode, blocked): the choice simply is not remembered.
  }
}

function BrandMark() {
  return (
    <span className="bg-brand-gradient shadow-primary grid size-8 shrink-0 place-items-center rounded-[0.6rem] text-white">
      <AudioWaveform aria-hidden className="size-4" />
    </span>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      to="/"
      aria-label={compact ? 'Voice Intelligence, overview' : undefined}
      className={cn(
        'focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-3',
        compact ? 'justify-center p-1' : 'px-2 py-1',
      )}
    >
      <BrandMark />
      {compact ? null : (
        <span className="grid leading-tight">
          <span className="text-sm font-semibold tracking-tight">Voice Intelligence</span>
          <span className="text-muted-foreground text-[11px]">Intelligence platform</span>
        </span>
      )}
    </Link>
  );
}

function NavLinks({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const route = useRoute();
  return (
    <nav aria-label="Main" className="grid gap-1">
      {NAV.map(({ to, label, icon: Icon, match }) => {
        const active = match(route);
        const link = (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group/nav focus-visible:ring-ring/50 relative flex h-9 items-center gap-3 rounded-lg text-sm font-medium outline-none transition-colors duration-(--duration-fast) focus-visible:ring-3',
              compact ? 'justify-center' : 'px-3',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
            )}
          >
            {active ? (
              <span
                aria-hidden
                className="bg-brand-gradient absolute inset-y-2 left-0 w-[3px] rounded-full"
              />
            ) : null}
            <Icon
              aria-hidden
              className={cn(
                'size-4 shrink-0 transition-colors duration-(--duration-fast)',
                active ? 'text-primary' : 'group-hover/nav:text-foreground',
              )}
            />
            <span className={cn(compact && 'sr-only')}>{label}</span>
          </Link>
        );
        if (!compact) return link;
        return (
          <Tooltip key={to}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

function SectionLabel({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <p className="text-muted-foreground px-3 text-[11px] font-medium tracking-wider uppercase">
      {children}
    </p>
  );
}

function PhaseNote({ hidden }: { hidden?: boolean }) {
  if (hidden) return null;
  return (
    <p className="text-muted-foreground px-3 text-[11px] leading-relaxed">
      Phase 1 foundation · analysis pipeline not yet available
    </p>
  );
}

function WorkspaceContext() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="bg-secondary text-secondary-foreground hidden size-7 shrink-0 place-items-center rounded-md text-xs font-semibold sm:grid"
      >
        {WORKSPACE_LABEL.charAt(0)}
      </span>
      <span className="truncate text-sm font-medium">{WORKSPACE_LABEL}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-warning border-warning/40 gap-1" tabIndex={0}>
            <ShieldAlert aria-hidden className="size-3" />
            Dev mode
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          Authentication is not implemented yet. Every request uses the local development principal.
          Not for production use.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Collapsible sidebar on desktop, sheet on small screens (layout-responsive.md). Brand accents stay
 * in this chrome and never reach evidence surfaces (ADR-0030).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const sheetNav = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  return (
    <div
      className="bg-background min-h-svh transition-[grid-template-columns] duration-(--duration-base) ease-(--ease-standard) lg:grid lg:grid-cols-[var(--sidebar-width)_1fr]"
      style={{ '--sidebar-width': collapsed ? '4.5rem' : '16rem' } as CSSProperties}
    >
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside
        id="app-sidebar"
        className={cn(
          'bg-sidebar border-sidebar-border sticky top-0 hidden h-svh flex-col gap-6 border-r py-4 lg:flex',
          collapsed ? 'px-2' : 'px-3',
        )}
      >
        <Brand compact={collapsed} />
        <div className="grid gap-2">
          <SectionLabel hidden={collapsed}>Workspace</SectionLabel>
          <NavLinks compact={collapsed} />
        </div>
        <div className="mt-auto grid gap-3">
          <SystemStatus compact={collapsed} />
          <PhaseNote hidden={collapsed} />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn('text-muted-foreground', collapsed ? 'mx-auto' : 'ml-1.5')}
          >
            {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="bg-background/75 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur-md sm:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open navigation"
              >
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="bg-sidebar flex w-72 flex-col gap-6 p-4"
              onOpenAutoFocus={(event) => {
                // Focus the current page's link rather than the first control in the sheet.
                event.preventDefault();
                sheetNav.current
                  ?.querySelector<HTMLElement>('a[aria-current="page"], a[href]')
                  ?.focus();
              }}
            >
              <SheetHeader className="p-0">
                <SheetTitle asChild>
                  <div>
                    <Brand />
                  </div>
                </SheetTitle>
                <SheetDescription className="sr-only">Main navigation</SheetDescription>
              </SheetHeader>
              <div ref={sheetNav} className="grid gap-2">
                <SectionLabel>Workspace</SectionLabel>
                <NavLinks onNavigate={() => setOpen(false)} />
              </div>
              <div className="mt-auto grid gap-3">
                <SystemStatus />
                <PhaseNote />
              </div>
            </SheetContent>
          </Sheet>
          <WorkspaceContext />
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
