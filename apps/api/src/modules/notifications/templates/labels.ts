import type { DisputeResolution, DisputeStatus, DisputeType, TransactionStatus } from '@jastipkita/core';
import type { Locale } from './format';

type L = Record<Locale, string>;

export const TX_STATUS_LABEL: Record<TransactionStatus, L> = {
  REQUEST_CREATED: { id: 'Titipan dibuat', en: 'Request created' },
  MATCHED: { id: 'Traveler ditemukan', en: 'Traveler matched' },
  AWAITING_PAYMENT: { id: 'Menunggu pembayaran', en: 'Awaiting payment' },
  PAYMENT_SECURED: { id: 'Pembayaran aman', en: 'Payment secured' },
  PRICE_CHANGE_PENDING: { id: 'Menunggu konfirmasi harga', en: 'Price change pending' },
  PURCHASE_APPROVED: { id: 'Pembelian disetujui', en: 'Purchase approved' },
  PURCHASED: { id: 'Barang sudah dibeli', en: 'Item purchased' },
  TRAVELING: { id: 'Dalam perjalanan', en: 'Traveling' },
  ARRIVED: { id: 'Traveler tiba', en: 'Traveler arrived' },
  CUSTOMS_PROCESS: { id: 'Proses bea cukai', en: 'Customs processing' },
  READY_FOR_HANDOVER: { id: 'Siap diserahkan', en: 'Ready for handover' },
  OUT_FOR_DELIVERY: { id: 'Sedang dikirim', en: 'Out for delivery' },
  DELIVERED: { id: 'Barang diterima', en: 'Delivered' },
  BUYER_CONFIRMED: { id: 'Dikonfirmasi penitip', en: 'Confirmed by buyer' },
  COMPLETED: { id: 'Selesai', en: 'Completed' },
  CANCELLED: { id: 'Dibatalkan', en: 'Cancelled' },
  DISPUTED: { id: 'Dalam dispute', en: 'Disputed' },
  REFUND_PENDING: { id: 'Refund diproses', en: 'Refund pending' },
  REFUNDED: { id: 'Dana dikembalikan', en: 'Refunded' },
};

export function txStatusLabel(status: unknown, locale: Locale): string {
  const l = TX_STATUS_LABEL[status as TransactionStatus];
  return l ? l[locale] : String(status ?? '-');
}

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, L> = {
  OPEN: { id: 'Dibuka', en: 'Open' },
  EVIDENCE_COLLECTION: { id: 'Pengumpulan bukti', en: 'Evidence collection' },
  UNDER_REVIEW: { id: 'Sedang ditinjau', en: 'Under review' },
  RESOLVED: { id: 'Diputuskan', en: 'Resolved' },
  APPEALED: { id: 'Banding diajukan', en: 'Appealed' },
  CLOSED: { id: 'Ditutup', en: 'Closed' },
};

export const DISPUTE_TYPE_LABEL: Record<DisputeType, L> = {
  ITEM_NOT_RECEIVED: { id: 'Barang tidak diterima', en: 'Item not received' },
  WRONG_ITEM: { id: 'Barang tidak sesuai', en: 'Wrong item' },
  DAMAGED_ITEM: { id: 'Barang rusak', en: 'Damaged item' },
  COUNTERFEIT: { id: 'Barang palsu', en: 'Counterfeit' },
  PRICE_DISPUTE: { id: 'Sengketa harga', en: 'Price dispute' },
  DELIVERY_DISPUTE: { id: 'Sengketa pengiriman', en: 'Delivery dispute' },
  OTHER: { id: 'Lainnya', en: 'Other' },
};

export const DISPUTE_RESOLUTION_LABEL: Record<DisputeResolution, L> = {
  REFUND_FULL: { id: 'Refund penuh', en: 'Full refund' },
  REFUND_PARTIAL: { id: 'Refund sebagian', en: 'Partial refund' },
  NO_REFUND: { id: 'Tanpa refund', en: 'No refund' },
  RETURN_AND_REFUND: { id: 'Retur & refund', en: 'Return & refund' },
  OTHER: { id: 'Lainnya', en: 'Other' },
};

export function label<K extends string>(map: Record<K, L>, key: unknown, locale: Locale): string {
  const l = map[key as K];
  return l ? l[locale] : String(key ?? '-');
}

/** Indonesian text of the STATUS chat message posted on every transaction status change. */
export const CHAT_STATUS_TEXT: Partial<Record<TransactionStatus, string>> = {
  MATCHED: 'Traveler ditemukan. Chat ini khusus untuk titipan {number} — semua pembayaran hanya lewat SafePay.',
  AWAITING_PAYMENT: 'Menunggu pembayaran penitip lewat SafePay.',
  PAYMENT_SECURED: 'Pembayaran aman di SafePay. Traveler: jangan beli dulu sampai status Pembelian Disetujui.',
  PRICE_CHANGE_PENDING: 'Traveler mengajukan perubahan harga. Menunggu konfirmasi penitip.',
  PURCHASE_APPROVED: 'Pembelian disetujui. Traveler boleh membeli barang sekarang.',
  PURCHASED: 'Barang sudah dibeli traveler. Bukti pembelian tersedia di detail transaksi.',
  TRAVELING: 'Traveler sudah berangkat membawa titipan.',
  ARRIVED: 'Traveler sudah tiba.',
  CUSTOMS_PROCESS: 'Titipan sedang dalam proses bea cukai.',
  READY_FOR_HANDOVER: 'Titipan siap diserahkan.',
  OUT_FOR_DELIVERY: 'Titipan sedang dikirim ke penitip.',
  DELIVERED: 'Titipan sudah diterima. Periksa barang, lalu konfirmasi atau buka dispute bila ada masalah.',
  BUYER_CONFIRMED: 'Penitip sudah mengonfirmasi penerimaan barang.',
  COMPLETED: 'Transaksi selesai. Terima kasih! Jangan lupa beri rating.',
  CANCELLED: 'Transaksi dibatalkan.',
  DISPUTED: 'Dispute dibuka. Tim JastipKita akan meninjau kasus ini.',
  REFUND_PENDING: 'Refund sedang diproses.',
  REFUNDED: 'Dana sudah dikembalikan ke penitip.',
};

/** Safety tip posted (SYSTEM message) after a message is flagged by chat moderation. */
export const CHAT_SAFETY_TIP =
  'Demi keamanan, jangan bayar atau bertukar kontak di luar JastipKita. Transaksi di luar SafePay tidak dilindungi. Info sensitif pada pesan telah disembunyikan.';
