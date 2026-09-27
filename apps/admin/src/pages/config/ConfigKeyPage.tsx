import { isBusinessConfigKey, validateBusinessConfig, type BusinessConfigKey } from '@jastipkita/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Config } from '../../api/admin';
import { describeError, validationIssues } from '../../api/errors';
import type { ConfigVersion } from '../../api/types';
import { useAuth, useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { ActionDialog } from '../../components/ActionDialog';
import { DataTable } from '../../components/DataTable';
import { DiffView, JsonView } from '../../components/data';
import { ValueForm } from '../../components/ValueForm';
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, IdText, LoadingBlock, PageHeader, Segmented, Select, StatusBadge, TabPanel, Tabs } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { jsonDiff } from '../../lib/diff';

type Tab = 'active' | 'history' | 'diff' | 'propose';

export function configApproveBlock(v: ConfigVersion, meId: string | undefined, permReason: string | null): string | null {
  if (permReason) return permReason;
  if (v.status !== 'PENDING_APPROVAL') return `Status ${v.status}`;
  if (v.createdBy && v.createdBy === meId) return 'Anda pengusul versi ini — persetujuan oleh admin lain (maker-checker)';
  return null;
}

export function clientValidate(key: string, value: unknown): { path: string; message: string }[] {
  if (!isBusinessConfigKey(key)) return [{ path: key, message: 'Key tidak dikenal oleh @jastipkita/core' }];
  const r = validateBusinessConfig(key as BusinessConfigKey, value);
  return r.ok ? [] : r.errors.map((e) => ({ path: String(e.path).replace(new RegExp(`^${key.replace(/\./g, '\\.')}\\.?`), ''), message: e.message }));
}

