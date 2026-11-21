import type { ComponentProps, ReactNode } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { MobileMenuButton } from './mobile-menu-button';

/** Lazy half of the app shell's mobile navigation: the Radix dialog, trigger and content. */
export function MobileNavSheet({
  open,
  onOpenChange,
  onOpenAutoFocus,
  brand,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAutoFocus: ComponentProps<typeof SheetContent>['onOpenAutoFocus'];
  brand: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <MobileMenuButton />
      </SheetTrigger>
      <SheetContent
        side="left"
        className="bg-sidebar flex w-72 flex-col gap-6 p-4"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <SheetHeader className="p-0">
          <SheetTitle asChild>
            <div>{brand}</div>
          </SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
