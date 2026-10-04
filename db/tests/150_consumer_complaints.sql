-- 150_consumer_complaints.sql — migration 0130 (consumer complaint channel, Permendag 19/2026; launch checklist L12).
--   support_tickets.category accepts COMPLAINT; every pre-existing category still works; unknown values are refused;
--   the swapped CHECK is validated (trusted) and remains a superset of the 0013 list.

BEGIN;
DO $$
DECLARE
  u uuid := jk_test.user('complainer', 2::smallint);
  v_id uuid;
  v_def text;
  v_valid boolean;
  c text;
BEGIN
  INSERT INTO support_tickets (user_id, category, subject, priority, sla_due_at)
  VALUES (u, 'COMPLAINT', 'Barang tidak sesuai deskripsi', 'HIGH', now() + interval '12 hours')
  RETURNING id INTO v_id;
  PERFORM jk_test.ok(v_id IS NOT NULL, 'COMPLAINT ticket accepted');
  PERFORM jk_test.ok((SELECT number ~ '^TKT-[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$' FROM support_tickets WHERE id = v_id),
                     'COMPLAINT ticket gets a TKT number like every ticket');

  FOREACH c IN ARRAY ARRAY['TRANSACTION','DISPUTE','REFUND','ACCOUNT','PAYMENT','CUSTOMS','OTHER'] LOOP
    PERFORM jk_test.succeeds(format(
      $q$INSERT INTO support_tickets (user_id, category, subject) VALUES (%L, %L, 'cek kategori lama')$q$, u, c),
      format('pre-0130 category %s still accepted', c));
  END LOOP;

  PERFORM jk_test.throws(format(
    $q$INSERT INTO support_tickets (user_id, category, subject) VALUES (%L, 'COMPLAINTS', 'typo')$q$, u),
    '23514', 'unknown category refused (CHECK still enforced)');
  PERFORM jk_test.throws(format(
    $q$UPDATE support_tickets SET category = 'complaint' WHERE id = %L$q$, v_id),
    '23514', 'category values are upper-case only');

  SELECT pg_get_constraintdef(oid), convalidated INTO v_def, v_valid
    FROM pg_constraint WHERE conrelid = 'support_tickets'::regclass AND conname = 'support_tickets_category_check';
  PERFORM jk_test.ok(v_valid, 'support_tickets_category_check is validated (not left NOT VALID)');
  PERFORM jk_test.ok(v_def LIKE '%COMPLAINT%' AND v_def LIKE '%TRANSACTION%' AND v_def LIKE '%CUSTOMS%' AND v_def LIKE '%OTHER%',
                     'category CHECK is a superset of the 0013 list');
  PERFORM jk_test.eq((SELECT count(*)::int FROM pg_constraint
                       WHERE conrelid = 'support_tickets'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%category%'),
                     1, 'exactly one category CHECK on support_tickets (old inline constraint replaced, not duplicated)');
END $$;
ROLLBACK;

-- jk_app (the API role) can file and read complaints like any other ticket.
BEGIN;
DO $$
DECLARE
  u uuid := jk_test.user('complainer-app', 2::smallint);
  v_n int;
BEGIN
  SET LOCAL ROLE jk_app;
  INSERT INTO support_tickets (user_id, category, subject, priority) VALUES (u, 'COMPLAINT', 'Pengaduan via API', 'HIGH');
  SELECT count(*)::int INTO v_n FROM support_tickets WHERE user_id = u AND category = 'COMPLAINT';
  RESET ROLE;
  PERFORM jk_test.eq(v_n, 1, 'jk_app inserts and reads COMPLAINT tickets');
END $$;
ROLLBACK;
