import { describe, expect, it } from 'vitest';
import { MASK, moderateText } from './moderation';

describe('chat moderation', () => {
  it.each([
    ['Transfer langsung aja ke BCA 1234567890 a.n. Dimas ya', ['BANK_ACCOUNT', 'OFF_PLATFORM_PAYMENT']],
    ['bayar di luar aplikasi biar gak kena fee', ['OFF_PLATFORM_PAYMENT']],
    ['WA aku di 0812-3456-7890 ya', ['CONTACT_PHONE']],
    ['chat aku +62 812 3456 7890', ['CONTACT_PHONE']],
    ['cek wa.me/6281234567890', ['CONTACT_LINK']],
    ['email saya dimas.p@gmail.com', ['CONTACT_EMAIL']],
    ['norek saya 123-456-7890-12', ['BANK_ACCOUNT', 'OFF_PLATFORM_PAYMENT']],
  ])('flags %s', (text, reasons) => {
    const r = moderateText(text);
    expect(r.flagged).toBe(true);
    expect(r.reasons).toEqual(reasons);
  });

  it('masks the sensitive parts but keeps the rest of the sentence', () => {
    const r = moderateText('WA aku di 0812-3456-7890 atau email dimas.p@gmail.com');
    expect(r.masked).toBe(`WA aku di ${MASK} atau email ${MASK}`);
    expect(r.masked).not.toMatch(/\d{4}/);
  });

  it.each([
    'Harganya Rp 15.000.000 ya kak',
    'Totalnya Rp15000000',
    'Budget 2500000 rupiah',
    'Nomor transaksi JK-260927-7K2M9Q',
    'Barangnya sudah dibeli, struknya aku upload di aplikasi',
    'Aku sampai Jakarta tanggal 12, ketemu di stasiun jam 15.30?',
    'Ukuran 42, warna hitam, 2 pcs',
  ])('does not flag normal messages: %s', (text) => {
    const r = moderateText(text);
    expect(r.flagged).toBe(false);
    expect(r.masked).toBe(text);
  });
});
