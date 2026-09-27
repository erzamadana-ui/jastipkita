/**
 * Notification template catalog. One entry per notification kind; the key is also stored as
 * notifications.event_type. Copy is Indonesian (default) + English; every template renders
 * in-app/push text and a full e-mail. SECURITY: delivery PINs / QR tokens are NEVER part of any
 * template — `delivery.pin_ready` only tells the buyer to open the app (see docs/api/engagement.md).
 */
import { DISPUTE_RESOLUTION_LABEL, DISPUTE_STATUS_LABEL, DISPUTE_TYPE_LABEL, label } from './labels';
import type { Copy, CopyContext, TemplateDef } from './types';

const ALL = ['IN_APP', 'PUSH', 'EMAIL'] as const;
const APP = ['IN_APP', 'PUSH'] as const;

// ---------------------------------------------------------------- helpers
const num = (c: CopyContext) => c.tx?.number ?? String(c.v.number ?? '');
const prod = (c: CopyContext) => c.tx?.productName ?? String(c.v.productName ?? (c.locale === 'en' ? 'your item' : 'titipanmu'));
const trav = (c: CopyContext) => c.tx?.travelerPublicName ?? (c.locale === 'en' ? 'Your traveler' : 'Traveler');
const amount = (c: CopyContext, k = 'amountIdr') => c.idr(c.v[k] ?? c.tx?.totalIdr ?? 0);
const s = (v: unknown, fallback = '') => (v === undefined || v === null || v === '' ? fallback : String(v));
const dsp = (c: CopyContext) => s(c.v.disputeNumber, 'Dispute');

/** Short copy for app-only templates (e-mail fields mirror the push text). */
function short(title: string, body: string, cta: string, extra: Partial<Copy> = {}): Copy {
  return { title, body, subject: title, heading: title, paragraphs: [body], cta, ...extra };
}

function def(
  key: string,
  opts: Omit<TemplateDef, 'key' | 'copy'>,
  id: (c: CopyContext) => Copy,
  en: (c: CopyContext) => Copy,
): TemplateDef {
  return { key, ...opts, copy: { id, en } };
}

const TICKET_STATUS: Record<string, { id: string; en: string }> = {
  OPEN: { id: 'Terbuka', en: 'Open' },
  PENDING_USER: { id: 'Menunggu balasanmu', en: 'Waiting for your reply' },
  IN_PROGRESS: { id: 'Sedang diproses', en: 'In progress' },
  RESOLVED: { id: 'Selesai', en: 'Resolved' },
  CLOSED: { id: 'Ditutup', en: 'Closed' },
};

const ACTOR = {
  id: { BUYER: 'penitip', TRAVELER: 'traveler', SYSTEM: 'sistem', ADMIN: 'tim JastipKita' } as Record<string, string>,
  en: { BUYER: 'the buyer', TRAVELER: 'the traveler', SYSTEM: 'the system', ADMIN: 'the JastipKita team' } as Record<string, string>,
};

