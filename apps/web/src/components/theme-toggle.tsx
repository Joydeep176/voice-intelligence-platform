import { useState } from 'react';
import { ThemeButton } from './shell/theme-button';
import { useIntentLoad } from './shell/use-intent-load';

// The Radix menu loads on first intent; the trigger itself is eager so it never shifts or disappears.
const loadThemeMenu = () => import('./shell/theme-menu').then((m) => m.ThemeMenu);

export function ThemeToggle() {
  const { Component: ThemeMenu, load } = useIntentLoad(loadThemeMenu);
  const [activated, setActivated] = useState(false);
  if (activated && ThemeMenu) return <ThemeMenu />;
  const activate = () => {
    setActivated(true);
    load();
  };
  return (
    <ThemeButton
      aria-haspopup="menu"
      aria-expanded={false}
      data-state="closed"
      onPointerEnter={load}
      onPointerDown={load}
      onFocus={load}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          activate();
        }
      }}
    />
  );
}
