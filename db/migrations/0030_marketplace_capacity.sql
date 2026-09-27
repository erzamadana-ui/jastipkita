-- 0030_marketplace_capacity.sql
-- Marketplace: per-transaction trip capacity reservations. trips.reserved_kg / reserved_items are
-- the running totals; this table is the ledger that makes reserve/release idempotent (one row per
-- transaction, released at most once) so outbox consumers can safely replay
-- transaction.status_changed events.
BEGIN;

CREATE TABLE IF NOT EXISTS trip_capacity_reservations (
  transaction_id uuid PRIMARY KEY REFERENCES transactions(id),
  trip_id        uuid NOT NULL REFERENCES trips(id),
  offer_id       uuid REFERENCES offers(id),
  kg             numeric(6,2) NOT NULL CHECK (kg >= 0),
  items          integer NOT NULL DEFAULT 0 CHECK (items >= 0),
  reserved_at    timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  release_reason text CHECK (release_reason IS NULL OR char_length(release_reason) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS trip_capacity_reservations_trip_idx ON trip_capacity_reservations (trip_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS trip_capacity_reservations_trip_id_idx ON trip_capacity_reservations (trip_id);
CREATE INDEX IF NOT EXISTS trip_capacity_reservations_offer_id_idx ON trip_capacity_reservations (offer_id);
SELECT jk_attach_updated_at('trip_capacity_reservations');

-- Public discovery: ACTIVE trips by departure date (keyset pagination).
CREATE INDEX IF NOT EXISTS trips_discovery_idx ON trips (departure_date, id) WHERE status = 'ACTIVE';

SELECT jk_apply_grants();

COMMIT;
