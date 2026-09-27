/** Help-center search: instant client-side filter over the static index, merged with GET /v1/support/faq?q= when the API is up. */
import { api, escapeHtml } from '../lib/api.ts';

interface Item { slug: string; q: string; a: string; c: string; tags: string[] }
interface ApiItem { slug: string; question: string; excerpt: string; category: string }
const index: Item[] = JSON.parse(document.getElementById('help-index')?.textContent ?? '[]');
const input = document.querySelector<HTMLInputElement>('#help-q');
const box = document.querySelector<HTMLDivElement>('#hasil');
const browse = document.querySelector<HTMLDivElement>('#help-browse');
const source = document.querySelector<HTMLParagraphElement>('#help-source');
const base = location.pathname.replace(/bantuan\/.*$/, 'bantuan/');

function norm(s: string) { return s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, ''); }
function score(it: Item, terms: string[]): number {
  const hay = norm(`${it.q} ${it.tags.join(' ')}`);
  const body = norm(it.a);
  let s = 0;
  for (const t of terms) { if (hay.includes(t)) s += 3; else if (body.includes(t)) s += 1; else return 0; }
  return s;
}
function render(items: Array<{ slug: string; q: string; a: string }>, q: string) {
  if (!box || !browse) return;
  box.hidden = false; browse.hidden = true;
  box.innerHTML = items.length
    ? `<p class="small muted" style="margin-bottom:12px">${items.length} hasil untuk “${escapeHtml(q)}”</p><div class="grid" style="--gap:10px">${items
        .map((i) => `<a class="card card-link" style="padding:16px 18px" href="${base}${encodeURIComponent(i.slug)}/"><strong>${escapeHtml(i.q)}</strong><p class="small muted" style="margin-top:4px">${escapeHtml(i.a)}…</p></a>`)
        .join('')}</div>`
    : `<div class="note note-neutral"><p>Tidak ada hasil untuk “${escapeHtml(q)}”. Coba kata lain, misalnya “refund”, “kurs”, atau “PIN”.</p></div>`;
}
let timer: number | undefined;
let seq = 0;
input?.addEventListener('input', () => {
  window.clearTimeout(timer);
  const q = input.value.trim();
  if (q.length < 2) { if (box && browse) { box.hidden = true; browse.hidden = false; } return; }
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const local = index.map((it) => ({ it, s: score(it, terms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => ({ slug: x.it.slug, q: x.it.q, a: x.it.a }));
  render(local, q);
  const my = ++seq;
  timer = window.setTimeout(async () => {
    try {
      const res = await api<{ data: ApiItem[] }>('/v1/support/faq', { query: { q, locale: 'id', limit: 20 }, timeoutMs: 5000 });
      if (my !== seq) return;
      const seen = new Set(local.map((l) => l.slug));
      const merged = [...local, ...res.data.filter((d) => !seen.has(d.slug)).map((d) => ({ slug: d.slug, q: d.question, a: d.excerpt }))];
      render(merged, q);
      if (source) source.textContent = 'Hasil digabung dengan pusat bantuan JastipKita (server).';
    } catch { /* API not live yet — static results stay */ }
  }, 350);
});
document.querySelector('#help-search')?.addEventListener('submit', (e) => e.preventDefault());
