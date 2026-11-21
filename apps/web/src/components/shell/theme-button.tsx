import { Moon, Sun } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';

/** The theme trigger. Rendered eagerly and again as the Radix trigger, so both are identical. */
export function ThemeButton(props: Omit<ComponentProps<typeof Button>, 'children'>) {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label="Change theme" {...props}>
      <Sun aria-hidden className="dark:hidden" />
      <Moon aria-hidden className="hidden dark:block" />
    </Button>
  );
}
