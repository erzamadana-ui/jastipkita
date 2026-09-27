# Runbook — Insiden Pembayaran (SafePay / Xendit)

> Berlaku untuk staging (Xendit TEST) dan production. **Prinsip:** jangan pernah "memperbaiki" saldo dengan UPDATE
> manual — ledger append-only; koreksi hanya lewat fungsi/endpoint yang menulis jurnal & audit. Setiap langkah admin
> tercatat di `audit_logs`. Referensi: `docs/04-payments-ledger.md`, `docs/api/money.md`.

## 0. Triage (≤ 15 menit)
| Pertanyaan | Cara cek |
|---|---|
| Mode apa? | `GET /v1/health` → `integrations.payments` = MOCK / SANDBOX / LIVE |
| Seberapa luas? | Admin → Transaksi (filter `AWAITING_PAYMENT` terlama), `payment_webhook_events` belum diproses, alert log `ALERT reconciliation.mismatch` / `payment.amount_mismatch` |
| Uang pengguna berisiko? | ada pembayaran SECURED tanpa transisi, refund FAILED berulang, payout ke rekening tak dikenal → **P1** |
| Status Xendit | status.xendit.co, dashboard Xendit (mode test/live sesuai env) |

Prioritas: **P1** = dana pengguna salah catat/salah kirim atau LIVE terganggu > 30 menit; **P2** = tertunda tapi tercatat
benar; **P3** = hanya staging. P1 → beri tahu owner + Finance segera; update ke pengguna terdampak ≤ 2 jam.

## 1. Webhook gagal / tidak masuk
Gejala: pembeli sudah bayar, transaksi tetap `AWAITING_PAYMENT`.
1. Cek log Worker (Cloudflare → Workers → `jastipkita-api-*` → Logs) untuk `POST /v1/webhooks/payments/xendit`:
   - `401` → token salah: bandingkan `XENDIT_WEBHOOK_TOKEN` (GitHub secret) dengan *verification token* di dashboard Xendit
     (mode yang sama!). Perbaiki secret → *Deploy* dengan `force_secrets=true`. Request 401 **tidak disimpan** (by design).
   - `5xx` → error pemrosesan; Xendit mengulang otomatis 6× (15 m, 45 m, 2 j, 3 j, 6 j, 12 j). Perbaiki penyebab (DB, kuota Neon, CPU).
   - tidak ada request sama sekali → URL webhook di dashboard Xendit salah / tidak dipasang untuk event itu.
2. Pemulihan: job `money.reconcile_pending_payments` (tiap 10 menit) menanyakan status ke Xendit untuk pembayaran
   PENDING > 15 menit dan mengamankannya bila sudah dibayar — biasanya pulih sendiri. Untuk mempercepat: *Resend* webhook
   dari dashboard Xendit (idempoten; duplikat → `200 DUPLICATE`).
3. Verifikasi: payment `SECURED`, jurnal `PAYMENT_CAPTURED` ada, transaksi `PAYMENT_SECURED`.

## 2. Nominal / mata uang tidak cocok (`payment.amount_mismatch`)
Sistem **tidak** mengamankan dana: risk assessment HOLD + review risiko terbuka + flag hold payout.
1. Bandingkan `payments.amount_idr` dengan transaksi di dashboard Xendit (reference `JK-…`).
2. Kemungkinan: pembeli membayar VA dengan nominal berbeda (VA fixed seharusnya menolak), manipulasi, bug quote.
3. Keputusan (Finance + Risk, maker-checker): batalkan transaksi → refund penuh dari jalur admin; atau bila sah dan bisa
   dijelaskan, selesaikan via review risiko (Admin → Risk reviews → resolve) — jangan pernah menaikkan angka secara manual.
4. Bila indikasi fraud → `docs/runbooks/security-incident.md`.

## 3. Transaksi macet di `AWAITING_PAYMENT`
- Invoice/sesi kedaluwarsa (default 30 menit) → job `money.expire_payments` mengembalikan transaksi ke `MATCHED` (re-quote).
  Di Workers cron berjalan tiap 5 menit → keterlambatan ≤ 5 menit adalah normal.
- Pembayaran terlambat masuk setelah kedaluwarsa → otomatis `LATE_PAYMENT_CAPTURED` + refund penuh (`LATE_PAYMENT`) —
  pastikan refund berjalan (§4). Jelaskan ke pembeli bahwa dana dikembalikan.
- Macet > 1 jam tanpa sebab: cek antrean job (`jobs` status QUEUED terlama), cron aktif (Worker → Triggers), kuota Neon.

