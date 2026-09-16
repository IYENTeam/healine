<script lang="ts">
	import Flame from '@lucide/svelte/icons/flame';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import Route from '@lucide/svelte/icons/route';
	import Timer from '@lucide/svelte/icons/timer';
	import { formatDistance, formatDuration, formatNumber } from '$lib/utils/format';
	import type { Workout } from '$lib/workouts/types';

	let { workout }: { workout: Workout } = $props();

	// A fixed set, dashes and all: an empty slot says the provider sent nothing,
	// and cards that shed columns are cards you cannot scan down a column of.
	const metrics = $derived([
		{ icon: Timer, label: 'Duration', value: formatDuration(workout.duration_seconds) },
		{ icon: Route, label: 'Distance', value: formatDistance(workout.distance_meters) },
		{ icon: Flame, label: 'Calories', value: formatNumber(workout.calories_kcal, ' kcal') },
		{ icon: HeartPulse, label: 'Avg HR', value: formatNumber(workout.avg_heart_rate_bpm, ' bpm') }
	]);
</script>

<dl class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
	{#each metrics as metric (metric.label)}
		<div class="flex items-center gap-2">
			<metric.icon size={15} aria-hidden="true" class="shrink-0 text-muted-foreground/60" />
			<div class="min-w-0">
				<dd class="truncate text-sm font-medium text-foreground tabular-nums">{metric.value}</dd>
				<dt class="text-[11px] text-muted-foreground">{metric.label}</dt>
			</div>
		</div>
	{/each}
</dl>
