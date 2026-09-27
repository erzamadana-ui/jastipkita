/**
 * SEO country pages (/jastip-<slug>/). Content is written per country — no shared filler paragraphs.
 * Numbers (customs examples, classifications, limits) are NOT hard-coded in the copy: they are computed at
 * build time from @jastipkita/core + the seed rules, so the page cannot drift from the engine.
 * Store names are examples of where travelers commonly shop — they are NOT partners of JastipKita.
 */
import type { IconName } from './icons.generated.ts';

export interface CountryFaq {
  q: string;
  /** Plain text / light markdown (**bold**). Placeholders: {EXAMPLE_TOTAL}, {EXAMPLE_PCT}, {EXAMPLE_PRODUCT}. */
  a: string;
}

export interface CountryPage {
  code: 'JP' | 'KR' | 'SG' | 'US' | 'MY' | 'AU';
  slug: string;
  nameId: string;
  nameEn: string;
  currency: 'JPY' | 'KRW' | 'SGD' | 'USD' | 'MYR' | 'AUD';
  cities: string[];
  /** One-line summary for cards. */
  cardLine: string;
  title: string;
  description: string;
  h1: string;
  lead: string;
  intro: string[];
  highlights: Array<{ icon: IconName; title: string; text: string }>;
  categories: Array<{ code: string; examples: string }>;
  merchants: Array<{ name: string; kind: string }>;
  example: { product: string; categoryCode: string; unitPrice: string; quantity: number; note: string };
  /** Seed rule codes from db/seeds/0101_restricted_items.sql, rendered with their seed classification & message. */
  restricted: Array<{ code: string; title: string; context: string }>;
  tips: Array<{ title: string; text: string }>;
  faq: CountryFaq[];
}

