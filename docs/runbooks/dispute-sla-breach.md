# Runbook — Pelanggaran SLA Sengketa (Dispute)

> SLA dari config `dispute.sla` (default: jendela buka 72 jam setelah DELIVERED, bukti 72 jam, review 120 jam,
> banding 72 jam — nilai operasional **ASUMSI** sampai ditinjau setelah soft launch). Referensi: `docs/00-domain-model.md`
> §6 & §15.3, `docs/api/engagement.md` §5.

## 1. Cara pelanggaran terdeteksi
- Job `engagement.dispute_sla` (tiap 5 menit; di Workers efektif ≤ 5 menit) menandai sengketa yang lewat `sla_due_at`:
  `disputes.sla_breach`, `sla_breached_at`, event `dispute.sla_breached` (sekali per sengketa).
- Dashboard admin: Admin → Disputes (filter breach) dan `GET /v1/admin/support/sla`.
- Selama sengketa terbuka, **payout traveler ditahan** (guard `PAYOUT_CLEAR`) — keterlambatan merugikan kedua pihak.

## 2. Respons (target: tindakan dalam 4 jam kerja setelah breach)
| Langkah | Siapa | Detail |
|---|---|---|
| 1. Ambil alih | Ops lead | `POST /v1/admin/disputes/{id}/assign` ke agen yang tersedia; catat alasan keterlambatan |
| 2. Hubungi para pihak | Agen | notifikasi in-app + chat: minta maaf, sebut perkiraan keputusan (≤ 24 jam) |
| 3. Lengkapi bukti | Agen | bila perlu `request-evidence` (kembali ke EVIDENCE_COLLECTION); tetapkan tenggat baru yang jelas |
| 4. Putuskan | Agen + approver | `review` → `resolve` dengan tipe (`REFUND_FULL`, `REFUND_PARTIAL`, `NO_REFUND`, `RETURN_AND_REFUND`, `OTHER`) dan nominal; refund di atas ambang auto-approve butuh maker-checker |
| 5. Eksekusi & tutup | Sistem/Finance | refund/payout berjalan otomatis; RESOLVED → CLOSED setelah jendela banding |

## 3. Eskalasi
- > 24 jam setelah breach tanpa keputusan → Owner/Ops manager.
- Nilai transaksi > Rp10 juta (ambang auto-approve refund, ASUMSI) atau indikasi penipuan/barang palsu → Risk review wajib.
- Pola breach (≥ 3 per minggu) → evaluasi kapasitas agen atau ubah config `dispute.sla` (versi baru, maker-checker) — jangan
  memperpanjang SLA diam-diam per kasus.

## 4. Kasus khusus
- Pembeli menarik sengketa pada barang `DELIVERED` → transaksi lanjut ke `BUYER_CONFIRMED` otomatis. Penarikan lain membuat
  transaksi tetap `DISPUTED` dengan `transactionFollowUp: ADMIN_REQUIRED` (celah spesifikasi — tidak ada transisi
  `DISPUTED → status sebelumnya`) → agen harus menuntaskan manual (cancel/refund atau konfirmasi) melalui endpoint admin transaksi.
- Banding: hanya sekali, dalam 72 jam; SLA review dimulai ulang.

## 5. Metrik
Laporan mingguan: jumlah sengketa, % breach, median waktu ke keputusan, % keputusan dibanding, nilai refund dari
sengketa. Target awal (ASUMSI): breach < 5 %, median keputusan < 72 jam.

---

**Catatan keterbatasan data:** durasi SLA, ambang refund dan target metrik adalah **ASUMSI** operasional awal; nama
endpoint admin mengikuti modul admin yang sedang dibangun; belum ada data sengketa nyata.
