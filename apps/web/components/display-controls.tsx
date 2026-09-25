'use client';

import { useEffect, useState } from 'react';
import { GRID_COOKIE, THEME_COOKIE } from '@/lib/config';
import { cn } from '@/lib/utils';
import { IconGrid, IconMoon, IconSun } from '@/components/ui/icons';

/**
 * Display controls — colour scheme and the decorative grid.
 *
 * Both preferences live in a cookie and in a `data-*` attribute on `<html>`, so
 * the server can render the right theme on the first byte and no inline script
 * has to run on every navigation. The effect only *reads* the current attribute
 * to light up the active control: the buttons render unpressed on the server,
 * which is what avoids a hydration mismatch.
 */
type Theme = 'light' | 'dark';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function persist(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

export function DisplayControls() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [gridOn, setGridOn] = useState<boolean | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const current = root.dataset.theme;
    setTheme(current === 'dark' ? 'dark' : 'light');
    setGridOn(root.dataset.grid !== 'off');
  }, []);

  function applyTheme(next: Theme): void {
    document.documentElement.dataset.theme = next;
    persist(THEME_COOKIE, next);
    setTheme(next);
  }

  function toggleGrid(): void {
    const next = document.documentElement.dataset.grid === 'off' ? 'on' : 'off';
    document.documentElement.dataset.grid = next;
    persist(GRID_COOKIE, next);
    setGridOn(next === 'on');
  }

  return (
    <div className="flex items-center gap-1">
      <div
        role="group"
        aria-label="Esquema de color"
        className="flex items-center rounded-md border border-border p-0.5"
      >
        <button
          type="button"
          onClick={() => applyTheme('light')}
          aria-pressed={theme === 'light'}
          title="Esquema claro"
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-[0.3125rem] text-muted-foreground transition-colors',
            theme === 'light' ? 'bg-secondary text-foreground' : 'hover:text-foreground',
          )}
        >
          <IconSun />
          <span className="sr-only">Esquema claro</span>
        </button>
        <button
          type="button"
          onClick={() => applyTheme('dark')}
          aria-pressed={theme === 'dark'}
          title="Esquema oscuro"
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-[0.3125rem] text-muted-foreground transition-colors',
            theme === 'dark' ? 'bg-secondary text-foreground' : 'hover:text-foreground',
          )}
        >
          <IconMoon />
          <span className="sr-only">Esquema oscuro</span>
        </button>
      </div>

      <button
        type="button"
        onClick={toggleGrid}
        aria-pressed={gridOn === true}
        title={gridOn === false ? 'Mostrar trama de fondo' : 'Ocultar trama de fondo'}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground',
          gridOn === true && 'bg-secondary text-foreground',
        )}
      >
        <IconGrid />
        <span className="sr-only">
          {gridOn === false ? 'Mostrar trama de fondo' : 'Ocultar trama de fondo'}
        </span>
      </button>
    </div>
  );
}
