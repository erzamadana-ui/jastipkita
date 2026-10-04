/**
 * SEC-19 (docs/security/review-2026-09.md; decision 2026-10-04): anonymous visitors of public trip discovery see trip
 * dates at ISO-week precision (Monday–Sunday); signed-in users see exact dates. Trip dates are calendar dates of the
 * traveler's itinerary (DB `date`), so the week is the ISO week of that calendar date; "today" is the Asia/Jakarta date.
 *
 * Contract (TripPublic):
 *   datePrecision      'DAY' | 'WEEK'
 *   departureWindow    { from, to }  DAY: from = to = departureDate · WEEK: Monday..Sunday containing the departure
 *   arrivalWindow      { from, to }  same for the arrival
 *   departureDate / arrivalDate     DAY: exact · WEEK: = window.from (kept for older clients; never the exact date)
 */
import { addDaysIso } from '../catalog/shared';

export type DatePrecision = 'DAY' | 'WEEK';

export interface DateWindow {
  from: string;
  to: string;
}

/** Monday of the ISO week containing `day` (YYYY-MM-DD). */
export function isoWeekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDaysIso(day, -((dow + 6) % 7));
}

/** Monday..Sunday window of the ISO week containing `day`. */
export function isoWeekWindow(day: string): DateWindow {
  const from = isoWeekStart(day);
  return { from, to: addDaysIso(from, 6) };
}

export function dateWindow(day: string, precision: DatePrecision): DateWindow {
  return precision === 'WEEK' ? isoWeekWindow(day) : { from: day, to: day };
}

/**
 * Discovery filters for anonymous requests are evaluated at week granularity (inclusive of whole weeks), so a
 * day-precise filter cannot be used to probe the exact date: departureFrom → Monday of its week, departureTo /
 * arrivalBy → Sunday of their week, and "not departed yet" → departures from the Monday of the current week.
 */
export function coarsenDiscoveryBounds(
  b: { today: string; departureFrom?: string | undefined; departureTo?: string | undefined; arrivalBy?: string | undefined },
  precision: DatePrecision,
): { from: string; departureTo?: string; arrivalBy?: string } {
  const lower = (d: string) => (precision === 'WEEK' ? isoWeekStart(d) : d);
  const upper = (d: string) => (precision === 'WEEK' ? isoWeekWindow(d).to : d);
  const floor = lower(b.today);
  const from = b.departureFrom && lower(b.departureFrom) > floor ? lower(b.departureFrom) : floor;
  return {
    from,
    ...(b.departureTo ? { departureTo: upper(b.departureTo) } : {}),
    ...(b.arrivalBy ? { arrivalBy: upper(b.arrivalBy) } : {}),
  };
}
