-- 0007_trips_requests.sql
-- Traveler trips (FSM §3), trip verification docs, buyer requests, offers.
BEGIN;

CREATE TABLE IF NOT EXISTS trips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traveler_id         uuid NOT NULL REFERENCES users(id),
  origin_country      char(2) NOT NULL REFERENCES countries(code),
  origin_city         text NOT NULL,
  destination_country char(2) NOT NULL REFERENCES countries(code),
  destination_city    text NOT NULL,
  departure_date      date NOT NULL,
  arrival_date        date NOT NULL,
  return_date         date,
  capacity_kg         numeric(6,2) NOT NULL CHECK (capacity_kg > 0),
  reserved_kg         numeric(6,2) NOT NULL DEFAULT 0,
  max_items           integer CHECK (max_items IS NULL OR max_items > 0),
  reserved_items      integer NOT NULL DEFAULT 0 CHECK (reserved_items >= 0),
  fee_type            text NOT NULL CHECK (fee_type IN ('FIXED','PERCENT','PER_KG')),
  fee_value           bigint NOT NULL CHECK (fee_value >= 0),   -- IDR for FIXED/PER_KG, bps for PERCENT
  excluded_categories text[] NOT NULL DEFAULT '{}',
  notes               text,
  status              text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','VERIFICATION_PENDING','VERIFIED','ACTIVE','FULL','TRAVELING','COMPLETED','CANCELLED')),
  verified_at         timestamptz,
  published_at        timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_reason    text,
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, traveler_id),                               -- composite FK target
  CHECK (arrival_date >= departure_date),
  CHECK (return_date IS NULL OR return_date >= departure_date),
  CHECK (reserved_kg >= 0 AND reserved_kg <= capacity_kg),
  CHECK (max_items IS NULL OR reserved_items <= max_items),
  CHECK (fee_type <> 'PERCENT' OR fee_value <= 10000),
  CHECK (origin_country <> destination_country),
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);
-- Matching: open trips by route and date window.
CREATE INDEX IF NOT EXISTS trips_match_idx ON trips (destination_country, origin_country, arrival_date)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS trips_match_city_idx ON trips (origin_country, lower(origin_city), departure_date)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS trips_traveler_idx ON trips (traveler_id, status, departure_date DESC);
CREATE INDEX IF NOT EXISTS trips_origin_country_idx ON trips (origin_country);
CREATE INDEX IF NOT EXISTS trips_status_departure_idx ON trips (status, departure_date);
SELECT jk_attach_updated_at('trips');

