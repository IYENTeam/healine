<script lang="ts">
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import PeriodFilter from './PeriodFilter.svelte';
	import { CAPTION } from '$lib/components/ui/typography';
	import type { Period } from '$lib/summary/period';

	let {
		period,
		hrefFor,
		providers,
		labelFor,
		selected
	}: {
		period: Period;
		hrefFor: (changes: Record<string, string | null>) => string;
		/** Provider slugs this user has connected, whatever the period holds. */
		providers: string[];
		labelFor: (provider: string) => string;
		selected: string;
	} = $props();

	// Links, not buttons: the server does the narrowing, so the choice has to
	// reach a load. `Segmented` marks them noscroll, which is what kept the
	// reader in place when this was client-side state.
	const items = $derived([
		{ value: '', label: 'All', href: hrefFor({ provider: null }) },
		...providers.map((provider) => ({
			value: provider,
			label: labelFor(provider),
			href: hrefFor({ provider })
		}))
	]);
</script>

<!-- Every filter in one place, above the cards: they govern all of them, and a
     control tucked inside one card is a control nobody finds. -->
<div class="flex flex-wrap items-end gap-x-8 gap-y-3">
	<div class="flex flex-col gap-1.5">
		<span class={CAPTION}>Period</span>
		<PeriodFilter {period} {hrefFor} />
	</div>

	<!-- Nothing to choose between with a single connection. -->
	{#if providers.length > 1}
		<div class="flex flex-col gap-1.5">
			<span class={CAPTION}>Provider</span>
			<Segmented label="Provider" {items} {selected} />
		</div>
	{/if}
</div>
