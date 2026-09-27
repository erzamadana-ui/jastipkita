-- 0015_analytics_views.sql
-- Business metric views (read-only, derived; safe for jk_readonly). Days/months are
-- calendar WIB (Asia/Jakarta). Reversible: db/rollback/0015_down.sql.
BEGIN;

-- Funnel from DB facts (not client analytics): signups -> requests -> offers ->
-- transaction milestones. Counts distinct entities reaching a step on that day.
CREATE OR REPLACE VIEW v_funnel_daily AS
WITH tx AS (
  SELECT (created_at AT TIME ZONE 'Asia/Jakarta')::date AS day,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'REQUEST_CREATED')  AS tx_created,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'MATCHED')          AS tx_matched,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'AWAITING_PAYMENT') AS tx_checkout,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'PAYMENT_SECURED')  AS tx_payment_secured,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'PURCHASED')        AS tx_purchased,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'DELIVERED')        AS tx_delivered,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'COMPLETED')        AS tx_completed,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'CANCELLED')        AS tx_cancelled,
         count(DISTINCT transaction_id) FILTER (WHERE to_status = 'REFUNDED')         AS tx_refunded
    FROM transaction_events GROUP BY 1
), su AS (
  SELECT (created_at AT TIME ZONE 'Asia/Jakarta')::date AS day, count(*) AS signups FROM users GROUP BY 1
), rq AS (
  SELECT (created_at AT TIME ZONE 'Asia/Jakarta')::date AS day, count(*) AS requests_created FROM requests GROUP BY 1
), rp AS (
  SELECT (published_at AT TIME ZONE 'Asia/Jakarta')::date AS day, count(*) AS requests_published
    FROM requests WHERE published_at IS NOT NULL GROUP BY 1
), oc AS (
  SELECT (created_at AT TIME ZONE 'Asia/Jakarta')::date AS day, count(*) AS offers_created FROM offers GROUP BY 1
), oa AS (
  SELECT (responded_at AT TIME ZONE 'Asia/Jakarta')::date AS day, count(*) AS offers_accepted
    FROM offers WHERE status = 'ACCEPTED' AND responded_at IS NOT NULL GROUP BY 1
), days AS (
  SELECT day FROM tx UNION SELECT day FROM su UNION SELECT day FROM rq
  UNION SELECT day FROM rp UNION SELECT day FROM oc UNION SELECT day FROM oa
)
SELECT d.day,
       coalesce(su.signups, 0)            AS signups,
       coalesce(rq.requests_created, 0)   AS requests_created,
       coalesce(rp.requests_published, 0) AS requests_published,
       coalesce(oc.offers_created, 0)     AS offers_created,
       coalesce(oa.offers_accepted, 0)    AS offers_accepted,
       coalesce(tx.tx_created, 0)         AS tx_created,
       coalesce(tx.tx_matched, 0)         AS tx_matched,
       coalesce(tx.tx_checkout, 0)        AS tx_checkout,
       coalesce(tx.tx_payment_secured, 0) AS tx_payment_secured,
       coalesce(tx.tx_purchased, 0)       AS tx_purchased,
       coalesce(tx.tx_delivered, 0)       AS tx_delivered,
       coalesce(tx.tx_completed, 0)       AS tx_completed,
       coalesce(tx.tx_cancelled, 0)       AS tx_cancelled,
       coalesce(tx.tx_refunded, 0)        AS tx_refunded
  FROM days d
  LEFT JOIN tx USING (day) LEFT JOIN su USING (day) LEFT JOIN rq USING (day)
  LEFT JOIN rp USING (day) LEFT JOIN oc USING (day) LEFT JOIN oa USING (day);

-- Per completed transaction price lines of its active (accepted) quote.
CREATE OR REPLACE VIEW v_completed_transaction_lines AS
SELECT t.id AS transaction_id,
       (t.completed_at AT TIME ZONE 'Asia/Jakarta')::date AS day,
       t.total_idr,
       coalesce(sum(ql.amount_idr) FILTER (WHERE ql.line_type = 'ITEM_PRICE'), 0)            AS item_price_idr,
       coalesce(sum(ql.amount_idr) FILTER (WHERE ql.line_type = 'TRAVELER_FEE'), 0)          AS traveler_fee_idr,
       coalesce(sum(ql.amount_idr) FILTER (WHERE ql.bucket = 'PLATFORM_REVENUE'), 0)         AS platform_revenue_idr,
       coalesce(-sum(ql.amount_idr) FILTER (WHERE ql.line_type IN ('DISCOUNT','REFERRAL_CREDIT')), 0) AS promo_cost_idr
  FROM transactions t
  LEFT JOIN quote_lines ql ON ql.quote_id = t.active_quote_id
 WHERE t.status = 'COMPLETED'
 GROUP BY t.id;

-- GMV = sum of ITEM_PRICE lines of COMPLETED transactions (by completion day).
CREATE OR REPLACE VIEW v_gmv_daily AS
SELECT day,
       count(*)              AS completed_transactions,
       sum(item_price_idr)   AS gmv_idr,
       sum(total_idr)        AS total_collected_idr,
       round(avg(item_price_idr)) AS avg_item_price_idr
  FROM v_completed_transaction_lines GROUP BY day;

