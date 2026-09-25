import type { ReactNode } from 'react';
import {
  IconCalendar,
  IconChart,
  IconClipboard,
  IconHardHat,
  IconHome,
  IconUpload,
  IconWallet,
  type IconProps,
} from '@/components/ui/icons';

/**
 * Maps a route to its glyph.
 *
 * The mapping lives in a component and not in `lib/navigation.ts` on purpose:
 * the registry stays React-free so `node --test` can load it, while the visual
 * vocabulary stays out of the access model.
 */
const GLYPHS: Record<string, (props: IconProps) => ReactNode> = {
  '/': IconHome,
  '/salud/pacientes': IconClipboard,
  '/salud/agenda': IconCalendar,
  '/salud/caja': IconWallet,
  '/salud/imports': IconUpload,
  '/salud/tableros/[role]': IconChart,
  '/obras': IconHardHat,
  '/obras/[siteId]': IconHardHat,
};

export interface RouteIconProps {
  readonly path: string;
  readonly className?: string;
}

export function RouteIcon({ path, className }: RouteIconProps) {
  const Glyph = GLYPHS[path];
  if (Glyph === undefined) return null;
  return <Glyph className={className} />;
}
