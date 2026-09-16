import { apiDelete, apiGet } from './api';
import { periodWindow, type Period } from '$lib/filters/period';
import type { WorkoutPage } from '$lib/workouts/types';

/**
 * Unlike the summaries, this endpoint requires both bounds, so "All time" has to
 * name one. Unix 0 is the honest way to say "from the beginning".
 */
const ALL_TIME_START = '0';

const stamp = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

/** Tomorrow UTC, so today's workouts are inside the half-open window. */
function tomorrow(): Date {
	const date = new Date();
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCDate(date.getUTCDate() + 1);
	return date;
}

export type WorkoutQuery = {
	period: Period;
	provider?: string;
	type?: string;
	cursor?: string;
	limit?: number;
	/** Zones are a second table read, so the totals pass asks for none. */
	zones?: boolean;
};

export function fetchWorkouts(
	userId: string,
	accessToken: string,
	{ period, provider = '', type = '', cursor = '', limit = 10, zones = true }: WorkoutQuery
): Promise<WorkoutPage> {
	const window = periodWindow(period);
	const params = new URLSearchParams({
		start_date: window ? stamp(window.from) : ALL_TIME_START,
		end_date: stamp(window ? window.to : tomorrow()),
		limit: String(limit)
	});
	// A card cannot draw zones until it is expanded, but paging again on expand
	// would be worse than carrying them.
	if (zones) params.set('include', 'zones');
	if (provider) params.set('provider', provider);
	if (type) params.set('type', type);
	if (cursor) params.set('cursor', cursor);

	return apiGet<WorkoutPage>(`/api/v1/users/${userId}/events/workouts?${params}`, accessToken);
}

export const deleteWorkout = (userId: string, workoutId: string, accessToken: string) =>
	apiDelete(`/api/v1/users/${userId}/events/workouts/${workoutId}`, accessToken);