-- Take rate from priced quote lines. Finance-grade numbers come from the ledger
-- (ledger_bucket_balances); this view is the product/BI approximation.
CREATE OR REPLACE VIEW v_take_rate AS
SELECT day,
       sum(item_price_idr)       AS gmv_idr,
       sum(platform_revenue_idr) AS platform_revenue_idr,
       sum(traveler_fee_idr)     AS traveler_fee_idr,
       sum(promo_cost_idr)       AS promo_cost_idr,
       round(sum(platform_revenue_idr)::numeric / nullif(sum(item_price_idr), 0), 6) AS take_rate,
       round((sum(platform_revenue_idr) - sum(promo_cost_idr))::numeric / nullif(sum(item_price_idr), 0), 6) AS net_take_rate
  FROM v_completed_transaction_lines GROUP BY day;

-- Refund rate by calendar month (event month for both numerator and denominator).
CREATE OR REPLACE VIEW v_refund_rate AS
WITH paid AS (
  SELECT date_trunc('month', secured_at AT TIME ZONE 'Asia/Jakarta')::date AS month,
         count(DISTINCT transaction_id) AS paid_transactions, sum(amount_idr) AS secured_idr
    FROM payments WHERE secured_at IS NOT NULL GROUP BY 1
), ref AS (
  SELECT date_trunc('month', coalesce(processed_at, updated_at) AT TIME ZONE 'Asia/Jakarta')::date AS month,
         count(DISTINCT transaction_id) AS refunded_transactions, sum(amount_idr) AS refunded_idr,
         count(*) FILTER (WHERE type = 'FULL') AS full_refunds, count(*) FILTER (WHERE type = 'PARTIAL') AS partial_refunds
    FROM refunds WHERE status = 'SUCCEEDED' GROUP BY 1
)
SELECT coalesce(paid.month, ref.month) AS month,
       coalesce(paid_transactions, 0) AS paid_transactions,
       coalesce(refunded_transactions, 0) AS refunded_transactions,
       coalesce(full_refunds, 0) AS full_refunds,
       coalesce(partial_refunds, 0) AS partial_refunds,
       coalesce(secured_idr, 0) AS secured_idr,
       coalesce(refunded_idr, 0) AS refunded_idr,
       round(coalesce(refunded_transactions, 0)::numeric / nullif(paid_transactions, 0), 6) AS refund_rate_count,
       round(coalesce(refunded_idr, 0)::numeric / nullif(secured_idr, 0), 6) AS refund_rate_amount
  FROM paid FULL JOIN ref ON ref.month = paid.month;

-- Dispute rate: disputes opened in month / transactions delivered in month.
CREATE OR REPLACE VIEW v_dispute_rate AS
WITH dl AS (
  SELECT date_trunc('month', delivered_at AT TIME ZONE 'Asia/Jakarta')::date AS month, count(*) AS delivered_transactions
    FROM transactions WHERE delivered_at IS NOT NULL GROUP BY 1
), ds AS (
  SELECT date_trunc('month', created_at AT TIME ZONE 'Asia/Jakarta')::date AS month,
         count(*) AS disputes_opened,
         count(*) FILTER (WHERE resolution IN ('REFUND_FULL','REFUND_PARTIAL','RETURN_AND_REFUND')) AS disputes_refunded,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (resolved_at - created_at)) / 3600)
           FILTER (WHERE resolved_at IS NOT NULL) AS median_hours_to_resolve
    FROM disputes GROUP BY 1
)
SELECT coalesce(dl.month, ds.month) AS month,
       coalesce(delivered_transactions, 0) AS delivered_transactions,
       coalesce(disputes_opened, 0) AS disputes_opened,
       coalesce(disputes_refunded, 0) AS disputes_refunded,
       round(median_hours_to_resolve::numeric, 1) AS median_hours_to_resolve,
       round(coalesce(disputes_opened, 0)::numeric / nullif(delivered_transactions, 0), 6) AS dispute_rate
  FROM dl FULL JOIN ds ON ds.month = dl.month;

-- Capacity utilization per trip (reserved vs capacity) and matched transactions.
CREATE OR REPLACE VIEW v_traveler_utilization AS
SELECT tr.id AS trip_id, tr.traveler_id, tr.origin_country, tr.destination_country,
       tr.departure_date, tr.arrival_date, tr.status,
       tr.capacity_kg, tr.reserved_kg,
       round(tr.reserved_kg / nullif(tr.capacity_kg, 0), 4) AS utilization,
       count(t.id) FILTER (WHERE t.status NOT IN ('CANCELLED','REFUNDED')) AS live_transactions,
       count(t.id) FILTER (WHERE t.status = 'COMPLETED') AS completed_transactions,
       coalesce(sum(t.total_idr) FILTER (WHERE t.status = 'COMPLETED'), 0) AS completed_value_idr
  FROM trips tr
  LEFT JOIN transactions t ON t.trip_id = tr.id
 GROUP BY tr.id;

COMMIT;