export default function ConfigKeyPage() {
  const { key = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'active';
  const setTab = (t: Tab) => setSp({ tab: t }, { replace: true });
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['config', 'detail', key], queryFn: () => Config.detail(key) });
  const approveCap = useCan(CAP.configApprove);
  const proposeCap = useCan(CAP.configPropose);
  const [dlg, setDlg] = useState<{ kind: 'approve' | 'reject'; v: ConfigVersion } | null>(null);
  const decide = useAdminAction({
    run: (x: { kind: 'approve' | 'reject'; v: ConfigVersion; reason: string }) => (x.kind === 'approve' ? Config.approve(x.v.id) : Config.reject(x.v.id, x.reason)),
    invalidate: [['config']],
    toastErrors: false,
    success: (r) => `${r.key} v${r.version} → ${r.status}`,
  });

  if (q.isPending) return <LoadingBlock rows={10} />;
  if (q.isError || !q.data) return <Callout tone="danger">Config tidak dapat dimuat: {describeError(q.error).title}</Callout>;
  const d = q.data;
  const pending = d.history.find((h) => h.status === 'PENDING_APPROVAL') ?? null;

  return (
    <div className="stack stack--lg">
      <PageHeader
        breadcrumb={<Link to="/config">Business config</Link>}
        title={<code>{d.key}</code>}
        subtitle={
          <span className="row">
            {d.active ? <Badge tone="success">Aktif v{d.active.version}</Badge> : <Badge tone="danger">Tidak ada versi aktif</Badge>}
            {d.active?.isAssumption ? <Badge tone="amber">ASUMSI — perlu validasi</Badge> : null}
            {pending ? <Badge tone="warning">v{pending.version} menunggu persetujuan</Badge> : null}
            <span className="muted">{d.history.length} versi</span>
          </span>
        }
      />
      {pending ? (
        <Card
          title={`Usulan v${pending.version} menunggu persetujuan`}
          hint={
            <span>
              oleh <IdText id={pending.createdBy} /> · <DateTime value={pending.createdAt} /> · “{pending.changeReason}”
            </span>
          }
          actions={
            <>
              <Button variant="danger-outline" mfa disabledReason={approveCap.reason ?? (pending.status !== 'PENDING_APPROVAL' ? 'Sudah diputuskan' : null)} onClick={() => setDlg({ kind: 'reject', v: pending })}>
                Tolak
              </Button>
              <Button variant="success" icon="check" mfa disabledReason={configApproveBlock(pending, me?.id, approveCap.reason)} onClick={() => setDlg({ kind: 'approve', v: pending })} data-testid="config-approve">
                Setujui & aktifkan
              </Button>
            </>
          }
          flush
        >
          {pending.isAssumption ? (
            <div style={{ padding: '12px 18px 0' }}>
              <Callout tone="warning">Ditandai ASUMSI oleh pengusul — nilai belum tervalidasi (hukum/finance/vendor).</Callout>
            </div>
          ) : null}
          <DiffView changes={d.history.find((h) => h.id === pending.id)?.diffFromActive ?? []} caption={`Perubahan v${pending.version} terhadap versi aktif`} />
        </Card>
      ) : null}

      <Tabs
        label="Config"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'active', label: 'Nilai aktif' },
          { key: 'history', label: 'Riwayat versi', count: d.history.length },
          { key: 'diff', label: 'Bandingkan' },
          { key: 'propose', label: 'Ajukan versi baru' },
        ]}
      />
      {tab === 'active' ? (
        <TabPanel id="active">
          <div className="grid grid-2">
            <Card title="Nilai (JSON)">{d.active ? <JsonView value={d.active.value} label={`Nilai aktif ${d.key}`} /> : '—'}</Card>
            <Card title="Metadata">
              {d.active ? (
                <dl className="kv">
                  <dt>Versi</dt>
                  <dd>v{d.active.version}</dd>
                  <dt>Berlaku sejak</dt>
                  <dd>
                    <DateTime value={d.active.effectiveFrom} />
                  </dd>
                  <dt>Alasan</dt>
                  <dd>{d.active.changeReason}</dd>
                  <dt>Pengusul</dt>
                  <dd>
                    <IdText id={d.active.createdBy} />
                  </dd>
                  <dt>Penyetuju</dt>
                  <dd>
                    <IdText id={d.active.approvedBy} /> <DateTime value={d.active.approvedAt} />
                  </dd>
                  <dt>Catatan</dt>
                  <dd>{d.active.notes ?? '—'}</dd>
                </dl>
              ) : null}
            </Card>
          </div>
        </TabPanel>
      ) : null}
      {tab === 'history' ? (
        <TabPanel id="history">
          <Card flush>
            <DataTable
              caption="Riwayat versi"
              rows={d.history}
              rowKey={(h) => h.id}
              columns={[
                { key: 'v', header: 'Versi', render: (h) => <strong>v{h.version}</strong>, sortValue: (h) => h.version },
                { key: 's', header: 'Status', render: (h) => <span className="row row--tight"><StatusBadge status={h.status} />{h.isAssumption ? <Badge tone="amber">ASUMSI</Badge> : null}</span> },
                { key: 'r', header: 'Alasan', render: (h) => <span className="small">{h.changeReason}{h.rejectedReason ? <span className="cell-sub">Ditolak: {h.rejectedReason}</span> : null}</span> },
                { key: 'c', header: 'Perubahan vs aktif', align: 'right', render: (h) => (h.diffFromActive.length ? `${h.diffFromActive.length} path` : '—') },
                { key: 'by', header: 'Pengusul → penyetuju', render: (h) => <span className="row row--tight"><IdText id={h.createdBy} /> → <IdText id={h.approvedBy} /></span> },
                { key: 't', header: 'Dibuat', render: (h) => <DateTime value={h.createdAt} />, sortValue: (h) => h.createdAt },
                { key: 'x', header: '', render: (h) => (h.status !== 'ACTIVE' ? <Button size="sm" variant="ghost" onClick={() => setSp({ tab: 'diff', version: String(h.version) }, { replace: true })}>Diff</Button> : null) },
              ]}
            />
          </Card>
        </TabPanel>
      ) : null}
      {tab === 'diff' ? <DiffTab configKey={d.key} versions={d.history.map((h) => h.version)} activeVersion={d.active?.version ?? null} initial={sp.get('version')} /> : null}
      {tab === 'propose' ? (
        <TabPanel id="propose">{pending ? <Callout tone="warning">Masih ada usulan v{pending.version} yang menunggu — satu usulan per key (409 CONFIG_PROPOSAL_PENDING).</Callout> : proposeCap.allowed ? <ProposeForm configKey={d.key} active={d.active?.value} /> : <Callout tone="warning" icon="lock">{proposeCap.reason}</Callout>}</TabPanel>
      ) : null}

      <ActionDialog
        open={dlg?.kind === 'approve'}
        onClose={() => setDlg(null)}
        title={`Setujui & aktifkan ${d.key} v${dlg?.v.version ?? ''}`}
        description="activate_business_config(): versi aktif lama → SUPERSEDED, cache API diinvalidasi (instance lain mengikuti TTL). Divalidasi ulang dengan validator terbaru."
        confirmLabel="Setujui & aktifkan"
        tone="success"
        mfa
        reason={false}
        onConfirm={(reason) => decide.mutateAsync({ ...dlg!, reason })}
      >
        <DiffView changes={dlg ? (d.history.find((h) => h.id === dlg.v.id)?.diffFromActive ?? []) : []} caption="Perubahan yang akan diaktifkan" />
      </ActionDialog>
      <ActionDialog open={dlg?.kind === 'reject'} onClose={() => setDlg(null)} title={`Tolak ${d.key} v${dlg?.v.version ?? ''}`} confirmLabel="Tolak usulan" tone="danger" mfa onConfirm={(reason) => decide.mutateAsync({ ...dlg!, reason })} />
    </div>
  );
}

