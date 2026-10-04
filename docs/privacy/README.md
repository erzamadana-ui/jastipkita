# Kepatuhan Privasi (UU PDP) — Indeks

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat hukum.** Dokumen di folder ini disusun dari kode & konfigurasi repo
> per 2026-10-04 dan wajib disahkan DPO + konsultan hukum sebelum data pribadi nyata diproses. Ringkasan kebijakan &
> kontrol teknis ada di `docs/10-privacy.md`; riset regulasi di `docs/research/05-legal-regulatory.md`.

| Dokumen | Isi | Status |
|---|---|---|
| [ropa.md](ropa.md) | Catatan Aktivitas Pemrosesan (RoPA): 21 aktivitas, 14 prosesor/pihak ketiga + 2 penerima lain, retensi kebijakan vs eksekusi job, transfer lintas negara, gap G-01…G-09 | DRAF 0.1 |
| [dpia-kyc-payout.md](dpia-kyc-payout.md) | DPIA KYC (dokumen identitas, selfie/liveness) & rekening payout/refund: alur data dari kode, kebutuhan & proporsionalitas, 15 risiko K×D, kontrol yang sudah ada, tindakan A-01…A-10, blok persetujuan DPO | DRAF 0.1 — belum disetujui |
| [dpa-template.md](dpa-template.md) | Template perjanjian pemrosesan data (Indonesia + annex Inggris): instruksi, sub-prosesor, transfer lintas negara, notifikasi insiden ≤ 24 jam ke pengendali agar 3×24 jam terpenuhi, daftar periksa untuk DPA standar vendor | TEMPLATE |

Urutan kerja yang disarankan (usulan): tunjuk DPO → sahkan RoPA → setujui DPIA (syarat A-01…A-08) → tanda tangani DPA
prosesor → baru buka KYC nyata (`docs/10-privacy.md` §9, launch checklist L10–L11).

SOP operasional yang memakai dokumen ini: [`../sop/README.md`](../sop/README.md).

---

**Catatan keterbatasan data:** semua durasi retensi dan lokasi prosesor berstatus ASUMSI; ketentuan PP 33/2026 dikutip
dari sumber sekunder; DPO dan badan hukum pengendali belum ada; integrasi pihak ketiga masih MOCK/SANDBOX.
