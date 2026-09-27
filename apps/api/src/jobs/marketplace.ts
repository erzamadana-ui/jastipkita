import type { JobGroup } from './types';

/** Background jobs for the "marketplace" module group. OWNED by the marketplace agent/team. */
export const marketplaceJobs: JobGroup = {
  outbox: {},
  scheduled: [],
  queues: {},
};
