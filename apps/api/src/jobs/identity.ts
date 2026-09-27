import type { JobGroup } from './types';

/** Background jobs for the "identity" module group. OWNED by the identity agent/team. */
export const identityJobs: JobGroup = {
  outbox: {},
  scheduled: [],
  queues: {},
};
