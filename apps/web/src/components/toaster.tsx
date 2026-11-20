import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { Toast } from 'radix-ui';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { cn } from 'cn';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  notify: (toast: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<ToastTone, { icon: typeof Info; className: string; label: string }> = {
  success: { icon: CheckCircle2, className: 'text-success', label: 'Success' },
  error: { icon: TriangleAlert, className: 'text-destructive', label: 'Error' },
  info: { icon: Info, className: 'text-info', label: 'Information' },
};

/**
 * Notifications on the Radix Toast primitive (covered by ADR-0022; no extra toast library).
 * Announced politely to screen readers; errors stay until dismissed.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const notify = useCallback((toast: Omit<ToastItem, 'id'>) => {
    setToasts((all) => [...all.slice(-3), { ...toast, id: Date.now() + Math.random() }]);
  }, []);
  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      <Toast.Provider swipeDirection="right" duration={6000}>
        {children}
        {toasts.map((t) => {
          const tone = TONE[t.tone];
          const Icon = tone.icon;
          return (
            <Toast.Root
              key={t.id}
              duration={t.tone === 'error' ? Infinity : undefined}
              onOpenChange={(open) => !open && setToasts((all) => all.filter((x) => x.id !== t.id))}
              className="group bg-popover text-popover-foreground ring-foreground/10 grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-xl p-4 shadow-lg ring-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2"
            >
              <Icon aria-hidden className={cn('mt-0.5 size-4', tone.className)} />
              <div className="grid gap-1">
                <Toast.Title className="text-sm font-medium">
                  <span className="sr-only">{tone.label}: </span>
                  {t.title}
                </Toast.Title>
                {t.description ? (
                  <Toast.Description className="text-muted-foreground text-sm">
                    {t.description}
                  </Toast.Description>
                ) : null}
              </div>
              <Toast.Close
                aria-label="Dismiss notification"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-md p-0.5 outline-none focus-visible:ring-3"
              >
                <X aria-hidden className="size-4" />
              </Toast.Close>
            </Toast.Root>
          );
        })}
        <Toast.Viewport className="fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