export const COUNTRY_PAGES: CountryPage[] = [
  {
    code: 'JP',
    slug: 'jastip-jepang',
    nameId: 'Jepang',
    nameEn: 'Japan',
    currency: 'JPY',
    cities: ['Tokyo', 'Osaka', 'Kyoto', 'Fukuoka', 'Sapporo'],
    cardLine: 'Figure, trading card, skincare & camilan',
    title: 'Jastip Jepang Aman — Titip Belanja dari Tokyo, Osaka & Kyoto',
    description:
      'Titip beli figure, trading card, skincare & camilan Jepang lewat traveler terverifikasi. Estimasi bea masuk & pajak PMK 34/2025, cek barang terlarang, dana ditahan SafePay.',
    h1: 'Jastip Jepang: figure, TCG & skincare dari Tokyo sampai Osaka',
    lead: 'Titip ke traveler yang tripnya terverifikasi. Dana kamu ditahan SafePay dan baru diteruskan setelah barang kamu terima.',
    intro: [
      'Jepang adalah rute jastip yang paling “berburu”: figure dan trading card yang habis di hari rilis, sunscreen dan skincare drugstore yang harganya jauh lebih murah di sana, sampai camilan edisi daerah yang tidak pernah masuk Indonesia. Karena barangnya sering langka, kecepatan dan kejujuran traveler sama pentingnya.',
      'Hal yang paling sering bikin kaget: barang titipan dari Jepang bukan barang pribadi traveler. Jadi tidak ada pembebasan USD 500 — bea masuk 10%, PPN, dan PPh 22 dihitung dari nilai penuh barang. Di JastipKita, estimasi itu sudah masuk ke rincian harga sebelum kamu membayar, lengkap dengan dasar aturannya.',
    ],
    highlights: [
      {
        icon: 'receipt',
        title: 'Dibeli dengan pajak konsumsi',
        text: 'Fasilitas tax-free Jepang ditujukan untuk barang pribadi wisatawan, bukan titipan untuk orang lain. Traveler JastipKita membeli barang titipan dengan harga termasuk pajak, dan harga di struk itulah yang menjadi dasar nilai pabean.',
      },
      {
        icon: 'timer',
        title: 'Rilis terbatas butuh jadwal pas',
        text: 'Figure, kolaborasi Pokémon Center, atau booster box TCG sering habis di hari pertama. Pilih trip yang tanggal belanjanya cocok dengan jadwal rilis, dan tulis varian cadangan di catatan titipan.',
      },
      {
        icon: 'triangle-alert',
        title: 'Pisau, sake & obat perlu dicek',
        text: 'Pisau dapur Jepang hanya boleh di bagasi tercatat, minuman beralkohol untuk orang lain tidak bisa dititipkan, dan obat bebas Jepang punya batas jumlah. Cek dulu di pemeriksa barang terlarang.',
      },
    ],
    categories: [
      { code: 'TOYS_HOBBIES', examples: 'Figure skala, Gunpla & plamo, mainan edisi Jepang' },
      { code: 'COLLECTIBLES_TCG', examples: 'Pokémon TCG, One Piece Card Game, merchandise anime' },
      { code: 'COSMETICS_SKINCARE', examples: 'Sunscreen, serum, makeup drugstore' },
      { code: 'FOOD_SNACKS', examples: 'KitKat rasa lokal, camilan oleh-oleh daerah' },
      { code: 'CAMERAS', examples: 'Kamera mirrorless, lensa, aksesori foto' },
      { code: 'FASHION_APPAREL', examples: 'Streetwear, koleksi edisi Jepang' },
    ],
    merchants: [
      { name: 'Don Quijote', kind: 'toko diskon serba ada, buka sampai malam' },
      { name: 'Pokémon Center', kind: 'merchandise & kartu resmi' },
      { name: 'Animate & Mandarake', kind: 'anime, manga & barang koleksi' },
      { name: 'Yodobashi & Bic Camera', kind: 'elektronik, kamera & mainan' },
      { name: 'Matsumoto Kiyoshi', kind: 'drugstore, skincare & kosmetik' },
      { name: 'Uniqlo & GU', kind: 'fashion dengan koleksi khusus Jepang' },
    ],
    example: {
      product: 'Figure skala 1/7',
      categoryCode: 'TOYS_HOBBIES',
      unitPrice: '28000',
      quantity: 1,
      note: 'Harga toko termasuk pajak konsumsi Jepang.',
    },
    restricted: [
      { code: 'RI_ID_KNIVES', title: 'Pisau dapur (santoku, gyuto)', context: 'Populer sebagai oleh-oleh dari Sakai & Seki.' },
      { code: 'RI_ID_BLADES_SWORDS', title: 'Katana, tanto & pedang hias', context: 'Termasuk replika dekoratif dari toko suvenir.' },
      { code: 'RI_ID_ALCOHOL_CATEGORY', title: 'Sake, umeshu & whisky Jepang', context: 'Tidak bisa dititipkan di JastipKita.' },
      { code: 'RI_ID_MEDICINE_CATEGORY', title: 'Obat bebas Jepang', context: 'Mis. obat flu, pereda nyeri, obat mata.' },
      { code: 'RI_JP_TAXFREE_NOT_FOR_RESALE', title: 'Belanja tax-free untuk titipan', context: 'Aturan khusus rute Jepang.' },
      { code: 'RI_ID_RICE_SUGAR', title: 'Beras Jepang (koshihikari)', context: 'Sering diminta, statusnya sedang dikaji.' },
    ],
    tips: [
      {
        title: 'Label harga punya dua angka',
        text: 'Toko Jepang sering mencantumkan harga sebelum pajak (税抜) dan sesudah pajak (税込). Rincian JastipKita memakai harga yang benar-benar dibayar; bila harga di kasir berbeda lebih dari toleransi (2% atau maks. Rp 50.000), traveler wajib meminta konfirmasi harga dan kamu punya 15 menit untuk menyetujui atau menolak.',
      },
      {
        title: 'Cek versi elektronik domestik',
        text: 'Sebagian elektronik untuk pasar Jepang memakai tegangan 100 V, colokan tipe A, atau menu berbahasa Jepang saja. Pastikan spesifikasinya cocok sebelum menitip — barang yang sudah dibeli sesuai permintaan tidak bisa dibatalkan.',
      },
      {
        title: 'Struk & foto adalah bukti',
        text: 'Setelah membeli, traveler mengunggah foto struk, foto barang, nama toko, harga aktual, dan waktu pembelian. Untuk kategori bernilai tinggi (kamera, jam tangan, barang branded) wajib ada nomor seri dan video.',
      },
    ],
    faq: [
      {
        q: 'Berapa bea masuk dan pajak jastip dari Jepang?',
        a: 'Barang titipan bukan barang pribadi traveler, sehingga menurut PMK 34/2025 dikenai bea masuk 10% dari nilai pabean, lalu PPN (12% × DPP 11/12, efektif 11%) dan PPh 22 5% dari nilai impor — total sekitar {EXAMPLE_PCT}% dari nilai barang. Contoh {EXAMPLE_PRODUCT} di halaman ini: estimasi {EXAMPLE_TOTAL}. Nilai final selalu ditetapkan Bea Cukai.',
      },
      {
        q: 'Bisakah traveler memakai fasilitas tax-free untuk barang titipan saya?',
        a: 'Tidak. Fasilitas tax-free Jepang ditujukan untuk barang pribadi wisatawan dan bukan untuk dijual kembali atau dibelikan untuk orang lain. Menurut informasi yang kami himpun (belum dikonfirmasi dari sumber resmi Jepang), mulai 1 November 2026 sistemnya beralih menjadi refund saat keberangkatan. Karena itu barang titipan dibeli dengan harga termasuk pajak.',
      },
      {
        q: 'Apakah pisau dapur Jepang boleh dititipkan?',
        a: 'Boleh dengan syarat: pisau dapur hanya boleh dibawa di bagasi tercatat (bukan kabin) dan kamu wajib menyetujui peringatan barang terbatas sebelum membayar. Pisau lipat/taktis dan pedang (katana, tanto) diperlakukan jauh lebih ketat.',
      },
      {
        q: 'Bagaimana kalau figure yang saya titip ternyata habis?',
        a: 'Traveler baru boleh membeli setelah status PURCHASE APPROVED. Bila stok habis, traveler membatalkan sebelum membeli dan dana kamu dikembalikan penuh sesuai Kebijakan Refund — traveler tidak boleh mengganti barang tanpa persetujuanmu.',
      },
      {
        q: 'Kapan barang dari Jepang sampai?',
        a: 'Tergantung tanggal kepulangan traveler yang kamu pilih; tanggal tiba ditampilkan di setiap trip. Setelah tiba dan urusan bea cukai selesai, serah terima dilakukan dengan PIN/QR saat bertemu atau lewat kurir dengan nomor resi.',
      },
    ],
  },
  {
    code: 'KR',
    slug: 'jastip-korea',
    nameId: 'Korea Selatan',
    nameEn: 'South Korea',
    currency: 'KRW',
    cities: ['Seoul', 'Busan', 'Incheon'],
    cardLine: 'Skincare, album K-pop & fashion Seoul',
    title: 'Jastip Korea Aman — Titip Skincare, Album K-pop & Fashion Seoul',
    description:
      'Titip beli skincare Korea, album & merchandise K-pop, dan fashion Seoul lewat traveler terverifikasi. Batas kosmetik BPOM, estimasi bea & pajak PMK 34/2025, dana ditahan SafePay.',
    h1: 'Jastip Korea: skincare, album K-pop & fashion Seoul tanpa was-was',
    lead: 'Dari Myeongdong sampai Seongsu — titip ke traveler terverifikasi, bayar lewat SafePay, dan lihat estimasi bea & pajak sebelum checkout.',
    intro: [
      'Korea Selatan identik dengan dua hal yang paling sering dititip: K-beauty dan K-pop. Skincare yang baru rilis di Olive Young, album dengan versi dan photocard tertentu, sampai merchandise pop-up store yang hanya ada beberapa minggu. Fashion dari Hongdae dan Seongsu juga makin banyak diburu.',
      'Justru karena skincare paling laris, batasnya perlu dipahami: kosmetik untuk penggunaan pribadi dibatasi jumlahnya per penumpang, dan barang titipan tidak dikecualikan dari aturan BPOM. JastipKita menampilkan batas ini di awal — lengkap dengan persetujuan yang harus kamu berikan sebelum membayar — supaya tidak ada yang tertahan di bandara.',
    ],
    highlights: [
      {
        icon: 'sparkles',
        title: 'Skincare ada batas jumlahnya',
        text: 'Kosmetik & skincare dibatasi per penumpang per kedatangan (total semua jenis). Pesanan dengan jumlah di atas batas ditolak sistem, dan traveler tetap harus menghitung total kosmetik yang ia bawa dari semua penitip.',
      },
      {
        icon: 'sticker',
        title: 'Album & photocard: sebutkan versinya',
        text: 'Satu album bisa punya beberapa versi sampul dan photocard acak. Tulis versi yang kamu mau (dan boleh tidaknya diganti) di catatan titipan, karena traveler tidak bisa memilih photocard di dalam segel.',
      },
      {
        icon: 'shield-alert',
        title: 'Hati-hati barang tiruan',
        text: 'Pasar grosir terkenal juga menjual barang tiruan merek terkenal. Barang palsu dilarang di JastipKita; untuk tas dan barang branded, traveler wajib mengunggah nota toko resmi dan bukti keaslian.',
      },
    ],
    categories: [
      { code: 'COSMETICS_SKINCARE', examples: 'Serum, toner, sunscreen, sheet mask' },
      { code: 'BOOKS_MEDIA', examples: 'Album K-pop, photobook, majalah' },
      { code: 'COLLECTIBLES_TCG', examples: 'Merchandise resmi, lightstick, photocard set' },
      { code: 'FASHION_APPAREL', examples: 'Streetwear lokal Seoul, koleksi pop-up' },
      { code: 'SUPPLEMENTS_VITAMINS', examples: 'Red ginseng, vitamin' },
      { code: 'FOOD_SNACKS', examples: 'Ramyeon edisi khusus, camilan' },
    ],
    merchants: [
      { name: 'Olive Young', kind: 'drugstore K-beauty terbesar' },
      { name: 'Daiso Korea', kind: 'barang murah & skincare dasar' },
      { name: 'Toko album & toko resmi agensi', kind: 'album, lightstick & merchandise resmi' },
      { name: 'Musinsa & butik Seongsu', kind: 'fashion lokal Korea' },
      { name: 'The Hyundai & department store', kind: 'brand premium' },
      { name: 'Pop-up store', kind: 'kolaborasi terbatas — cek tanggalnya' },
    ],
    example: {
      product: 'Paket skincare 6 pcs (serum, toner, sunscreen)',
      categoryCode: 'COSMETICS_SKINCARE',
      unitPrice: '150000',
      quantity: 1,
      note: 'Satu paket berisi 6 produk — dihitung sebagai 6 pcs kosmetik untuk batas BPOM.',
    },
    restricted: [
      { code: 'RI_ID_COSMETICS_CATEGORY', title: 'Kosmetik & skincare', context: 'Kategori jastip Korea paling populer.' },
      { code: 'RI_ID_SUPPLEMENTS_CATEGORY', title: 'Red ginseng & suplemen', context: 'Dihitung per jenis produk.' },
      { code: 'RI_ID_COUNTERFEIT', title: 'Barang tiruan / “KW”', context: 'Termasuk tas & sepatu replika.' },
      { code: 'RI_ID_ALCOHOL_KEYWORD', title: 'Soju & makgeolli', context: 'Minuman beralkohol untuk orang lain.' },
      { code: 'RI_ID_POWERBANK_KEYWORD', title: 'Power bank & baterai cadangan', context: 'Sering dibeli bersama merchandise.' },
    ],
    tips: [
      {
        title: 'Cek tanggal kedaluwarsa & batch',
        text: 'Minta traveler memotret tanggal kedaluwarsa/PAO saat mengunggah bukti pembelian, terutama untuk produk promo atau set hadiah.',
      },
      {
        title: 'Jangan klaim tax refund untuk titipan',
        text: 'Skema pengembalian pajak turis umumnya ditujukan untuk barang pribadi wisatawan. Traveler JastipKita membeli barang titipan dengan harga normal dan tidak mengklaim refund, supaya nilai di struk dan nilai yang dideklarasikan tetap konsisten.',
      },
      {
        title: 'Pre-order tidak sama dengan stok',
        text: 'Album pre-order baru dikirim toko setelah tanggal rilis. Pastikan tanggal rilis jatuh sebelum traveler pulang; bila tidak, pilih trip lain daripada meminta traveler “menunggu kiriman”.',
      },
    ],
    faq: [
      {
        q: 'Berapa banyak skincare Korea yang boleh saya titip?',
        a: 'Kosmetik & skincare untuk penggunaan pribadi dibatasi maksimal 20 pcs per penumpang per kedatangan (total semua jenis). Karena barang titipan bukan barang pribadi traveler, jumlah besar berisiko ditahan BPOM/Bea Cukai. Pemeriksa JastipKita menolak pesanan yang melewati batas.',
      },
      {
        q: 'Berapa estimasi bea & pajak untuk skincare dari Korea?',
        a: 'Untuk {EXAMPLE_PRODUCT}, estimasi bea masuk + PPN + PPh 22 adalah {EXAMPLE_TOTAL} (sekitar {EXAMPLE_PCT}% dari nilai barang) memakai kurs pajak minggu ini. Bea Cukai memakai kurs pada minggu kedatangan dan menetapkan nilai final.',
      },
      {
        q: 'Apakah soju atau makgeolli bisa dititipkan?',
        a: 'Tidak. Minuman beralkohol untuk orang lain termasuk barang kena cukai non-pribadi yang memerlukan pelunasan cukai dan izin impor, sehingga JastipKita tidak menerimanya.',
      },
      {
        q: 'Bagaimana kalau photocard yang saya dapat bukan bias saya?',
        a: 'Photocard acak di dalam album tersegel tidak bisa dipilih traveler. Itu bukan alasan dispute. Bila kamu butuh photocard tertentu, cari listing set photocard resmi dan tulis detailnya di titipan.',
      },
    ],
  },
  {
    code: 'SG',
    slug: 'jastip-singapore',
    nameId: 'Singapura',
    nameEn: 'Singapore',
    currency: 'SGD',
    cities: ['Orchard', 'Marina Bay', 'Changi'],
    cardLine: 'Barang branded, LEGO & camilan',
    title: 'Jastip Singapore Aman — Titip Tas Branded, Mainan & Camilan',
    description:
      'Titip beli tas & barang branded, LEGO, dan camilan Singapura lewat traveler terverifikasi. Bukti keaslian wajib, estimasi bea & pajak PMK 34/2025, dana ditahan SafePay.',
    h1: 'Jastip Singapura: barang branded & camilan, dengan bukti keaslian',
    lead: 'Rute pendek dengan trip yang sering. Titip ke traveler terverifikasi, bayar lewat SafePay, dan pastikan setiap barang branded datang dengan nota resmi.',
    intro: [
      'Singapura hanya satu jam lebih dari Jakarta, jadi trip traveler ke sana termasuk yang paling sering. Yang dititip biasanya barang bernilai tinggi: tas dan dompet dari butik Orchard Road, jam tangan, LEGO set eksklusif, sampai camilan oleh-oleh yang hanya dijual di sana.',
      'Untuk barang bernilai tinggi, yang paling penting adalah bukti. Di JastipKita, kategori barang mewah dan jam tangan mewajibkan traveler mengunggah nota toko, nomor seri, dan video pembelian. Kulit hewan eksotis seperti python atau buaya juga butuh dokumen CITES — bagian yang sering luput dari jastip informal.',
    ],
    highlights: [
      {
        icon: 'gem',
        title: 'Barang branded wajib bukti',
        text: 'Kategori barang mewah dan jam tangan mewajibkan nomor seri dan video pembelian, selain foto struk. Ini melindungi kamu dari barang tiruan dan melindungi traveler dari tuduhan menukar barang.',
      },
      {
        icon: 'plane',
        title: 'Rute pendek, trip sering',
        text: 'Banyak traveler bolak-balik untuk kerja atau liburan akhir pekan. Bandingkan beberapa trip: tanggal tiba, sisa kapasitas, fee, dan Trust Score traveler.',
      },
      {
        icon: 'ban',
        title: 'Vape & rokok elektrik ditolak',
        text: 'Rokok, cerutu, dan rokok elektrik untuk orang lain termasuk barang kena cukai non-pribadi dan tidak dapat dititipkan di JastipKita.',
      },
    ],
    categories: [
      { code: 'LUXURY_GOODS', examples: 'Tas & dompet butik, aksesori branded' },
      { code: 'BAGS_ACCESSORIES', examples: 'Tas fashion brand lokal Singapura' },
      { code: 'WATCHES_JEWELRY', examples: 'Jam tangan, perhiasan' },
      { code: 'TOYS_HOBBIES', examples: 'LEGO set, mainan edukatif' },
      { code: 'FOOD_SNACKS', examples: 'Salted egg snack, kue & kaya' },
      { code: 'ELECTRONICS_AUDIO', examples: 'Headphone, aksesori gadget' },
    ],
    merchants: [
      { name: 'ION Orchard & Paragon', kind: 'butik brand internasional' },
      { name: 'Takashimaya & Tangs', kind: 'department store' },
      { name: 'Charles & Keith / Pedro', kind: 'tas & sepatu brand Singapura' },
      { name: 'Toko camilan oleh-oleh', kind: 'salted egg snack, kaya, kue' },
      { name: 'LEGO Certified Store', kind: 'set LEGO & eksklusif toko' },
      { name: 'Toko area publik Changi Airport', kind: 'belanja menjelang terbang' },
    ],
    example: {
      product: 'Tas kulit brand Singapura',
      categoryCode: 'BAGS_ACCESSORIES',
      unitPrice: '259',
      quantity: 1,
      note: 'Harga butik sudah termasuk GST Singapura.',
    },
    restricted: [
      { code: 'RI_ID_WILDLIFE_CITES', title: 'Tas kulit eksotis (python, buaya)', context: 'Sering ada di butik barang mewah.' },
      { code: 'RI_ID_COUNTERFEIT', title: 'Barang tiruan', context: 'Termasuk “mirror quality”.' },
      { code: 'RI_ID_TOBACCO_VAPE_CATEGORY', title: 'Rokok, cerutu & vape', context: 'Tidak bisa dititipkan.' },
      { code: 'RI_ID_PERFUME_CATEGORY', title: 'Parfum', context: 'Ada batas jumlah & aturan cairan penerbangan.' },
      { code: 'RI_ID_POWERBANK_CATEGORY', title: 'Power bank & baterai', context: 'Hanya di kabin, ada batas Wh.' },
    ],
    tips: [
      {
        title: 'Minta nota, kartu garansi & dust bag',
        text: 'Untuk barang branded, pastikan traveler memotret nota butik, kartu garansi/sertifikat, dan kondisi segel sebelum barang dikemas ulang. Semua masuk ke bukti pembelian yang tersimpan di transaksi.',
      },
      {
        title: 'Nilai pabean = harga yang dibayar',
        text: 'Harga di Singapura umumnya sudah termasuk GST. Traveler tidak mengklaim pengembalian pajak turis untuk barang titipan, sehingga harga di struk menjadi dasar estimasi bea & pajak.',
      },
      {
        title: 'Barang mahal, limit transaksi lebih ketat',
        text: 'Batas nilai per transaksi mengikuti level verifikasi (KYC) kamu dan traveler. Untuk tas di atas beberapa juta rupiah, pastikan akunmu sudah terverifikasi identitas.',
      },
    ],
    faq: [
      {
        q: 'Apakah tas branded dari Singapura kena PPnBM?',
        a: 'Menurut daftar barang mewah yang berlaku (PMK 96/PMK.03/2021 jo PMK 15/PMK.03/2023), tas, jam, perhiasan, dan parfum branded tidak dikenai PPnBM. Yang berlaku untuk barang titipan: bea masuk 10%, PPN, dan PPh 22 dari nilai penuh.',
      },
      {
        q: 'Berapa estimasi bea & pajak untuk tas dari Singapura?',
        a: 'Contoh {EXAMPLE_PRODUCT} di halaman ini: estimasi {EXAMPLE_TOTAL} atau sekitar {EXAMPLE_PCT}% dari nilai barang. Bea Cukai menetapkan nilai final berdasarkan kurs pada minggu kedatangan.',
      },
      {
        q: 'Bagaimana saya tahu tasnya asli?',
        a: 'Untuk kategori barang mewah & jam tangan, traveler wajib mengunggah nota toko resmi, nomor seri, dan video pembelian. Bila barang yang diterima terbukti palsu, kamu bisa membuka dispute tipe COUNTERFEIT dalam 72 jam setelah barang diterima.',
      },
      {
        q: 'Bisakah saya titip rokok elektrik dari Singapura?',
        a: 'Tidak. Rokok, cerutu, dan rokok elektrik untuk orang lain tidak dapat dititipkan di JastipKita.',
      },
    ],
  },
  {
    code: 'US',
    slug: 'jastip-usa',
    nameId: 'Amerika Serikat',
    nameEn: 'United States',
    currency: 'USD',
    cities: ['New York', 'Los Angeles', 'San Francisco', 'Seattle'],
    cardLine: 'Vitamin, sneakers & gadget',
    title: 'Jastip USA Aman — Titip Vitamin, Sneakers & Gadget dari Amerika',
    description:
      'Titip beli vitamin, sneakers, gadget & produk bath-and-body dari Amerika lewat traveler terverifikasi. Registrasi IMEI, batas suplemen, estimasi bea & pajak, dana ditahan SafePay.',
    h1: 'Jastip USA: vitamin, sneakers & gadget — tanpa kejutan di bandara',
    lead: 'Rute jauh dengan trip lebih jarang. Rencanakan lebih awal, pahami aturan IMEI dan suplemen, dan lihat estimasi landed cost sebelum membayar.',
    intro: [
      'Dari Amerika, yang paling sering dititip adalah vitamin dan suplemen dari warehouse store, sneakers edisi tertentu, produk bath-and-body, dan gadget. Karena penerbangannya panjang dan trip lebih jarang, titipan dari AS biasanya direncanakan berminggu-minggu sebelumnya.',
      'Dua aturan paling penting untuk rute ini: ponsel wajib dideklarasikan dan IMEI-nya didaftarkan atas paspor traveler (maksimal 2 unit per penumpang, termasuk ponsel pribadinya), dan suplemen dibatasi 5 pcs per jenis. Produk yang legal di sebagian negara bagian AS — seperti CBD — tetap dilarang masuk Indonesia.',
    ],
    highlights: [
      {
        icon: 'receipt',
        title: 'Harga label belum termasuk pajak',
        text: 'Di AS, sales tax ditambahkan di kasir dan besarnya berbeda per negara bagian/kota. Nilai pabean memakai total yang benar-benar dibayar di struk — bukan harga di rak.',
      },
      {
        icon: 'smartphone',
        title: 'Ponsel: IMEI atas paspor traveler',
        text: 'iPhone dan ponsel lain wajib dideklarasikan dan IMEI didaftarkan di bandara atau maksimal 60 hari setelah tiba. Kuota 2 unit dibagi dengan ponsel pribadi traveler, jadi tanyakan dulu sisa kuotanya.',
      },
      {
        icon: 'pill',
        title: 'Suplemen & obat resep dibatasi',
        text: 'Suplemen maksimal 5 pcs per jenis. Obat resep seperti injeksi GLP-1 butuh resep atas nama pengguna dan izin BPOM — tidak untuk dititipbelikan.',
      },
    ],
    categories: [
      { code: 'SUPPLEMENTS_VITAMINS', examples: 'Multivitamin, fish oil, protein' },
      { code: 'FOOTWEAR', examples: 'Sneakers rilisan terbatas, sepatu lari' },
      { code: 'MOBILE_PHONES', examples: 'iPhone & ponsel (wajib registrasi IMEI)' },
      { code: 'COMPUTERS_TABLETS', examples: 'Laptop & tablet' },
      { code: 'PERFUME', examples: 'Parfum & body mist' },
      { code: 'SPORTS_OUTDOOR', examples: 'Perlengkapan hiking & olahraga' },
    ],
    merchants: [
      { name: 'Costco & warehouse store', kind: 'vitamin & kebutuhan rumah ukuran besar' },
      { name: 'Target & Walmart', kind: 'serba ada, mainan, kosmetik' },
      { name: 'Apple Store', kind: 'iPhone, iPad, Mac' },
      { name: 'Toko sneakers & outlet', kind: 'rilisan terbatas & diskon outlet' },
      { name: 'Toko bath-and-body', kind: 'body mist, lotion, lilin aroma' },
      { name: 'Premium outlet mall', kind: 'fashion & tas dengan harga outlet' },
    ],
    example: {
      product: 'Sepatu lari (harga setelah sales tax)',
      categoryCode: 'FOOTWEAR',
      unitPrice: '160',
      quantity: 1,
      note: 'Total di struk, sudah termasuk sales tax.',
    },
    restricted: [
      { code: 'RI_ID_SUPPLEMENTS_CATEGORY', title: 'Vitamin & suplemen', context: 'Kategori jastip AS paling populer.' },
      { code: 'RI_ID_MOBILE_PHONES_CATEGORY', title: 'iPhone & ponsel', context: 'Deklarasi & registrasi IMEI.' },
      { code: 'RI_ID_MEDICINE_PRESCRIPTION', title: 'Obat resep & injeksi GLP-1', context: 'Mis. Ozempic, Mounjaro, isotretinoin.' },
      { code: 'RI_ID_NARCOTICS_PSYCHOTROPICS', title: 'Produk CBD / THC', context: 'Legal di sebagian negara bagian AS, dilarang di Indonesia.' },
      { code: 'RI_ID_AEROSOLS_CATEGORY', title: 'Body mist, dry shampoo & aerosol', context: 'Aturan barang berbahaya penerbangan.' },
      { code: 'RI_ID_SELF_DEFENSE_DEVICES', title: 'Pepper spray & stun gun', context: 'Dijual bebas di AS.' },
    ],
    tips: [
      {
        title: 'Cek versi carrier & region',
        text: 'Ponsel “carrier-locked” atau model khusus AS bisa bermasalah dengan operator Indonesia. Titip hanya model unlocked dan cek dukungan band/eSIM sebelum membayar.',
      },
      {
        title: 'Pengembalian barang hampir mustahil',
        text: 'Setelah traveler pulang, retur ke toko AS tidak realistis. Pastikan ukuran, warna, dan versi sudah benar — pertanyaan di chat sebelum pembelian jauh lebih murah daripada dispute.',
      },
      {
        title: 'Rencanakan jauh hari',
        text: 'Trip AS lebih jarang dan kapasitas bagasi cepat penuh. Simpan draf titipan lebih awal dan pantau trip baru di halaman pencarian trip.',
      },
    ],
    faq: [
      {
        q: 'Berapa banyak vitamin dari Amerika yang boleh dititip?',
        a: 'Suplemen & obat tradisional dibatasi maksimal 5 pcs per jenis per penumpang untuk penggunaan pribadi. Jumlah di atas itu ditolak oleh pemeriksa JastipKita karena berisiko ditahan BPOM/Bea Cukai.',
      },
      {
        q: 'Bisakah saya titip iPhone dari Amerika?',
        a: 'Bisa, dengan syarat: ponsel wajib dideklarasikan dan IMEI didaftarkan atas paspor traveler (maksimal 2 unit per penumpang, termasuk ponsel pribadi traveler), di bandara atau maksimal 60 hari setelah tiba. Bea & pajak dibayar saat registrasi dan sudah masuk estimasi di rincian harga.',
      },
      {
        q: 'Berapa estimasi bea & pajak untuk sneakers dari AS?',
        a: 'Contoh {EXAMPLE_PRODUCT}: estimasi {EXAMPLE_TOTAL} atau sekitar {EXAMPLE_PCT}% dari nilai barang, dihitung dari total yang dibayar di struk (termasuk sales tax).',
      },
      {
        q: 'Produk CBD legal di AS — kenapa tidak bisa dititip?',
        a: 'Produk ganja, CBD, dan THC dilarang masuk Indonesia (UU Narkotika), apa pun status hukumnya di negara asal. Sanksinya pidana berat, sehingga JastipKita memblokirnya di checkout.',
      },
    ],
  },
  {
    code: 'MY',
    slug: 'jastip-malaysia',
    nameId: 'Malaysia',
    nameEn: 'Malaysia',
    currency: 'MYR',
    cities: ['Kuala Lumpur', 'Johor Bahru', 'Penang', 'Kuching'],
    cardLine: 'Camilan, outlet & perlengkapan bayi',
    title: 'Jastip Malaysia Aman — Titip dari Kuala Lumpur, Johor & Penang',
    description:
      'Titip beli camilan, fashion outlet, perlengkapan bayi & buku dari Malaysia lewat traveler terverifikasi — via udara, laut, atau darat. Estimasi bea & pajak, dana ditahan SafePay.',
    h1: 'Jastip Malaysia: dekat, sering, dan tetap tercatat rapi',
    lead: 'Traveler datang lewat udara, kapal, atau jalur darat Kalimantan. Apa pun rutenya, dana kamu ditahan SafePay sampai barang diterima.',
    intro: [
      'Malaysia adalah tetangga dengan rute paling beragam: pesawat ke Kuala Lumpur dan Penang, kapal dari Batam ke Johor, sampai perlintasan darat di Kalimantan. Yang dititip pun beragam — coklat dan kopi oleh-oleh, sepatu dan tas dari premium outlet, perlengkapan bayi, sampai buku impor yang lebih murah.',
      'Karena harga barangnya sering kecil, perhatikan dua hal: minimum nilai barang per titipan dan biaya yang tetap berlaku (fee traveler, perlindungan, dan estimasi bea & pajak). Menggabungkan beberapa barang dalam satu titipan biasanya membuat biaya per barang jauh lebih masuk akal.',
    ],
    highlights: [
      {
        icon: 'route',
        title: 'Udara, laut, atau darat',
        text: 'Kedatangan lewat udara dan laut dideklarasikan melalui All Indonesia, sedangkan perlintasan darat masih memakai e-CD Bea Cukai. Traveler tetap wajib mendeklarasikan barang titipan dengan jujur di jalur mana pun.',
      },
      {
        icon: 'package',
        title: 'Gabungkan titipan kecil',
        text: 'Nilai barang minimum per titipan saat ini {MIN_ITEM}, dan beberapa biaya punya nilai minimum (fee traveler {MIN_TRAVELER_FEE}, platform fee {MIN_PLATFORM_FEE}). Titip beberapa barang sekaligus agar rincian biaya tetap efisien.',
      },
      {
        icon: 'shirt',
        title: 'Pakaian bekas dilarang',
        text: 'Pakaian bekas/preloved dilarang diimpor ke Indonesia. Hanya pakaian baru — lengkap dengan label atau struk — yang bisa dititipkan.',
      },
    ],
    categories: [
      { code: 'FOOD_SNACKS', examples: 'Coklat, kopi, biskuit oleh-oleh' },
      { code: 'FOOTWEAR', examples: 'Sepatu olahraga dari premium outlet' },
      { code: 'FASHION_APPAREL', examples: 'Pakaian baru brand lokal & outlet' },
      { code: 'BABY_KIDS', examples: 'Perlengkapan & pakaian bayi' },
      { code: 'BOOKS_MEDIA', examples: 'Buku impor & novel berbahasa Inggris' },
      { code: 'PERFUME', examples: 'Parfum & body mist' },
    ],
    merchants: [
      { name: 'Pavilion KL & Mid Valley', kind: 'mal besar Kuala Lumpur' },
      { name: 'Johor Premium Outlets', kind: 'outlet brand internasional' },
      { name: 'Toko coklat & kopi oleh-oleh', kind: 'camilan khas Malaysia' },
      { name: 'Toko buku besar KLCC', kind: 'buku impor' },
      { name: 'AEON & hypermarket', kind: 'kebutuhan rumah & bayi' },
      { name: 'Watsons & Guardian', kind: 'drugstore & perawatan diri' },
    ],
    example: {
      product: 'Sepatu olahraga dari outlet',
      categoryCode: 'FOOTWEAR',
      unitPrice: '399',
      quantity: 1,
      note: 'Harga outlet setelah diskon.',
    },
    restricted: [
      { code: 'RI_ID_FOOD_CATEGORY', title: 'Coklat, kopi & camilan', context: 'Oleh-oleh Malaysia paling umum.' },
      { code: 'RI_ID_USED_CLOTHING_KEYWORD', title: 'Pakaian bekas / thrift', context: 'Termasuk bundle preloved.' },
      { code: 'RI_ID_INFANT_FORMULA', title: 'Susu formula bayi', context: 'Sering dicari dari hypermarket.' },
      { code: 'RI_ID_TOBACCO_VAPE_CATEGORY', title: 'Rokok & vape', context: 'Tidak bisa dititipkan.' },
      { code: 'RI_ID_RICE_SUGAR', title: 'Beras & gula', context: 'Status sedang dikaji.' },
    ],
    tips: [
      {
        title: 'Cek minimum titipan',
        text: 'Nilai barang minimum per titipan ({MIN_ITEM}) berlaku untuk semua negara. Untuk oleh-oleh murah, kumpulkan beberapa barang dalam satu titipan atau ajak teman menitip bersama.',
      },
      {
        title: 'Tanggal kedaluwarsa makanan',
        text: 'Pangan olahan dibatasi untuk penggunaan pribadi (maks. 5 kg per penumpang). Minta traveler memotret tanggal kedaluwarsa, dan hindari produk berbahan daging atau susu segar.',
      },
      {
        title: 'Serah terima di kota perbatasan',
        text: 'Traveler dari Johor atau Kalimantan sering tiba di Batam, Pontianak, atau kota perbatasan lain. Cek kota tujuan trip dan pilih serah terima lewat kurir bila kamu tinggal di kota lain.',
      },
    ],
    faq: [
      {
        q: 'Apakah barang dari Malaysia lewat jalur darat juga kena bea masuk?',
        a: 'Ya. Barang titipan tetap bukan barang pribadi traveler, apa pun jalurnya. Bedanya hanya pada kanal deklarasi: kedatangan udara & laut lewat All Indonesia, darat lewat e-CD Bea Cukai.',
      },
      {
        q: 'Berapa estimasi bea & pajak untuk sepatu dari Malaysia?',
        a: 'Contoh {EXAMPLE_PRODUCT}: estimasi {EXAMPLE_TOTAL} atau sekitar {EXAMPLE_PCT}% dari nilai barang, dengan kurs pajak minggu ini. Nilai final ditetapkan Bea Cukai.',
      },
      {
        q: 'Bolehkah titip baju preloved dari Malaysia?',
        a: 'Tidak. Impor pakaian bekas dilarang (Permendag), sehingga JastipKita memblokir titipan pakaian bekas/preloved di checkout.',
      },
      {
        q: 'Kenapa titipan coklat murah saya ditolak?',
        a: 'Ada nilai barang minimum per titipan ({MIN_ITEM}) agar biaya layanan tetap wajar bagi kamu dan traveler. Gabungkan beberapa barang dalam satu titipan untuk melewati batas tersebut.',
      },
    ],
  },
  {
    code: 'AU',
    slug: 'jastip-australia',
    nameId: 'Australia',
    nameEn: 'Australia',
    currency: 'AUD',
    cities: ['Sydney', 'Melbourne', 'Perth', 'Brisbane'],
    cardLine: 'Vitamin, skincare & boots',
    title: 'Jastip Australia Aman — Titip Vitamin, Skincare & Boots',
    description:
      'Titip beli vitamin, skincare natural, boots, dan perlengkapan bayi dari Australia lewat traveler terverifikasi. Batas suplemen, aturan karantina, estimasi bea & pajak, dana ditahan SafePay.',
    h1: 'Jastip Australia: vitamin, skincare & boots, dengan aturan karantina yang jelas',
    lead: 'Dari chemist di Sydney sampai outlet di Melbourne — titip ke traveler terverifikasi dan ketahui batasnya sebelum membayar.',
    intro: [
      'Australia terkenal dengan vitamin dan suplemen dari chemist, skincare berbahan alami, boots kulit domba, dan perlengkapan bayi. Banyak juga yang mencari madu manuka dan produk susu — dua hal yang justru paling sering bermasalah di karantina.',
      'Karena itu halaman ini menonjolkan aturannya: suplemen dibatasi 5 pcs per jenis, susu formula dibatasi, dan produk hewani seperti madu, keju, atau dendeng dapat memerlukan dokumen karantina. JastipKita memeriksa setiap titipan terhadap daftar ini sebelum checkout.',
    ],
    highlights: [
      {
        icon: 'pill',
        title: 'Vitamin: 5 pcs per jenis',
        text: 'Batas ini berlaku per penumpang untuk penggunaan pribadi. Titipan yang melewati batas ditolak sistem supaya traveler tidak membawa jumlah komersial.',
      },
      {
        icon: 'shield-alert',
        title: 'Produk hewani & karantina',
        text: 'Madu, produk susu, daging olahan, dan dendeng dapat termasuk produk hewan yang diawasi Badan Karantina Indonesia. Sebagian kategori masih dikaji, jadi cek dulu sebelum menitip.',
      },
      {
        icon: 'baby',
        title: 'Susu formula dibatasi',
        text: 'Susu formula bayi diawasi BPOM dan tidak dikecualikan untuk barang titipan. Pemeriksa JastipKita menandainya sebagai barang terbatas yang perlu persetujuanmu.',
      },
    ],
    categories: [
      { code: 'SUPPLEMENTS_VITAMINS', examples: 'Multivitamin, fish oil, probiotik' },
      { code: 'COSMETICS_SKINCARE', examples: 'Skincare natural, lip balm, sunscreen' },
      { code: 'FOOTWEAR', examples: 'Boots kulit domba, sepatu outdoor' },
      { code: 'BABY_KIDS', examples: 'Perlengkapan & pakaian bayi' },
      { code: 'FOOD_SNACKS', examples: 'Biskuit coklat, camilan kemasan' },
      { code: 'SPORTS_OUTDOOR', examples: 'Perlengkapan hiking & surfing' },
    ],
    merchants: [
      { name: 'Chemist & apotek besar', kind: 'vitamin, suplemen & skincare' },
      { name: 'Supermarket nasional', kind: 'camilan & kebutuhan rumah' },
      { name: 'Department store', kind: 'fashion & kosmetik premium' },
      { name: 'Toko boots & outlet (DFO)', kind: 'boots & fashion harga outlet' },
      { name: 'Toko perlengkapan outdoor', kind: 'hiking, camping, surfing' },
      { name: 'Toko kosmetik premium', kind: 'skincare & makeup' },
    ],
    example: {
      product: 'Boots kulit domba',
      categoryCode: 'FOOTWEAR',
      unitPrice: '260',
      quantity: 1,
      note: 'Harga toko sudah termasuk GST Australia.',
    },
    restricted: [
      { code: 'RI_ID_SUPPLEMENTS_CATEGORY', title: 'Vitamin & suplemen', context: 'Kategori jastip Australia paling populer.' },
      { code: 'RI_ID_HONEY_DAIRY', title: 'Madu manuka & produk susu', context: 'Status sedang dikaji — cek sebelum menitip.' },
      { code: 'RI_ID_INFANT_FORMULA', title: 'Susu formula bayi', context: 'Diawasi BPOM.' },
      { code: 'RI_ID_ANIMAL_PRODUCTS_KEYWORD', title: 'Dendeng, daging & sosis', context: 'Produk hewani olahan.' },
      { code: 'RI_ID_MEDICINE_CATEGORY', title: 'Obat bebas', context: 'Ada batas jumlah per jenis.' },
    ],
    tips: [
      {
        title: 'Harga promo chemist cepat berubah',
        text: 'Harga vitamin di chemist sering berganti mingguan. Bila harga di rak berbeda di luar toleransi, traveler akan meminta konfirmasi harga — kamu punya 15 menit untuk menyetujui atau menolak tanpa penalti.',
      },
      {
        title: 'Cairan & kaca di bagasi',
        text: 'Skincare cair, parfum, dan botol kaca menambah berat dan risiko pecah. Traveler bisa menolak titipan yang tidak muat kapasitas atau batas cairan kabin.',
      },
      {
        title: 'Musim terbalik untuk fashion',
        text: 'Saat Indonesia kemarau, Australia bisa sedang musim dingin — koleksi boots dan jaket justru lengkap. Manfaatkan untuk titipan musiman, tapi cek ukuran versi AU.',
      },
    ],
    faq: [
      {
        q: 'Bolehkah titip madu manuka dari Australia?',
        a: 'Madu dan produk susu dapat termasuk produk hewan yang diawasi Badan Karantina Indonesia. Aturan JastipKita untuk kategori ini masih dalam kajian (belum berlaku otomatis), jadi pemeriksa menandainya sebagai barang terbatas pangan dan kamu wajib menyetujui risikonya sebelum membayar.',
      },
      {
        q: 'Berapa estimasi bea & pajak untuk boots dari Australia?',
        a: 'Contoh {EXAMPLE_PRODUCT}: estimasi {EXAMPLE_TOTAL} atau sekitar {EXAMPLE_PCT}% dari nilai barang. Nilai final ditetapkan Bea Cukai berdasarkan kurs pada minggu kedatangan.',
      },
      {
        q: 'Berapa banyak vitamin Australia yang boleh dititip?',
        a: 'Maksimal 5 pcs per jenis produk per penumpang untuk penggunaan pribadi. Pemeriksa JastipKita otomatis menolak jumlah di atas batas itu.',
      },
      {
        q: 'Apakah trip dari Australia lebih lama sampai?',
        a: 'Bergantung pada traveler; banyak yang pulang untuk libur semester atau akhir tahun. Lihat tanggal tiba di setiap trip dan simpan draf titipanmu agar bisa langsung menawarkan saat trip baru muncul.',
      },
    ],
  },
];

export function countryBySlug(slug: string): CountryPage | undefined {
  return COUNTRY_PAGES.find((c) => c.slug === slug);
}
