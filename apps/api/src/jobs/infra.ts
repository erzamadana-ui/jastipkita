import { createAuditCheckpoint } from '../modules/infra/audit-checkpoints';
import type { JobGroup } from './types';

/**
 * Background jobs for the "infra" module group (operations & resilience). Every job is idempotent.
 *   infra.audit_checkpoint   daily (UTC day window)   verify the audit chain since the previous checkpoint, then record the
 *                                                     head in audit_checkpoints AND store audit-checkpoints/YYYY/MM/DD.json
 *                                                     (launch checklist T12; production bucket = Object Lock / WORM)
 */
export const infraJobs: JobGroup = {
  outbox: {},
  scheduled: [{ name: 'infra.audit_checkpoint', everySec: 86_400, run: createAuditCheckpoint }],
  queues: {},
};
