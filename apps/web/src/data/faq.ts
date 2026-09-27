/**
 * Static help-center content (Bahasa Indonesia) rendered at build time for SEO and as the offline fallback.
 * The first 7 articles mirror db/seeds/0001_reference.sql (same slugs) so API and static pages agree;
 * the API (GET /v1/support/faq) remains the source of truth when it is reachable.
 * Numbers come from packages/core/src/config/business-config.defaults.json — keep them in sync.
 */
export type FaqCategory = 'GENERAL' | 'BUYER' | 'TRAVELER' | 'PAYMENT' | 'CUSTOMS' | 'DELIVERY' | 'DISPUTE' | 'ACCOUNT' | 'REFERRAL';

export interface FaqArticle {
  slug: string;
  category: FaqCategory;
  question: string;
  /** Paragraphs separated by blank lines; **bold** supported. */
  answer: string;
  tags: string[];
}

export const FAQ_CATEGORIES: Record<FaqCategory, { id: string; en: string; icon: string }> = {
  GENERAL: { id: 'Umum', en: 'General', icon: 'circle-help' },
  BUYER: { id: 'Penitip', en: 'Buyers', icon: 'shopping-bag' },
  TRAVELER: { id: 'Traveler', en: 'Travelers', icon: 'plane' },
  PAYMENT: { id: 'Pembayaran & SafePay', en: 'Payments & SafePay', icon: 'shield-check' },
  CUSTOMS: { id: 'Bea cukai & pajak', en: 'Customs & tax', icon: 'landmark' },
  DELIVERY: { id: 'Serah terima', en: 'Delivery', icon: 'package' },
  DISPUTE: { id: 'Dispute & refund', en: 'Disputes & refunds', icon: 'scale' },
  ACCOUNT: { id: 'Akun & privasi', en: 'Account & privacy', icon: 'user-check' },
  REFERRAL: { id: 'Referral & credit', en: 'Referral & credit', icon: 'gift' },
};

