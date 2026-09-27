import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Promotions } from '../../api/admin';
import type { BodyOf } from '../../api/admin';
import type { Promotion } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { JsonView } from '../../components/data';
import { Drawer } from '../../components/Overlay';
import { cleanValue, SCHEMAS, SchemaForm, validateAgainst, type FormValue } from '../../components/SchemaForm';
import { Badge, Button, Callout, Card, DateTime, Meter, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatBps, formatIdr, formatPercent, humanize } from '../../lib/format';
import { CATEGORY_OPTIONS, ORIGIN_COUNTRY_OPTIONS } from '../../lib/reference';

const BASE_SCHEMA = { ...SCHEMAS.AdminPromotionCreate!, properties: Object.fromEntries(Object.entries(SCHEMAS.AdminPromotionCreate!.properties ?? {}).filter(([k]) => k !== 'conditions' && k !== 'benefit')) };

export function describeBenefit(b: Record<string, unknown>): string {
  switch (b.kind) {
    case 'PERCENT':
      return `${formatBps(Number(b.rateBps))} dari ${humanize(String(b.base ?? 'SUBTOTAL'))}${b.capIdr ? `, maks ${formatIdr(Number(b.capIdr))}` : ''}`;
    case 'FIXED':
      return `Potongan ${formatIdr(Number(b.amountIdr))}`;
    case 'FREE_PLATFORM_FEE':
      return 'Gratis platform fee';
    case 'CASHBACK_CREDIT':
      return `Cashback credit ${b.rateBps ? formatBps(Number(b.rateBps)) : formatIdr(Number(b.amountIdr ?? 0))}${b.capIdr ? `, maks ${formatIdr(Number(b.capIdr))}` : ''}`;
    default:
      return JSON.stringify(b);
  }
}

