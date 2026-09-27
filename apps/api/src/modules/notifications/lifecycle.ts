/**
 * E-mail lifecycle required by the product brief (§18) → source event → template.
 * `status` = transaction.status_changed `to`; `role` = recipient side when the template branches.
 * Used by the docs and by templates.test.ts ("every lifecycle event has a template").
 */
export interface LifecycleEntry {
  step: string;
  event: string;
  status?: string;
  template: string;
  role?: 'BUYER' | 'TRAVELER';
}

export const EMAIL_LIFECYCLE: readonly LifecycleEntry[] = [
  { step: 'Account registration', event: 'user.registered', template: 'account.welcome' },
  { step: 'KYC submitted', event: 'kyc.submitted', template: 'kyc.submitted' },
  { step: 'KYC approved', event: 'kyc.approved', template: 'kyc.approved' },
  { step: 'KYC rejected', event: 'kyc.rejected', template: 'kyc.rejected' },
  { step: 'Request created', event: 'request.created', template: 'request.created', role: 'BUYER' },
  { step: 'Traveler matched', event: 'transaction.status_changed', status: 'MATCHED', template: 'transaction.matched', role: 'BUYER' },
  { step: 'Request accepted', event: 'transaction.status_changed', status: 'MATCHED', template: 'transaction.matched', role: 'TRAVELER' },
  { step: 'Payment (checkout created)', event: 'payment.checkout_created', template: 'payment.checkout_created', role: 'BUYER' },
  { step: 'Payment secured', event: 'transaction.status_changed', status: 'PAYMENT_SECURED', template: 'transaction.payment_secured', role: 'BUYER' },
  { step: 'Price adjustment requested', event: 'price_confirmation.requested', template: 'price.change_requested', role: 'BUYER' },
  { step: 'Price approval result', event: 'price_confirmation.resolved', template: 'price.change_result', role: 'BUYER' },
  { step: 'Product purchased', event: 'transaction.status_changed', status: 'PURCHASED', template: 'transaction.purchased', role: 'BUYER' },
  { step: 'Receipt available', event: 'purchase.proof_submitted', template: 'purchase.receipt_available', role: 'BUYER' },
  { step: 'Traveler departure', event: 'transaction.status_changed', status: 'TRAVELING', template: 'transaction.traveling', role: 'BUYER' },
  { step: 'Traveler arrival', event: 'transaction.status_changed', status: 'ARRIVED', template: 'transaction.arrived', role: 'BUYER' },
  { step: 'Customs', event: 'transaction.status_changed', status: 'CUSTOMS_PROCESS', template: 'transaction.customs', role: 'BUYER' },
  { step: 'Out for delivery', event: 'transaction.status_changed', status: 'OUT_FOR_DELIVERY', template: 'transaction.out_for_delivery', role: 'BUYER' },
  { step: 'Ready for handover', event: 'transaction.status_changed', status: 'READY_FOR_HANDOVER', template: 'transaction.ready_for_handover', role: 'BUYER' },
  { step: 'PIN/QR ready (no PIN in e-mail)', event: 'delivery.pin_ready', template: 'delivery.pin_ready', role: 'BUYER' },
  { step: 'Item received (delivered)', event: 'transaction.status_changed', status: 'DELIVERED', template: 'transaction.delivered', role: 'BUYER' },
  { step: 'Transaction completed', event: 'transaction.status_changed', status: 'COMPLETED', template: 'transaction.completed', role: 'BUYER' },
  { step: 'Traveler payout scheduled', event: 'payout.scheduled', template: 'payout.scheduled', role: 'TRAVELER' },
  { step: 'Traveler payout paid', event: 'payout.paid', template: 'payout.paid', role: 'TRAVELER' },
  { step: 'Refund requested', event: 'refund.requested', template: 'refund.requested', role: 'BUYER' },
  { step: 'Refund succeeded', event: 'refund.succeeded', template: 'refund.succeeded', role: 'BUYER' },
  { step: 'Refund failed', event: 'refund.failed', template: 'refund.failed', role: 'BUYER' },
  { step: 'Dispute opened', event: 'dispute.opened', template: 'dispute.opened' },
  { step: 'Dispute updated', event: 'dispute.status_changed', template: 'dispute.updated' },
  { step: 'Dispute resolved', event: 'dispute.resolved', template: 'dispute.resolved' },
  { step: 'Final receipt', event: 'receipt.final_available', template: 'receipt.final', role: 'BUYER' },
  // QA 2026-09-28 (BUG-QA-01..04) and SEC-12
  { step: 'Price clarification requested (traveler)', event: 'price_confirmation.clarification_requested', template: 'price.clarification_requested', role: 'TRAVELER' },
  { step: 'Refund destination required (VA/retail)', event: 'refund.destination_required', template: 'refund.destination_required', role: 'BUYER' },
  { step: 'Refund destination set', event: 'refund.destination_set', template: 'refund.destination_updated', role: 'BUYER' },
  { step: 'Trip cancelled by traveler (buyer)', event: 'transaction.trip_cancelled', template: 'transaction.trip_cancelled', role: 'BUYER' },
  { step: 'Trip cancelled by traveler (traveler)', event: 'transaction.trip_cancelled', template: 'transaction.trip_cancelled', role: 'TRAVELER' },
];
