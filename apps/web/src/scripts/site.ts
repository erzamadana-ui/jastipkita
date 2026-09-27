/**
 * Site-wide progressive enhancement (~1 kB): mobile nav, theme toggle, consent banner.
 * Storage policy: only strictly-necessary keys, written only after an explicit user action:
 *   jk-consent  — the visitor's cookie/analytics choice ("necessary" | "analytics")
 *   jk-theme    — theme the visitor picked with the toggle
 * No analytics or third-party trackers are loaded, regardless of consent.
 */

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — choice lasts for this page view only */
  }
}

// ---- Mobile navigation ----
const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
const mobileNav = document.getElementById('mobile-nav');
if (toggle && mobileNav) {
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    mobileNav.dataset.open = String(open);
  });
  mobileNav.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) {
      toggle.setAttribute('aria-expanded', 'false');
      mobileNav.dataset.open = 'false';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      toggle.setAttribute('aria-expanded', 'false');
      mobileNav.dataset.open = 'false';
      toggle.focus();
    }
  });
}

// ---- Theme toggle (system → explicit opposite → …) ----
const root = document.documentElement;
function effectiveTheme(): 'light' | 'dark' {
  const forced = root.getAttribute('data-theme');
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    safeSet('jk-theme', next);
  });
});

// ---- Consent banner ----
const banner = document.querySelector<HTMLElement>('[data-consent]');
if (banner) {
  const stored = safeGet('jk-consent');
  if (!stored) banner.hidden = false;
  banner.querySelectorAll<HTMLButtonElement>('[data-consent-choice]').forEach((b) => {
    b.addEventListener('click', () => {
      safeSet('jk-consent', b.dataset.consentChoice === 'analytics' ? 'analytics' : 'necessary');
      banner.hidden = true;
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-consent-open]').forEach((b) => {
    b.addEventListener('click', () => {
      banner.hidden = false;
      banner.querySelector<HTMLButtonElement>('[data-consent-choice]')?.focus();
    });
  });
}
