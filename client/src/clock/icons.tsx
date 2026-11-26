/** Stroke icons for the clock page (no icon library: keeps the page small). */
import type { ReactNode } from 'react';

const Svg = ({ size = 24, sw = 2, children }: { size?: number; sw?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconHelp = (p: { size?: number }) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14" /><path d="M12 17h.01" /></Svg>
);
export const IconIn = (p: { size?: number }) => (
  <Svg {...p}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /></Svg>
);
export const IconOut = (p: { size?: number }) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></Svg>
);
export const IconCheck = (p: { size?: number; sw?: number }) => (
  <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
);
export const IconRetry = (p: { size?: number }) => (
  <Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></Svg>
);
export const IconClock = (p: { size?: number }) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
);
export const IconPin = (p: { size?: number }) => (
  <Svg {...p}><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></Svg>
);
export const IconPinOff = (p: { size?: number }) => (
  <Svg {...p}><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><path d="M4 4l16 16" /></Svg>
);
export const IconShield = (p: { size?: number }) => (
  <Svg {...p}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /></Svg>
);
export const IconWarn = (p: { size?: number }) => (
  <Svg {...p}><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></Svg>
);
export const IconBell = (p: { size?: number }) => (
  <Svg {...p}><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7 2.5 7h-17S6 15 6 9" /><path d="M10 20a2.2 2.2 0 0 0 4 0" /></Svg>
);
export const IconWifi = (p: { size?: number }) => (
  <Svg {...p}><path d="M5 12.5a10 10 0 0 1 14 0" /><path d="M8.5 16a5 5 0 0 1 7 0" /><path d="M12 19.5h.01" /></Svg>
);
export const IconPhoneCheck = ({ size = 24, tablet = false }: { size?: number; tablet?: boolean }) =>
  tablet ? (
    <Svg size={size} sw={1.8}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M9 12l2 2 4-4" /></Svg>
  ) : (
    <Svg size={size} sw={1.8}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M9.5 12l2 2 3.5-3.5" /></Svg>
  );
export const IconDeviceOff = ({ size = 24, tablet = false }: { size?: number; tablet?: boolean }) =>
  tablet ? (
    <Svg size={size}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3 3l18 18" /></Svg>
  ) : (
    <Svg size={size}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M3 3l18 18" /></Svg>
  );
export const IconAddHome = ({ size = 22 }: { size?: number }) => (
  <Svg size={size}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M12 9v6M9 12h6" /></Svg>
);
export const IconMail = (p: { size?: number }) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></Svg>
);
export const IconUser = (p: { size?: number }) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>
);
export const IconKeyboard = (p: { size?: number }) => (
  <Svg {...p}><rect x="2" y="6" width="20" height="12" rx="3" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></Svg>
);
export const IconChevron = (p: { size?: number }) => (
  <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
);
export const IconQr = (p: { size?: number }) => (
  <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></Svg>
);
export const IconPhone = (p: { size?: number }) => (
  <Svg {...p}><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18h2" /></Svg>
);