CREATE TABLE IF NOT EXISTS trip_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  actor_types text[] NOT NULL CHECK (actor_types <@ ARRAY['TRAVELER','SYSTEM','ADMIN'] AND cardinality(actor_types) > 0),
  description text,
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status IN ('DRAFT','VERIFICATION_PENDING','VERIFIED','ACTIVE','FULL','TRAVELING','COMPLETED','CANCELLED')),
  CHECK (to_status   IN ('DRAFT','VERIFICATION_PENDING','VERIFIED','ACTIVE','FULL','TRAVELING','COMPLETED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS trip_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     uuid NOT NULL REFERENCES trips(id),
  from_status text,
  to_status   text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('TRAVELER','SYSTEM','ADMIN')),
  actor_id    uuid,
  reason      text,
  meta        jsonb NOT NULL DEFAULT '{}',
  version     integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_events_trip_idx ON trip_events (trip_id, id);
SELECT jk_make_append_only('trip_events');

CREATE OR REPLACE TRIGGER trg_status_via_function BEFORE INSERT OR UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION jk_status_via_function_only('DRAFT');

CREATE OR REPLACE FUNCTION jk_trip_created_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO trip_events (trip_id, from_status, to_status, actor_type, actor_id, version)
  VALUES (NEW.id, NULL, NEW.status, 'TRAVELER', NEW.traveler_id, NEW.version);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_trip_created_event AFTER INSERT ON trips
  FOR EACH ROW EXECUTE FUNCTION jk_trip_created_event();

-- Validates (from,to,actor) against trip_transitions, bumps version, writes
-- trip_events + outbox_events + audit_logs atomically. Business guards (KYC level,
-- config trips.allow_unverified_active, capacity) are enforced by the API service.
CREATE OR REPLACE FUNCTION transition_trip(p_trip uuid, p_expected_version integer, p_to text, p_actor_type text,
                                           p_actor_id uuid, p_reason text DEFAULT NULL, p_meta jsonb DEFAULT '{}')
RETURNS trips
LANGUAGE plpgsql AS $$
DECLARE
  v_row trips%ROWTYPE;
  v_from text;
  v_actors text[];
BEGIN
  SELECT * INTO v_row FROM trips WHERE id = p_trip FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('trip %s not found', p_trip);
  END IF;
  IF v_row.version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'JK409',
      MESSAGE = format('trip %s version conflict: expected %s, current %s', p_trip, p_expected_version, v_row.version),
      DETAIL = json_build_object('currentVersion', v_row.version, 'currentStatus', v_row.status)::text;
  END IF;
  v_from := v_row.status;
  SELECT actor_types INTO v_actors FROM trip_transitions WHERE from_status = v_from AND to_status = p_to;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422', MESSAGE = format('illegal trip transition %s -> %s', v_from, p_to);
  END IF;
  IF NOT (p_actor_type = ANY (v_actors)) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK403',
      MESSAGE = format('actor %s may not move trip %s -> %s (allowed: %s)', p_actor_type, v_from, p_to, array_to_string(v_actors, ','));
  END IF;

  PERFORM set_config('jk.fsm_ctx', 'trips:' || p_trip, true);
  UPDATE trips
     SET status = p_to,
         version = version + 1,
         verified_at  = CASE WHEN p_to = 'VERIFIED'  THEN now() ELSE verified_at END,
         published_at = CASE WHEN p_to = 'ACTIVE' AND published_at IS NULL THEN now() ELSE published_at END,
         completed_at = CASE WHEN p_to = 'COMPLETED' THEN now() ELSE completed_at END,
         cancelled_at = CASE WHEN p_to = 'CANCELLED' THEN now() ELSE cancelled_at END,
         cancelled_reason = CASE WHEN p_to = 'CANCELLED' THEN p_reason ELSE cancelled_reason END
   WHERE id = p_trip
  RETURNING * INTO v_row;
  PERFORM set_config('jk.fsm_ctx', '', true);

  INSERT INTO trip_events (trip_id, from_status, to_status, actor_type, actor_id, reason, meta, version)
  VALUES (p_trip, v_from, p_to, p_actor_type, p_actor_id, p_reason, coalesce(p_meta, '{}'), v_row.version);
  PERFORM jk_outbox('trip', p_trip::text, 'trip.status_changed',
    jsonb_build_object('tripId', p_trip, 'from', v_from, 'to', p_to, 'version', v_row.version,
                       'travelerId', v_row.traveler_id, 'actorType', p_actor_type, 'actorId', p_actor_id, 'reason', p_reason));
  PERFORM jk_audit(p_actor_type, p_actor_id, 'trip.transition', 'trip', p_trip::text,
                   jsonb_build_object('status', v_from, 'version', p_expected_version),
                   jsonb_build_object('status', p_to, 'version', v_row.version),
                   jsonb_build_object('reason', p_reason) || coalesce(p_meta, '{}'));
  RETURN v_row;
END $$;

CREATE TABLE IF NOT EXISTS trip_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips(id),
  doc_type      text NOT NULL CHECK (doc_type IN ('ETICKET','ITINERARY','BOARDING_PASS')),
  file_id       uuid REFERENCES files(id),
  extracted     jsonb NOT NULL DEFAULT '{}',   -- parsed fields, no passenger ID numbers
  pnr_hash      bytea,
  flight_number text CHECK (flight_number IS NULL OR flight_number ~ '^[A-Z0-9]{2,3}[0-9]{1,5}[A-Z]?$'),
  flight_date   date,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'PENDING' OR reviewed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS trip_verifications_trip_id_idx ON trip_verifications (trip_id);
CREATE INDEX IF NOT EXISTS trip_verifications_file_id_idx ON trip_verifications (file_id);
CREATE INDEX IF NOT EXISTS trip_verifications_reviewed_by_idx ON trip_verifications (reviewed_by);
CREATE INDEX IF NOT EXISTS trip_verifications_pnr_idx ON trip_verifications (pnr_hash) WHERE pnr_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_verifications_queue_idx ON trip_verifications (created_at) WHERE status = 'PENDING';
SELECT jk_attach_updated_at('trip_verifications');

-- ---------------------------------------------------------------------------
-- Requests (buyer "titipan")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id            uuid NOT NULL REFERENCES users(id),
  source_type         text NOT NULL CHECK (source_type IN ('URL','PHOTO','SEARCH','MANUAL')),
  product_url         text CHECK (product_url IS NULL OR product_url ~* '^https?://'),
  product_name        text NOT NULL CHECK (char_length(product_name) BETWEEN 2 AND 300),
  merchant_name       text,
  merchant_country    char(2) REFERENCES countries(code),
  category_code       text REFERENCES product_categories(code),
  hs_code             text CHECK (hs_code IS NULL OR hs_code ~ '^[0-9]{4,10}$'),
  quantity            integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  variant             text,
  unit_price_minor    bigint CHECK (unit_price_minor IS NULL OR unit_price_minor >= 0),
  price_currency      char(3) REFERENCES currencies(code),
  est_weight_kg       numeric(6,3) CHECK (est_weight_kg IS NULL OR est_weight_kg > 0),
  notes               text,
  max_budget_idr      bigint CHECK (max_budget_idr IS NULL OR max_budget_idr > 0),
  needed_by           date,
  destination_country char(2) NOT NULL DEFAULT 'ID' REFERENCES countries(code),
  destination_city    text,
  delivery_preference text CHECK (delivery_preference IN ('MEETUP','COURIER','PARTNER_LOGISTICS','ANY')),
  restriction_class   text CHECK (restriction_class IN ('ALLOWED','RESTRICTED','DECLARATION_REQUIRED','PERMIT_REQUIRED','PROHIBITED')),
  restriction_rule_ref text,
  restriction_ack_at  timestamptz,
  extraction          jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPEN','MATCHED','CLOSED','CANCELLED','EXPIRED')),
  published_at        timestamptz,
  expires_at          timestamptz,
  closed_at           timestamptz,
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, buyer_id),
  CHECK ((unit_price_minor IS NULL) = (price_currency IS NULL)),
  -- PROHIBITED items can never be published
  CHECK (restriction_class IS DISTINCT FROM 'PROHIBITED' OR status IN ('DRAFT','CANCELLED','CLOSED','EXPIRED'))
);
CREATE INDEX IF NOT EXISTS requests_open_idx ON requests (merchant_country, destination_country, needed_by)
  WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS requests_status_country_idx ON requests (status, merchant_country, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_buyer_idx ON requests (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_category_code_idx ON requests (category_code);
CREATE INDEX IF NOT EXISTS requests_price_currency_idx ON requests (price_currency);
CREATE INDEX IF NOT EXISTS requests_destination_country_idx ON requests (destination_country);
CREATE INDEX IF NOT EXISTS requests_expiry_idx ON requests (expires_at) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS requests_product_name_trgm ON requests USING gin (product_name gin_trgm_ops);
SELECT jk_attach_updated_at('requests');

CREATE TABLE IF NOT EXISTS request_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  file_id    uuid REFERENCES files(id),
  source_url text,
  sort       smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, sort),
  CHECK (file_id IS NOT NULL OR source_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS request_images_file_id_idx ON request_images (file_id);

CREATE TABLE IF NOT EXISTS offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid NOT NULL REFERENCES requests(id),
  trip_id          uuid NOT NULL,
  traveler_id      uuid NOT NULL REFERENCES users(id),
  initiated_by     text NOT NULL CHECK (initiated_by IN ('TRAVELER','BUYER')),
  traveler_fee_idr bigint NOT NULL CHECK (traveler_fee_idr >= 0),
  message          text CHECK (char_length(message) <= 2000),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED')),
  expires_at       timestamptz,
  responded_at     timestamptz,
  decline_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, request_id),
  FOREIGN KEY (trip_id, traveler_id) REFERENCES trips(id, traveler_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_accepted_per_request ON offers (request_id) WHERE status = 'ACCEPTED';
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_pending_per_trip ON offers (request_id, trip_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS offers_request_idx ON offers (request_id, status);
CREATE INDEX IF NOT EXISTS offers_trip_idx ON offers (trip_id, traveler_id);
CREATE INDEX IF NOT EXISTS offers_traveler_idx ON offers (traveler_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS offers_expiry_idx ON offers (expires_at) WHERE status = 'PENDING';
SELECT jk_attach_updated_at('offers');

COMMIT;
