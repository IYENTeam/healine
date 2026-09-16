import type { Workout } from './types';

export type WorkoutTotals = {
	count: number;
	seconds: number;
	calories: number;
	meters: number;
	/** The period holds more workouts than we were able to add up. */
	partial: boolean;
};

const add = (workouts: Workout[], pick: (workout: Workout) => number | null) =>
	workouts.reduce((sum, workout) => sum + (pick(workout) ?? 0), 0);

/**
 * There is no workout aggregate endpoint, so the sums come from the records
 * themselves and `partial` says when the API held more than one page could
 * carry. The count is the API's own, which is exact however many we summed.
 */
export function sumWorkouts(workouts: Workout[], total: number | null): WorkoutTotals {
	return {
		count: total ?? workouts.length,
		seconds: add(workouts, (workout) => workout.duration_seconds),
		calories: add(workouts, (workout) => workout.calories_kcal),
		meters: add(workouts, (workout) => workout.distance_meters),
		partial: total !== null && total > workouts.length
	};
}