function DiffTab({ configKey, versions, activeVersion, initial }: { configKey: string; versions: number[]; activeVersion: number | null; initial: string | null }) {
  const others = versions.filter((v) => v !== activeVersion);
  const [version, setVersion] = useState<string>(initial ?? String(others[0] ?? versions[0] ?? ''));
  const [against, setAgainst] = useState<string>('');
  const q = useQuery({ queryKey: ['config', 'diff', configKey, version, against], queryFn: () => Config.diff(configKey, Number(version), against ? Number(against) : undefined), enabled: !!version });
  return (
    <TabPanel id="diff">
      <Card
        title="Diff struktural"
        hint={q.data ? `v${q.data.from.version} (${q.data.from.status}) → v${q.data.to.version} (${q.data.to.status})` : 'Pilih versi'}
        actions={
          <>
            <Field label="Versi">
              <Select className="select--sm" value={version} onChange={setVersion} options={versions.map((v) => ({ value: String(v), label: `v${v}${v === activeVersion ? ' (aktif)' : ''}` }))} />
            </Field>
            <Field label="Dibandingkan dengan">
              <Select className="select--sm" value={against} onChange={setAgainst} options={[{ value: '', label: 'Versi aktif' }, ...versions.map((v) => ({ value: String(v), label: `v${v}` }))]} />
            </Field>
          </>
        }
        flush
      >
        {q.isPending ? (
          <div style={{ padding: 18 }}>
            <LoadingBlock />
          </div>
        ) : q.data ? (
          <DiffView changes={q.data.changes} caption={`Diff ${configKey}`} emptyText="Tidak ada perbedaan antara kedua versi." />
        ) : (
          <div style={{ padding: 18 }}>
            <Callout tone="danger">{describeError(q.error).title}</Callout>
          </div>
        )}
      </Card>
    </TabPanel>
  );
}

