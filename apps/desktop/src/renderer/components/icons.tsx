import type { ReactNode, SVGProps } from 'react';

function Svg({ children, size = 16, ...p }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

export const IconFolder = (p: P) => <Svg {...p}><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></Svg>;
export const IconFile = (p: P) => <Svg {...p}><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></Svg>;
export const IconPlus = (p: P) => <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
export const IconChevron = (p: P) => <Svg {...p}><path d="M6 4l4 4-4 4" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="M3.5 8.5l3 3 6-7" /></Svg>;
export const IconClip = (p: P) => <Svg {...p}><path d="M11.5 7l-4.2 4.2a2 2 0 0 1-2.8-2.8l4.6-4.6a1.3 1.3 0 0 1 1.9 1.9L6.6 9.2" /></Svg>;
export const IconSend = (p: P) => <Svg {...p}><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></Svg>;
export const IconStop = (p: P) => <Svg {...p}><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></Svg>;
export const IconTerminal = (p: P) => <Svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 7l2 1.5L5 10M8.5 10.5H11" /></Svg>;
export const IconDiff = (p: P) => <Svg {...p}><path d="M5 2.5v7M2.5 5H7.5M11 13.5v-7M8.5 11H13.5" /></Svg>;
export const IconSettings = (p: P) => <Svg {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></Svg>;
export const IconUndo = (p: P) => <Svg {...p}><path d="M6 3.5L3 6.5l3 3M3 6.5h6a3.5 3.5 0 0 1 0 7H7" /></Svg>;
export const IconSearch = (p: P) => <Svg {...p}><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></Svg>;
export const IconTrash = (p: P) => <Svg {...p}><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8" /></Svg>;
export const IconPanel = (p: P) => <Svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></Svg>;
export const IconImage = (p: P) => <Svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1" /><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" /></Svg>;
export const IconAudio = (p: P) => <Svg {...p}><path d="M3 8v0M5.5 5.5v5M8 3.5v9M10.5 6v4M13 7.5v1" /></Svg>;
export const IconShield = (p: P) => <Svg {...p}><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" /></Svg>;

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Выполняется" />;
}
