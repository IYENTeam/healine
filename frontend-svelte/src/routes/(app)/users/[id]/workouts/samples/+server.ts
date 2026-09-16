import { json } from '@sveltejs/kit';
import { requireToken } from '$lib/server/guard';
import { fetchWorkoutSamples } from '$lib/server/timeseries';
import type { RequestHandler } from './$types';

/**
 * Fetched when a card opens, not with the list: ten workouts' worth of curves is
 * ten timeseries scans for the nine nobody expands.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const accessToken = await requireToken(locals);

	const from = url.searchParams.get('from') ?? '';
	const to = url.searchParams.get('to') ?? '';
	const seconds = Number(url.searchParams.get('seconds') ?? 0);
	const provider = url.searchParams.get('provider') ?? '';

	if (!from || !to) return json({ samples: [], truncated: false });

	return json(await fetchWorkoutSamples(params.id, accessToken, { from, to, seconds }, provider));
};
