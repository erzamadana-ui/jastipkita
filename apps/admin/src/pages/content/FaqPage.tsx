import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Faq } from '../../api/admin';
import type { FaqArticle } from '../../api/types';
import { useCan } from '../../auth/AuthProvider';
import { CAP } from '../../auth/permissions';
import { DataTable } from '../../components/DataTable';
import { Markdown } from '../../components/Markdown';
import { Drawer } from '../../components/Overlay';
import { Button, Callout, Card, DateTime, Field, PageHeader, Select, StatusBadge } from '../../components/ui';
import { useAdminAction } from '../../hooks/useAdminAction';
import { humanize } from '../../lib/format';

const CATEGORIES = ['GENERAL', 'BUYER', 'TRAVELER', 'PAYMENT', 'CUSTOMS', 'DELIVERY', 'DISPUTE', 'ACCOUNT', 'REFERRAL'];

export default function FaqPage() {
  const [status, setStatus] = useState('');
  const [locale, setLocale] = useState('id');
  const [category, setCategory] = useState('');
  const q = useQuery({ queryKey: ['faq', status, locale, category], queryFn: () => Faq.list({ ...(status ? { status: status as 'DRAFT' } : {}), ...(locale ? { locale: locale as 'id' } : {}), ...(category ? { category: category as 'GENERAL' } : {}) }) });
  const [editing, setEditing] = useState<FaqArticle | 'new' | null>(null);
  return (
    <div className="stack stack--lg">
      <PageHeader title="FAQ" subtitle="Artikel bantuan (Markdown). Terbit → tampil di aplikasi & situs." actions={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Artikel baru</Button>} />
      <Card flush>
        <div className="filterbar">
          <Field label="Status">
            <Select value={status} onChange={setStatus} placeholder="Semua" options={['DRAFT', 'PUBLISHED', 'ARCHIVED']} />
          </Field>
          <Field label="Bahasa">
            <Select value={locale} onChange={setLocale} placeholder="Semua" options={[{ value: 'id', label: 'Indonesia' }, { value: 'en', label: 'English' }]} />
          </Field>
          <Field label="Kategori">
            <Select value={category} onChange={setCategory} placeholder="Semua" options={CATEGORIES} />
          </Field>
        </div>
        <DataTable
          caption="Artikel FAQ"
          rows={q.data?.data}
          loading={q.isPending}
          error={q.error}
          rowKey={(f) => f.id}
          onRowClick={(f) => setEditing(f)}
          rowLabel={(f) => `Ubah FAQ ${f.question}`}
          empty={{ title: 'Belum ada artikel' }}
          columns={[
            { key: 'q', header: 'Pertanyaan', render: (f) => <span className="stack" style={{ gap: 0 }}><span className="cell-primary">{f.question}</span><span className="cell-sub mono">{f.slug} · {f.locale}</span></span> },
            { key: 'c', header: 'Kategori', render: (f) => humanize(f.category) },
            { key: 's', header: 'Status', render: (f) => <StatusBadge status={f.status} /> },
            { key: 'o', header: 'Urutan', align: 'right', render: (f) => f.sortOrder, sortValue: (f) => f.sortOrder },
            { key: 'u', header: 'Diperbarui', render: (f) => <DateTime value={f.updatedAt} />, sortValue: (f) => f.updatedAt },
          ]}
        />
      </Card>
      {editing ? <FaqEditor article={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function FaqEditor({ article, onClose }: { article: FaqArticle | null; onClose: () => void }) {
  const perm = useCan(CAP.faq);
  const [v, setV] = useState({ slug: article?.slug ?? '', locale: article?.locale ?? 'id', category: article?.category ?? 'GENERAL', question: article?.question ?? '', answerMd: article?.answerMd ?? '', tags: (article?.tags ?? []).join(', '), sortOrder: String(article?.sortOrder ?? 0) });
  const set = (k: keyof typeof v, val: string) => setV((s) => ({ ...s, [k]: val }));
  const body = { slug: v.slug.trim(), locale: v.locale as 'id', category: v.category as 'GENERAL', question: v.question.trim(), answerMd: v.answerMd, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean), sortOrder: Number(v.sortOrder) || 0 };
  const inv = [['faq']];
  const save = useAdminAction({ run: () => (article ? Faq.patch(article.id, body) : Faq.create(body)), invalidate: inv, success: 'Artikel disimpan', onSuccess: onClose });
  const status = useAdminAction({ run: (to: 'publish' | 'archive' | 'unpublish' | 'delete') => (to === 'publish' ? Faq.publish(article!.id) : to === 'archive' ? Faq.archive(article!.id) : to === 'unpublish' ? Faq.unpublish(article!.id) : Faq.remove(article!.id)), invalidate: inv, success: 'Status artikel diperbarui', onSuccess: onClose });
  const invalid = !/^[a-z0-9-]{3,}$/.test(body.slug) ? 'Slug huruf kecil/angka/tanda hubung (min. 3)' : body.question.length < 5 ? 'Pertanyaan terlalu pendek' : body.answerMd.trim().length < 10 ? 'Jawaban terlalu pendek' : null;
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={article ? 'Ubah artikel FAQ' : 'Artikel FAQ baru'}
      subtitle={article ? <StatusBadge status={article.status} /> : 'Disimpan sebagai DRAFT'}
      footer={
        <>
          {article?.status === 'DRAFT' ? <Button variant="danger-outline" onClick={() => status.mutate('delete')} disabledReason={perm.reason}>Hapus draf</Button> : null}
          {article?.status === 'PUBLISHED' ? <Button onClick={() => status.mutate('unpublish')} disabledReason={perm.reason}>Kembalikan ke draf</Button> : null}
          {article && article.status !== 'ARCHIVED' && article.status !== 'DRAFT' ? <Button onClick={() => status.mutate('archive')} disabledReason={perm.reason}>Arsipkan</Button> : null}
          <span className="spacer" />
          <Button onClick={onClose}>Batal</Button>
          <Button variant="primary" loading={save.isPending} disabledReason={perm.reason ?? invalid} onClick={() => save.mutate(undefined)}>
            Simpan
          </Button>
          {article && article.status !== 'PUBLISHED' ? (
            <Button variant="success" loading={status.isPending} disabledReason={perm.reason} onClick={() => status.mutate('publish')}>
              Terbitkan
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form-grid">
        <Field label="Slug" required>
          <input className="input mono" value={v.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} />
        </Field>
        <Field label="Bahasa">
          <Select value={v.locale} onChange={(x) => set('locale', x)} options={[{ value: 'id', label: 'Indonesia' }, { value: 'en', label: 'English' }]} />
        </Field>
        <Field label="Kategori">
          <Select value={v.category} onChange={(x) => set('category', x)} options={CATEGORIES} />
        </Field>
        <Field label="Urutan">
          <input className="input" type="number" value={v.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
        </Field>
      </div>
      <Field label="Pertanyaan" required>
        <input className="input" value={v.question} onChange={(e) => set('question', e.target.value)} />
      </Field>
      <div className="grid grid-2">
        <Field label="Jawaban (Markdown)" required hint="**tebal**, *miring*, `kode`, [tautan](https://…), daftar - / 1.">
          <textarea className="textarea textarea--code" rows={16} value={v.answerMd} onChange={(e) => set('answerMd', e.target.value)} />
        </Field>
        <div className="field">
          <span className="field__label">Pratinjau</span>
          <div className="card" style={{ padding: 14, minHeight: 280 }}>
            <Markdown source={v.answerMd} />
          </div>
        </div>
      </div>
      <Field label="Tag" hint="Pisahkan dengan koma">
        <input className="input" value={v.tags} onChange={(e) => set('tags', e.target.value)} />
      </Field>
      {save.error ? <Callout tone="danger">{String((save.error as Error).message)}</Callout> : null}
    </Drawer>
  );
}