export const FAQ: FaqArticle[] = [
  // ---- mirrored from db/seeds/0001_reference.sql ----
  {
    slug: 'apa-itu-jastipkita',
    category: 'GENERAL',
    question: 'Apa itu JastipKita?',
    answer:
      'JastipKita mempertemukan **Penitip** yang ingin membeli barang dari luar negeri dengan **Traveler** yang sedang bepergian. Penitip membuat request, Traveler mengajukan penawaran, dan seluruh pembayaran berjalan melalui SafePay. Rincian harga (harga barang, fee traveler, estimasi bea masuk & pajak, biaya layanan) selalu ditampilkan sebelum membayar.',
    tags: ['umum', 'cara kerja'],
  },
  {
    slug: 'apa-itu-safepay',
    category: 'PAYMENT',
    question: 'Apa itu SafePay dan kapan dana diteruskan ke Traveler?',
    answer:
      'SafePay adalah alur pembayaran JastipKita. Dana Penitip diterima melalui mitra payment gateway dan dicatat terpisah untuk setiap transaksi. Dana **tidak** diteruskan ke Traveler sebelum barang diterima dan dikonfirmasi Penitip, atau dikonfirmasi otomatis 48 jam setelah status *Terkirim* bila tidak ada dispute.\n\nJastipKita bukan bank dan bukan dompet digital. Dana diproses dan ditahan oleh mitra payment gateway berizin Bank Indonesia; saat ini integrasi pembayaran masih tahap uji (sandbox).',
    tags: ['safepay', 'pembayaran', 'dana'],
  },
  {
    slug: 'kapan-traveler-boleh-membeli',
    category: 'TRAVELER',
    question: 'Kapan Traveler boleh membeli barang titipan?',
    answer:
      'Hanya setelah status transaksi **Pembelian Disetujui** (PURCHASE_APPROVED), yang mensyaratkan pembayaran Penitip sudah diamankan SafePay. Sebelum status itu aplikasi Traveler menampilkan banner merah **DO NOT PURCHASE**. Pembelian sebelum waktunya menjadi risiko Traveler sendiri.',
    tags: ['traveler', 'pembelian', 'do not purchase'],
  },
  {
    slug: 'estimasi-bea-masuk',
    category: 'CUSTOMS',
    question: 'Bagaimana bea masuk dan pajak impor dihitung?',
    answer:
      'Bea masuk dan pajak impor pada rincian harga adalah **estimasi** berdasarkan aturan kepabeanan yang berlaku saat penawaran dibuat; versi aturan yang dipakai dicatat pada setiap penawaran harga. Jumlah final ditetapkan petugas Bea dan Cukai. Bila Traveler membayar bea masuk, bukti pembayaran resmi wajib diunggah. Selisih antara estimasi dan tagihan resmi diproses sesuai Syarat & Ketentuan.\n\nUntuk barang titipan (bukan barang pribadi traveler), PMK 34/2025 mengenakan bea masuk 10% dari nilai penuh, PPN 12% × DPP 11/12, dan PPh 22 5% dari nilai impor — sekitar 27,6% dari nilai barang. Coba hitung di **Kalkulator bea & pajak**.',
    tags: ['bea cukai', 'pajak', 'estimasi'],
  },
  {
    slug: 'harga-barang-berubah',
    category: 'BUYER',
    question: 'Bagaimana jika harga barang di toko berbeda?',
    answer:
      'Jika harga aktual berbeda lebih dari toleransi (2% atau maksimal Rp50.000), Traveler mengirim konfirmasi harga beserta foto struk/label. Penitip punya waktu 15 menit untuk menyetujui, menolak, atau meminta klarifikasi. Menolak kenaikan harga tidak dianggap kesalahan Penitip: transaksi dibatalkan dan dana dikembalikan penuh, termasuk biaya pembayaran, tanpa penalti Trust Score. Jika tidak ada respons sampai batas waktu, konfirmasi dianggap ditolak.',
    tags: ['harga', 'konfirmasi harga'],
  },
  {
    slug: 'cara-membuka-dispute',
    category: 'DISPUTE',
    question: 'Bagaimana cara membuka dispute?',
    answer:
      'Dispute dapat dibuka dari halaman transaksi paling lambat 72 jam setelah barang berstatus terkirim. Kedua pihak mengunggah bukti dalam 72 jam; tim JastipKita menargetkan keputusan dalam 120 jam setelah bukti lengkap. Keputusan dapat diajukan banding satu kali dalam 72 jam.',
    tags: ['dispute', 'komplain', 'refund'],
  },
  {
    slug: 'jastipkita-credit',
    category: 'REFERRAL',
    question: 'Apa itu JastipKita Credit?',
    answer:
      'JastipKita Credit adalah saldo potongan yang didapat dari program referral atau promo. Credit berlaku 90 hari, hanya dapat dipakai sebagai potongan saat checkout, dan tidak dapat dicairkan menjadi uang.',
    tags: ['credit', 'referral'],
  },
  // ---- additional web articles ----
  {
    slug: 'cara-menitip-barang',
    category: 'BUYER',
    question: 'Bagaimana cara menitip barang dari luar negeri?',
    answer:
      '1) Tempel link produk, unggah foto, atau isi detail barang secara manual. 2) Sistem memeriksa barang terlarang dan menampilkan estimasi landed cost. 3) Pilih traveler yang rutenya cocok, atau tunggu penawaran. 4) Setelah match, bayar lewat SafePay — dana ditahan sampai barang kamu terima. 5) Traveler membeli setelah status PURCHASE APPROVED, mengunggah struk, lalu membawa barang pulang. 6) Serah terima dengan PIN/QR atau kurir, lalu konfirmasi penerimaan.',
    tags: ['penitip', 'cara kerja', 'titip'],
  },
  {
    slug: 'rincian-biaya-11-baris',
    category: 'PAYMENT',
    question: 'Biaya apa saja yang saya bayar?',
    answer:
      'Semua biaya tampil di rincian 11 baris sebelum kamu membayar: Harga Barang, Traveler Fee, Bea Masuk (estimasi), Pajak Impor (estimasi), JastipKita Protection (1,5%), Platform Fee (5%), PPN atas layanan (12% × 11/12 dari fee layanan), Biaya Pembayaran (tergantung metode), Diskon promo, JastipKita Credit, dan Total Landed Cost. Tidak ada biaya yang tidak tampil di rincian.',
    tags: ['biaya', 'harga', 'fee', 'breakdown'],
  },
  {
    slug: 'kurs-dikunci',
    category: 'PAYMENT',
    question: 'Kurs apa yang dipakai dan berapa lama dikunci?',
    answer:
      'Harga barang dalam mata uang asing dikonversi ke rupiah dengan kurs yang dikunci selama 30 menit saat checkout. Kurs ini sudah termasuk markup kurs (umumnya 1,5%; KRW 2%) yang ditampilkan di rincian. Bila waktu kunci habis sebelum kamu membayar, kurs diperbarui dan rincian dihitung ulang.\n\nKurs untuk bea masuk berbeda: Bea Cukai memakai kurs pajak (KMK) pada minggu kedatangan traveler, sehingga estimasi bea & pajak dapat sedikit berbeda dari tagihan final.',
    tags: ['kurs', 'fx', 'nilai tukar'],
  },
  {
    slug: 'metode-pembayaran',
    category: 'PAYMENT',
    question: 'Metode pembayaran apa yang tersedia?',
    answer:
      'Rencana metode: Virtual Account bank, QRIS, e-wallet, dan kartu kredit/debit, diproses oleh mitra payment gateway berizin Bank Indonesia. Biaya tiap metode ditampilkan sebagai baris Biaya Pembayaran sebelum membayar. Saat ini pembayaran masih tahap uji (sandbox) dan belum menerima uang sungguhan.',
    tags: ['pembayaran', 'va', 'qris', 'kartu'],
  },
  {
    slug: 'barang-yang-tidak-boleh-dititip',
    category: 'CUSTOMS',
    question: 'Barang apa saja yang tidak boleh dititipkan?',
    answer:
      'Barang **terlarang** (mis. narkotika & produk CBD, senjata, minuman beralkohol, rokok & vape, uang tunai, hewan hidup, pakaian bekas, barang palsu) diblokir di checkout. Barang **terbatas** (mis. obat, suplemen, kosmetik, pangan, ponsel, power bank) boleh dengan batas jumlah dan wajib kamu setujui peringatannya sebelum membayar. Cek barangmu di **Cek barang terlarang**.',
    tags: ['barang terlarang', 'lartas', 'restricted'],
  },
  {
    slug: 'jastip-bukan-barang-pribadi',
    category: 'CUSTOMS',
    question: 'Kenapa barang titipan tidak dapat pembebasan USD 500?',
    answer:
      'Pembebasan FOB USD 500 per orang per kedatangan hanya untuk **barang pribadi** penumpang. Barang yang dibeli untuk orang lain (jastip) diperlakukan sebagai barang bukan pribadi, sehingga bea masuk dan pajak dihitung dari nilai penuh dan tetap tunduk pada aturan larangan/pembatasan. JastipKita tidak pernah menyarankan traveler menyamarkan titipan sebagai barang pribadi atau memecah barang untuk menghindari bea.',
    tags: ['usd 500', 'barang pribadi', 'bea cukai'],
  },
  {
    slug: 'cara-jadi-traveler',
    category: 'TRAVELER',
    question: 'Bagaimana cara menjadi traveler JastipKita?',
    answer:
      'Daftar di aplikasi, verifikasi nomor HP, lalu verifikasi identitas (KTP/paspor + selfie & liveness) untuk mencapai level **Identitas terverifikasi**. Tambahkan rekening payout dan unggah dokumen perjalanan (tiket/boarding pass) supaya trip kamu bisa diverifikasi dan tampil di pencarian. Trip tanpa dokumen perjalanan tidak dapat diaktifkan.',
    tags: ['traveler', 'kyc', 'daftar'],
  },
  {
    slug: 'kapan-traveler-dibayar',
    category: 'TRAVELER',
    question: 'Kapan traveler menerima pembayaran?',
    answer:
      'Traveler fee dan penggantian harga barang dijadwalkan untuk dibayarkan setelah penitip mengonfirmasi barang diterima (atau konfirmasi otomatis 48 jam setelah terkirim tanpa dispute) dan tidak ada dispute terbuka. Pembayaran dikirim ke rekening payout yang sudah terverifikasi. Pajak atas penghasilan traveler adalah tanggung jawab traveler sesuai ketentuan perpajakan.',
    tags: ['payout', 'traveler', 'pembayaran'],
  },
  {
    slug: 'deklarasi-bea-cukai-traveler',
    category: 'TRAVELER',
    question: 'Apakah traveler wajib mendeklarasikan barang titipan?',
    answer:
      'Ya. Barang titipan wajib dideklarasikan dengan jujur sebagai barang bukan pribadi melalui All Indonesia (kedatangan udara & laut) atau e-CD (darat). Bea & pajak dibayar atas nama traveler dan bukti pembayarannya diunggah ke transaksi; estimasi yang sudah dibayar penitip dipakai untuk menggantinya. Ponsel juga wajib registrasi IMEI (maks. 2 unit per penumpang).',
    tags: ['deklarasi', 'all indonesia', 'traveler'],
  },
  {
    slug: 'serah-terima-pin-qr',
    category: 'DELIVERY',
    question: 'Bagaimana serah terima barang dengan PIN atau QR?',
    answer:
      'Saat bertemu traveler, periksa barangnya dulu. Bila sesuai, berikan PIN 6 digit atau tunjukkan QR dari aplikasi (QR berlaku 30 menit). Jangan berikan PIN sebelum barang sesuai. PIN dibatasi 5 kali percobaan. Untuk pengiriman kurir, kamu menerima nomor resi dan status pelacakan.',
    tags: ['pin', 'qr', 'serah terima', 'meetup'],
  },
  {
    slug: 'konfirmasi-otomatis-48-jam',
    category: 'DELIVERY',
    question: 'Apa yang terjadi kalau saya lupa konfirmasi penerimaan?',
    answer:
      'Transaksi dikonfirmasi otomatis 48 jam setelah berstatus terkirim bila tidak ada dispute. Setelah itu dana diteruskan ke traveler. Kalau ada masalah dengan barang, buka dispute sebelum batas waktu.',
    tags: ['konfirmasi', 'otomatis', 'delivered'],
  },
  {
    slug: 'membatalkan-titipan',
    category: 'DISPUTE',
    question: 'Bisakah saya membatalkan titipan?',
    answer:
      'Bisa, dengan dampak berbeda per tahap. **Sebelum membayar**: tanpa biaya. **Setelah pembayaran aman, sebelum pembelian disetujui**: dana dikembalikan penuh kecuali biaya pembayaran (bila kamu menolak kenaikan harga, biaya pembayaran ikut dikembalikan). **Setelah pembelian disetujui tetapi barang belum dibeli**: 10% traveler fee, 50% platform fee & PPN layanannya, serta biaya pembayaran tidak dikembalikan; traveler menerima kompensasi 10% traveler fee (min. Rp10.000). **Setelah barang dibeli atau dalam perjalanan**: penitip tidak bisa membatalkan — gunakan Dispute Center. Rincian lengkap ada di Kebijakan Refund.',
    tags: ['batal', 'cancel', 'refund'],
  },
  {
    slug: 'refund-berapa-lama',
    category: 'DISPUTE',
    question: 'Berapa lama proses refund?',
    answer:
      'Refund diproses ke metode pembayaran asal melalui mitra payment gateway (atau transfer bila metode tersebut tidak mendukung refund). Waktu masuknya dana bergantung pada bank/penyedia metode pembayaran. Refund bernilai besar memerlukan persetujuan dua orang tim keuangan (maker-checker).',
    tags: ['refund', 'waktu'],
  },
  {
    slug: 'level-verifikasi-akun',
    category: 'ACCOUNT',
    question: 'Apa arti level verifikasi (KYC) akun?',
    answer:
      'Level 1 Terdaftar · Level 2 HP terverifikasi (syarat checkout) · Level 3 Identitas terverifikasi (KTP/paspor + selfie) · Level 4 Traveler terverifikasi (rekening payout + trip terverifikasi) · Level 5 Trusted Traveler (≥10 transaksi selesai, Trust Score ≥ 80, dispute rate < 3%). Batas nilai transaksi naik seiring level.',
    tags: ['kyc', 'verifikasi', 'level'],
  },
  {
    slug: 'hapus-akun',
    category: 'ACCOUNT',
    question: 'Bagaimana cara menghapus akun dan data saya?',
    answer:
      'Buka Profil → Keamanan & privasi → Hapus akun di aplikasi, atau masuk di situs lalu buka halaman Akun. Penghapusan dijadwalkan dengan masa tenggang 14 hari (bisa dibatalkan), dan ditolak sementara bila masih ada transaksi berjalan, dispute terbuka, atau payout/refund yang belum selesai. Sebagian data wajib disimpan lebih lama sesuai hukum (mis. catatan keuangan). Detail di halaman **Hapus akun & data**.',
    tags: ['hapus akun', 'privasi', 'data'],
  },
  {
    slug: 'trust-score',
    category: 'ACCOUNT',
    question: 'Apa itu Trust Score?',
    answer:
      'Trust Score (0–100) merangkum rekam jejak akun: level verifikasi, transaksi selesai, ketepatan waktu, rating, riwayat pembayaran, verifikasi trip, serta pengurang dari pembatalan, dispute, dan sinyal penipuan. Skor dipakai untuk rekomendasi traveler dan batas transaksi. Penyesuaian manual oleh tim wajib beralasan dan tercatat.',
    tags: ['trust score', 'reputasi'],
  },
  {
    slug: 'program-referral',
    category: 'REFERRAL',
    question: 'Bagaimana cara kerja program referral?',
    answer:
      'Bagikan kode referral kamu. Saat teman menyelesaikan transaksi pertama minimal Rp500.000, kamu dan teman masing-masing mendapat JastipKita Credit (nilai mengikuti ketentuan program yang berlaku, dengan batas bulanan). Credit tidak dapat dicairkan dan berlaku 90 hari.',
    tags: ['referral', 'kode', 'credit'],
  },
  {
    slug: 'transaksi-di-luar-aplikasi',
    category: 'GENERAL',
    question: 'Bolehkah saya membayar traveler langsung di luar aplikasi?',
    answer:
      'Jangan. Transaksi di luar SafePay tidak dilindungi: tidak ada penahanan dana, tidak ada bukti pembelian yang tercatat, dan tidak bisa dibuka dispute. Laporkan traveler yang meminta transfer ke rekening pribadi melalui menu Laporkan di aplikasi.',
    tags: ['penipuan', 'safepay', 'transfer'],
  },
];
