import type { JobGroup } from './types';

/** Background jobs for the "engagement" module group. OWNED by the engagement agent/team. */
export const engagementJobs: JobGroup = {
  outbox: {},
  scheduled: [],
  queues: {},
};
