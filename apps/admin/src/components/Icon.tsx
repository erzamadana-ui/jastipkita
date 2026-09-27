/** Minimal stroke icon set (Lucide-style geometry, drawn inline — no icon font, no external requests). */
import type { IconName } from '../auth/permissions';

type Extra =
  | 'info' | 'alert' | 'check' | 'x' | 'chevron-right' | 'chevron-left' | 'chevron-down' | 'search' | 'refresh' | 'lock' | 'shield'
  | 'logout' | 'sun' | 'moon' | 'monitor' | 'external' | 'copy' | 'eye' | 'download' | 'plus' | 'clock' | 'sort' | 'sort-asc'
  | 'sort-desc' | 'file' | 'key' | 'ban' | 'play' | 'flag' | 'database';

export type AnyIcon = IconName | Extra;

const P: Record<AnyIcon, string> = {
  dashboard: 'M3 13h8V3H3zM13 21h8v-8h-8zM13 3v6h8V3zM3 21h8v-4H3z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  kyc: 'M3 5h18v14H3zM7 15h4M7 11h4M15 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4M13 16c.5-1 1.2-1.5 2-1.5s1.5.5 2 1.5',
  trip: 'M2 16l20-6-2-2-7 2-5-5-2 1 3 5-5 1.5-2-1.5-1 1z M3 21h18',
  tx: 'M4 7h13l-3-3M20 17H7l3 3',
  dispute: 'M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0zM8 21h8',
  refund: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v8M9.5 10.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.6c0 2.4-5 1.2-5 3.6 0 1 1.1 1.6 2.5 1.6s2.5-.5 2.5-1.5',
  payout: 'M2 7h20v12H2zM2 11h20M6 15h4',
  bank: 'M3 21h18M4 10h16M12 3l9 5H3zM6 10v8M10 10v8M14 10v8M18 10v8',
  recon: 'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  risk: 'M12 2l9 4v6c0 5-3.8 9.3-9 10-5.2-.7-9-5-9-10V6zM12 8v4M12 16h.01',
  trust: 'M12 2l9 4v6c0 5-3.8 9.3-9 10-5.2-.7-9-5-9-10V6zM8.5 12l2.5 2.5 4.5-5',
  referral: 'M16 11a4 4 0 1 0-8 0M12 15v6M9 18h6M20 8v6M23 11h-6',
  promo: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
  config: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  customs: 'M3 21V9l9-6 9 6v12M9 21v-6h6v6M3 12h18',
  restricted: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M4.9 4.9l14.2 14.2',
  ticket: 'M3 7a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4zM13 5v2M13 17v2M13 11v2',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  faq: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  legal: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8M8 9h2',
  audit: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2M9 14l2 2 4-4',
  rbac: 'M15 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4M15 7v3M4 21v-2a4 4 0 0 1 4-4h2M9 11a4 4 0 1 0 0-8M19 13l-4 4-2-2M21 21h-8',
  db: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 16v-4M12 8h.01',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0M12 9v4M12 17h.01',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  'chevron-right': 'M9 18l6-6-6-6',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
  lock: 'M5 11h14v10H5zM7 11V7a5 5 0 0 1 10 0v4',
  shield: 'M12 2l9 4v6c0 5-3.8 9.3-9 10-5.2-.7-9-5-9-10V6z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8',
  monitor: 'M2 3h20v14H2zM8 21h8M12 17v4',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  copy: 'M9 9h13v13H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  plus: 'M12 5v14M5 12h14',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
  sort: 'M8 9l4-4 4 4M16 15l-4 4-4-4',
  'sort-asc': 'M8 14l4-4 4 4',
  'sort-desc': 'M8 10l4 4 4-4',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M4.9 4.9l14.2 14.2',
  play: 'M5 3l14 9-14 9z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
};

export function Icon({ name, size = 18, label, className }: { name: AnyIcon; size?: number; label?: string; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={P[name]} />
    </svg>
  );
}
