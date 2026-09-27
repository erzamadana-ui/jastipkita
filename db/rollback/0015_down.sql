-- 0015_down.sql — drops the derived metric views created by 0015_analytics_views.sql.
-- Safe: views hold no data. Apply only while 0015 is the latest applied migration:
--   db/scripts/migrate.sh --rollback 0015
BEGIN;
DROP VIEW IF EXISTS v_traveler_utilization;
DROP VIEW IF EXISTS v_dispute_rate;
DROP VIEW IF EXISTS v_refund_rate;
DROP VIEW IF EXISTS v_take_rate;
DROP VIEW IF EXISTS v_gmv_daily;
DROP VIEW IF EXISTS v_completed_transaction_lines;
DROP VIEW IF EXISTS v_funnel_daily;
COMMIT;
