<script lang="ts">
	import Dumbbell from '@lucide/svelte/icons/dumbbell';
	import Flame from '@lucide/svelte/icons/flame';
	import Route from '@lucide/svelte/icons/route';
	import Timer from '@lucide/svelte/icons/timer';
	import Figures from '$lib/components/ui/Figures.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { DASH, formatDistance, formatDuration, formatNumber } from '$lib/utils/format';
	import { resource } from '$lib/utils/resource.svelte';
	import type { WorkoutTotals } from '$lib/workouts/totals';

	let { userId, search }: { userId: string; search: string } = $props();

	// Its own request, not part of the page load: summing a period reads every
	// record in it, and the cards below are what the reader came for.
	const summed = resource<WorkoutTotals>(() => `/users/${userId}/workouts/totals${search}`);
	const totals = $derived(summed.current);

	const figures = $derived(
		totals && [
			{ icon: Dumbbell, label: 'Workouts', value: totals.count },
			{ icon: Timer, label: 'Total time', value: formatDuration(totals.seconds) },
			{
				icon: Flame,
				label: 'Calories',
				value: totals.calories > 0 ? formatNumber(totals.calories) : DASH
			},
			{ icon: Route, label: 'Distance', value: formatDistance(totals.meters) }
		]
	);
</script>

{#if figures}
	<Figures {figures} label="Workout totals" />
{:else}
	<Skeleton class="h-[52px]" />
{/if}

{#if totals?.partial}
	<!-- Say it rather than quietly under-reporting: the count is exact, the sums
	     beside it are not, and an admin comparing them deserves to know which. -->
	<p class="mt-3 text-xs text-muted-foreground">
		Totals cover the most recent workouts in this period, not all {totals.count}.
	</p>
{/if}
