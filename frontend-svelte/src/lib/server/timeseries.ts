import { apiGet } from './api';
import { CHART_TYPES, resolutionFor, type Sample } from '$lib/timeseries/samples';

type SamplePage = { data: Sample[]; pagination: { total_count: number | null } };

/** The endpoint's own ceiling, and what one curve is allowed to cost. */
const PAGE = 1000;

export type WorkoutSamples = {
	samples: Sample[];
	/** What the readings are: stored values, or averages over a bucket. */
	resolution: string;
	/** The window holds more than a page, so the curve is missing detail. */
	truncated: boolean;
};

export async function fetchWorkoutSamples(
	userId: string,
	accessToken: string,
	window: { from: string; to: string; seconds: number },
	provider: string
): Promise<WorkoutSamples> {
	const load = async (resolution: string) => {
		const params = new URLSearchParams({
			start_time: window.from,
			end_time: window.to,
			resolution,
			limit: String(PAGE)
		});
		for (const type of CHART_TYPES) params.append('types', type);
		// Without this a phone worn alongside the watch adds its own lines, and
		// the question here is what the workout's own device recorded.
		if (provider) params.set('provider', provider);

		const page = await apiGet<SamplePage>(
			`/api/v1/users/${userId}/timeseries?${params}`,
			accessToken
		);
		const total = page.pagination.total_count ?? page.data.length;
		return { samples: page.data, resolution, truncated: total > page.data.length };
	};

	// Stored readings first: a minute average smooths exactly the spikes an admin
	// opened the chart to look at. Only when they do not fit does the curve get
	// bucketed, and then it says so.
	const raw = await load('raw');
	return raw.truncated ? load(resolutionFor(window.seconds)) : raw;
}
