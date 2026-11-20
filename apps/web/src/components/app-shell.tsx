import {
  AudioWaveform,
  FolderOpen,
  LayoutDashboard,
  Menu,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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
    to: '/recordings/new',
    label: 'Upload',
    icon: Upload,
    match: (r: Route) => r.name === 'upload',
  },
] as const;

function Brand() {
  return (
    <Link
      to="/"
      className="focus-visible:ring-ring/50 flex items-center gap-2 rounded-md px-2 py-1 outline-none focus-visible:ring-3"
    >
      <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-lg">
        <AudioWaveform aria-hidden className="size-4" />
      </span>
      <span className="text-sm font-semibold tracking-tight">Voice Intelligence</span>
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const route = useRoute();
  return (
    <nav aria-label="Main" className="grid gap-1">
      {NAV.map(({ to, label, icon: Icon, match }) => {
        const active = match(route);
        return (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium outline-none transition-colors duration-(--duration-fast) focus-visible:ring-3',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function WorkspaceContext() {
  return (
    <div className="flex min-w-0 items-center gap-2">
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

/** Persistent sidebar on desktop, sheet on small screens (layout-responsive.md). */
export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-background min-h-svh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside className="bg-sidebar border-sidebar-border hidden border-r lg:flex lg:flex-col lg:gap-6 lg:px-3 lg:py-4">
        <Brand />
        <NavLinks />
        <p className="text-muted-foreground mt-auto px-2 text-xs">
          Phase 1 foundation · analysis pipeline not yet available
        </p>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur sm:px-6">
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
            <SheetContent side="left" className="w-72 p-4">
              <SheetHeader className="p-0">
                <SheetTitle asChild>
                  <div>
                    <Brand />
                  </div>
                </SheetTitle>
                <SheetDescription className="sr-only">Main navigation</SheetDescription>
              </SheetHeader>
              <Separator className="my-2" />
              <NavLinks onNavigate={() => setOpen(false)} />
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