function ProposeForm({ configKey, active }: { configKey: string; active: unknown }) {
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [value, setValue] = useState<unknown>(() => structuredClone(active ?? {}));
  const [raw, setRaw] = useState(() => JSON.stringify(active ?? {}, null, 2));
  const [rawErr, setRawErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [assumption, setAssumption] = useState(false);
  const [notes, setNotes] = useState('');
  const [serverErr, setServerErr] = useState<unknown>(null);
  useEffect(() => {
    if (mode === 'json') setRaw(JSON.stringify(value, null, 2));
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const issues = useMemo(() => clientValidate(configKey, value), [configKey, value]);
  const diff = useMemo(() => jsonDiff(active, value), [active, value]);
  const propose = useAdminAction({
    run: () => Config.propose(configKey, { value, changeReason: reason.trim(), isAssumption: assumption, ...(notes.trim() ? { notes: notes.trim() } : {}) }),
    invalidate: [['config']],
    toastErrors: false,
    success: (r) => `Usulan v${r.version} dibuat — menunggu persetujuan admin lain`,
  });
  const serverIssues = validationIssues(serverErr);
  const block = rawErr ? 'Perbaiki JSON' : issues.length ? `${issues.length} isian tidak valid (validator core)` : diff.length === 0 ? 'Tidak ada perubahan dari versi aktif' : reason.trim().length < 10 ? 'Alasan minimal 10 karakter' : null;
  return (
    <div className="grid grid-main-side">
      <Card
        title="Nilai usulan"
        hint="Form dibangkitkan dari bentuk nilai aktif; divalidasi dengan validateBusinessConfig (@jastipkita/core) — validator yang sama dengan API."
        actions={
          <Segmented
            label="Mode editor"
            value={mode}
            onChange={(m) => {
              if (m === 'form' && mode === 'json') {
                try {
                  setValue(JSON.parse(raw));
                  setRawErr(null);
                } catch (e) {
                  setRawErr(e instanceof Error ? e.message : 'JSON tidak valid');
                  return;
                }
              }
              setMode(m);
            }}
            options={[
              { key: 'form', label: 'Form' },
              { key: 'json', label: 'JSON mentah' },
            ]}
          />
        }
      >
        {mode === 'form' ? (
          <ValueForm value={value} onChange={setValue} errors={issues} rootLabel={`Form ${configKey}`} />
        ) : (
          <Field label="JSON" error={rawErr} hint="Fallback untuk struktur yang tidak terjangkau form.">
            <textarea
              className="textarea textarea--code"
              rows={22}
              value={raw}
              spellCheck={false}
              onChange={(e) => {
                setRaw(e.target.value);
                try {
                  setValue(JSON.parse(e.target.value));
                  setRawErr(null);
                } catch (err) {
                  setRawErr(err instanceof Error ? err.message : 'JSON tidak valid');
                }
              }}
            />
          </Field>
        )}
      </Card>
      <div className="stack stack--lg">
        <Card title={`Pratinjau perubahan (${diff.length})`} flush>
          <DiffView changes={diff} caption="Perubahan usulan terhadap versi aktif" emptyText="Belum ada perubahan." />
        </Card>
        {issues.length ? (
          <Callout tone="danger" title="Validasi core:">
            <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {issues.slice(0, 8).map((i, n) => (
                <li key={n}>
                  <code>{i.path || '$'}</code> {i.message}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {serverErr ? (
          <Callout tone="danger" title={describeError(serverErr).title}>
            {serverIssues.length ? (
              <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {serverIssues.map((i, n) => (
                  <li key={n}>
                    <code>{i.path}</code> {i.message}
                  </li>
                ))}
              </ul>
            ) : (
              describeError(serverErr).detail
            )}
          </Callout>
        ) : null}
        <Card title="Alasan & penandaan">
          <div className="stack">
            <Field label="Alasan perubahan" required hint="Tercatat di audit log dan terlihat penyetuju.">
              <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="config-reason" />
            </Field>
            <Checkbox checked={assumption} onChange={setAssumption} label="Nilai ini ASUMSI (belum divalidasi hukum/finance/vendor)" />
            <Field label="Catatan (opsional)">
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              mfa
              loading={propose.isPending}
              disabledReason={block}
              data-testid="config-propose"
              onClick={() => {
                setServerErr(null);
                propose.mutate(undefined, { onError: setServerErr, onSuccess: () => setReason('') });
              }}
            >
              Ajukan versi baru
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
