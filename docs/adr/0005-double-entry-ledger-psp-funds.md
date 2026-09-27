# ADR 0005 — Double-entry ledger; funds held by a licensed PSP, not by JastipKita

- Status: Accepted (2026-09) — legal confirmation pending (see Consequences)
- Deciders: owner (GM), engineering, legal (pending)

## Context
SafePay holds a buyer's money until the item is delivered, sometimes for weeks. In Indonesia, receiving and
administering funds for other parties' payments is a regulated payment-service activity (PBI 23/6/PBI/2021,
research `docs/research/02-xendit-integration.md` §9). A marketplace that parks buyer money in its own bank account,
or offers a withdrawable balance, risks operating an unlicensed payment service / e-money.

## Decision
- Buyer funds are collected by **Xendit** (BI-licensed PJP) and stay in the provider balance (master or OWNED
  sub-account). JastipKita never routes funds through its own bank account.
- "Holding" is **accounting only**: an immutable double-entry ledger (`ledger_journals`, `ledger_entries`,
  balanced per currency at COMMIT) with buckets `PRODUCT_FUND`, `CUSTOMS_RESERVE`, `CLEARING`, `TRAVELER_EARNING`,
  `REFUND`, `PLATFORM_REVENUE`, `TAX_PAYABLE`, `PAYMENT_FEE`, `PROMOTION_CREDIT` vs external `PROVIDER_CASH`.
- Release to travelers by provider payout after `BUYER_CONFIRMED`; refunds by provider refund or payout to a
  validated buyer account. Corrections only by reversal journals.
- JastipKita Credit is closed-loop and non-withdrawable.
- Live money is impossible without `XENDIT_ENV=live` **and** `ALLOW_LIVE_PAYMENTS=true` (env validation) **and** the
  recorded owner decision checked by `deploy-production.yml`.

## Consequences
- Every rupiah is traceable per transaction (`v_transaction_ledger`) and reconciled daily against the provider.
- Open items before LIVE: written confirmation from Xendit that long holds are allowed for this use case, legal
  opinion (escrow vs trustee account), tax treatment of fees and traveler income (`docs/checklists/launch-checklist.md`).
- Refund channel limits (VA/retail cannot refund) force payout-to-buyer flows and bank-account validation (Iluma not
  wired yet → refunds needing a destination are refused rather than trusted blindly).

## Alternatives considered
- Own escrow bank account — requires licensing/trust structure; rejected for MVP.
- Split rules at settlement — pays the traveler before delivery; incompatible with escrow.
