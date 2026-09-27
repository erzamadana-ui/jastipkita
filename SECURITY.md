# Security Policy / Kebijakan Keamanan

## Melaporkan kerentanan / Reporting a vulnerability
**Jangan** membuka issue publik atau menguji dengan data/dana pengguna sungguhan.
Please do **not** open a public issue and do not test against real users' data or money.

- Kirim laporan ke pemilik repositori melalui **GitHub Private Vulnerability Reporting** (tab *Security → Report a
  vulnerability*) bila tersedia, atau e-mail keamanan resmi yang akan dicantumkan di
  `https://antarkitaindonesia.com/jastipkita/` sebelum peluncuran publik.
- Sertakan: deskripsi, langkah reproduksi, dampak, endpoint/versi, dan bukti konsep minimal.

Target respons (ASUMSI sampai tim keamanan terbentuk): konfirmasi ≤ 3 hari kerja, penilaian awal ≤ 7 hari kerja, perbaikan
kritis secepatnya dengan koordinasi publikasi. Kami tidak menuntut peneliti yang beritikad baik, mengikuti kebijakan ini,
tidak mengakses data orang lain lebih dari yang diperlukan untuk pembuktian, dan tidak mengganggu layanan.

## Ruang lingkup / Scope
Dalam lingkup: API `/v1` (staging & production), aplikasi mobile JastipKita, admin SPA, situs `antarkitaindonesia.com/jastipkita/`.
Di luar lingkup: layanan pihak ketiga (Xendit, Cloudflare, Neon, Google, Apple), serangan DoS volumetrik, social engineering
terhadap staf, temuan tanpa dampak keamanan (mis. header informatif).

## Versi yang didukung
Hanya deployment terbaru dari branch `main` (staging) dan rilis production terbaru.

Detail kontrol keamanan: `docs/09-security.md`. Prosedur insiden internal: `docs/runbooks/security-incident.md`.
