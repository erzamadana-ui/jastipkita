import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Legal } from '../../api/admin';
import type { LegalDocument } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { Markdown } from '../../components/Markdown';
import { Drawer } from '../../components/Overlay';
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, LoadingBlock, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { humanize, isoFromWibInput, wibInputFromIso } from '../../lib/format';

const TYPES = ['TOS', 'PRIVACY', 'KYC', 'MARKETING', 'COOKIES', 'TRAVELER_AGREEMENT', 'PAYMENT_TERMS', 'REFUND_POLICY', 'PROHIBITED_ITEMS', 'COMMUNITY_GUIDELINES'] as const;
type LegalType = (typeof TYPES)[number];

export default function LegalPage() {
  const [type, setType] = useState('');
  const [locale, setLocale] = useState('');
  const q = useQuery({ queryKey: ['legal', type, locale], queryFn: () => Legal.list({ ...(type ? { type: type as LegalType } : {}), ...(locale ? { locale: locale as 'id' } : {}) }) });
  const [open, setOpen] = useState<string | 'new' | null>(null);
  return (
    <div className="stack stack--lg">
      <PageHeader title="Dokumen legal" subtitle="Versi per jenis & bahasa. Versi terbit IMMUTABLE — bukti persetujuan pengguna. “current” = yang dilihat pengguna." actions={<Button variant="primary" icon="plus" onClick={() => setOpen('new')}>Versi baru</Button>} />
      <Callout tone="info">Versi <strong>current</strong> (terbit terbaru, belum dipensiunkan) disajikan ke aplikasi & situs lewat <code>GET /v1/legal/documents</code>; versinya dibaca klien dari <code>GET /v1/consents/requirements</code> dan hanya versi terbit yang diterima saat pengguna memberi persetujuan.</Callout>
      <Card flush>
        <div className="filterbar">
          <Field label="Jenis">
            <Select value={type} onChange={setType} placeholder="Semua" options={[...TYPES]} />
          </Field>
          <Field label="Bahasa">
            <Select value={locale} onChange={setLocale} placeholder="Semua" options={[{ value: 'id', label: 'Indonesia' }, { value: 'en', label: 'English' }]} />
          </Field>
        </div>
        <DataTable
          caption="Dokumen legal"
          rows={q.data?.data}
          loading={q.isPending}
          error={q.error}
          rowKey={(d) => d.id}
          onRowClick={(d) => setOpen(d.id)}
          rowLabel={(d) => `Buka ${d.type} ${d.version}`}
          empty={{ title: 'Belum ada dokumen' }}
          columns={[
            { key: 't', header: 'Jenis', render: (d) => <span className="stack" style={{ gap: 0 }}><strong>{humanize(d.type)}</strong><span className="cell-sub">{d.title}{d.summary ? ` — ${d.summary}` : ''}</span></span> },
            { key: 'v', header: 'Versi', render: (d) => <code>{d.version}</code> },
            { key: 'l', header: 'Bahasa', render: (d) => d.locale.toUpperCase() },
            { key: 's', header: 'Status', render: (d) => <span className="row row--tight"><StatusBadge status={d.status} />{d.current ? <Badge tone="success">current</Badge> : null}</span> },
            { key: 'p', header: 'Terbit', render: (d) => <DateTime value={d.publishedAt} /> },
            { key: 'e', header: 'Berlaku', render: (d) => (d.effectiveAt ? <DateTime value={d.effectiveAt} /> : <span className="muted small">saat terbit</span>) },
            { key: 'c', header: 'Ringkasan perubahan', render: (d) => <span className="small">{d.summaryOfChanges ?? '—'}</span> },
          ]}
        />
      </Card>
      {open ? <LegalEditor id={open === 'new' ? null : open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function LegalEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const perm = useCan(CAP.legal);
  const q = useQuery({ queryKey: ['legal', 'detail', id], queryFn: () => Legal.detail(id!), enabled: !!id });
  const doc = q.data ?? null;
  if (id && !doc) {
    return (
      <Drawer open wide onClose={onClose} title="Dokumen legal">
        <LoadingBlock rows={8} />
      </Drawer>
    );
  }
  return <LegalForm doc={doc} onClose={onClose} permReason={perm.reason} />;
}

function LegalForm({ doc, onClose, permReason }: { doc: LegalDocument | null; onClose: () => void; permReason: string | null }) {
  const [v, setV] = useState({ type: doc?.type ?? 'TOS', version: doc?.version ?? '', locale: doc?.locale ?? 'id', title: doc?.title ?? '', bodyMd: doc?.bodyMd ?? '', summaryOfChanges: doc?.summaryOfChanges ?? '', summary: doc?.summary ?? '', effectiveAt: wibInputFromIso(doc?.effectiveAt) });
  const set = (k: keyof typeof v, val: string) => setV((s) => ({ ...s, [k]: val }));
  const [dlg, setDlg] = useState<null | 'publish' | 'retire'>(null);
  const [retirePrevious, setRetirePrevious] = useState(true);
  const locked = !!doc && doc.status !== 'DRAFT';
  const inv = [['legal']];
  const save = useAdminAction({
    run: () => {
      const effectiveAt = isoFromWibInput(v.effectiveAt);
      return doc
        ? Legal.patch(doc.id, { title: v.title, bodyMd: v.bodyMd, summaryOfChanges: v.summaryOfChanges, ...(v.summary.trim() || doc.summary ? { summary: v.summary.trim() } : {}), ...(effectiveAt || doc.effectiveAt ? { effectiveAt } : {}) })
        : Legal.create({ type: v.type as LegalType, version: v.version.trim(), locale: v.locale as 'id', title: v.title, bodyMd: v.bodyMd, ...(v.summaryOfChanges ? { summaryOfChanges: v.summaryOfChanges } : {}), ...(v.summary.trim() ? { summary: v.summary.trim() } : {}), ...(effectiveAt ? { effectiveAt } : {}) });
    },
    invalidate: inv,
    success: 'Draf dokumen disimpan',
    onSuccess: onClose,
  });
  const publish = useAdminAction({ run: () => Legal.publish(doc!.id, retirePrevious), invalidate: inv, toastErrors: false, success: 'Dokumen diterbitkan', onSuccess: onClose });
  const retire = useAdminAction({ run: (reason: string) => Legal.retire(doc!.id, reason), invalidate: inv, toastErrors: false, success: 'Dokumen dipensiunkan', onSuccess: onClose });
  const invalid = !v.version.trim() ? 'Versi wajib' : !/^[0-9A-Za-z._-]{1,40}$/.test(v.version.trim()) ? 'Versi hanya huruf, angka, titik, _ atau -' : v.title.trim().length < 3 ? 'Judul wajib' : v.bodyMd.trim().length < 20 ? 'Isi terlalu pendek' : v.summary.length > 1000 ? 'Ringkasan maks. 1000 karakter' : null;
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={doc ? `${humanize(doc.type)} ${doc.version} (${doc.locale})` : 'Versi dokumen legal baru'}
      subtitle={doc ? <span className="row row--tight"><StatusBadge status={doc.status} />{doc.current ? <Badge tone="success">current</Badge> : null}</span> : 'Draf — dapat diubah sampai terbit'}
      footer={
        <>
          {doc?.status === 'PUBLISHED' ? <Button variant="danger-outline" mfa onClick={() => setDlg('retire')} disabledReason={permReason}>Pensiunkan</Button> : null}
          <span className="spacer" />
          <Button onClick={onClose}>Tutup</Button>
          {!locked ? (
            <Button variant="primary" loading={save.isPending} disabledReason={permReason ?? invalid} onClick={() => save.mutate(undefined)}>
              Simpan draf
            </Button>
          ) : null}
          {doc?.status === 'DRAFT' ? (
            <Button variant="success" mfa onClick={() => setDlg('publish')} disabledReason={permReason}>
              Terbitkan
            </Button>
          ) : null}
        </>
      }
    >
      {locked ? <Callout tone="info" icon="lock">Versi terbit tidak dapat diubah (bukti persetujuan). Buat versi baru untuk perubahan.</Callout> : null}
      <div className="form-grid">
        <Field label="Jenis">
          <Select value={v.type} onChange={(x) => set('type', x)} options={[...TYPES]} disabled={!!doc} />
        </Field>
        <Field label="Versi" required>
          <input className="input mono" value={v.version} onChange={(e) => set('version', e.target.value)} disabled={!!doc} placeholder="2026-10" />
        </Field>
        <Field label="Bahasa">
          <Select value={v.locale} onChange={(x) => set('locale', x)} options={[{ value: 'id', label: 'Indonesia' }, { value: 'en', label: 'English' }]} />
        </Field>
      </div>
      <Field label="Judul" required>
        <input className="input" value={v.title} onChange={(e) => set('title', e.target.value)} disabled={locked} />
      </Field>
      <div className="form-grid">
        <Field label="Ringkasan publik" hint="Satu baris, tampil di daftar dokumen publik (maks. 1000 karakter).">
          <input className="input" value={v.summary} maxLength={1000} onChange={(e) => set('summary', e.target.value)} disabled={locked} />
        </Field>
        <Field label="Berlaku mulai (WIB)" hint="Kosong = berlaku saat diterbitkan.">
          <input className="input" type="datetime-local" value={v.effectiveAt} onChange={(e) => set('effectiveAt', e.target.value)} disabled={locked} />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Isi (Markdown)" required>
          <textarea className="textarea textarea--code" rows={18} value={v.bodyMd} onChange={(e) => set('bodyMd', e.target.value)} disabled={locked} />
        </Field>
        <div className="field">
          <span className="field__label">Pratinjau</span>
          <div className="card" style={{ padding: 14, minHeight: 320, maxHeight: 460, overflow: 'auto' }}>
            <Markdown source={v.bodyMd} />
          </div>
        </div>
      </div>
      <Field label="Ringkasan perubahan">
        <input className="input" value={v.summaryOfChanges} onChange={(e) => set('summaryOfChanges', e.target.value)} disabled={locked} />
      </Field>
      <ActionDialog open={dlg === 'publish'} onClose={() => setDlg(null)} title="Terbitkan dokumen" description="Setelah terbit, dokumen immutable. Persetujuan baru pengguna mengacu ke versi ini." confirmLabel="Terbitkan" tone="success" mfa reason={false} onConfirm={() => publish.mutateAsync(undefined)}>
        <Checkbox checked={retirePrevious} onChange={setRetirePrevious} label="Pensiunkan versi terbit sebelumnya (jenis & bahasa sama)" hint="Disarankan — pengguna diminta menyetujui teks baru." />
      </ActionDialog>
      <ActionDialog open={dlg === 'retire'} onClose={() => setDlg(null)} title="Pensiunkan dokumen" confirmLabel="Pensiunkan" tone="danger" mfa onConfirm={(r) => retire.mutateAsync(r)} />
    </Drawer>
  );
}