// ---------------------------------------------------------------- catalog
export const TEMPLATES: readonly TemplateDef[] = [
  // ============================================================ ACCOUNT
  def(
    'account.welcome',
    { group: 'ACCOUNT', category: 'ACCOUNT', channels: ['IN_APP', 'EMAIL'], link: 'home', breakdown: 'NONE' },
    () => ({
      title: 'Selamat datang di JastipKita',
      body: 'Akunmu sudah aktif. Verifikasi nomor HP untuk mulai checkout.',
      subject: 'Selamat datang di JastipKita',
      heading: 'Akunmu sudah aktif',
      paragraphs: [
        'Terima kasih sudah bergabung. Di JastipKita kamu bisa menitip belanja dari luar negeri ke traveler terverifikasi — dana ditahan SafePay sampai barang kamu terima.',
        'Langkah berikutnya: verifikasi nomor HP (level 2) supaya bisa checkout. Ingin jadi traveler? Lengkapi verifikasi identitas (level 3).',
      ],
      cta: 'Mulai titip',
    }),
    () => ({
      title: 'Welcome to JastipKita',
      body: 'Your account is active. Verify your phone number to start checking out.',
      subject: 'Welcome to JastipKita',
      heading: 'Your account is active',
      paragraphs: [
        'Thanks for joining. On JastipKita you can ask verified travelers to shop abroad for you — your money is held by SafePay until you receive the item.',
        'Next step: verify your phone number (level 2) to check out. Want to travel and earn? Complete identity verification (level 3).',
      ],
      cta: 'Start a request',
    }),
  ),
  def(
    'account.phone_verified',
    { group: 'ACCOUNT', category: 'ACCOUNT', channels: APP, link: 'verification', breakdown: 'NONE' },
    () => short('Nomor HP terverifikasi', 'Akunmu naik ke level 2 — kamu sekarang bisa checkout.', 'Lihat verifikasi'),
    () => short('Phone number verified', 'Your account is now level 2 — you can check out.', 'View verification'),
  ),
  def(
    'kyc.submitted',
    { group: 'ACCOUNT', category: 'ACCOUNT', channels: ALL, link: 'verification', breakdown: 'NONE' },
    (c) => ({
      title: 'Verifikasi sedang ditinjau',
      body: `Dokumen verifikasi level ${s(c.v.targetLevel, '3')} sudah kami terima.`,
      subject: 'Pengajuan verifikasi kamu sudah diterima',
      heading: 'Verifikasi sedang ditinjau',
      paragraphs: [
        `Dokumen verifikasi untuk level ${s(c.v.targetLevel, '3')} sudah kami terima dan sedang ditinjau.`,
        'Kami akan mengabari kamu begitu hasilnya keluar. Dokumen identitas disimpan terenkripsi dan hanya dipakai untuk verifikasi.',
      ],
      cta: 'Lihat status verifikasi',
    }),
    (c) => ({
      title: 'Verification under review',
      body: `We received your level ${s(c.v.targetLevel, '3')} verification documents.`,
      subject: 'We received your verification',
      heading: 'Verification under review',
      paragraphs: [
        `We received your documents for level ${s(c.v.targetLevel, '3')} and are reviewing them.`,
        'We will let you know as soon as there is a result. Identity documents are stored encrypted and used for verification only.',
      ],
      cta: 'View verification status',
    }),
  ),
  def(
    'kyc.approved',
    { group: 'ACCOUNT', category: 'ACCOUNT', channels: ALL, link: 'verification', breakdown: 'NONE' },
    (c) => ({
      title: 'Verifikasi disetujui',
      body: `Akunmu sekarang level ${s(c.v.targetLevel, '3')}.`,
      subject: `Verifikasi level ${s(c.v.targetLevel, '3')} disetujui`,
      heading: 'Verifikasi disetujui',
      paragraphs: [
        `Selamat! Verifikasi kamu disetujui dan akunmu sekarang level ${s(c.v.targetLevel, '3')}.`,
        'Batas transaksi kamu ikut naik sesuai level. Detailnya bisa kamu lihat di menu Verifikasi.',
      ],
      highlight: { tone: 'success', text: `Level ${s(c.v.targetLevel, '3')} aktif` },
      cta: 'Lihat akun',
    }),
    (c) => ({
      title: 'Verification approved',
      body: `Your account is now level ${s(c.v.targetLevel, '3')}.`,
      subject: `Level ${s(c.v.targetLevel, '3')} verification approved`,
      heading: 'Verification approved',
      paragraphs: [
        `Congratulations! Your verification was approved and your account is now level ${s(c.v.targetLevel, '3')}.`,
        'Your transaction limits increase with your level. See the Verification menu for details.',
      ],
      highlight: { tone: 'success', text: `Level ${s(c.v.targetLevel, '3')} active` },
      cta: 'View account',
    }),
  ),
  def(
    'kyc.rejected',
    { group: 'ACCOUNT', category: 'ACCOUNT', channels: ALL, critical: ['EMAIL'], link: 'verification', breakdown: 'NONE' },
    (c) => ({
      title: 'Verifikasi belum berhasil',
      body: `Ada yang perlu diperbaiki pada pengajuan level ${s(c.v.targetLevel, '3')}.`,
      subject: 'Verifikasi kamu perlu diperbaiki',
      heading: 'Verifikasi belum berhasil',
      paragraphs: [
        `Maaf, pengajuan verifikasi level ${s(c.v.targetLevel, '3')} belum bisa kami setujui.`,
        ...(c.v.reason ? [`Alasan: ${s(c.v.reason)}`] : []),
        'Perbaiki dokumen sesuai catatan lalu ajukan ulang dari menu Verifikasi.',
      ],
      highlight: { tone: 'warning', text: 'Pastikan foto dokumen jelas, tidak terpotong, dan nama sesuai akun.' },
      cta: 'Ajukan ulang',
    }),
    (c) => ({
      title: 'Verification not approved',
      body: `Your level ${s(c.v.targetLevel, '3')} submission needs fixing.`,
      subject: 'Your verification needs attention',
      heading: 'Verification not approved',
      paragraphs: [
        `Sorry, we could not approve your level ${s(c.v.targetLevel, '3')} verification.`,
        ...(c.v.reason ? [`Reason: ${s(c.v.reason)}`] : []),
        'Please fix the documents and resubmit from the Verification menu.',
      ],
      highlight: { tone: 'warning', text: 'Make sure document photos are sharp, uncropped and match your account name.' },
      cta: 'Resubmit',
    }),
  ),
  def(
    'kyc.trusted_traveler',
    { group: 'ACCOUNT', category: 'ACCOUNT', channels: ALL, link: 'verification', breakdown: 'NONE' },
    (c) => {
      const granted = c.v.granted === true;
      const facts = `Saat ini: ${s(c.v.completedAsTraveler, '0')} transaksi selesai, Trust Score ${s(c.v.trustScore, '-')}, tingkat dispute ${s(c.v.disputeRatePct, '0')}%.`;
      return {
        title: granted ? 'Kamu sekarang Trusted Traveler' : 'Status Trusted Traveler dicabut',
        body: granted ? 'Selamat! Akunmu naik ke level 5 (Trusted Traveler).' : 'Akunmu kembali ke level 4. Lihat alasannya di aplikasi.',
        subject: granted ? 'Selamat, kamu Trusted Traveler!' : 'Perubahan status Trusted Traveler',
        heading: granted ? 'Kamu sekarang Trusted Traveler' : 'Status Trusted Traveler dicabut',
        paragraphs: [
          'Status Trusted Traveler dievaluasi otomatis: minimal 10 transaksi selesai sebagai traveler, Trust Score minimal 80, dan tingkat dispute di bawah 3%.',
          facts,
          granted
            ? 'Batas transaksi kamu naik dan badge Trusted Traveler tampil di profilmu.'
            : 'Badge dilepas tanpa pengumuman publik. Status akan kembali otomatis saat syarat terpenuhi lagi.',
        ],
        highlight: granted ? { tone: 'success', text: 'Level 5 — Trusted Traveler' } : { tone: 'info', text: 'Level 4 — Traveler terverifikasi' },
        cta: 'Lihat detail',
      };
    },
    (c) => {
      const granted = c.v.granted === true;
      return {
        title: granted ? 'You are now a Trusted Traveler' : 'Trusted Traveler status removed',
        body: granted ? 'Congratulations! Your account is now level 5 (Trusted Traveler).' : 'Your account is back to level 4. See why in the app.',
        subject: granted ? 'Congratulations, you are a Trusted Traveler!' : 'Trusted Traveler status update',
        heading: granted ? 'You are now a Trusted Traveler' : 'Trusted Traveler status removed',
        paragraphs: [
          'Trusted Traveler is evaluated automatically: at least 10 completed transactions as a traveler, Trust Score of 80 or more, and a dispute rate below 3%.',
          `Currently: ${s(c.v.completedAsTraveler, '0')} completed transactions, Trust Score ${s(c.v.trustScore, '-')}, dispute rate ${s(c.v.disputeRatePct, '0')}%.`,
          granted
            ? 'Your transaction limits increase and the Trusted Traveler badge shows on your profile.'
            : 'The badge is removed without any public announcement and returns automatically once you qualify again.',
        ],
        highlight: granted ? { tone: 'success', text: 'Level 5 — Trusted Traveler' } : { tone: 'info', text: 'Level 4 — Verified traveler' },
        cta: 'View details',
      };
    },
  ),
  def(
    'payout_account.verified',
    { group: 'ACCOUNT', category: 'ACCOUNT', channels: ALL, link: 'account', breakdown: 'NONE' },
    (c) => ({
      title: 'Rekening payout terverifikasi',
      body: `Rekening ${s(c.v.accountMask, '')} siap menerima pencairan.`.replace('  ', ' '),
      subject: 'Rekening payout kamu terverifikasi',
      heading: 'Rekening payout terverifikasi',
      paragraphs: [`Rekening ${s(c.v.bankCode)} ${s(c.v.accountMask)} sudah terverifikasi dan siap menerima pencairan dana traveler.`, 'Jika kamu tidak menambahkan rekening ini, segera hubungi Pusat Bantuan.'],
      cta: 'Lihat rekening',
    }),
    (c) => ({
      title: 'Payout account verified',
      body: `Account ${s(c.v.accountMask, '')} is ready to receive payouts.`,
      subject: 'Your payout account is verified',
      heading: 'Payout account verified',
      paragraphs: [`Account ${s(c.v.bankCode)} ${s(c.v.accountMask)} is verified and ready to receive traveler payouts.`, 'If you did not add this account, contact the Help Center immediately.'],
      cta: 'View account',
    }),
  ),
  def(
    'privacy.export_ready',
    { group: 'ACCOUNT', category: 'SECURITY', channels: ALL, critical: ['EMAIL'], link: 'account', breakdown: 'NONE' },
    () => ({
      title: 'Ekspor data siap',
      body: 'Salinan data akunmu siap diunduh dari aplikasi.',
      subject: 'Ekspor data akun kamu siap',
      heading: 'Ekspor data siap diunduh',
      paragraphs: ['Salinan data akun yang kamu minta sudah siap. Demi keamanan, unduh dari aplikasi setelah masuk — tautan unduhan berlaku terbatas.', 'Jika kamu tidak meminta ekspor data, segera hubungi Pusat Bantuan.'],
      cta: 'Unduh di aplikasi',
    }),
    () => ({
      title: 'Data export ready',
      body: 'Your account data export is ready in the app.',
      subject: 'Your data export is ready',
      heading: 'Your data export is ready',
      paragraphs: ['The copy of your account data is ready. For your security, download it from the app after signing in — the link expires.', 'If you did not request an export, contact the Help Center immediately.'],
      cta: 'Download in the app',
    }),
  ),
  def(
    'account.deletion_scheduled',
    { group: 'ACCOUNT', category: 'SECURITY', channels: ALL, critical: ['EMAIL', 'IN_APP'], link: 'account', breakdown: 'NONE' },
    (c) => ({
      title: 'Penghapusan akun dijadwalkan',
      body: `Akunmu akan dihapus pada ${c.dt(c.v.effectiveAt)}.`,
      subject: 'Penghapusan akun JastipKita dijadwalkan',
      heading: 'Penghapusan akun dijadwalkan',
      paragraphs: [
        `Permintaan penghapusan akun sudah kami terima. Akunmu akan dihapus pada ${c.dt(c.v.effectiveAt)}.`,
        'Catatan keuangan tetap disimpan sesuai kewajiban hukum; sisa JastipKita Credit akan hangus.',
      ],
      highlight: { tone: 'warning', text: 'Bukan kamu yang meminta? Batalkan dari aplikasi sebelum tanggal tersebut.' },
      cta: 'Kelola akun',
    }),
    (c) => ({
      title: 'Account deletion scheduled',
      body: `Your account will be deleted on ${c.dt(c.v.effectiveAt)}.`,
      subject: 'Your JastipKita account deletion is scheduled',
      heading: 'Account deletion scheduled',
      paragraphs: [
        `We received your deletion request. Your account will be deleted on ${c.dt(c.v.effectiveAt)}.`,
        'Financial records are kept as required by law; remaining JastipKita Credit will be forfeited.',
      ],
      highlight: { tone: 'warning', text: 'Not you? Cancel it from the app before that date.' },
      cta: 'Manage account',
    }),
  ),
  def(
    'support.ticket_updated',
    { group: 'ACCOUNT', category: 'SYSTEM', channels: ALL, link: 'support', breakdown: 'NONE' },
    (c) => {
      const st = TICKET_STATUS[s(c.v.status)]?.id ?? s(c.v.status);
      return {
        title: `Tiket ${s(c.v.ticketNumber)} diperbarui`,
        body: `Status: ${st}. Buka untuk melihat balasan tim kami.`,
        subject: `Update tiket bantuan ${s(c.v.ticketNumber)}`,
        heading: 'Tiket bantuan diperbarui',
        paragraphs: [`Ada pembaruan untuk tiket ${s(c.v.ticketNumber)}. Status sekarang: ${st}.`, 'Balas langsung dari aplikasi agar riwayat percakapan tetap tercatat.'],
        cta: 'Lihat tiket',
      };
    },
    (c) => {
      const st = TICKET_STATUS[s(c.v.status)]?.en ?? s(c.v.status);
      return {
        title: `Ticket ${s(c.v.ticketNumber)} updated`,
        body: `Status: ${st}. Open it to read our reply.`,
        subject: `Support ticket ${s(c.v.ticketNumber)} update`,
        heading: 'Support ticket updated',
        paragraphs: [`Ticket ${s(c.v.ticketNumber)} has an update. Current status: ${st}.`, 'Reply from the app so the conversation history stays in one place.'],
        cta: 'View ticket',
      };
    },
  ),
  def(
    'referral.rewarded',
    { group: 'ACCOUNT', category: 'REFERRAL', channels: ALL, link: 'wallet', breakdown: 'NONE' },
    (c) => ({
      title: 'Kamu dapat JastipKita Credit',
      body: `${amount(c)} credit referral masuk, berlaku sampai ${c.date(c.v.expiresAt)}.`,
      subject: `${amount(c)} JastipKita Credit untukmu`,
      heading: 'Credit referral masuk',
      paragraphs: [
        `${amount(c)} JastipKita Credit dari program referral sudah masuk ke dompetmu dan berlaku sampai ${c.date(c.v.expiresAt)}.`,
        'Credit dipakai otomatis sebagai potongan di transaksi berikutnya dan tidak dapat dicairkan.',
      ],
      highlight: { tone: 'success', text: `+ ${amount(c)} credit` },
      cta: 'Lihat dompet',
    }),
    (c) => ({
      title: 'You earned JastipKita Credit',
      body: `${amount(c)} referral credit added, valid until ${c.date(c.v.expiresAt)}.`,
      subject: `${amount(c)} JastipKita Credit for you`,
      heading: 'Referral credit added',
      paragraphs: [
        `${amount(c)} JastipKita Credit from the referral program is in your wallet, valid until ${c.date(c.v.expiresAt)}.`,
        'Credit is applied as a discount on your next transactions and cannot be withdrawn.',
      ],
      highlight: { tone: 'success', text: `+ ${amount(c)} credit` },
      cta: 'Open wallet',
    }),
  ),
  def(
    'credit.cashback_granted',
    { group: 'ACCOUNT', category: 'PROMOTION', channels: ALL, link: 'wallet', breakdown: 'NONE' },
    (c) => ({
      title: 'Cashback masuk',
      body: `${amount(c)} JastipKita Credit dari promo ${s(c.v.promotionName, '')} sudah masuk.`.replace('  ', ' '),
      subject: `Cashback ${amount(c)} sudah masuk`,
      heading: 'Cashback masuk',
      paragraphs: [
        `Cashback ${amount(c)} untuk transaksi ${num(c)} sudah masuk sebagai JastipKita Credit, berlaku sampai ${c.date(c.v.expiresAt)}.`,
        'Credit tidak dapat dicairkan dan dipakai sebagai potongan transaksi berikutnya.',
      ],
      highlight: { tone: 'success', text: `+ ${amount(c)} credit` },
      cta: 'Lihat dompet',
    }),
    (c) => ({
      title: 'Cashback received',
      body: `${amount(c)} JastipKita Credit from ${s(c.v.promotionName, 'a promotion')} was added.`,
      subject: `${amount(c)} cashback received`,
      heading: 'Cashback received',
      paragraphs: [
        `${amount(c)} cashback for transaction ${num(c)} was added as JastipKita Credit, valid until ${c.date(c.v.expiresAt)}.`,
        'Credit cannot be withdrawn and is applied to your next transactions.',
      ],
      highlight: { tone: 'success', text: `+ ${amount(c)} credit` },
      cta: 'Open wallet',
    }),
  ),
  // ============================================================ MARKETPLACE
  def(
    'trip.verified',
    { group: 'TRANSACTION', category: 'TRIP', channels: ALL, link: 'trip', breakdown: 'NONE' },
    (c) => ({
      title: 'Trip terverifikasi',
      body: `Trip ${s(c.v.route)} sudah terverifikasi. Publikasikan agar penitip bisa menemukanmu.`,
      subject: 'Trip kamu sudah terverifikasi',
      heading: 'Trip terverifikasi',
      paragraphs: [`Dokumen perjalanan untuk trip ${s(c.v.route)} sudah kami verifikasi.`, 'Publikasikan trip agar penitip bisa mengirim titipan. Ingat: beli barang hanya setelah status Pembelian Disetujui.'],
      highlight: { tone: 'success', text: 'Badge Trip terverifikasi aktif' },
      cta: 'Kelola trip',
    }),
    (c) => ({
      title: 'Trip verified',
      body: `Your trip ${s(c.v.route)} is verified. Publish it so buyers can find you.`,
      subject: 'Your trip is verified',
      heading: 'Trip verified',
      paragraphs: [`We verified the travel documents for your trip ${s(c.v.route)}.`, 'Publish the trip to receive requests. Remember: only buy items once the status is Purchase Approved.'],
      highlight: { tone: 'success', text: 'Verified trip badge active' },
      cta: 'Manage trip',
    }),
  ),
  def(
    'request.created',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'request', breakdown: 'NONE' },
    (c) => ({
      title: 'Titipan dibuat',
      body: `"${prod(c)}" sudah tersimpan. Publikasikan agar traveler bisa menawar.`,
      subject: `Titipan "${prod(c)}" sudah dibuat`,
      heading: 'Titipan kamu sudah dibuat',
      paragraphs: [`Titipan "${prod(c)}" sudah tersimpan.`, 'Setelah dipublikasikan, traveler terverifikasi bisa mengirim penawaran. Kamu akan kami kabari setiap ada penawaran baru.'],
      cta: 'Lihat titipan',
    }),
    (c) => ({
      title: 'Request created',
      body: `"${prod(c)}" is saved. Publish it so travelers can make offers.`,
      subject: `Your request "${prod(c)}" was created`,
      heading: 'Your request was created',
      paragraphs: [`Your request "${prod(c)}" is saved.`, 'Once published, verified travelers can send offers. We will notify you about every new offer.'],
      cta: 'View request',
    }),
  ),
  def(
    'offer.created',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: APP, link: 'request', breakdown: 'NONE' },
    (c) =>
      c.role === 'TRAVELER'
        ? short('Undangan titip baru', `Penitip mengundangmu membawa "${prod(c)}".`, 'Lihat undangan')
        : short('Penawaran baru', `${s(c.v.travelerName, 'Traveler')} menawarkan fee ${amount(c, 'travelerFeeIdr')} untuk "${prod(c)}".`, 'Lihat penawaran'),
    (c) =>
      c.role === 'TRAVELER'
        ? short('New request invitation', `A buyer invited you to bring "${prod(c)}".`, 'View invitation')
        : short('New offer', `${s(c.v.travelerName, 'A traveler')} offered a ${amount(c, 'travelerFeeIdr')} fee for "${prod(c)}".`, 'View offer'),
  ),
  def(
    'offer.accepted',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: APP, link: 'request', breakdown: 'NONE' },
    (c) => short('Penawaran diterima', `Penawaranmu untuk "${prod(c)}" diterima.`, 'Lihat detail'),
    (c) => short('Offer accepted', `Your offer for "${prod(c)}" was accepted.`, 'View details'),
  ),
  def(
    'offer.declined',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: APP, link: 'request', breakdown: 'NONE' },
    (c) => short('Penawaran tidak dipilih', `Penawaran untuk "${prod(c)}" tidak dipilih. Coba titipan lain yang cocok dengan tripmu.`, 'Cari titipan'),
    (c) => short('Offer not selected', `The offer for "${prod(c)}" was not selected. Try other requests matching your trip.`, 'Find requests'),
  ),
  def(
    'offer.expired',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: APP, link: 'request', breakdown: 'NONE' },
    (c) => short('Penawaran kedaluwarsa', `Penawaran untuk "${prod(c)}" sudah kedaluwarsa.`, 'Lihat titipan'),
    (c) => short('Offer expired', `The offer for "${prod(c)}" has expired.`, 'View request'),
  ),
  // ============================================================ TRANSACTION LIFECYCLE
  def(
    'transaction.matched',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Request diterima',
            body: `Kamu terhubung dengan penitip untuk "${prod(c)}". Tunggu pembayaran aman.`,
            subject: `Request diterima: ${num(c)}`,
            heading: 'Request titipan diterima',
            paragraphs: [
              `Kamu sekarang terhubung dengan penitip untuk "${prod(c)}". Chat transaksi sudah dibuka.`,
              'Penitip akan membayar lewat SafePay. Kamu baru boleh membeli barang setelah status Pembelian Disetujui.',
            ],
            highlight: { tone: 'danger', text: 'JANGAN BELI DULU / DO NOT PURCHASE — tunggu status Pembelian Disetujui.' },
            cta: 'Lihat titipan',
          }
        : {
            title: 'Traveler ditemukan',
            body: `${trav(c)} akan membawa titipanmu. Lanjutkan ke pembayaran.`,
            subject: `Traveler ditemukan untuk ${num(c)}`,
            heading: 'Traveler ditemukan',
            paragraphs: [
              `${trav(c)} menerima titipan "${prod(c)}". Chat transaksi sudah dibuka.`,
              'Langkah berikutnya: cek rincian harga lalu bayar lewat SafePay. Dana ditahan aman dan baru diteruskan ke traveler setelah kamu menerima barang.',
            ],
            cta: 'Lanjut ke pembayaran',
          },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Request accepted',
            body: `You are matched with the buyer for "${prod(c)}". Wait for the payment to be secured.`,
            subject: `Request accepted: ${num(c)}`,
            heading: 'Request accepted',
            paragraphs: [
              `You are now matched with the buyer for "${prod(c)}". The transaction chat is open.`,
              'The buyer pays through SafePay. Only buy the item once the status is Purchase Approved.',
            ],
            highlight: { tone: 'danger', text: 'DO NOT PURCHASE yet — wait for Purchase Approved.' },
            cta: 'View request',
          }
        : {
            title: 'Traveler matched',
            body: `${trav(c)} will bring your item. Continue to payment.`,
            subject: `Traveler matched for ${num(c)}`,
            heading: 'Traveler matched',
            paragraphs: [
              `${trav(c)} accepted your request "${prod(c)}". The transaction chat is open.`,
              'Next: review the price breakdown and pay through SafePay. Your money is held safely and only released to the traveler after you receive the item.',
            ],
            cta: 'Continue to payment',
          },
  ),
  def(
    'payment.checkout_created',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Selesaikan pembayaran',
      body: `Bayar ${amount(c)} sebelum ${c.dt(c.v.expiresAt)} lewat SafePay.`,
      subject: `Tagihan pembayaran ${num(c)}`,
      heading: 'Selesaikan pembayaran',
      paragraphs: [
        `Tagihan SafePay untuk titipan "${prod(c)}" sudah dibuat. Selesaikan pembayaran sebelum ${c.dt(c.v.expiresAt)}.`,
        'Bayar hanya lewat halaman pembayaran di aplikasi atau situs resmi JastipKita. Kami tidak pernah meminta transfer ke rekening pribadi.',
      ],
      highlight: { tone: 'info', text: `Total tagihan: ${amount(c)}` },
      cta: 'Bayar sekarang',
    }),
    (c) => ({
      title: 'Complete your payment',
      body: `Pay ${amount(c)} before ${c.dt(c.v.expiresAt)} through SafePay.`,
      subject: `Payment invoice for ${num(c)}`,
      heading: 'Complete your payment',
      paragraphs: [
        `Your SafePay invoice for "${prod(c)}" is ready. Please pay before ${c.dt(c.v.expiresAt)}.`,
        'Only pay on the payment page in the JastipKita app or website. We never ask you to transfer to a personal bank account.',
      ],
      highlight: { tone: 'info', text: `Amount due: ${amount(c)}` },
      cta: 'Pay now',
    }),
  ),
  def(
    'payment.expired',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Tagihan kedaluwarsa',
      body: `Tagihan untuk ${num(c)} kedaluwarsa. Buat tagihan baru untuk melanjutkan.`,
      subject: `Tagihan ${num(c)} kedaluwarsa`,
      heading: 'Tagihan kedaluwarsa',
      paragraphs: ['Batas waktu pembayaran sudah lewat dan belum ada dana yang masuk.', 'Buka transaksi untuk membuat penawaran harga dan tagihan baru. Kurs dan estimasi bea masuk akan dihitung ulang.'],
      cta: 'Buat tagihan baru',
    }),
    (c) => ({
      title: 'Invoice expired',
      body: `The invoice for ${num(c)} expired. Create a new one to continue.`,
      subject: `Invoice for ${num(c)} expired`,
      heading: 'Invoice expired',
      paragraphs: ['The payment deadline passed and no funds were received.', 'Open the transaction to get a new quote and invoice. FX and customs estimates are recalculated.'],
      cta: 'Create new invoice',
    }),
  ),
  def(
    'payment.failed',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Pembayaran gagal',
      body: `Pembayaran untuk ${num(c)} gagal. Coba lagi dengan metode lain.`,
      subject: `Pembayaran ${num(c)} gagal`,
      heading: 'Pembayaran gagal',
      paragraphs: ['Pembayaran kamu belum berhasil diproses oleh mitra pembayaran. Tidak ada dana yang ditahan.', 'Silakan coba lagi atau pilih metode pembayaran lain.'],
      cta: 'Coba bayar lagi',
    }),
    (c) => ({
      title: 'Payment failed',
      body: `The payment for ${num(c)} failed. Try again with another method.`,
      subject: `Payment for ${num(c)} failed`,
      heading: 'Payment failed',
      paragraphs: ['Your payment could not be processed by our payment partner. No funds were held.', 'Please try again or choose another payment method.'],
      cta: 'Try again',
    }),
  ),
  def(
    'transaction.payment_secured',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL'], link: 'transaction' },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Dana penitip sudah aman',
            body: `Cek harga aktual "${prod(c)}" lalu konfirmasi. Jangan beli sebelum Pembelian Disetujui.`,
            subject: `Dana aman untuk ${num(c)} — konfirmasi harga`,
            heading: 'Dana penitip sudah aman',
            paragraphs: [
              `Pembayaran penitip untuk "${prod(c)}" sudah ditahan SafePay.`,
              'Cek harga aktual di toko lalu konfirmasi di aplikasi. Jika harga berbeda di luar toleransi, penitip akan diminta menyetujui perubahan.',
            ],
            highlight: { tone: 'danger', text: 'JANGAN BELI DULU / DO NOT PURCHASE — beli hanya setelah status Pembelian Disetujui.' },
            cta: 'Konfirmasi harga',
          }
        : {
            title: 'Pembayaran aman',
            body: `${amount(c)} ditahan SafePay untuk ${num(c)}.`,
            subject: `Pembayaran aman untuk ${num(c)}`,
            heading: 'Pembayaran kamu aman',
            paragraphs: [
              `Pembayaran untuk titipan "${prod(c)}" sudah kami terima dan ditahan SafePay.`,
              'Dana baru diteruskan ke traveler setelah kamu menerima barang. Traveler akan mengonfirmasi harga aktual sebelum membeli.',
            ],
            highlight: { tone: 'success', text: `Pembayaran aman / PAYMENT SECURED — ${amount(c)} ditahan SafePay` },
            cta: 'Lihat status titipan',
          },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Buyer payment secured',
            body: `Check the actual price of "${prod(c)}" and confirm. Do not buy before Purchase Approved.`,
            subject: `Payment secured for ${num(c)} — confirm the price`,
            heading: 'Buyer payment secured',
            paragraphs: [
              `The buyer's payment for "${prod(c)}" is held by SafePay.`,
              'Check the actual price in store and confirm it in the app. If it differs beyond tolerance, the buyer will be asked to approve the change.',
            ],
            highlight: { tone: 'danger', text: 'DO NOT PURCHASE yet — only buy once the status is Purchase Approved.' },
            cta: 'Confirm price',
          }
        : {
            title: 'Payment secured',
            body: `${amount(c)} is held by SafePay for ${num(c)}.`,
            subject: `Payment secured for ${num(c)}`,
            heading: 'Your payment is secured',
            paragraphs: [
              `We received your payment for "${prod(c)}" and SafePay is holding it.`,
              'The money is only released to the traveler after you receive the item. The traveler confirms the actual price before buying.',
            ],
            highlight: { tone: 'success', text: `PAYMENT SECURED — ${amount(c)} held by SafePay` },
            cta: 'Track your request',
          },
  ),
  def(
    'price.change_requested',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL', 'PUSH'], link: 'transaction' },
    (c) => {
      const diff = Number(c.v.actualIdr ?? 0) - Number(c.v.originalIdr ?? 0);
      return {
        title: 'Konfirmasi perubahan harga',
        body: `Harga berubah ${c.idr(c.v.originalIdr)} → ${c.idr(c.v.actualIdr)}. Jawab sebelum ${c.dt(c.v.expiresAt)}.`,
        subject: `Perlu konfirmasi: perubahan harga ${num(c)}`,
        heading: 'Traveler meminta penyesuaian harga',
        paragraphs: [
          `${trav(c)} menemukan harga aktual "${prod(c)}" berbeda dari harga yang kamu bayar.`,
          `Setujui, tolak, atau minta klarifikasi sebelum ${c.dt(c.v.expiresAt)}. Jika tidak dijawab, perubahan dianggap ditolak dan dana kamu dikembalikan penuh tanpa penalti.`,
        ],
        details: [
          ['Harga awal', c.idr(c.v.originalIdr)],
          ['Harga aktual', c.idr(c.v.actualIdr)],
          ['Selisih', `${diff >= 0 ? '+' : ''}${c.idr(diff)}`],
        ],
        highlight: { tone: 'warning', text: `Batas waktu konfirmasi: ${c.dt(c.v.expiresAt)}` },
        cta: 'Tinjau perubahan harga',
      };
    },
    (c) => {
      const diff = Number(c.v.actualIdr ?? 0) - Number(c.v.originalIdr ?? 0);
      return {
        title: 'Confirm price change',
        body: `Price changed ${c.idr(c.v.originalIdr)} → ${c.idr(c.v.actualIdr)}. Respond before ${c.dt(c.v.expiresAt)}.`,
        subject: `Action needed: price change for ${num(c)}`,
        heading: 'Your traveler requested a price adjustment',
        paragraphs: [
          `${trav(c)} found that the actual price of "${prod(c)}" differs from what you paid.`,
          `Approve, reject or ask for clarification before ${c.dt(c.v.expiresAt)}. If you do not respond, the change is treated as rejected and you get a full refund without penalty.`,
        ],
        details: [
          ['Original price', c.idr(c.v.originalIdr)],
          ['Actual price', c.idr(c.v.actualIdr)],
          ['Difference', `${diff >= 0 ? '+' : ''}${c.idr(diff)}`],
        ],
        highlight: { tone: 'warning', text: `Respond by ${c.dt(c.v.expiresAt)}` },
        cta: 'Review price change',
      };
    },
  ),
  def(
    'price.clarification_requested',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL', 'PUSH'], link: 'transaction' },
    (c) => ({
      title: 'Penitip minta klarifikasi harga',
      body: `Jawab sebelum ${c.dt(c.v.expiresAt)} agar ${num(c)} tidak dibatalkan otomatis.`,
      subject: `Perlu jawaban: klarifikasi harga ${num(c)}`,
      heading: 'Penitip meminta klarifikasi perubahan harga',
      paragraphs: [
        `Penitip bertanya tentang harga aktual "${prod(c)}" (${c.idr(c.v.originalIdr)} → ${c.idr(c.v.actualIdr)}).`,
        ...(c.v.note ? [`Pertanyaan: "${s(c.v.note)}"`] : []),
        `Jawab di aplikasi sebelum ${c.dt(c.v.expiresAt)} (jendela konfirmasi direset saat kamu menjawab). Jika tidak dijawab, perubahan harga dianggap ditolak dan dana penitip dikembalikan penuh.`,
      ],
      highlight: { tone: 'danger', text: 'JANGAN BELI DULU / DO NOT PURCHASE' },
      cta: 'Jawab klarifikasi',
    }),
    (c) => ({
      title: 'Buyer asked about the price',
      body: `Reply before ${c.dt(c.v.expiresAt)} so ${num(c)} is not cancelled automatically.`,
      subject: `Reply needed: price clarification for ${num(c)}`,
      heading: 'The buyer asked for a price clarification',
      paragraphs: [
        `The buyer has a question about the actual price of "${prod(c)}" (${c.idr(c.v.originalIdr)} → ${c.idr(c.v.actualIdr)}).`,
        ...(c.v.note ? [`Question: "${s(c.v.note)}"`] : []),
        `Reply in the app before ${c.dt(c.v.expiresAt)} (answering resets the window). Without a reply the price change counts as rejected and the buyer gets a full refund.`,
      ],
      highlight: { tone: 'danger', text: 'DO NOT PURCHASE' },
      cta: 'Reply now',
    }),
  ),
  def(
    'price.change_result',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'transaction' },
    (c) => {
      const st = s(c.v.status);
      const traveler = c.role === 'TRAVELER';
      const t: Record<string, [string, string]> = traveler
        ? {
            APPROVED: ['Harga baru disetujui', 'Penitip menyetujui harga baru.'],
            REJECTED: ['Perubahan harga ditolak', 'Penitip menolak perubahan harga — jangan beli barang. Transaksi dibatalkan.'],
            EXPIRED: ['Waktu konfirmasi habis', 'Penitip tidak merespons — transaksi dibatalkan. Jangan beli barang.'],
            CLARIFICATION_REQUESTED: ['Penitip meminta klarifikasi', 'Jelaskan perubahan harga sebelum waktu konfirmasi habis.'],
          }
        : {
            APPROVED: ['Perubahan harga disetujui', 'Traveler akan melanjutkan pembelian sesuai harga baru.'],
            REJECTED: ['Perubahan harga ditolak', 'Transaksi dibatalkan dan dana kamu dikembalikan penuh tanpa penalti.'],
            EXPIRED: ['Waktu konfirmasi habis', 'Perubahan dianggap ditolak. Dana kamu dikembalikan penuh tanpa penalti.'],
            CLARIFICATION_REQUESTED: ['Klarifikasi diminta', 'Kami menunggu penjelasan traveler. Kamu akan dikabari.'],
          };
      const [title, body] = t[st] ?? ['Hasil konfirmasi harga', `Status: ${st}`];
      return {
        title,
        body,
        subject: `${title} — ${num(c)}`,
        heading: title,
        paragraphs: [body],
        details: c.v.actualIdr !== undefined ? [['Harga aktual', c.idr(c.v.actualIdr)]] : [],
        ...(st === 'REJECTED' || st === 'EXPIRED'
          ? { highlight: { tone: traveler ? ('danger' as const) : ('info' as const), text: traveler ? 'JANGAN BELI / DO NOT PURCHASE' : 'Refund penuh diproses otomatis' } }
          : {}),
        cta: 'Lihat transaksi',
      };
    },
    (c) => {
      const st = s(c.v.status);
      const traveler = c.role === 'TRAVELER';
      const t: Record<string, [string, string]> = traveler
        ? {
            APPROVED: ['New price approved', 'The buyer approved the new price.'],
            REJECTED: ['Price change rejected', 'The buyer rejected the price change — do not buy. The transaction is cancelled.'],
            EXPIRED: ['Confirmation window expired', 'The buyer did not respond — the transaction is cancelled. Do not buy.'],
            CLARIFICATION_REQUESTED: ['Buyer asked for clarification', 'Explain the price change before the window closes.'],
          }
        : {
            APPROVED: ['Price change approved', 'Your traveler will buy at the new price.'],
            REJECTED: ['Price change rejected', 'The transaction is cancelled and you get a full refund without penalty.'],
            EXPIRED: ['Confirmation window expired', 'The change is treated as rejected. You get a full refund without penalty.'],
            CLARIFICATION_REQUESTED: ['Clarification requested', 'We are waiting for the traveler to explain. We will keep you posted.'],
          };
      const [title, body] = t[st] ?? ['Price confirmation result', `Status: ${st}`];
      return {
        title,
        body,
        subject: `${title} — ${num(c)}`,
        heading: title,
        paragraphs: [body],
        details: c.v.actualIdr !== undefined ? [['Actual price', c.idr(c.v.actualIdr)]] : [],
        ...(st === 'REJECTED' || st === 'EXPIRED'
          ? { highlight: { tone: traveler ? ('danger' as const) : ('info' as const), text: traveler ? 'DO NOT PURCHASE' : 'Full refund is processed automatically' } }
          : {}),
        cta: 'View transaction',
      };
    },
  ),
  def(
    'transaction.purchase_approved',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Boleh beli sekarang',
            body: `Pembelian Disetujui untuk ${num(c)}. Simpan struk & foto barang.`,
            subject: `Pembelian disetujui: ${num(c)}`,
            heading: 'Kamu boleh membeli barang sekarang',
            paragraphs: [
              `Harga "${prod(c)}" sudah dikonfirmasi dan dana penitip aman di SafePay.`,
              'Setelah membeli, unggah bukti pembelian: struk, foto barang, nama toko, harga, dan waktu pembelian.',
            ],
            highlight: { tone: 'success', text: 'Pembelian disetujui / PURCHASE APPROVED' },
            cta: 'Unggah bukti pembelian',
          }
        : short('Traveler segera membeli', `Harga sudah dikonfirmasi; ${trav(c)} akan membeli "${prod(c)}".`, 'Lihat status', {
            subject: `Pembelian disetujui: ${num(c)}`,
          }),
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'You can buy now',
            body: `Purchase approved for ${num(c)}. Keep the receipt & item photos.`,
            subject: `Purchase approved: ${num(c)}`,
            heading: 'You can buy the item now',
            paragraphs: [
              `The price of "${prod(c)}" is confirmed and the buyer's money is safe in SafePay.`,
              'After buying, upload the purchase proof: receipt, item photos, store name, price and time of purchase.',
            ],
            highlight: { tone: 'success', text: 'PURCHASE APPROVED' },
            cta: 'Upload purchase proof',
          }
        : short('Your traveler is buying', `Price confirmed; ${trav(c)} will buy "${prod(c)}".`, 'View status', { subject: `Purchase approved: ${num(c)}` }),
  ),
  def(
    'transaction.purchased',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Barang sudah dibeli',
      body: `${trav(c)} sudah membeli "${prod(c)}".`,
      subject: `Titipan ${num(c)} sudah dibeli`,
      heading: 'Titipanmu sudah dibeli',
      paragraphs: [`${trav(c)} sudah membeli "${prod(c)}". Bukti pembelian bisa kamu cek di detail transaksi.`, 'Selanjutnya titipan akan dibawa sesuai jadwal perjalanan traveler.'],
      cta: 'Lihat bukti pembelian',
    }),
    (c) => ({
      title: 'Item purchased',
      body: `${trav(c)} bought "${prod(c)}".`,
      subject: `Your item for ${num(c)} was purchased`,
      heading: 'Your item was purchased',
      paragraphs: [`${trav(c)} bought "${prod(c)}". You can check the purchase proof in the transaction details.`, 'The item now travels with the traveler according to the trip schedule.'],
      cta: 'View purchase proof',
    }),
  ),
  def(
    'purchase.receipt_available',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Bukti pembelian tersedia',
      body: `Struk & foto barang untuk ${num(c)} sudah bisa kamu cek.`,
      subject: `Bukti pembelian ${num(c)} tersedia`,
      heading: 'Bukti pembelian tersedia',
      paragraphs: ['Traveler mengunggah bukti pembelian (struk, foto barang, toko, harga, dan waktu).', 'Cek apakah barang sesuai pesananmu. Ada yang janggal? Hubungi traveler lewat chat atau Pusat Bantuan.'],
      cta: 'Cek bukti pembelian',
    }),
    (c) => ({
      title: 'Purchase proof available',
      body: `Receipt & item photos for ${num(c)} are ready to check.`,
      subject: `Purchase proof for ${num(c)} is available`,
      heading: 'Purchase proof available',
      paragraphs: ['Your traveler uploaded the purchase proof (receipt, item photos, store, price and time).', 'Check that the item matches your order. Something off? Message the traveler or contact the Help Center.'],
      cta: 'Check purchase proof',
    }),
  ),
  def(
    'transaction.traveling',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Traveler berangkat',
      body: `${trav(c)} sudah berangkat membawa titipanmu.`,
      subject: `Titipan ${num(c)} dalam perjalanan`,
      heading: 'Titipanmu dalam perjalanan',
      paragraphs: [`${trav(c)} sudah berangkat membawa "${prod(c)}".`],
      details: c.tx?.arrivalDate ? [['Perkiraan tiba', c.date(c.tx.arrivalDate)]] : [],
      cta: 'Lacak titipan',
    }),
    (c) => ({
      title: 'Traveler departed',
      body: `${trav(c)} departed with your item.`,
      subject: `Your item for ${num(c)} is on its way`,
      heading: 'Your item is on its way',
      paragraphs: [`${trav(c)} departed carrying "${prod(c)}".`],
      details: c.tx?.arrivalDate ? [['Estimated arrival', c.date(c.tx.arrivalDate)]] : [],
      cta: 'Track your item',
    }),
  ),
  def(
    'transaction.arrived',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Traveler sudah tiba',
      body: `Titipanmu sudah tiba bersama ${trav(c)}.`,
      subject: `Titipan ${num(c)} sudah tiba`,
      heading: 'Traveler sudah tiba',
      paragraphs: [`${trav(c)} sudah tiba membawa "${prod(c)}".`, 'Traveler akan menyelesaikan proses bea cukai (bila perlu) lalu menyiapkan serah terima.'],
      cta: 'Lihat status',
    }),
    (c) => ({
      title: 'Traveler arrived',
      body: `Your item arrived with ${trav(c)}.`,
      subject: `Your item for ${num(c)} has arrived`,
      heading: 'Traveler arrived',
      paragraphs: [`${trav(c)} arrived with "${prod(c)}".`, 'The traveler completes customs (if needed) and then prepares the handover.'],
      cta: 'View status',
    }),
  ),
  def(
    'transaction.customs',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Proses bea cukai',
      body: `Titipan ${num(c)} sedang diproses bea cukai.`,
      subject: `Titipan ${num(c)} dalam proses bea cukai`,
      heading: 'Titipan dalam proses bea cukai',
      paragraphs: ['Titipanmu sedang melalui proses kepabeanan.', 'Bea masuk dan pajak impor pada rincian adalah estimasi; nilai final mengikuti penetapan Bea Cukai dan bukti bayar diunggah traveler.'],
      cta: 'Lihat status',
    }),
    (c) => ({
      title: 'Customs processing',
      body: `Your item for ${num(c)} is in customs.`,
      subject: `Your item for ${num(c)} is in customs`,
      heading: 'Item in customs',
      paragraphs: ['Your item is going through Indonesian customs.', 'Customs duty and import tax in the breakdown are estimates; the final amount is set by Customs and the traveler uploads the payment proof.'],
      cta: 'View status',
    }),
  ),
  def(
    'transaction.ready_for_handover',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Siap diserahkan',
      body: `Titipan ${num(c)} siap diserahkan. Atur jadwal dengan ${trav(c)}.`,
      subject: `Titipan ${num(c)} siap diserahkan`,
      heading: 'Titipanmu siap diserahkan',
      paragraphs: [`"${prod(c)}" siap diserahkan. Atur waktu dan tempat serah terima dengan ${trav(c)} lewat chat.`, 'Saat bertemu, periksa barang dulu sebelum memberikan PIN/QR dari aplikasi.'],
      cta: 'Atur serah terima',
    }),
    (c) => ({
      title: 'Ready for handover',
      body: `Your item for ${num(c)} is ready. Arrange a time with ${trav(c)}.`,
      subject: `Your item for ${num(c)} is ready for handover`,
      heading: 'Your item is ready for handover',
      paragraphs: [`"${prod(c)}" is ready. Arrange the handover with ${trav(c)} in the chat.`, 'When you meet, inspect the item before showing the PIN/QR from the app.'],
      cta: 'Arrange handover',
    }),
  ),
  def(
    'transaction.out_for_delivery',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Titipan sedang dikirim',
      body: `Titipan ${num(c)} sedang dalam pengiriman.`,
      subject: `Titipan ${num(c)} sedang dikirim`,
      heading: 'Titipanmu sedang dikirim',
      paragraphs: [`"${prod(c)}" sedang dikirim ke alamatmu.`, 'Periksa kondisi barang saat diterima. Ada masalah? Buka dispute dari aplikasi.'],
      details: [
        ...(c.v.courierName ? ([['Kurir', s(c.v.courierName)]] as [string, string][]) : []),
        ...(c.v.trackingNumber ? ([['No. resi', s(c.v.trackingNumber)]] as [string, string][]) : []),
      ],
      cta: 'Lacak pengiriman',
    }),
    (c) => ({
      title: 'Out for delivery',
      body: `Your item for ${num(c)} is being delivered.`,
      subject: `Your item for ${num(c)} is out for delivery`,
      heading: 'Your item is out for delivery',
      paragraphs: [`"${prod(c)}" is on its way to your address.`, 'Inspect the item on arrival. Any problem? Open a dispute from the app.'],
      details: [
        ...(c.v.courierName ? ([['Courier', s(c.v.courierName)]] as [string, string][]) : []),
        ...(c.v.trackingNumber ? ([['Tracking no.', s(c.v.trackingNumber)]] as [string, string][]) : []),
      ],
      cta: 'Track delivery',
    }),
  ),
  def(
    'delivery.pin_ready',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'PIN serah terima siap',
      body: 'Buka aplikasi untuk melihat PIN/QR. PIN tidak pernah dikirim lewat e-mail atau notifikasi.',
      subject: `PIN serah terima ${num(c)} siap di aplikasi`,
      heading: 'PIN/QR serah terima siap',
      paragraphs: [
        `PIN/QR serah terima untuk "${prod(c)}" sudah siap di aplikasi JastipKita.`,
        'Demi keamanan, PIN tidak pernah kami kirim lewat e-mail, SMS, atau notifikasi — buka aplikasi untuk melihatnya.',
      ],
      highlight: { tone: 'warning', text: 'Periksa barang dulu. Jangan berikan PIN sebelum barang sesuai.' },
      cta: 'Buka PIN di aplikasi',
    }),
    (c) => ({
      title: 'Handover PIN ready',
      body: 'Open the app to see your PIN/QR. PINs are never sent by e-mail or notification.',
      subject: `Handover PIN for ${num(c)} is ready in the app`,
      heading: 'Handover PIN/QR ready',
      paragraphs: [
        `The handover PIN/QR for "${prod(c)}" is ready in the JastipKita app.`,
        'For your security we never send the PIN by e-mail, SMS or notification — open the app to see it.',
      ],
      highlight: { tone: 'warning', text: 'Inspect the item first. Do not share the PIN until the item is right.' },
      cta: 'Open PIN in the app',
    }),
  ),
  def(
    'transaction.delivered',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Serah terima tercatat',
            body: `Titipan ${num(c)} sudah diterima penitip. Dana diteruskan setelah konfirmasi.`,
            subject: `Serah terima ${num(c)} tercatat`,
            heading: 'Serah terima tercatat',
            paragraphs: [
              `"${prod(c)}" tercatat sudah diterima penitip.`,
              `Dana diteruskan setelah penitip mengonfirmasi, atau otomatis ${s(c.v.autoConfirmHours, '48')} jam setelah serah terima bila tidak ada dispute.`,
            ],
            cta: 'Lihat transaksi',
          }
        : {
            title: 'Titipan diterima',
            body: `Periksa barangmu. Konfirmasi atau buka dispute dalam ${s(c.v.disputeWindowHours, '72')} jam.`,
            subject: `Titipan ${num(c)} sudah diterima`,
            heading: 'Titipanmu sudah diterima',
            paragraphs: [
              `"${prod(c)}" tercatat sudah kamu terima.`,
              `Jika barang sesuai, konfirmasi penerimaan. Jika ada masalah, buka dispute dalam ${s(c.v.disputeWindowHours, '72')} jam. Tanpa konfirmasi atau dispute, transaksi dikonfirmasi otomatis setelah ${s(c.v.autoConfirmHours, '48')} jam dan dana diteruskan ke traveler.`,
            ],
            cta: 'Konfirmasi atau laporkan',
          },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Handover recorded',
            body: `The buyer received ${num(c)}. Funds are released after confirmation.`,
            subject: `Handover for ${num(c)} recorded`,
            heading: 'Handover recorded',
            paragraphs: [
              `"${prod(c)}" is recorded as received by the buyer.`,
              `Funds are released after the buyer confirms, or automatically ${s(c.v.autoConfirmHours, '48')} hours after handover if there is no dispute.`,
            ],
            cta: 'View transaction',
          }
        : {
            title: 'Item received',
            body: `Check your item. Confirm or open a dispute within ${s(c.v.disputeWindowHours, '72')} hours.`,
            subject: `Your item for ${num(c)} was delivered`,
            heading: 'Your item was delivered',
            paragraphs: [
              `"${prod(c)}" is recorded as received.`,
              `If everything is right, confirm receipt. If there is a problem, open a dispute within ${s(c.v.disputeWindowHours, '72')} hours. Without confirmation or dispute the transaction is confirmed automatically after ${s(c.v.autoConfirmHours, '48')} hours and funds go to the traveler.`,
            ],
            cta: 'Confirm or report',
          },
  ),
  def(
    'transaction.buyer_confirmed',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => short('Penitip mengonfirmasi', `Barang ${num(c)} dikonfirmasi. Pencairan dana sedang dijadwalkan.`, 'Lihat transaksi', { subject: `Penitip mengonfirmasi ${num(c)}` }),
    (c) => short('Buyer confirmed', `The buyer confirmed ${num(c)}. Your payout is being scheduled.`, 'View transaction', { subject: `Buyer confirmed ${num(c)}` }),
  ),
  def(
    'transaction.completed',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Transaksi selesai',
            body: `Pencairan untuk ${num(c)} sudah dijadwalkan. Beri rating untuk penitip.`,
            subject: `Transaksi ${num(c)} selesai`,
            heading: 'Transaksi selesai',
            paragraphs: [`Terima kasih sudah membawa "${prod(c)}" dengan aman.`, 'Pencairan dana sudah dijadwalkan ke rekening payout-mu. Beri rating untuk penitip dalam 14 hari.'],
            cta: 'Beri rating',
          }
        : {
            title: 'Transaksi selesai',
            body: `Terima kasih! Beri rating untuk ${trav(c)}.`,
            subject: `Transaksi ${num(c)} selesai`,
            heading: 'Transaksi selesai',
            paragraphs: [`Titipan "${prod(c)}" sudah selesai. Terima kasih sudah memakai JastipKita!`, `Bantu penitip lain dengan memberi rating untuk ${trav(c)} dalam 14 hari.`],
            cta: 'Beri rating',
          },
    (c) =>
      c.role === 'TRAVELER'
        ? {
            title: 'Transaction completed',
            body: `Your payout for ${num(c)} is scheduled. Rate the buyer.`,
            subject: `Transaction ${num(c)} completed`,
            heading: 'Transaction completed',
            paragraphs: [`Thanks for delivering "${prod(c)}" safely.`, 'Your payout is scheduled to your payout account. Rate the buyer within 14 days.'],
            cta: 'Leave a rating',
          }
        : {
            title: 'Transaction completed',
            body: `Thank you! Rate ${trav(c)}.`,
            subject: `Transaction ${num(c)} completed`,
            heading: 'Transaction completed',
            paragraphs: [`Your request "${prod(c)}" is complete. Thanks for using JastipKita!`, `Help other buyers by rating ${trav(c)} within 14 days.`],
            cta: 'Leave a rating',
          },
  ),
  def(
    'transaction.trip_cancelled',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, critical: ['EMAIL'], link: 'transaction' },
    (c) => {
      const refund = Number(c.v.refundIdr ?? 0);
      return c.role === 'TRAVELER'
        ? {
            title: 'Trip dibatalkan — transaksi ditutup',
            body: `${num(c)} dibatalkan karena trip-mu dibatalkan.`,
            subject: `Transaksi ${num(c)} dibatalkan (trip dibatalkan)`,
            heading: 'Transaksi dibatalkan karena trip dibatalkan',
            paragraphs: [
              `Karena trip-mu dibatalkan, transaksi "${prod(c)}" (${num(c)}) ditutup sesuai kebijakan pembatalan.`,
              refund > 0 ? `Penitip menerima refund penuh ${c.idr(refund)}, termasuk biaya pembayaran.` : 'Penitip belum membayar, jadi tidak ada dana yang ditahan.',
              Number(c.v.trustPenalty ?? 0) > 0 ? 'Pembatalan oleh traveler memengaruhi Trust Score kamu.' : 'Jangan membeli barang untuk transaksi ini.',
            ],
            highlight: { tone: 'danger', text: 'JANGAN BELI / DO NOT PURCHASE' },
            cta: 'Lihat detail',
          }
        : {
            title: 'Trip traveler dibatalkan',
            body: refund > 0 ? `Dana ${c.idr(refund)} untuk ${num(c)} dikembalikan penuh.` : `${num(c)} dibatalkan; kamu tidak dikenai biaya.`,
            subject: `Trip traveler untuk ${num(c)} dibatalkan`,
            heading: 'Traveler membatalkan trip',
            paragraphs: [
              `${trav(c)} membatalkan trip, sehingga titipan "${prod(c)}" (${num(c)}) dibatalkan tanpa kesalahan dari kamu.`,
              refund > 0
                ? `Refund penuh ${c.idr(refund)} (termasuk biaya pembayaran) diproses otomatis — kamu akan menerima e-mail status refund.`
                : 'Belum ada pembayaran yang diambil; tagihan yang masih terbuka sudah dihentikan.',
              'Kamu bisa membuat request lagi atau mencari traveler lain di aplikasi.',
            ],
            highlight: { tone: refund > 0 ? ('success' as const) : ('warning' as const), text: refund > 0 ? `Refund penuh ${c.idr(refund)}` : 'Tidak ada biaya' },
            cta: 'Cari traveler lain',
          };
    },
    (c) => {
      const refund = Number(c.v.refundIdr ?? 0);
      return c.role === 'TRAVELER'
        ? {
            title: 'Trip cancelled — transaction closed',
            body: `${num(c)} was cancelled because your trip was cancelled.`,
            subject: `Transaction ${num(c)} cancelled (trip cancelled)`,
            heading: 'Transaction cancelled because the trip was cancelled',
            paragraphs: [
              `Because your trip was cancelled, the transaction for "${prod(c)}" (${num(c)}) was closed under the cancellation policy.`,
              refund > 0 ? `The buyer receives a full refund of ${c.idr(refund)}, including the payment fee.` : 'The buyer had not paid yet, so no money was held.',
              Number(c.v.trustPenalty ?? 0) > 0 ? 'A cancellation by the traveler affects your Trust Score.' : 'Do not buy the item for this transaction.',
            ],
            highlight: { tone: 'danger', text: 'DO NOT PURCHASE' },
            cta: 'View details',
          }
        : {
            title: "Traveler's trip cancelled",
            body: refund > 0 ? `${c.idr(refund)} for ${num(c)} is refunded in full.` : `${num(c)} was cancelled; you are not charged.`,
            subject: `Traveler's trip for ${num(c)} cancelled`,
            heading: 'Your traveler cancelled the trip',
            paragraphs: [
              `${trav(c)} cancelled the trip, so your request "${prod(c)}" (${num(c)}) was cancelled through no fault of yours.`,
              refund > 0
                ? `A full refund of ${c.idr(refund)} (including the payment fee) is processed automatically — you will get refund status e-mails.`
                : 'No payment was taken; any open invoice has been stopped.',
              'You can create a new request or find another traveler in the app.',
            ],
            highlight: { tone: refund > 0 ? ('success' as const) : ('warning' as const), text: refund > 0 ? `Full refund ${c.idr(refund)}` : 'No charge' },
            cta: 'Find another traveler',
          };
    },
  ),
  def(
    'transaction.cancelled',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Transaksi dibatalkan',
      body: `${num(c)} dibatalkan oleh ${ACTOR.id[s(c.v.actorType)] ?? 'sistem'}.`,
      subject: `Transaksi ${num(c)} dibatalkan`,
      heading: 'Transaksi dibatalkan',
      paragraphs: [
        `Transaksi untuk "${prod(c)}" dibatalkan oleh ${ACTOR.id[s(c.v.actorType)] ?? 'sistem'}.`,
        c.role === 'TRAVELER'
          ? 'Jangan membeli barang untuk transaksi ini. Kapasitas trip-mu dikembalikan.'
          : 'Jika sudah ada pembayaran, refund diproses otomatis sesuai kebijakan pembatalan.',
      ],
      ...(c.role === 'TRAVELER' ? { highlight: { tone: 'danger' as const, text: 'JANGAN BELI / DO NOT PURCHASE' } } : {}),
      cta: 'Lihat detail',
    }),
    (c) => ({
      title: 'Transaction cancelled',
      body: `${num(c)} was cancelled by ${ACTOR.en[s(c.v.actorType)] ?? 'the system'}.`,
      subject: `Transaction ${num(c)} cancelled`,
      heading: 'Transaction cancelled',
      paragraphs: [
        `The transaction for "${prod(c)}" was cancelled by ${ACTOR.en[s(c.v.actorType)] ?? 'the system'}.`,
        c.role === 'TRAVELER'
          ? 'Do not buy the item for this transaction. Your trip capacity is released.'
          : 'If you already paid, the refund is processed automatically under the cancellation policy.',
      ],
      ...(c.role === 'TRAVELER' ? { highlight: { tone: 'danger' as const, text: 'DO NOT PURCHASE' } } : {}),
      cta: 'View details',
    }),
  ),
  // ============================================================ MONEY OUT
  def(
    'refund.requested',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL'], link: 'transaction' },
    (c) => ({
      title: 'Refund sedang diproses',
      body: `${amount(c)} untuk ${num(c)} sedang dikembalikan.`,
      subject: `Refund ${s(c.v.refundNumber)} sedang diproses`.trim(),
      heading: 'Refund sedang diproses',
      paragraphs: [
        c.v.method === 'PAYOUT_TO_BUYER'
          ? `Refund ${amount(c)} untuk transaksi ${num(c)} akan ditransfer ke rekening bank atas namamu (Virtual Account/gerai tidak bisa di-refund langsung).`
          : `Refund ${amount(c)} untuk transaksi ${num(c)} sedang kami proses ke metode pembayaran asal.`,
        c.v.method === 'PAYOUT_TO_BUYER'
          ? 'Jika belum, tambahkan rekening tujuan refund di aplikasi. Dana kamu tetap aman sampai dikirim.'
          : 'Waktu dana masuk tergantung metode pembayaran (umumnya 1–14 hari kerja).',
      ],
      details: c.v.refundNumber ? [['No. refund', s(c.v.refundNumber)]] : [],
      cta: 'Lacak refund',
    }),
    (c) => ({
      title: 'Refund in progress',
      body: `${amount(c)} for ${num(c)} is being refunded.`,
      subject: `Refund ${s(c.v.refundNumber)} in progress`.trim(),
      heading: 'Refund in progress',
      paragraphs: [
        c.v.method === 'PAYOUT_TO_BUYER'
          ? `The ${amount(c)} refund for transaction ${num(c)} will be transferred to a bank account in your name (virtual accounts / retail outlets cannot be refunded directly).`
          : `We are refunding ${amount(c)} for transaction ${num(c)} to your original payment method.`,
        c.v.method === 'PAYOUT_TO_BUYER'
          ? 'If you have not yet, add a refund destination account in the app. Your money stays safe until it is sent.'
          : 'Timing depends on the payment method (usually 1–14 business days).',
      ],
      details: c.v.refundNumber ? [['Refund no.', s(c.v.refundNumber)]] : [],
      cta: 'Track refund',
    }),
  ),
  def(
    'refund.succeeded',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL'], link: 'transaction' },
    (c) => ({
      title: 'Refund berhasil',
      body: `${amount(c)} sudah dikembalikan.`,
      subject: `Refund ${num(c)} berhasil`,
      heading: 'Refund berhasil',
      paragraphs: [`Refund ${amount(c)} untuk transaksi ${num(c)} sudah berhasil dikirim.`],
      details: c.v.refundNumber ? [['No. refund', s(c.v.refundNumber)]] : [],
      highlight: { tone: 'success', text: `Refund ${amount(c)} berhasil` },
      cta: 'Lihat transaksi',
    }),
    (c) => ({
      title: 'Refund completed',
      body: `${amount(c)} has been refunded.`,
      subject: `Refund for ${num(c)} completed`,
      heading: 'Refund completed',
      paragraphs: [`The ${amount(c)} refund for transaction ${num(c)} was sent successfully.`],
      details: c.v.refundNumber ? [['Refund no.', s(c.v.refundNumber)]] : [],
      highlight: { tone: 'success', text: `Refund ${amount(c)} completed` },
      cta: 'View transaction',
    }),
  ),
  def(
    'refund.failed',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL'], link: 'transaction' },
    (c) => ({
      title: 'Refund perlu tindakan',
      body: `Refund ${amount(c)} belum berhasil. Tambahkan rekening tujuan di aplikasi.`,
      subject: `Refund ${num(c)} perlu tindakan`,
      heading: 'Refund belum berhasil',
      paragraphs: [`Refund ${amount(c)} untuk transaksi ${num(c)} belum berhasil dikirim ke metode pembayaran asal.`, 'Tambahkan rekening tujuan refund di aplikasi agar kami bisa mengirim ulang. Dana kamu tetap aman.'],
      highlight: { tone: 'warning', text: 'Perlu tindakan: tambahkan rekening tujuan refund' },
      cta: 'Tambahkan rekening',
    }),
    (c) => ({
      title: 'Refund needs action',
      body: `The ${amount(c)} refund did not go through. Add a destination account in the app.`,
      subject: `Refund for ${num(c)} needs action`,
      heading: 'Refund did not go through',
      paragraphs: [`The ${amount(c)} refund for transaction ${num(c)} could not be sent to the original payment method.`, 'Add a refund destination account in the app so we can resend it. Your money remains safe.'],
      highlight: { tone: 'warning', text: 'Action needed: add a refund destination account' },
      cta: 'Add account',
    }),
  ),
  def(
    'refund.destination_required',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL', 'PUSH'], link: 'transaction' },
    (c) => ({
      title: 'Tambahkan rekening untuk refund',
      body: `Refund ${amount(c)} untuk ${num(c)} menunggu rekening bank tujuan.`,
      subject: `Perlu tindakan: rekening tujuan refund ${num(c)}`,
      heading: 'Refund kamu menunggu rekening tujuan',
      paragraphs: [
        `Pembayaran ${num(c)} memakai Virtual Account/gerai yang tidak bisa di-refund otomatis, jadi refund ${amount(c)} akan kami transfer ke rekening bank.`,
        'Buka aplikasi dan tambahkan rekening atas namamu sendiri (perlu kode verifikasi). Rekening dengan nama berbeda dari identitas terverifikasi akan dicek manual oleh tim kami.',
      ],
      details: c.v.refundNumber ? [['No. refund', s(c.v.refundNumber)]] : [],
      highlight: { tone: 'warning', text: 'Perlu tindakan: tambahkan rekening tujuan refund' },
      cta: 'Tambah rekening refund',
    }),
    (c) => ({
      title: 'Add an account for your refund',
      body: `The ${amount(c)} refund for ${num(c)} is waiting for a destination bank account.`,
      subject: `Action needed: refund account for ${num(c)}`,
      heading: 'Your refund is waiting for a bank account',
      paragraphs: [
        `${num(c)} was paid by virtual account / retail outlet, which cannot be refunded automatically, so we will transfer the ${amount(c)} refund to a bank account.`,
        'Open the app and add an account in your own name (a verification code is required). Accounts whose name differs from your verified identity are reviewed manually.',
      ],
      details: c.v.refundNumber ? [['Refund no.', s(c.v.refundNumber)]] : [],
      highlight: { tone: 'warning', text: 'Action needed: add a refund destination account' },
      cta: 'Add refund account',
    }),
  ),
  def(
    'refund.destination_updated',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL', 'PUSH'], link: 'transaction' },
    (c) => ({
      title: 'Rekening tujuan refund diatur',
      body: `Refund ${num(c)} akan dikirim ke ${s(c.v.bankCode)} ${s(c.v.accountMask)}.`,
      subject: `Rekening tujuan refund ${num(c)} diatur`,
      heading: 'Rekening tujuan refund diatur',
      paragraphs: [
        `Refund ${amount(c)} untuk transaksi ${num(c)} akan dikirim ke rekening ${s(c.v.bankCode)} ${s(c.v.accountMask)}.`,
        c.v.validationStatus === 'PENDING_REVIEW'
          ? 'Nama pemilik rekening berbeda dengan identitas terverifikasi, jadi tim kami memeriksanya dulu sebelum dana dikirim.'
          : 'Bukan kamu yang mengaturnya? Segera hubungi Pusat Bantuan dan keluar dari semua sesi di aplikasi.',
      ],
      highlight: { tone: 'warning', text: 'Bukan kamu? Hubungi Pusat Bantuan sekarang' },
      cta: 'Lihat refund',
    }),
    (c) => ({
      title: 'Refund account set',
      body: `The refund for ${num(c)} will be sent to ${s(c.v.bankCode)} ${s(c.v.accountMask)}.`,
      subject: `Refund account for ${num(c)} set`,
      heading: 'Refund account set',
      paragraphs: [
        `The ${amount(c)} refund for transaction ${num(c)} will be sent to ${s(c.v.bankCode)} ${s(c.v.accountMask)}.`,
        c.v.validationStatus === 'PENDING_REVIEW'
          ? 'The account holder name differs from your verified identity, so our team reviews it before the money is sent.'
          : 'Not you? Contact the Help Center right away and sign out of all sessions in the app.',
      ],
      highlight: { tone: 'warning', text: 'Not you? Contact the Help Center now' },
      cta: 'View refund',
    }),
  ),
  def(
    'payout.scheduled',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Pencairan dijadwalkan',
      body: `${amount(c)} untuk ${num(c)} dijadwalkan cair.`,
      subject: `Pencairan ${s(c.v.payoutNumber)} dijadwalkan`.trim(),
      heading: 'Pencairan dijadwalkan',
      paragraphs: [`Pendapatan kamu dari transaksi ${num(c)} sebesar ${amount(c)} sudah dijadwalkan untuk dicairkan ke rekening payout.`],
      details: c.v.payoutNumber ? [['No. payout', s(c.v.payoutNumber)]] : [],
      cta: 'Lihat pencairan',
    }),
    (c) => ({
      title: 'Payout scheduled',
      body: `${amount(c)} for ${num(c)} is scheduled for payout.`,
      subject: `Payout ${s(c.v.payoutNumber)} scheduled`.trim(),
      heading: 'Payout scheduled',
      paragraphs: [`Your earnings of ${amount(c)} from transaction ${num(c)} are scheduled for payout to your account.`],
      details: c.v.payoutNumber ? [['Payout no.', s(c.v.payoutNumber)]] : [],
      cta: 'View payout',
    }),
  ),
  def(
    'payout.paid',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Dana sudah dicairkan',
      body: `${amount(c)} sudah ditransfer ke rekening ${s(c.v.accountMask, 'payout')}.`,
      subject: `Pencairan ${num(c)} berhasil`,
      heading: 'Pencairan berhasil',
      paragraphs: [`${amount(c)} dari transaksi ${num(c)} sudah ditransfer ke rekening ${s(c.v.accountMask, 'payout-mu')}.`],
      details: c.v.payoutNumber ? [['No. payout', s(c.v.payoutNumber)]] : [],
      highlight: { tone: 'success', text: `${amount(c)} dicairkan` },
      cta: 'Lihat pencairan',
    }),
    (c) => ({
      title: 'Payout sent',
      body: `${amount(c)} was transferred to account ${s(c.v.accountMask, '')}.`,
      subject: `Payout for ${num(c)} sent`,
      heading: 'Payout sent',
      paragraphs: [`${amount(c)} from transaction ${num(c)} was transferred to your payout account ${s(c.v.accountMask, '')}.`],
      details: c.v.payoutNumber ? [['Payout no.', s(c.v.payoutNumber)]] : [],
      highlight: { tone: 'success', text: `${amount(c)} paid out` },
      cta: 'View payout',
    }),
  ),
  def(
    'payout.failed',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'account' },
    (c) => ({
      title: 'Pencairan gagal',
      body: `Pencairan ${amount(c)} gagal. Periksa rekening payout kamu.`,
      subject: `Pencairan ${num(c)} gagal`,
      heading: 'Pencairan gagal',
      paragraphs: [`Pencairan ${amount(c)} untuk transaksi ${num(c)} gagal diproses bank.`, 'Periksa data rekening payout. Setelah diperbaiki, kami akan mencoba lagi.'],
      highlight: { tone: 'warning', text: 'Periksa rekening payout kamu' },
      cta: 'Periksa rekening',
    }),
    (c) => ({
      title: 'Payout failed',
      body: `The ${amount(c)} payout failed. Please check your payout account.`,
      subject: `Payout for ${num(c)} failed`,
      heading: 'Payout failed',
      paragraphs: [`The ${amount(c)} payout for transaction ${num(c)} was rejected by the bank.`, 'Please check your payout account details. We will retry after it is fixed.'],
      highlight: { tone: 'warning', text: 'Check your payout account' },
      cta: 'Check account',
    }),
  ),
  def(
    'payout.on_hold',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, link: 'transaction' },
    (c) => ({
      title: 'Pencairan ditahan sementara',
      body: `Pencairan ${num(c)} sedang ditinjau. Kami akan mengabari kamu.`,
      subject: `Pencairan ${num(c)} ditahan sementara`,
      heading: 'Pencairan ditahan sementara',
      paragraphs: [`Pencairan ${amount(c)} untuk transaksi ${num(c)} ditahan sementara untuk peninjauan (misalnya dispute terbuka atau verifikasi tambahan).`, 'Dana tetap aman. Kami akan mengabari kamu setelah peninjauan selesai.'],
      cta: 'Lihat detail',
    }),
    (c) => ({
      title: 'Payout on hold',
      body: `The payout for ${num(c)} is under review. We will keep you posted.`,
      subject: `Payout for ${num(c)} on hold`,
      heading: 'Payout on hold',
      paragraphs: [`The ${amount(c)} payout for transaction ${num(c)} is on hold for review (for example an open dispute or extra verification).`, 'Your money is safe. We will notify you once the review is done.'],
      cta: 'View details',
    }),
  ),
  def(
    'receipt.final',
    { group: 'PAYMENT', category: 'PAYMENT', channels: ALL, critical: ['EMAIL'], link: 'receipt' },
    (c) => ({
      title: 'Struk final tersedia',
      body: `Struk final ${num(c)} siap dilihat dan diunduh.`,
      subject: `Struk final ${num(c)}`,
      heading: 'Struk final transaksi',
      paragraphs: [`Berikut rincian final transaksi "${prod(c)}". Struk lengkap (PDF) bisa diunduh dari aplikasi atau situs JastipKita.`],
      cta: 'Lihat struk final',
    }),
    (c) => ({
      title: 'Final receipt available',
      body: `The final receipt for ${num(c)} is ready.`,
      subject: `Final receipt ${num(c)}`,
      heading: 'Final transaction receipt',
      paragraphs: [`Here is the final breakdown for "${prod(c)}". Download the full receipt (PDF) from the JastipKita app or website.`],
      cta: 'View final receipt',
    }),
  ),
  // ============================================================ DISPUTES
  def(
    'dispute.opened',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, critical: ['EMAIL'], link: 'dispute' },
    (c) =>
      c.v.isOpener === true
        ? {
            title: 'Dispute diterima',
            body: `${dsp(c)} untuk ${num(c)} sedang diproses.`,
            subject: `Dispute ${dsp(c)} diterima`,
            heading: 'Dispute kamu sudah diterima',
            paragraphs: [
              `Dispute ${dsp(c)} (${label(DISPUTE_TYPE_LABEL, c.v.type, 'id')}) untuk transaksi ${num(c)} sudah kami terima. Dana di SafePay tetap ditahan selama proses.`,
              `Unggah bukti (foto, video, chat, resi) sebelum ${c.dt(c.v.evidenceDueAt)}. Kami menargetkan keputusan sebelum ${c.dt(c.v.reviewDueAt)}.`,
            ],
            cta: 'Lihat dispute',
          }
        : {
            title: 'Ada dispute pada transaksimu',
            body: `${dsp(c)}: ${label(DISPUTE_TYPE_LABEL, c.v.type, 'id')}. Kirim bukti sebelum ${c.dt(c.v.evidenceDueAt)}.`,
            subject: `Dispute ${dsp(c)} pada transaksi ${num(c)}`,
            heading: 'Ada dispute pada transaksimu',
            paragraphs: [
              `Pihak lain membuka dispute ${dsp(c)} (${label(DISPUTE_TYPE_LABEL, c.v.type, 'id')}) untuk transaksi ${num(c)}.`,
              `Sampaikan penjelasan dan bukti sebelum ${c.dt(c.v.evidenceDueAt)}. Tim JastipKita meninjau kedua sisi secara netral.`,
            ],
            highlight: { tone: 'warning', text: `Batas unggah bukti: ${c.dt(c.v.evidenceDueAt)}` },
            cta: 'Kirim bukti',
          },
    (c) =>
      c.v.isOpener === true
        ? {
            title: 'Dispute received',
            body: `${dsp(c)} for ${num(c)} is being processed.`,
            subject: `Dispute ${dsp(c)} received`,
            heading: 'We received your dispute',
            paragraphs: [
              `Dispute ${dsp(c)} (${label(DISPUTE_TYPE_LABEL, c.v.type, 'en')}) for transaction ${num(c)} was received. Funds stay held by SafePay during the process.`,
              `Upload evidence (photos, video, chat, tracking) before ${c.dt(c.v.evidenceDueAt)}. We aim to decide before ${c.dt(c.v.reviewDueAt)}.`,
            ],
            cta: 'View dispute',
          }
        : {
            title: 'A dispute was opened',
            body: `${dsp(c)}: ${label(DISPUTE_TYPE_LABEL, c.v.type, 'en')}. Send evidence before ${c.dt(c.v.evidenceDueAt)}.`,
            subject: `Dispute ${dsp(c)} on transaction ${num(c)}`,
            heading: 'A dispute was opened on your transaction',
            paragraphs: [
              `The other party opened dispute ${dsp(c)} (${label(DISPUTE_TYPE_LABEL, c.v.type, 'en')}) for transaction ${num(c)}.`,
              `Share your explanation and evidence before ${c.dt(c.v.evidenceDueAt)}. The JastipKita team reviews both sides neutrally.`,
            ],
            highlight: { tone: 'warning', text: `Evidence deadline: ${c.dt(c.v.evidenceDueAt)}` },
            cta: 'Send evidence',
          },
  ),
  def(
    'dispute.updated',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, critical: ['EMAIL'], link: 'dispute' },
    (c) => ({
      title: 'Status dispute diperbarui',
      body: `${dsp(c)}: ${label(DISPUTE_STATUS_LABEL, c.v.status, 'id')}.`,
      subject: `Update dispute ${dsp(c)}`,
      heading: 'Status dispute diperbarui',
      paragraphs: [`Dispute ${dsp(c)} untuk transaksi ${num(c)} sekarang berstatus: ${label(DISPUTE_STATUS_LABEL, c.v.status, 'id')}.`],
      cta: 'Lihat dispute',
    }),
    (c) => ({
      title: 'Dispute status updated',
      body: `${dsp(c)}: ${label(DISPUTE_STATUS_LABEL, c.v.status, 'en')}.`,
      subject: `Dispute ${dsp(c)} update`,
      heading: 'Dispute status updated',
      paragraphs: [`Dispute ${dsp(c)} for transaction ${num(c)} is now: ${label(DISPUTE_STATUS_LABEL, c.v.status, 'en')}.`],
      cta: 'View dispute',
    }),
  ),
  def(
    'dispute.resolved',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, critical: ['EMAIL'], link: 'dispute' },
    (c) => {
      const res = label(DISPUTE_RESOLUTION_LABEL, c.v.resolution, 'id');
      const amt = Number(c.v.resolutionAmountIdr ?? 0) > 0 ? ` — ${c.idr(c.v.resolutionAmountIdr)}` : '';
      return {
        title: 'Dispute diputuskan',
        body: `${dsp(c)}: ${res}${amt}.`,
        subject: `Keputusan dispute ${dsp(c)}`,
        heading: 'Dispute sudah diputuskan',
        paragraphs: [
          `Keputusan untuk dispute ${dsp(c)} (transaksi ${num(c)}): ${res}${amt}.`,
          ...(c.v.appealDeadline ? [`Tidak setuju? Kamu bisa mengajukan banding satu kali sebelum ${c.dt(c.v.appealDeadline)}.`] : []),
        ],
        cta: 'Lihat keputusan',
      };
    },
    (c) => {
      const res = label(DISPUTE_RESOLUTION_LABEL, c.v.resolution, 'en');
      const amt = Number(c.v.resolutionAmountIdr ?? 0) > 0 ? ` — ${c.idr(c.v.resolutionAmountIdr)}` : '';
      return {
        title: 'Dispute resolved',
        body: `${dsp(c)}: ${res}${amt}.`,
        subject: `Decision on dispute ${dsp(c)}`,
        heading: 'Your dispute was resolved',
        paragraphs: [
          `Decision for dispute ${dsp(c)} (transaction ${num(c)}): ${res}${amt}.`,
          ...(c.v.appealDeadline ? [`Disagree? You can appeal once before ${c.dt(c.v.appealDeadline)}.`] : []),
        ],
        cta: 'View decision',
      };
    },
  ),
  def(
    'dispute.appealed',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: ALL, critical: ['EMAIL'], link: 'dispute' },
    (c) => ({
      title: 'Banding diajukan',
      body: `${dsp(c)} akan ditinjau ulang.`,
      subject: `Banding dispute ${dsp(c)}`,
      heading: 'Banding diajukan',
      paragraphs: [`Banding untuk dispute ${dsp(c)} (transaksi ${num(c)}) sudah diajukan. Tim kami akan meninjau ulang keputusan.`],
      cta: 'Lihat dispute',
    }),
    (c) => ({
      title: 'Appeal submitted',
      body: `${dsp(c)} will be reviewed again.`,
      subject: `Appeal on dispute ${dsp(c)}`,
      heading: 'Appeal submitted',
      paragraphs: [`An appeal was submitted for dispute ${dsp(c)} (transaction ${num(c)}). Our team will review the decision again.`],
      cta: 'View dispute',
    }),
  ),
  def(
    'dispute.evidence_added',
    { group: 'TRANSACTION', category: 'TRANSACTION', channels: APP, link: 'dispute', breakdown: 'NONE' },
    (c) => short('Bukti baru pada dispute', `${dsp(c)}: pihak lain menambahkan bukti.`, 'Lihat bukti'),
    (c) => short('New dispute evidence', `${dsp(c)}: the other party added evidence.`, 'View evidence'),
  ),
  // ============================================================ CHAT
  def(
    'chat.message',
    { group: 'CHAT', category: 'CHAT', channels: APP, link: 'conversation', breakdown: 'NONE' },
    (c) => short(s(c.v.senderName, 'Pesan baru'), s(c.v.preview, 'Pesan baru'), 'Balas'),
    (c) => short(s(c.v.senderName, 'New message'), s(c.v.preview, 'New message'), 'Reply'),
  ),
];

export const TEMPLATE_BY_KEY: ReadonlyMap<string, TemplateDef> = new Map(TEMPLATES.map((t) => [t.key, t]));

export function getTemplate(key: string): TemplateDef {
  const t = TEMPLATE_BY_KEY.get(key);
  if (!t) throw new Error(`unknown notification template ${key}`);
  return t;
}
