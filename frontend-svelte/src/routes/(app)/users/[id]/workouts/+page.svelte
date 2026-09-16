<script lang="ts">
	import Dumbbell from '@lucide/svelte/icons/dumbbell';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import FilterBar from '$lib/components/filters/FilterBar.svelte';
	import FilterGroup from '$lib/components/filters/FilterGroup.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import Pagination from '$lib/components/ui/Pagination.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import FilterSelect from '$lib/components/ui/FilterSelect.svelte';
	import WorkoutCard from '$lib/components/workouts/WorkoutCard.svelte';
	import WorkoutSummary from '$lib/components/workouts/WorkoutSummary.svelte';
	import type { PageSize } from '$lib/lists/pagination';
	import { providerLabel } from '$lib/providers/labels';
	import { humanise } from '$lib/utils/text';
	import { withParams } from '$lib/utils/url';
	import type { Workout } from '$lib/workouts/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// A cursor names a position in one query, so any filter change has to drop it
	// — and the counter with it — or page three of the old list answers for page
	// one of the new one.
	const hrefFor = (changes: Record<string, string | null>) =>
		withParams(page.url, { cursor: null, at: null, ...changes });

	// The API pages by cursor, which carries no ordinal, so the position is
	// tracked alongside it purely so the reader can see where they are.
	const at = $derived(Math.max(Number(page.url.searchParams.get('at') ?? 1), 1));

	function stepHref(cursor: string | null, delta: number) {
		// Page one is the bare URL, never a `prev_` cursor. Reached by cursor it
		// has nothing before it, so the API reports has_more false and withholds
		// the forward cursor too — which strands the reader with both arrows dead.
		if (at + delta === 1) return hrefFor({});
		return cursor === null ? null : withParams(page.url, { cursor, at: String(at + delta) });
	}
	const sizeHref = (size: PageSize) => hrefFor({ size: String(size) });

	const label = (entry: string) => providerLabel(data.providers, entry);
	const connected = $derived(data.connections.map((connection) => connection.provider));

	const typeOptions = $derived([
		{ value: '', label: 'All types' },
		...data.types.map((type) => ({ value: type, label: humanise(type) }))
	]);

	const workouts = $derived(data.workouts.data);
	const filtered = $derived(Boolean(data.provider || data.type || data.period.from));

	// One dialog for the page, not one per card, and the subject is separate from
	// openness so closing does not have to null it mid-transition.
	let removing = $state<Workout | null>(null);
	let removeOpen = $state(false);
</script>

<div class="flex flex-col gap-6">
	<FilterBar
		period={data.period}
		{hrefFor}
		providers={connected}
		labelFor={label}
		selected={data.provider}
	>
		{#if data.types.length > 1}
			<FilterGroup label="Type">
				<FilterSelect
					label="Type"
					labelled={false}
					value={data.type}
					options={typeOptions}
					onselect={(type) =>
						// eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefFor resolves
						goto(hrefFor({ type: type || null }), { noScroll: true })}
				/>
			</FilterGroup>
		{/if}
	</FilterBar>

	<!-- A rule under the controls: the figures answer to them, so they have to
	     read as results rather than as more of the toolbar. -->
	<div class="flex flex-col gap-5 border-t border-border pt-6">
		<!-- No card, no heading: the filters above say what is in scope, and four
		     labelled figures do not need a label of their own. It fetches its own
		     numbers, because summing them reads every record in the period and the
		     cards below should not queue behind that. -->
		<WorkoutSummary userId={page.params.id ?? ''} search={page.url.search} />

		{#if workouts.length === 0}
			<Card>
				<EmptyState
					icon={Dumbbell}
					title={filtered ? 'No workouts match these filters' : 'No workouts recorded'}
					description={filtered
						? 'Widen the period, or clear the provider and type.'
						: 'Nothing this user’s providers have delivered is a workout.'}
				/>
			</Card>
		{:else}
			<div class="flex flex-col gap-3">
				{#each workouts as workout (workout.id)}
					<WorkoutCard
						{workout}
						userId={page.params.id ?? ''}
						providerLabel={label(workout.source.provider)}
						ondelete={() => {
							removing = workout;
							removeOpen = true;
						}}
					/>
				{/each}
			</div>

			<!-- No `hrefFor`: this endpoint pages by cursor, so there is no page seven
			     to link to and the bar marks the position instead. -->
			<Pagination
				page={at}
				size={data.pageSize}
				total={data.workouts.pagination.total_count ?? workouts.length}
				previousHref={stepHref(data.workouts.pagination.previous_cursor, -1)}
				nextHref={stepHref(data.workouts.pagination.next_cursor, 1)}
				sizeHrefFor={sizeHref}
			/>
		{/if}
	</div>
</div>

<ConfirmDialog
	bind:open={removeOpen}
	title="Delete workout?"
	action="?/deleteWorkout"
	confirmLabel="Delete"
	busyLabel="Deleting…"
	destructive
	fields={{ workout: removing?.id ?? '' }}
>
	This removes the workout and everything stored with it. It cannot be undone — though a later sync
	will bring it back if the provider still has it.
</ConfirmDialog>
