import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Rules } from '../../api/admin';
import type { RuleDetail, RulePreviewResult, RuleKind, RuleVersion } from '../../api/types';
import { useAuth } from '../../auth/AuthProvider';
import { CAP, type Capability } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { JsonView } from '../../components/data';
import { Dialog, Drawer } from '../../components/Overlay';
import { cleanValue, SCHEMAS, SchemaForm, validateAgainst, type FormValue } from '../../components/SchemaForm';
import { Badge, Button, Callout, Card, DateTime, Field, IdText, KeyValue, LoadingBlock, Money, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { formatDate, humanize, wibDate } from '../../lib/format';
import { CATEGORY_OPTIONS, COUNTRY_OPTIONS } from '../../lib/reference';

const META: Record<RuleKind, { title: string; subtitle: string; schema: string; cap: Capability }> = {
  customs: { title: 'Aturan bea cukai', subtitle: 'Versi rule perhitungan bea masuk & pajak impor (§16).', schema: 'AdminCustomsRuleCreate', cap: CAP.customs },
  restricted: { title: 'Barang terbatas', subtitle: 'Klasifikasi ALLOWED … PROHIBITED per kategori/HS/kata kunci (§16).', schema: 'AdminRestrictedItemCreate', cap: CAP.restricted },
};

const STALE_DAYS = 180;

function ruleSummary(r: RuleVersion): string {
  if (r.kind === 'customs') return `${humanize(r.formulaCode)} · bea ${r.dutyRate ?? '—'} · PPN ${r.vatRate ?? '—'} · PPh ${r.incomeTaxRate ?? '—'}${r.exemptionUsd ? ` · bebas USD ${r.exemptionUsd}` : ''}`;
  return `${r.classification ?? '—'}${r.permitAuthority ? ` · izin ${r.permitAuthority}` : ''}${r.keywords?.length ? ` · ${r.keywords.slice(0, 3).join(', ')}` : ''}`;
}

export default function RulesPage({ kind }: { kind: RuleKind }) {
  const meta = META[kind];
  const api = useMemo(() => Rules(kind), [kind]);
  const [status, setStatus] = useState('');
  const [code, setCode] = useState('');
  const q = useQuery({ queryKey: ['rules', kind, status, code], queryFn: () => api.list({ ...(status ? { status } : {}), ...(code ? { code } : {}) }) });
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<FormValue | null>(null);
  const needs = (q.data?.data ?? []).filter((r) => r.needsVerification).length;
  return (
    <div className="stack stack--lg">
      <PageHeader title={meta.title} subtitle={`${meta.subtitle} Versi ACTIVE tidak pernah diubah — setiap perubahan adalah versi baru dengan sumber regulasi.`} actions={<Button variant="primary" icon="plus" onClick={() => setCreating({ destinationCountry: 'ID', effectiveFrom: wibDate(), lastVerifiedAt: wibDate() })}>Versi baru</Button>} />
      {needs ? (
        <Callout tone="warning" icon="flag" title={`${needs} versi NEEDS_VERIFICATION.`}>
          Draf/menunggu persetujuan belum boleh dianggap berlaku; verifikasi sumber regulasi sebelum menyetujui.
        </Callout>
      ) : null}
      <Card flush>
        <div className="filterbar">
          <Field label="Status">
            <Select value={status} onChange={setStatus} placeholder="Semua" options={['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED']} />
          </Field>
          <Field label="Kode">
            <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="mis. ID_DEFAULT" />
          </Field>
        </div>
        <DataTable
          caption={meta.title}
          rows={q.data?.data}
          loading={q.isPending}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpenId(r.id)}
          rowLabel={(r) => `Buka ${r.code} versi ${r.version}`}
          rowClassName={(r) => (r.needsVerification ? 'row--highlight' : undefined)}
          empty={{ title: 'Belum ada versi rule' }}
          columns={[
            { key: 'c', header: 'Kode · versi', render: (r) => <span className="stack" style={{ gap: 0 }}><code className="cell-primary">{r.code}</code><span className="cell-sub">v{r.version}</span></span>, sortValue: (r) => `${r.code}:${String(r.version).padStart(4, '0')}` },
            { key: 's', header: 'Status', render: (r) => <span className="row row--tight"><StatusBadge status={r.status} />{r.needsVerification ? <Badge tone="warning">NEEDS_VERIFICATION</Badge> : null}{r.inForceToday ? <Badge tone="success">Berlaku hari ini</Badge> : null}</span> },
            { key: 'scope', header: 'Cakupan', render: (r) => <span className="small">{r.originCountry ?? '*'} → {r.destinationCountry} · {r.categoryCode ?? 'semua kategori'}{r.hsCodePrefix ? ` · HS ${r.hsCodePrefix}` : ''}</span> },
            { key: 'sum', header: 'Ringkasan', render: (r) => <span className="small">{ruleSummary(r)}</span> },
            { key: 'eff', header: 'Berlaku', render: (r) => <span className="small nowrap">{formatDate(r.effectiveFrom)} – {r.effectiveUntil ? formatDate(r.effectiveUntil) : '∞'}</span>, sortValue: (r) => r.effectiveFrom },
            { key: 'src', header: 'Sumber', render: (r) => <span className="small truncate" style={{ maxWidth: 200, display: 'inline-block' }} title={r.sourceReference}>{r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">{r.sourceReference}</a> : r.sourceReference}</span> },
            { key: 'ver', header: 'Terakhir diverifikasi', render: (r) => <span className="stack" style={{ gap: 0 }}><span className={r.verificationAgeDays > STALE_DAYS ? 'badge badge--warning' : 'small'}>{formatDate(r.lastVerifiedAt)}</span><span className="cell-sub">{r.verificationAgeDays} hari · {r.verifiedBy ?? '—'}</span></span>, sortValue: (r) => r.verificationAgeDays },
          ]}
        />
      </Card>
      <footer className="footer-note">Angka tarif adalah data regulasi yang dikelola tim Compliance; hasil perhitungan selalu “Estimasi — nilai final ditetapkan Bea Cukai”. Versi &gt; {STALE_DAYS} hari sejak verifikasi ditandai.</footer>
      {openId ? <RuleDrawer kind={kind} id={openId} onClose={() => setOpenId(null)} onCopy={(v) => (setOpenId(null), setCreating(v))} /> : null}
      {creating ? <RuleEditor kind={kind} initial={creating} onClose={() => setCreating(null)} /> : null}
    </div>
  );
}

function RuleDrawer({ kind, id, onClose, onCopy }: { kind: RuleKind; id: string; onClose: () => void; onCopy: (v: FormValue) => void }) {
  const api = useMemo(() => Rules(kind), [kind]);
  const { me, can, missing } = useAuth();
  const q = useQuery({ queryKey: ['rules', kind, 'detail', id], queryFn: () => api.detail(id) });
  const [dlg, setDlg] = useState<null | 'discard' | 'submit' | 'approve' | 'reject' | 'retire' | 'reverify'>(null);
  const [preview, setPreview] = useState(false);
  const [verifiedBy, setVerifiedBy] = useState('');
  const [verifiedAt, setVerifiedAt] = useState(wibDate());
  const [editing, setEditing] = useState(false);
  const inv = [['rules', kind]];
  const run = useAdminAction({
    run: (v: { op: NonNullable<typeof dlg>; reason: string }) => {
      switch (v.op) {
        case 'discard':
          return api.discard(id, v.reason);
        case 'submit':
          return api.submit(id);
        case 'approve':
          return api.approve(id);
        case 'reject':
          return api.reject(id, v.reason);
        case 'retire':
          return api.retire(id, v.reason);
        default:
          return api.reverify(id, { lastVerifiedAt: verifiedAt, verifiedBy, ...(v.reason ? { sourceNote: v.reason } : {}) });
      }
    },
    invalidate: inv,
    toastErrors: false,
    success: (r) => ('status' in r && r.status ? `Rule → ${String(r.status)}` : 'Tersimpan'),
  });
  const r = q.data;
  const capOk = can(META[kind].cap);
  const permReason = capOk ? null : `Butuh izin: ${missing(META[kind].cap).join(', ')}`;
  const cfg: Record<NonNullable<typeof dlg>, { title: string; label: string; tone: 'primary' | 'danger' | 'success'; mfa?: boolean; reason: false | { minLength?: number; label?: string; required?: boolean } }> = {
    discard: { title: 'Buang draf', label: 'Buang draf', tone: 'danger', reason: { minLength: 5 } },
    submit: { title: 'Ajukan untuk persetujuan', label: 'Ajukan', tone: 'primary', reason: false },
    approve: { title: 'Setujui & aktifkan', label: 'Setujui & aktifkan', tone: 'success', mfa: true, reason: false },
    reject: { title: 'Tolak (kembali ke DRAFT)', label: 'Tolak', tone: 'danger', reason: { minLength: 5 } },
    retire: { title: 'Pensiunkan versi aktif', label: 'Pensiunkan', tone: 'danger', mfa: true, reason: { minLength: 5 } },
    reverify: { title: 'Catat verifikasi ulang sumber', label: 'Simpan verifikasi', tone: 'primary', reason: { label: 'Catatan sumber (opsional)', required: false, minLength: 0 } },
  };
  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={r ? `${r.code} v${r.version}` : 'Rule'}
      subtitle={r ? <span className="row row--tight"><StatusBadge status={r.status} />{r.needsVerification ? <Badge tone="warning">NEEDS_VERIFICATION</Badge> : null}</span> : null}
      footer={
        r ? (
          <>
            <Button icon="play" onClick={() => setPreview(true)}>Pratinjau dampak</Button>
            <Button icon="copy" onClick={() => onCopy(Object.fromEntries(Object.entries(r).filter(([k]) => k in (SCHEMAS[META[kind].schema]!.properties ?? {}))) as FormValue)}>Salin ke versi baru</Button>
            {r.status === 'DRAFT' ? (
              <>
                <Button onClick={() => setEditing(true)} disabledReason={permReason}>Ubah draf</Button>
                <Button variant="danger-outline" onClick={() => setDlg('discard')} disabledReason={permReason}>Buang</Button>
                <Button variant="primary" onClick={() => setDlg('submit')} disabledReason={permReason}>Ajukan</Button>
              </>
            ) : null}
            {r.status === 'PENDING_APPROVAL' ? (
              <>
                <Button variant="danger-outline" onClick={() => setDlg('reject')} disabledReason={permReason}>Tolak</Button>
                <Button variant="success" mfa onClick={() => setDlg('approve')} disabledReason={permReason ?? (r.createdBy === me?.id ? 'Anda pembuat versi ini — persetujuan oleh admin lain (maker-checker)' : null)}>Setujui</Button>
              </>
            ) : null}
            {r.status === 'ACTIVE' ? (
              <Button variant="danger-outline" mfa onClick={() => setDlg('retire')} disabledReason={permReason}>Pensiunkan</Button>
            ) : null}
            {r.status !== 'RETIRED' ? <Button onClick={() => setDlg('reverify')} disabledReason={permReason}>Verifikasi ulang</Button> : null}
          </>
        ) : null
      }
    >
      {!r ? (
        <LoadingBlock rows={8} />
      ) : (
        <>
          {r.needsVerification ? <Callout tone="warning" icon="flag">Versi ini belum berlaku. Pastikan sumber regulasi diverifikasi (tanggal, nomor peraturan) sebelum disetujui.</Callout> : null}
          <Card title="Nilai">
            <KeyValue cols={2} items={Object.entries(r).filter(([k]) => !['id', 'kind', 'versions', 'createdAt', 'updatedAt', 'needsVerification', 'inForceToday', 'verificationAgeDays'].includes(k)).map(([k, v]) => [humanize(k.replace(/([a-z])([A-Z])/g, '$1_$2')), v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string])} />
          </Card>
          <Card title="Versi kode ini" flush>
            <DataTable compact caption="Versi" rows={r.versions} rowKey={(v) => v.id} columns={[{ key: 'v', header: 'Versi', render: (v) => `v${v.version}` }, { key: 's', header: 'Status', render: (v) => <StatusBadge status={v.status} /> }, { key: 'e', header: 'Berlaku', render: (v) => `${formatDate(v.effectiveFrom)} – ${v.effectiveUntil ? formatDate(v.effectiveUntil) : '∞'}` }]} />
          </Card>
          <p className="small muted">
            Dibuat oleh <IdText id={r.createdBy} /> · <DateTime value={r.createdAt} /> · disetujui <IdText id={r.approvedBy} /> <DateTime value={r.approvedAt} />
          </p>
        </>
      )}
      {dlg ? (
        <ActionDialog
          open
          onClose={() => setDlg(null)}
          title={cfg[dlg].title}
          description={dlg === 'approve' ? 'Versi ACTIVE sebelumnya untuk kode ini ditutup sehari sebelum effectiveFrom, atau RETIRED bila mulai lebih lambat.' : undefined}
          confirmLabel={cfg[dlg].label}
          tone={cfg[dlg].tone}
          mfa={cfg[dlg].mfa}
          reason={cfg[dlg].reason}
          canConfirm={dlg !== 'reverify' || verifiedBy.trim().length > 1}
          onConfirm={(reason) => run.mutateAsync({ op: dlg, reason })}
        >
          {dlg === 'reverify' ? (
            <div className="form-grid">
              <Field label="Tanggal verifikasi" required>
                <input className="input" type="date" value={verifiedAt} onChange={(e) => setVerifiedAt(e.target.value)} />
              </Field>
              <Field label="Diverifikasi oleh" required>
                <input className="input" value={verifiedBy} onChange={(e) => setVerifiedBy(e.target.value)} placeholder="Nama / tim" />
              </Field>
            </div>
          ) : null}
        </ActionDialog>
      ) : null}
      {preview && r ? <PreviewDialog kind={kind} rule={r} onClose={() => setPreview(false)} /> : null}
      {editing && r ? <RuleEditor kind={kind} initial={r as unknown as FormValue} editId={r.id} onClose={() => setEditing(false)} /> : null}
    </Drawer>
  );
}

function RuleEditor({ kind, initial, editId, onClose }: { kind: RuleKind; initial: FormValue; editId?: string; onClose: () => void }) {
  const api = useMemo(() => Rules(kind), [kind]);
  const schema = SCHEMAS[META[kind].schema]!;
  const [value, setValue] = useState<FormValue>(() => Object.fromEntries(Object.entries(initial).filter(([k]) => k in (schema.properties ?? {}))));
  const errors = useMemo(() => validateAgainst(editId ? { ...schema, required: [] } : schema, value), [schema, value, editId]);
  const save = useAdminAction({
    run: () => {
      const body = cleanValue(schema, value);
      if (editId) {
        delete body.code;
        return api.patch(editId, body);
      }
      return api.create(body);
    },
    invalidate: [['rules', kind]],
    toastErrors: false,
    success: (r) => `${r.code} v${r.version} disimpan sebagai ${r.status}`,
    onSuccess: onClose,
  });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={editId ? 'Ubah draf' : 'Versi rule baru (DRAFT)'}
      description="Sumber regulasi (sourceReference) dan tanggal verifikasi wajib. Versi = max + 1 per kode."
      footer={
        <>
          <Button onClick={onClose}>Batal</Button>
          <Button variant="primary" loading={save.isPending} disabledReason={errors.length ? `${errors.length} isian belum valid` : null} onClick={() => save.mutate(undefined, { onError: (e) => setErr(e instanceof Error ? e.message : String(e)) })}>
            {editId ? 'Simpan draf' : 'Buat draf'}
          </Button>
        </>
      }
    >
      {err ? <Callout tone="danger">{err}</Callout> : null}
      <SchemaForm
        schema={schema}
        value={value}
        onChange={setValue}
        errors={errors}
        readOnly={editId ? ['code'] : []}
        options={{ originCountry: COUNTRY_OPTIONS, destinationCountry: COUNTRY_OPTIONS, categoryCode: CATEGORY_OPTIONS }}
        hints={{ sourceReference: 'Nomor/judul peraturan (mis. PMK 199/2019 jo. PMK 4/2025) — wajib', dutyRate: 'Desimal 0–1 (0.075 = 7,5 %)', vatRate: 'Desimal 0–1', exemptionUsd: 'Batas pembebasan per penumpang (USD)' }}
      />
    </Dialog>
  );
}

