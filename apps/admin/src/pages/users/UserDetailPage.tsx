import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { MfaResets, Users } from '../../api/admin';
import type { RevealedContact } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { ADMIN_ROLES, CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { JsonView } from '../../components/data';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Callout, Card, DateTime, Field, IdText, KeyValue, LoadingBlock, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatNumber, humanize } from '../../lib/format';
import { KycBadge, TrustBadge } from './UsersPage';

type Dlg = null | 'reveal' | 'suspend' | 'reactivate' | 'logout' | 'grant' | 'mfa-reset' | { revoke: string };

export default function UserDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['users', 'detail', id], queryFn: () => Users.detail(id) });
  const [dlg, setDlg] = useState<Dlg>(null);
  const [revealed, setRevealed] = useState<RevealedContact | null>(null);
  const [role, setRole] = useState('');
  const canSuspend = useCan(CAP.suspendUser);
  const canRoles = useCan(CAP.manageRoles);
  const inv = [['users']];

  const reveal = useAdminAction({ run: (reason: string) => Users.reveal(id, reason), toastErrors: false, onSuccess: (r) => setRevealed(r) });
  const suspend = useAdminAction({ run: (reason: string) => Users.suspend(id, reason), invalidate: inv, toastErrors: false, success: (r) => `Akun ditangguhkan · ${r.sessionsRevoked} sesi dicabut${r.warning ? ` · ${r.warning}` : ''}` });
  const reactivate = useAdminAction({ run: (reason: string) => Users.reactivate(id, reason), invalidate: inv, toastErrors: false, success: 'Akun diaktifkan kembali' });
  const logout = useAdminAction({ run: (reason: string) => Users.forceLogout(id, reason), invalidate: inv, toastErrors: false, success: (r) => `${r.sessionsRevoked} sesi dicabut` });
  const grant = useAdminAction({ run: (v: { role: string; reason: string }) => Users.grantRole(id, v.role, v.reason), invalidate: inv, toastErrors: false, success: (r) => r.message });
  const revoke = useAdminAction({ run: (v: { role: string; reason: string }) => Users.revokeRole(id, v.role, v.reason), invalidate: inv, toastErrors: false, success: 'Peran dicabut' });
  const canMfaReset = useCan(CAP.mfaResetRequest);
  const mfaReset = useAdminAction({
    run: (reason: string) => MfaResets.request(id, reason),
    invalidate: [['rbac']],
    toastErrors: false,
    success: 'Permintaan reset MFA dibuat · menunggu persetujuan SUPER_ADMIN lain',
  });

  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 60_000);
    return () => clearTimeout(t);
  }, [revealed]);

  if (q.isPending) return <LoadingBlock rows={8} />;
  if (q.isError || !q.data) return <Callout tone="danger">Pengguna tidak dapat dimuat.</Callout>;
  const u = q.data;
  const self = me?.id === u.id;

  return (
    <div className="stack stack--lg">
      <PageHeader
        breadcrumb={<Link to="/users">Pengguna</Link>}
        title={u.displayName ?? 'Pengguna'}
        subtitle={
          <span className="row">
            <IdText id={u.id} full /> <StatusBadge status={u.status} /> <KycBadge level={u.kycLevel} /> <TrustBadge score={u.trust.score} />
            {u.trust.overrideId ? <Badge tone="amber">Disesuaikan tim JastipKita</Badge> : null}
          </span>
        }
        actions={
          <>
            <Button icon="eye" mfa onClick={() => setDlg('reveal')}>
              Tampilkan kontak
            </Button>
            {u.status === 'SUSPENDED' ? (
              <Button variant="success" mfa onClick={() => setDlg('reactivate')} disabledReason={canSuspend.reason}>
                Aktifkan kembali
              </Button>
            ) : (
              <Button variant="danger-outline" icon="ban" mfa onClick={() => setDlg('suspend')} disabledReason={canSuspend.reason ?? (self ? 'Tidak dapat menangguhkan akun sendiri' : u.status !== 'ACTIVE' ? `Status ${u.status}` : null)}>
                Tangguhkan
              </Button>
            )}
            <Button icon="logout" onClick={() => setDlg('logout')} disabledReason={canSuspend.reason}>
              Paksa logout
            </Button>
          </>
        }
      />
      {u.suspendedAt ? (
        <Callout tone="danger" title="Akun ditangguhkan.">
          Sejak <DateTime value={u.suspendedAt} /> — {u.suspensionReason}
        </Callout>
      ) : null}

      <div className="grid grid-main-side">
        <div className="stack stack--lg">
          <Card title="Profil (dimasking)">
            <KeyValue
              cols={2}
              items={[
                ['E-mail', <span className="mono">{u.email ?? '—'}</span>],
                ['Telepon', <span className="mono">{u.phone ?? '—'}</span>],
                ['Mode aktif', humanize(u.activeMode)],
                ['Kode referral', <code>{u.referralCode}</code>],
                ['Terdaftar', <DateTime value={u.createdAt} />],
                ['Login terakhir', <DateTime value={u.lastLoginAt} />],
                ['Perangkat aktif', formatNumber(u.devices.count)],
                ['Dispute terbuka', formatNumber(u.disputes.open)],
                ['Security event 30 hari', `${u.security.events30d} (HIGH/CRITICAL ${u.security.highOrCritical30d})`],
                ['Review risiko terbuka', formatNumber(u.risk.openReviews)],
              ]}
            />
          </Card>
          <Card title="Ringkasan transaksi">
            <div className="grid grid-2">
              {(['asBuyer', 'asTraveler'] as const).map((k) => (
                <div key={k} className="stack stack--sm">
                  <strong>{k === 'asBuyer' ? 'Sebagai penitip' : 'Sebagai traveler'}</strong>
                  <KeyValue
                    items={[
                      ['Total', formatNumber(u.transactions[k].total)],
                      ['Selesai', formatNumber(u.transactions[k].completed)],
                      ['Nilai selesai', <Money value={u.transactions[k].completedValueIdr} />],
                      ['Per status', Object.entries(u.transactions[k].byStatus).map(([s, n]) => `${humanize(s)} ${n}`).join(' · ') || '—'],
                    ]}
                  />
                  <Link to={`/transactions?${k === 'asBuyer' ? 'buyerId' : 'travelerId'}=${u.id}`}>Lihat transaksi →</Link>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Sesi aktif" hint="Refresh-token family yang belum dicabut" flush>
            <DataTable
              compact
              caption="Sesi aktif"
              rows={u.sessions}
              rowKey={(s) => s.sessionId}
              empty={{ title: 'Tidak ada sesi aktif' }}
              columns={[
                { key: 'id', header: 'Sesi', render: (s) => <IdText id={s.sessionId} /> },
                { key: 'p', header: 'Platform', render: (s) => `${s.platform ?? '—'} ${s.appVersion ?? ''}` },
                { key: 'c', header: 'Dibuat', render: (s) => <DateTime value={s.createdAt} /> },
                { key: 'e', header: 'Kedaluwarsa', render: (s) => <DateTime value={s.expiresAt} /> },
              ]}
            />
          </Card>
          <Card title="Penilaian risiko" flush>
            <DataTable
              compact
              caption="Penilaian risiko pengguna"
              rows={u.risk.assessments}
              rowKey={(r) => r.id}
              empty={{ title: 'Belum ada penilaian' }}
              columns={[
                { key: 'd', header: 'Keputusan', render: (r) => <StatusBadge status={r.decision} /> },
                { key: 's', header: 'Skor', align: 'right', render: (r) => r.score },
                { key: 'r', header: 'Alasan', render: (r) => <span className="small">{Array.isArray(r.reasons) ? (r.reasons as { code?: string }[]).map((x) => x.code ?? '').join(', ') : '—'}</span> },
                { key: 'v', header: 'Rules', render: (r) => <code>{r.rulesVersion}</code> },
                { key: 't', header: 'Waktu', render: (r) => <DateTime value={r.createdAt} /> },
              ]}
            />
          </Card>
        </div>
        <div className="stack stack--lg">
          <Card
            title="Peran admin"
            hint="Peran istimewa (SUPER_ADMIN, FINANCE_SUPER_ADMIN) → maker-checker oleh SUPER_ADMIN lain"
            actions={
              <Button size="sm" icon="plus" mfa onClick={() => setDlg('grant')} disabledReason={canRoles.reason ?? (self ? 'Tidak dapat memberi peran ke diri sendiri' : null)}>
                Beri peran
              </Button>
            }
          >
            {u.roleGrants.length ? (
              <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {u.roleGrants.map((g) => (
                  <li key={g.roleCode} className="row row--between">
                    <span className="stack" style={{ gap: 2 }}>
                      <Badge tone="navy" dot={false}>
                        {g.roleCode}
                      </Badge>
                      <span className="small muted">
                        <DateTime value={g.grantedAt} /> · {g.reason ?? '—'}
                      </span>
                    </span>
                    <Button size="sm" variant="danger-outline" mfa onClick={() => setDlg({ revoke: g.roleCode })} disabledReason={canRoles.reason}>
                      Cabut
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Bukan admin.</p>
            )}
            {u.roleGrants.length ? (
              <div className="row row--between" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--jk-color-divider)' }}>
                <span className="small muted">Kehilangan authenticator? Reset TOTP = maker-checker (72 jam).</span>
                <Button size="sm" variant="danger-outline" icon="key" mfa onClick={() => setDlg('mfa-reset')} disabledReason={canMfaReset.reason ?? (self ? 'Tidak dapat mereset MFA milik sendiri — minta admin lain' : null)} data-testid="request-mfa-reset">
                  Ajukan reset MFA
                </Button>
              </div>
            ) : null}
          </Card>
          <Card title="Trust Score" actions={<Link to={`/trust?userId=${u.id}`}>Ajukan override →</Link>}>
            <div className="stack stack--sm">
              <TrustBadge score={u.trust.score} />
              <span className="small muted">
                Dihitung <DateTime value={u.trust.computedAt} />
              </span>
              <JsonView value={u.trust.components} label="Komponen trust score" />
            </div>
          </Card>
          <Card title="KYC & rekening payout">
            <div className="stack">
              {u.kyc.submissions.map((s) => (
                <div key={s.id} className="row row--between small">
                  <Link to={`/kyc/${s.id}`}>
                    {s.idType ?? 'KYC'} → L{s.targetLevel}
                  </Link>
                  <StatusBadge status={s.status} />
                </div>
              ))}
              {u.kyc.payoutAccounts.map((p) => (
                <div key={p.id} className="row row--between small">
                  <span className="mono">
                    {p.bankCode} {p.accountMask}
                  </span>
                  <StatusBadge status={p.verificationStatus} />
                </div>
              ))}
              {!u.kyc.submissions.length && !u.kyc.payoutAccounts.length ? <p className="muted small">Belum ada pengajuan.</p> : null}
            </div>
          </Card>
        </div>
      </div>

      <ActionDialog
        open={dlg === 'reveal'}
        onClose={() => setDlg(null)}
        title="Tampilkan kontak lengkap"
        description="Membuka e-mail, telepon dan nama lengkap. Tercatat sebagai audit users.pii_revealed + security event ADMIN_PII_REVEALED."
        confirmLabel="Tampilkan kontak"
        mfa
        reason={{ minLength: 5, placeholder: 'mis. Verifikasi manual tiket TKT-…' }}
        onConfirm={(reason) => reveal.mutateAsync(reason)}
      />
      <ActionDialog
        open={dlg === 'mfa-reset'}
        onClose={() => setDlg(null)}
        title="Ajukan reset MFA"
        description="Setelah disetujui SUPER_ADMIN lain (bukan Anda dan bukan pemilik akun), authenticator & kode pemulihan admin ini dinonaktifkan dan semua sesinya dicabut. Ia lalu masuk dengan OTP dan mendaftar ulang dalam 15 menit."
        confirmLabel="Ajukan reset"
        tone="danger"
        mfa
        reason={{ label: 'Alasan (min. 10 karakter, tercatat di audit)', minLength: 10, placeholder: 'mis. ponsel hilang, identitas dikonfirmasi lewat panggilan video' }}
        onConfirm={(r) => mfaReset.mutateAsync(r)}
      />
      <ActionDialog open={dlg === 'suspend'} onClose={() => setDlg(null)} title="Tangguhkan akun" description="Semua sesi dicabut. Transaksi terbuka tetap harus ditangani lewat menu Transaksi/Dispute." confirmLabel="Tangguhkan akun" tone="danger" mfa onConfirm={(r) => suspend.mutateAsync(r)} />
      <ActionDialog open={dlg === 'reactivate'} onClose={() => setDlg(null)} title="Aktifkan kembali akun" confirmLabel="Aktifkan kembali" tone="success" mfa onConfirm={(r) => reactivate.mutateAsync(r)} />
      <ActionDialog open={dlg === 'logout'} onClose={() => setDlg(null)} title="Paksa logout semua sesi" confirmLabel="Cabut semua sesi" tone="danger" onConfirm={(r) => logout.mutateAsync(r)} />
      <ActionDialog
        open={dlg === 'grant'}
        onClose={() => setDlg(null)}
        title="Beri peran admin"
        description="Peran non-istimewa langsung aktif. SUPER_ADMIN / FINANCE_SUPER_ADMIN menjadi permintaan (72 jam) yang harus disetujui SUPER_ADMIN lain."
        confirmLabel="Beri peran"
        mfa
        canConfirm={!!role}
        onConfirm={(reason) => grant.mutateAsync({ role, reason })}
      >
        <Field label="Peran" required>
          <Select value={role} onChange={setRole} placeholder="— pilih —" options={ADMIN_ROLES.filter((r) => !u.roles.includes(r)).map((r) => ({ value: r, label: r }))} />
        </Field>
      </ActionDialog>
      <ActionDialog
        open={typeof dlg === 'object' && dlg !== null}
        onClose={() => setDlg(null)}
        title={`Cabut peran ${typeof dlg === 'object' && dlg ? dlg.revoke : ''}`}
        description="Semua sesi pengguna ini langsung diakhiri (harus login ulang). SUPER_ADMIN terakhir dan SUPER_ADMIN milik sendiri tidak dapat dicabut."
        confirmLabel="Cabut peran"
        tone="danger"
        mfa
        onConfirm={(reason) => revoke.mutateAsync({ role: (dlg as { revoke: string }).revoke, reason })}
      />
      <Dialog
        open={!!revealed}
        onClose={() => setRevealed(null)}
        title="Kontak lengkap (tercatat)"
        description="Otomatis ditutup dalam 60 detik. Data tidak disimpan di cache aplikasi."
        footer={<Button onClick={() => setRevealed(null)}>Tutup</Button>}
      >
        {revealed ? (
          <KeyValue
            items={[
              ['Nama', revealed.displayName],
              ['E-mail', <span className="mono">{revealed.email ?? '—'}</span>],
              ['Telepon', <span className="mono">{revealed.phone ?? '—'}</span>],
              ['Dibuka', <DateTime value={revealed.revealedAt} />],
            ]}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
