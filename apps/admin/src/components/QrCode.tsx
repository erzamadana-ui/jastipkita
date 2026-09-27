import { useMemo } from 'react';
import { encodeQr, qrPath, type Ecc } from '../lib/qr';

/** Inline SVG QR (always dark-on-white with a quiet zone so it scans in dark mode too). */
export function QrCode({ value, size = 208, ecc = 'M', label }: { value: string; size?: number; ecc?: Ecc; label: string }) {
  const m = useMemo(() => encodeQr(value, ecc), [value, ecc]);
  const dim = m.size + 8;
  return (
    <div className="qr">
      <svg width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <rect width={dim} height={dim} style={{ fill: 'var(--jk-color-white)' }} />
        <path d={qrPath(m)} style={{ fill: 'var(--jk-color-black)' }} />
      </svg>
    </div>
  );
}
