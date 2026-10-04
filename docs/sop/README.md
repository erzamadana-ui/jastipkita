# SOP Operasional — Indeks

> **TEMPLATE UNTUK REVIEW PROFESIONAL.** SOP disusun dari perilaku kode per 2026-10-04 (endpoint admin, config berversi,
> job). Jam layanan, target penyelesaian, dan struktur tim berstatus ASUMSI sampai diputuskan Owner. Runbook teknis
> (langkah sistem saat insiden) tetap di `docs/runbooks/`; SOP di sini mengatur pekerjaan harian dan komunikasi.

| SOP | Untuk | Isi utama |
|---|---|---|
| [customer-service.md](customer-service.md) | SUPPORT, OPERATIONS | kanal & jam, kategori/prioritas (termasuk `COMPLAINT`), SLA `support.sla`, alur tiket, hak data pribadi, 11 makro, penanganan pengaduan & eskalasi ke Ditjen PKTN/BPSK, KPI |
| [dispute-resolution.md](dispute-resolution.md) | OPERATIONS, FINANCE, RISK | FSM sengketa, jendela `dispute.sla` (+ temuan jendela efektif 48 jam), prosedur 12 langkah, resolusi → akibat dana, maker-checker & 4-mata, banding, 7 templat |
| [refund-payout-operations.md](refund-payout-operations.md) | FINANCE, FINANCE_SUPER_ADMIN | jadwal harian, approval refund, review rekening tujuan refund, layar rekonsiliasi (apa yang dibandingkan & tidak), payout & jeda rekening baru 24 jam, checklist tutup buku bulanan |
| [incident-communication.md](incident-communication.md) | IC, DPO, Legal, CS | matriks pemberitahuan (UU PDP Pasal 46, PP 71/2019 Pasal 14 & 24), lini waktu 3×24 jam, templat pembayaran/kebocoran data/gangguan, tenggat otomatis saat gangguan |

Terkait: `docs/runbooks/` (teknis), [`../privacy/README.md`](../privacy/README.md) (RoPA, DPIA, DPA),
`docs/checklists/launch-checklist.md` (B1, B2, B3, L10–L12, T10).

---

**Catatan keterbatasan data:** belum ada data operasional nyata (pra-peluncuran); fitur yang ditambahkan engineer lain pada
2026-10-04 (kategori `COMPLAINT`, jeda rekening payout baru, checkpoint audit) dibaca dari kode tanpa menjalankan tesnya;
semua SOP wajib diuji dalam simulasi (tabletop) sebelum launch.
