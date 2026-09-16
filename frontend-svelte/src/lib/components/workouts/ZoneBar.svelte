<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import ChartRow from '$lib/components/ui/ChartRow.svelte';
	import Caption from '$lib/components/ui/Caption.svelte';
	import { HEAT_STEPS } from '$lib/summary/shades';
	import { formatDuration } from '$lib/utils/format';

	let {
		title,
		icon: Icon,
		zones,
		unit,
		children
	}: {
		title: string;
		icon: Component;
		/** `max` is the zone's upper bound, absent when the provider sent none. */
		zones: { zone: number; seconds: number; max: number | null }[];
		unit: string;
		/** A control sharing the heading's line — the kind switch, where there is one. */
		children?: Snippet;
	} = $props();

	const spent = $derived(zones.filter((entry) => entry.seconds > 0));
	const total = $derived(spent.reduce((sum, entry) => sum + entry.seconds, 0));
	const longest = $derived(Math.max(...spent.map((entry) => entry.seconds), 0));

	// Zone 0 is the easiest, so it takes the palest step: the same ramp the
	// heatmaps use, read here as effort rather than as density.
	const shade = (zone: number) => HEAT_STEPS[Math.min(zone + 1, HEAT_STEPS.length - 1)];

	/** `≤ 152` on its own, or `134–152` once the zone below has a ceiling. */
	function range(index: number): string {
		const top = spent[index].max;
		if (top === null) return '';
		const below = index > 0 ? spent[index - 1].max : null;
		return below === null ? `≤${top}` : `${below + 1}–${top}`;
	}

	const share = (seconds: number) => (total === 0 ? 0 : Math.round((seconds / total) * 100));
</script>

{#if total > 0}
	<div class="flex flex-col gap-2">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<Caption icon={Icon}>
				{title}
				<span class="normal-case">({unit})</span>
			</Caption>
			{@render children?.()}
		</div>

		<!-- The same label / track / value row as every other chart on the site, so
		     a zone reads like a heatmap row rather than a bespoke widget. -->
		<div class="flex flex-col gap-1">
			{#each spent as entry, index (entry.zone)}
				<ChartRow label="Z{entry.zone + 1} {range(index)}" value={formatDuration(entry.seconds)}>
					<div class="flex items-center gap-2">
						<span class="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
							<span
								aria-hidden="true"
								class="block h-full rounded-full {shade(entry.zone)}"
								style="width: {longest === 0 ? 0 : (entry.seconds / longest) * 100}%"
							></span>
						</span>
						<span class="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
							{share(entry.seconds)}%
						</span>
					</div>
				</ChartRow>
			{/each}
		</div>
	</div>
{/if}