export default function PromotionsPage() {
  const { me } = useAuth();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['promotions', status], queryFn: () => Promotions.list(status || undefined) });
  const perm = useCan(CAP.promotions);
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const [dlg, setDlg] = useState<{ kind: 'activate' | 'pause' | 'end'; p: Promotion } | null>(null);
  const act = useAdminAction({
    run: (v: { kind: 'activate' | 'pause' | 'end'; p: Promotion; reason: string }) => (v.kind === 'activate' ? Promotions.activate(v.p.id) : v.kind === 'pause' ? Promotions.pause(v.p.id, v.reason) : Promotions.end(v.p.id, v.reason)),
    invalidate: [['promotions']],
    toastErrors: false,
    success: (r) => `Promo ${r.name} → ${r.status}`,
  });
  const activateBlock = (p: Promotion) => perm.reason ?? (p.createdBy === me?.id ? 'Anda pembuat promo ini — aktivasi oleh admin lain (maker-checker)' : !['DRAFT', 'PAUSED'].includes(p.status) ? `Status ${p.status}` : p.endsAt && Date.parse(p.endsAt) <= Date.now() ? 'Tanggal berakhir sudah lewat' : null);

  return (
    <div className="stack stack--lg">
      <PageHeader title="Promo" subtitle="Kondisi & benefit diedit lewat form yang dibangkitkan dari JSON Schema kontrak API. Aktivasi = maker-checker + MFA." actions={<Button variant="primary" icon="plus" onClick={() => setEditing('new')} disabledReason={perm.reason}>Promo baru</Button>} />
      <Card title="Daftar promo" actions={<Select className="select--sm" aria-label="Status" value={status} onChange={setStatus} placeholder="Semua" options={['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED']} />} flush>
        <DataTable
          caption="Promo"
          rows={q.data?.data}
          loading={q.isPending}
          error={q.error}
          rowKey={(p) => p.id}
          onRowClick={(p) => setEditing(p)}
          rowLabel={(p) => `Buka promo ${p.name}`}
          empty={{ title: 'Belum ada promo' }}
          columns={[
            { key: 'n', header: 'Promo', render: (p) => <span className="stack" style={{ gap: 0 }}><span className="cell-primary">{p.name}</span><span className="cell-sub">{p.code ? <code>{p.code}</code> : humanize(p.type)}</span></span> },
            { key: 'b', header: 'Benefit', render: (p) => <span className="small">{describeBenefit(p.benefit)}</span> },
            { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
            { key: 'per', header: 'Periode', render: (p) => <span className="small"><DateTime value={p.startsAt} /> – {p.endsAt ? <DateTime value={p.endsAt} /> : 'tanpa akhir'}</span> },
            { key: 'bud', header: 'Budget terpakai', render: (p) => (p.budget.totalIdr ? <span className="stack" style={{ gap: 2, minWidth: 140 }}><Meter ratio={p.budget.usedRatio} label={`Budget ${p.name}`} tone={(p.budget.usedRatio ?? 0) > 0.9 ? 'danger' : (p.budget.usedRatio ?? 0) > 0.7 ? 'warn' : undefined} /><span className="cell-sub"><Money value={p.budget.usedIdr} /> / <Money value={p.budget.totalIdr} /> ({formatPercent(p.budget.usedRatio, 0)})</span></span> : <span className="muted small">tanpa batas</span>) },
            { key: 'u', header: 'Dipakai', align: 'right', render: (p) => `${p.usage.count}${p.usage.limitTotal ? ` / ${p.usage.limitTotal}` : ''}` },
            {
              key: 'a',
              header: 'Aksi',
              render: (p) => (
                <span className="btn-group">
                  {['DRAFT', 'PAUSED'].includes(p.status) ? (
                    <Button size="sm" variant="success" mfa disabledReason={activateBlock(p)} onClick={() => setDlg({ kind: 'activate', p })}>
                      Aktifkan
                    </Button>
                  ) : null}
                  {p.status === 'ACTIVE' ? (
                    <Button size="sm" disabledReason={perm.reason} onClick={() => setDlg({ kind: 'pause', p })}>
                      Jeda
                    </Button>
                  ) : null}
                  {p.status !== 'ENDED' ? (
                    <Button size="sm" variant="danger-outline" disabledReason={perm.reason} onClick={() => setDlg({ kind: 'end', p })}>
                      Akhiri
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </Card>
      {editing ? <PromotionEditor promo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ActionDialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg ? `${dlg.kind === 'activate' ? 'Aktifkan' : dlg.kind === 'pause' ? 'Jeda' : 'Akhiri'} promo ${dlg.p.name}` : ''}
        description={dlg?.kind === 'activate' ? `Benefit: ${describeBenefit(dlg.p.benefit)}. Pengaktif harus berbeda dari pembuat (juga dijaga DB).` : dlg?.kind === 'end' ? 'Terminal — promo tidak dapat diaktifkan lagi.' : 'Promo berhenti dipakai sampai diaktifkan kembali (maker-checker).'}
        confirmLabel={dlg?.kind === 'activate' ? 'Aktifkan promo' : dlg?.kind === 'pause' ? 'Jeda promo' : 'Akhiri promo'}
        tone={dlg?.kind === 'activate' ? 'success' : 'danger'}
        mfa={dlg?.kind === 'activate'}
        reason={dlg?.kind === 'activate' ? false : { minLength: 5 }}
        onConfirm={(reason) => act.mutateAsync({ ...dlg!, reason })}
      />
    </div>
  );
}

function PromotionEditor({ promo, onClose }: { promo: Promotion | null; onClose: () => void }) {
  const editable = !promo || ['DRAFT', 'PAUSED'].includes(promo.status);
  const [base, setBase] = useState<FormValue>(() =>
    promo
      ? { code: promo.code, name: promo.name, description: promo.description, type: promo.type, budgetTotalIdr: promo.budget.totalIdr, usageLimitTotal: promo.usage.limitTotal, usageLimitPerUser: promo.usage.limitPerUser, startsAt: promo.startsAt, endsAt: promo.endsAt, fundedBy: promo.fundedBy }
      : { type: 'PROMO_CODE', fundedBy: 'PLATFORM', startsAt: new Date().toISOString() },
  );
  const [conditions, setConditions] = useState<FormValue>(() => promo?.conditions ?? {});
  const [benefit, setBenefit] = useState<FormValue>(() => promo?.benefit ?? { kind: 'PERCENT', rateBps: 1000, base: 'PLATFORM_FEE' });
  const [err, setErr] = useState<string | null>(null);
  const errors = useMemo(
    () => [
      ...validateAgainst(BASE_SCHEMA, base),
      ...validateAgainst(SCHEMAS.AdminPromoConditions!, conditions).map((e) => ({ ...e, path: `conditions.${e.path}` })),
      ...validateAgainst(SCHEMAS.AdminPromoBenefit!, benefit).map((e) => ({ ...e, path: `benefit.${e.path}` })),
      ...(base.type === 'PROMO_CODE' && !base.code ? [{ path: 'code', message: 'PROMO_CODE membutuhkan code' }] : []),
      ...(promo && typeof base.budgetTotalIdr === 'number' && base.budgetTotalIdr < promo.budget.usedIdr ? [{ path: 'budgetTotalIdr', message: `Tidak boleh di bawah terpakai ${formatIdr(promo.budget.usedIdr)}` }] : []),
    ],
    [base, conditions, benefit, promo],
  );
  const save = useAdminAction({
    run: () => {
      const body = { ...cleanValue(BASE_SCHEMA, base), conditions: cleanValue(SCHEMAS.AdminPromoConditions!, conditions), benefit: cleanValue(SCHEMAS.AdminPromoBenefit!, benefit) };
      return promo ? Promotions.patch(promo.id, body as BodyOf<'/v1/admin/promotions/{id}', 'patch'>) : Promotions.create(body as BodyOf<'/v1/admin/promotions'>);
    },
    invalidate: [['promotions']],
    toastErrors: false,
    success: (r) => `Promo ${r.name} disimpan (${r.status})`,
    onSuccess: onClose,
  });
  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={promo ? `Promo: ${promo.name}` : 'Promo baru (DRAFT)'}
      subtitle={promo ? <span className="row row--tight"><StatusBadge status={promo.status} /> versi {promo.version} · dibuat oleh {promo.createdBy?.slice(0, 8) ?? '—'}</span> : 'Disimpan sebagai DRAFT; aktivasi oleh admin lain.'}
      footer={
        <>
          <Button onClick={onClose}>Batal</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabledReason={!editable ? `Promo ${promo?.status} — jeda dulu untuk mengubah` : errors.length ? `${errors.length} isian belum valid` : null}
            onClick={() => {
              setErr(null);
              save.mutate(undefined, { onError: (e) => setErr(e instanceof Error ? e.message : String(e)) });
            }}
          >
            {promo ? 'Simpan perubahan' : 'Buat DRAFT'}
          </Button>
        </>
      }
    >
      {!editable ? <Callout tone="warning">Promo {promo?.status}: hanya DRAFT/PAUSED yang dapat diubah.</Callout> : null}
      {err ? <Callout tone="danger">{err}</Callout> : null}
      <fieldset className="fieldset" disabled={!editable}>
        <legend>Dasar</legend>
        <SchemaForm schema={BASE_SCHEMA} value={base} onChange={setBase} errors={errors} labels={{ budgetTotalIdr: 'Budget total (IDR)', usageLimitTotal: 'Batas pemakaian total', usageLimitPerUser: 'Batas per pengguna', startsAt: 'Mulai', endsAt: 'Berakhir', fundedBy: 'Didanai oleh' }} />
      </fieldset>
      <fieldset className="fieldset" disabled={!editable}>
        <legend>Benefit</legend>
        <SchemaForm schema={SCHEMAS.AdminPromoBenefit!} value={benefit} onChange={setBenefit} errors={errors.map((e) => ({ ...e, path: e.path.replace(/^benefit\./, '') }))} labels={{ kind: 'Jenis benefit', rateBps: 'Rate (bps)', capIdr: 'Maksimum (IDR)', amountIdr: 'Nominal (IDR)', base: 'Basis', 'kind:PERCENT': 'Persentase', 'kind:FIXED': 'Potongan tetap', 'kind:FREE_PLATFORM_FEE': 'Gratis platform fee', 'kind:CASHBACK_CREDIT': 'Cashback credit' }} />
        <p className="small muted" style={{ marginTop: 8 }}>
          Ringkasan: {describeBenefit(benefit)}
        </p>
      </fieldset>
      <fieldset className="fieldset" disabled={!editable}>
        <legend>Kondisi</legend>
        <SchemaForm
          schema={SCHEMAS.AdminPromoConditions!}
          value={conditions}
          onChange={setConditions}
          errors={errors.map((e) => ({ ...e, path: e.path.replace(/^conditions\./, '') }))}
          options={{ originCountries: ORIGIN_COUNTRY_OPTIONS, categories: CATEGORY_OPTIONS }}
          labels={{ minItemValueIdr: 'Nilai barang minimal (IDR)', originCountries: 'Negara asal', categories: 'Kategori', firstTransactionOnly: 'Hanya transaksi pertama', travelerIds: 'ID traveler', userSegments: 'Segmen pengguna', public: 'Tampil publik', cashbackExpiryDays: 'Masa berlaku cashback (hari)' }}
        />
      </fieldset>
      <details>
        <summary className="small">Pratinjau payload JSON (baca saja)</summary>
        <JsonView value={{ ...cleanValue(BASE_SCHEMA, base), conditions: cleanValue(SCHEMAS.AdminPromoConditions!, conditions), benefit: cleanValue(SCHEMAS.AdminPromoBenefit!, benefit) }} />
      </details>
      {promo ? (
        <Card title="Pemakaian">
          <p className="small">
            Redemption: reserved {promo.usage.redemptions.reserved} · applied {promo.usage.redemptions.applied} ({formatIdr(promo.usage.redemptions.appliedIdr)}) · reversed {promo.usage.redemptions.reversed}
          </p>
          {promo.approvedBy ? <Badge tone="success">Diaktifkan oleh {promo.approvedBy.slice(0, 8)}</Badge> : null}
        </Card>
      ) : null}
    </Drawer>
  );
}