## 4. Refund gagal
1. Admin → Refunds: status `FAILED`, `attempts`, pesan error provider.
2. Penyebab umum & tindakan:
   | Error provider | Arti | Tindakan |
   |---|---|---|
   | `REFUND_NOT_SUPPORTED` / kanal VA, retail | kanal tidak mendukung refund | sistem beralih ke **payout ke rekening pembeli**; minta pembeli mengisi rekening (`refund.destination_required`) |
   | `INSUFFICIENT_BALANCE` | saldo Xendit kurang | **P1** — dana keluar lebih cepat dari seharusnya; Finance top-up/rekonsiliasi; hentikan payout sementara |
   | `REFUND_AMOUNT_EXCEEDED`, `PARTIAL_REFUND_NOT_SUPPORTED` | nominal/kanal | pecah ulang via admin; eskalasi ke Tim API |
   | `BANK_ACCOUNT_VALIDATION_UNAVAILABLE` | validasi nama rekening belum aktif (Iluma) | tidak bisa refund via payout secara otomatis → keputusan Finance (lihat launch checklist T10) |
3. Sistem mencoba ulang maks. 3× (SYSTEM); setelah itu admin: `POST /v1/admin/refunds/{id}/…` (retry/approve sesuai status,
   maker-checker ≠ peminta). Jangan membuat refund kedua untuk dana yang sama — trigger DB menolak total refund > pembayaran.
4. SLA komunikasi: pembeli diberi tahu status refund ≤ 1×24 jam.

## 5. Payout traveler gagal / ditahan
- `ON_HOLD` karena risiko/sengketa/amount mismatch → selesaikan penyebab dulu; release oleh admin berbeda dari yang menahan
  (`/v1/admin/payouts/{id}/release`, maker-checker).
- `FAILED` (rekening tidak valid, bank error) → minta traveler memperbarui rekening (verifikasi nama wajib), `retry`.

## 6. Rekonsiliasi harian berbeda (`COMPLETED_WITH_DIFFS`)
1. Admin/DB: `reconciliation_items` status mismatch untuk run terakhir.
2. Kategori: pembayaran SECURED tanpa jurnal capture (bug → Tim API, P1), nominal berbeda (→ §2), transaksi Xendit tanpa
   pasangan internal (pembayaran yatim → cari reference, refund bila tak bertuan).
3. Tutup setiap item dengan catatan; ulang rekonsiliasi keesokan hari harus 0 selisih.

## 7. Mengganti Xendit TEST ↔ LIVE (hanya production, butuh persetujuan)
**TEST → LIVE** (go-live):
1. Semua gerbang P0 `docs/checklists/launch-checklist.md` = SELESAI; kontrak & konfirmasi tertulis Xendit (L4) ada.
2. Owner mencatat keputusan: dokumen keputusan bernomor → variabel production `LIVE_PAYMENTS_DECISION_REF`, dan
   `ALLOW_LIVE_PAYMENTS=true`.
3. Secret production: `XENDIT_SECRET_KEY` = `xnd_production_…` (kunci baru, izin minimal), `XENDIT_WEBHOOK_TOKEN` (token live).
   Pasang URL webhook di dashboard Xendit **mode live**.
4. *Actions → Deploy production*: centang `allow_live_payments`, isi `decision_ref` sama persis, ketik `DEPLOY PRODUCTION`.
   Workflow menolak bila tidak konsisten; smoke test harus melihat `payments: "LIVE"`.
5. Uji transaksi nyata bernilai kecil oleh staf (bayar → refund) sebelum dibuka ke pengguna; pantau rekonsiliasi hari pertama.

**LIVE → TEST** (darurat, mis. insiden provider): set `ALLOW_LIVE_PAYMENTS=false`, secret Xendit kembali ke kunci test,
deploy production dengan input tidak dicentang. Checkout baru akan SANDBOX; pembayaran LIVE yang sudah SECURED tetap
diproses/di-refund secara manual oleh Finance melalui dashboard live + pencatatan admin. Umumkan gangguan checkout.

## 8. Setelah insiden
Post-mortem ≤ 5 hari kerja (kronologi, dampak Rp & jumlah pengguna, akar masalah, tindakan). Catat di Admin →
System alerts / tiket ops. Bila ada data pribadi terdampak → `docs/10-privacy.md` §8 (3×24 jam).

---

**Catatan keterbatasan data:** jadwal retry webhook, kode error dan perilaku refund per kanal berasal dari dokumentasi
publik Xendit (research 02, 2026-09-27) dan belum diuji dengan akun Xendit sungguhan; endpoint admin mengikuti modul admin
yang sedang dibangun dan dapat berubah nama.
