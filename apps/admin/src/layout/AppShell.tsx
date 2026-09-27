/**
 * App chrome: permanent environment/SANDBOX ribbon (never dismissible), permission-aware sidebar, top bar with
 * the session banner (MFA freshness, roles, theme, logout).
 */
import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router';
import { requestStepUp } from '../api/mfa';
import { mfaSecondsLeft } from '../api/session';
import { useAuth } from '../auth/AuthProvider';
import { visibleNav, type Permission } from '../auth/permissions';
import { Icon } from '../components/Icon';
import { Badge, Button } from '../components/ui';
import { ENV } from '../env';
import { nonLive, useIntegrationModes, useNow } from '../hooks/misc';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme';

const BASE = import.meta.env.BASE_URL;

export function EnvRibbon() {
  const { modes } = useIntegrationModes();
  const notLive = nonLive(modes);
  const prod = ENV.appEnv === 'production';
  if (prod && modes && notLive.length === 0) return null;
  const envLabel = prod ? 'PRODUCTION' : ENV.appEnv === 'staging' ? 'STAGING' : 'DEVELOPMENT';
  const tag = !prod ? 'SANDBOX' : 'SANDBOX';
  return (
    <div className="env-ribbon" role="status" data-testid="env-ribbon">
      <strong>{tag}</strong>
      <span>
        {envLabel} ·{' '}
        {notLive.length
          ? `Integrasi belum LIVE: ${notLive.map(([k, v]) => `${k} ${v}`).join(', ')}`
          : modes
            ? 'Semua integrasi LIVE, tetapi lingkungan ini bukan produksi'
            : 'Mode integrasi belum diketahui'}{' '}
        — pembayaran bukan uang sungguhan
      </span>
    </div>
  );
}

function MfaPill() {
  const { snapshot } = useAuth();
  const now = useNow(15_000);
  const left = mfaSecondsLeft(snapshot.mfaAt, ENV.mfaWindowSec, now);
  if (left > 0) {
    const min = Math.ceil(left / 60);
    return (
      <span className="mfa-pill mfa-pill--fresh" role="status" data-testid="mfa-status" title="Step-up MFA masih berlaku untuk aksi sensitif">
        <Icon name="shield" size={14} /> MFA aktif · {min} mnt
      </span>
    );
  }
  return (
    <button type="button" className="mfa-pill mfa-pill--stale" onClick={() => void requestStepUp()} data-testid="mfa-status" title="Aksi sensitif akan meminta kode TOTP. Klik untuk verifikasi sekarang.">
      <Icon name="lock" size={14} /> MFA perlu verifikasi
    </button>
  );
}

function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const next: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  const label: Record<ThemePref, string> = { system: 'Tema: ikuti sistem', light: 'Tema: terang', dark: 'Tema: gelap' };
  return (
    <Button
      variant="ghost"
      icon={pref === 'system' ? 'monitor' : pref === 'light' ? 'sun' : 'moon'}
      aria-label={`${label[pref]} (klik untuk ganti)`}
      title={label[pref]}
      onClick={() => {
        const n = next[pref];
        setThemePref(n);
        setPref(n);
      }}
    />
  );
}

/** Permission-aware navigation: items the admin lacks permission for are not rendered at all. */
export function SidebarNav({ perms, roles }: { perms: Set<Permission>; roles: readonly string[] }) {
  const nav = visibleNav(perms, roles);
  return (
    <nav aria-label="Menu admin">
      {nav.map((s) => (
        <div className="nav-section" key={s.title}>
          <div className="nav-section__title" id={`nav-${s.title}`}>
            {s.title}
          </div>
          <ul role="list" aria-labelledby={`nav-${s.title}`} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {s.items.map((i) => (
              <li key={i.to}>
                <NavLink to={i.to} end={i.to === '/'} className="nav-link" title={i.label}>
                  <Icon name={i.icon} />
                  <span>{i.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, roles, perms, logout } = useAuth();
  const { modes } = useIntegrationModes();
  const ribbon = ENV.appEnv !== 'production' || !modes || nonLive(modes).length > 0;
  return (
    <div className={ribbon ? 'has-ribbon' : undefined}>
      <a href="#main" className="skip-link">
        Lewati ke konten
      </a>
      {ribbon ? <EnvRibbon /> : null}
      <div className="shell">
        <aside className="sidebar" aria-label="Navigasi utama">
          <div className="sidebar__brand">
            <img className="full" src={`${BASE}logo-horizontal-dark.svg`} alt="JastipKita" width={124} height={30} />
            <img className="mark" src={`${BASE}logo-symbol-dark.svg`} alt="JastipKita" width={30} height={30} style={{ display: 'none' }} />
            <span className="tag">Admin</span>
          </div>
          <SidebarNav perms={perms} roles={roles} />
          <div className="sidebar__foot">
            Titip Mudah, Aman, Terpercaya.
            <br />
            Build {ENV.appEnv}
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <Badge tone={ENV.appEnv === 'production' ? 'success' : 'warning'}>{ENV.appEnv.toUpperCase()}</Badge>
            <span className="spacer" />
            <MfaPill />
            <ThemeToggle />
            <div className="topbar__user">
              <span className="name">{me?.displayName ?? me?.email ?? 'Admin'}</span>
              <span className="roles">{roles.join(' · ')}</span>
            </div>
            <Button variant="ghost" icon="logout" onClick={() => void logout()} aria-label="Keluar">
              Keluar
            </Button>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
