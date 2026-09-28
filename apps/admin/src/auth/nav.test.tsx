import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SidebarNav } from '../layout/AppShell';
import { CAP, hasCapability, homePath, permissionsFor, visibleNav } from './permissions';

function renderNav(roles: string[]) {
  render(
    <MemoryRouter>
      <SidebarNav perms={permissionsFor(roles)} roles={roles} />
    </MemoryRouter>,
  );
  return within(screen.getByRole('navigation', { name: 'Menu admin' }));
}

describe('permission-based navigation', () => {
  it('SUPPORT sees tickets, chat moderation, users, transactions and FAQ — nothing financial or infra', () => {
    const nav = renderNav(['SUPPORT']);
    for (const l of ['Tiket support', 'Moderasi chat', 'Pengguna', 'Transaksi', 'FAQ']) expect(nav.getByRole('link', { name: l })).toBeInTheDocument();
    for (const l of ['Dashboard', 'Persetujuan refund', 'Payout traveler', 'Rekening settlement', 'DB & Infra Center', 'Peran & akses', 'Business config', 'Audit log']) {
      expect(nav.queryByRole('link', { name: l })).not.toBeInTheDocument();
    }
    expect(nav.queryByText('Keuangan')).not.toBeInTheDocument();
  });

  it('FINANCE sees money screens but not disputes, KYC or the DB center', () => {
    const nav = renderNav(['FINANCE']);
    for (const l of ['Dashboard', 'Persetujuan refund', 'Review rekening refund', 'Payout traveler', 'Rekening settlement', 'Rekonsiliasi', 'Audit log', 'Business config']) expect(nav.getByRole('link', { name: l })).toBeInTheDocument();
    for (const l of ['Dispute', 'Review KYC', 'DB & Infra Center', 'Promo']) expect(nav.queryByRole('link', { name: l })).not.toBeInTheDocument();
  });

  it('SUPER_ADMIN sees the DB & Infra Center and RBAC; only FINANCE_SUPER_ADMIN may approve settlement changes', () => {
    const nav = renderNav(['SUPER_ADMIN']);
    expect(nav.getByRole('link', { name: 'DB & Infra Center' })).toBeInTheDocument();
    expect(nav.getByRole('link', { name: 'Peran & akses' })).toBeInTheDocument();
    expect(hasCapability(permissionsFor(['SUPER_ADMIN']), ['SUPER_ADMIN'], CAP.settlementApprove)).toBe(false);
    expect(hasCapability(permissionsFor(['FINANCE_SUPER_ADMIN']), ['FINANCE_SUPER_ADMIN'], CAP.settlementApprove)).toBe(true);
    expect(hasCapability(permissionsFor(['FINANCE_SUPER_ADMIN']), ['FINANCE_SUPER_ADMIN'], CAP.infraOperate)).toBe(false);
  });

  it('combines roles and drops empty sections; lands roles without analytics on their first page', () => {
    const roles = ['COMPLIANCE', 'MARKETING'];
    const sections = visibleNav(permissionsFor(roles), roles).map((s) => s.title);
    expect(sections).toContain('Konfigurasi');
    expect(sections).not.toContain('Sistem');
    expect(homePath(permissionsFor(['SUPPORT']), ['SUPPORT'])).toBe('/users');
    expect(homePath(permissionsFor([]), [])).toBe('/no-access');
  });

  it('prefers effective permissions from /v1/me over the mirrored matrix (unknown codes ignored)', () => {
    const fromServer = permissionsFor(['SUPPORT'], ['users.read', 'audit.read', 'future.permission']);
    expect([...fromServer].sort()).toEqual(['audit.read', 'users.read']);
    expect(permissionsFor(['SUPPORT'], []).size).toBe(0);
    expect(permissionsFor(['SUPPORT'], undefined).has('support.tickets.manage')).toBe(true);
  });
});
