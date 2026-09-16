import { fetchConnections } from '$lib/server/connections';
import { requireToken } from '$lib/server/guard';
import { fetchProviders } from '$lib/server/providers';
import { fetchDataTimeline } from '$lib/server/summary';
import { deleteWorkout, fetchWorkouts } from '$lib/server/workouts';
import { attempt } from '$lib/server/form';
import { ALL_TIME, parsePeriod } from '$lib/filters/period';
import { isPageSize } from '$lib/lists/pagination';
import { totalsFromTimeline } from '$lib/summary/timeline';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, locals }) => {
	const accessToken = await requireToken(locals);
	const period = parsePeriod(url.searchParams);

	const askedProvider = url.searchParams.get('provider') ?? '';
	const askedType = url.searchParams.get('type') ?? '';
	const cursor = url.searchParams.get('cursor') ?? '';

	// Ten, not the list default of twenty: these cards expand, and twenty of them
	// is a page nobody reaches the end of. The sizes on offer are the shared ones.
	const asked = Number(url.searchParams.get('size'));
	const pageSize = isPageSize(asked) ? asked : 10;

	// Both option lists span the user's whole history, not the chosen period, so
	// neither control empties itself as you step through days. A provider or a
	// type with nothing this week is exactly what an admin wants to select.
	const options = Promise.all([
		fetchProviders(accessToken),
		fetchConnections(params.id, accessToken),
		fetchDataTimeline(params.id, accessToken, ALL_TIME, 'workout_type')
	]);

	const query = (provider: string, type: string) =>
		fetchWorkouts(params.id, accessToken, { period, provider, type, cursor, limit: pageSize });

	// Both filters are backend enums, so an invented one is a 422 and a dead page
	// — which is why they are checked against what this user actually has, the
	// same list the controls offer. With neither asked for there is nothing to
	// check, so the list query has no reason to queue behind the option lists:
	// on a plain visit the two travel together instead of one after the other.
	const started = !askedProvider && !askedType ? query('', '') : null;

	const [providers, connections, everyType] = await options;
	const types = Object.keys(totalsFromTimeline(everyType)).sort();
	const known = (value: string, allowed: string[]) => (allowed.includes(value) ? value : '');

	const provider = known(
		askedProvider,
		connections.map((connection) => connection.provider)
	);
	const type = known(askedType, types);

	const workouts = (await started) ?? (await query(provider, type));

	return {
		period,
		provider,
		type,
		types,
		workouts,
		providers,
		connections,
		pageSize
	};
};

export const actions: Actions = {
	deleteWorkout: async ({ params, request, locals }) => {
		const accessToken = await requireToken(locals);
		const id = String((await request.formData()).get('workout') ?? '');

		return attempt('deleteWorkout', { workout: id }, () =>
			deleteWorkout(params.id, id, accessToken)
		);
	}
};
