import { Menu } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';

/** The mobile navigation trigger. Rendered eagerly and again as the Radix trigger, so both are identical. */
export function MobileMenuButton(props: Omit<ComponentProps<typeof Button>, 'children'>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="lg:hidden"
      aria-label="Open navigation"
      {...props}
    >
      <Menu aria-hidden />
    </Button>
  );
}
