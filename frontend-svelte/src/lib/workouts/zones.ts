import HeartPulse from '@lucide/svelte/icons/heart-pulse';
import Zap from '@lucide/svelte/icons/zap';
import type { Component } from 'svelte';
import type { Workout } from './types';

export type ZoneKind = {
	/** The series these zones describe, which is also the line they band. */
	type: 'heart_rate' | 'power';
	label: string;
	unit: string;
	icon: Component;
	zones: { zone: number; seconds: number; max: number | null }[];
};

/**
 * The kinds of zone this workout carries, in the order they are offered. Both
 * shapes differ only in what the ceiling is called, so they are flattened to one
 * `max` and the chart and the strip can read either without knowing which.
 */
export function zoneKinds(workout: Workout): ZoneKind[] {
	const kinds: ZoneKind[] = [];

	if (workout.hr_zones) {
		kinds.push({
			type: 'heart_rate',
			label: 'Heart rate',
			unit: 'bpm',
			icon: HeartPulse,
			zones: workout.hr_zones.zones.map((zone) => ({ ...zone, max: zone.max_bpm }))
		});
	}

	if (workout.power_zones) {
		kinds.push({
			type: 'power',
			label: 'Power',
			unit: 'W',
			icon: Zap,
			zones: workout.power_zones.zones.map((zone) => ({ ...zone, max: zone.max_watts }))
		});
	}

	return kinds;
}