function PreviewDialog({ kind, rule, onClose }: { kind: RuleKind; rule: RuleDetail; onClose: () => void }) {
  const api = useMemo(() => Rules(kind), [kind]);
  const schema = SCHEMAS.AdminRulePreview!;
  const [value, setValue] = useState<FormValue>({ originCountry: rule.originCountry ?? 'JP', destinationCountry: rule.destinationCountry, categoryCode: rule.categoryCode ?? 'ELECTRONICS', unitPriceMinor: 8800000, currency: 'JPY', quantity: 1, productName: 'Sampel barang' });
  const [result, setResult] = useState<RulePreviewResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errors = validateAgainst(schema, value);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.preview(rule.id, cleanValue(schema, value) as never));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'number' ? (o[k] as number) : null);
  return (
    <Dialog open wide onClose={onClose} title={`Pratinjau dampak ${rule.code} v${rule.version}`} description="Sampel barang dihitung dengan rule yang berlaku vs. set yang sama dengan versi ini menggantikan kodenya." footer={<><Button onClick={onClose}>Tutup</Button><Button variant="primary" icon="play" loading={busy} disabledReason={errors.length ? 'Lengkapi sampel' : null} onClick={() => void run()}>Hitung</Button></>}>
      <SchemaForm schema={schema} value={value} onChange={setValue} errors={errors} hidden={['fx']} options={{ originCountry: COUNTRY_OPTIONS, destinationCountry: COUNTRY_OPTIONS, categoryCode: CATEGORY_OPTIONS }} hints={{ unitPriceMinor: 'Minor unit mata uang (JPY 0 desimal, USD sen)' }} />
      {err ? <Callout tone="danger">{err}</Callout> : null}
      {result ? (
        kind === 'customs' ? (
          <table className="breakdown" aria-label="Hasil pratinjau bea cukai">
            <tbody>
              <tr>
                <td />
                <td className="small muted">Berlaku sekarang</td>
                <td className="small muted">Dengan versi ini</td>
                <td className="small muted">Selisih</td>
              </tr>
              {(['dutyIdr', 'importTaxIdr', 'totalIdr'] as const).map((k) => (
                <tr key={k} className={k === 'totalIdr' ? 'total' : undefined}>
                  <td>{k === 'dutyIdr' ? 'Bea masuk' : k === 'importTaxIdr' ? 'Pajak impor' : 'Total'} <span className="estimate">Estimasi</span></td>
                  <td>{'error' in result.current ? <span className="muted">{String(result.current.error)}</span> : <Money value={pick(result.current, k)} />}</td>
                  <td>
                    <Money value={pick(result.proposed, k)} />
                  </td>
                  <td>{result.delta ? <Money value={result.delta[k]} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <KeyValue
            items={[
              ['Sekarang', <StatusBadge status={String(result.current.classification)} />],
              ['Dengan versi ini', <StatusBadge status={String(result.proposed.classification)} />],
              ['Berubah', result.changed ? <Badge tone="warning">Ya</Badge> : 'Tidak'],
            ]}
          />
        )
      ) : null}
      {result ? (
        <details>
          <summary className="small">Detail mentah</summary>
          <JsonView value={result} />
        </details>
      ) : null}
    </Dialog>
  );
}
