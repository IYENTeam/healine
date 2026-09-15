import type { DataSummary } from './types';

/** The figures above the fold; per-type counts come from the timelines. */
export type Totals = Pick<
	DataSummary,
	'total_data_points' | 'total_workouts' | 'total_sleep_events'
>;

/**
 * Totals as one provider sees them. Absent from `by_provider` means it
 * delivered nothing in the period, so zeroes — not everyone's totals.
 */
export function narrowToProvider(summary: DataSummary, provider: string): Totals {
	const only = summary.by_provider.find((entry) => entry.provider === provider);

	return {
		total_data_points: only?.data_points ?? 0,
		total_workouts: only?.workout_count ?? 0,
		total_sleep_events: only?.sleep_count ?? 0
	};
}
