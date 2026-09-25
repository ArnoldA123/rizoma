import type { ReactNode, SVGProps } from 'react';

/**
 * Icon set — inline SVG on `currentColor`, no icon dependency.
 *
 * Fourteen hand-drawn glyphs keep the bundle dependency-free and let the stroke
 * weight match the hairline borders (1.6 at 24×24, rendered at 16px). Every
 * icon is `aria-hidden`; a label always carries the meaning.
 */
export type IconProps = SVGProps<SVGSVGElement>;

function Glyph({ children, ...props }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 10.5 12 4l8.5 6.5" />
      <path d="M5.5 9.8V19a1 1 0 0 0 1 1H10v-4.5h4V20h3.5a1 1 0 0 0 1-1V9.8" />
    </Glyph>
  );
}

export function IconClipboard(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 4.5h6v2H9z" />
      <path d="M7.5 5.5H6a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-1.5" />
      <path d="M9 11h6M9 15h4" />
    </Glyph>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="5.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
    </Glyph>
  );
}

export function IconWallet(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="6" width="17" height="13" rx="1.5" />
      <path d="M3.5 10h17" />
      <circle cx="16.5" cy="14" r="1" />
    </Glyph>
  );
}

export function IconHardHat(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 16.5h16" />
      <path d="M5.5 16.5V14a6.5 6.5 0 0 1 13 0v2.5" />
      <path d="M10 7.6V4.9M14 7.6V4.9" />
      <path d="M3.5 19.5h17" />
    </Glyph>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4.5 12h15M13.5 6l6 6-6 6" />
    </Glyph>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <path d="M12 14.5v2" />
    </Glyph>
  );
}

export function IconShieldCheck(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.5 5 6v6c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </Glyph>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 4.5 3.5 19h17z" />
      <path d="M12 10v4.2M12 16.8v.1" />
    </Glyph>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 12.5h3.2L9 6.5l3 11 2.4-5h6.1" />
    </Glyph>
  );
}

export function IconLogOut(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M14 5.5h4a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-4" />
      <path d="M11 8.5 7.5 12 11 15.5M7.5 12H16" />
    </Glyph>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
    </Glyph>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M19 14.6A7.6 7.6 0 0 1 9.4 5a7.6 7.6 0 1 0 9.6 9.6z" />
    </Glyph>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16" />
    </Glyph>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 15.5V4.5M8.5 8 12 4.5 15.5 8" />
      <path d="M4.5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3.5" />
    </Glyph>
  );
}

export function IconChart(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4.5 19.5h15" />
      <path d="M7.5 19.5v-6M12 19.5V6.5M16.5 19.5v-9" />
    </Glyph>
  );
}
