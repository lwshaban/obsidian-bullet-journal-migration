// Recurring-task scheduling — a one-shot "lay down every occurrence now" model
// (like a calendar's "repeats until…"), not a background recurrence engine.
//
// The interval unit decides the note granularity, mirroring the migration
// markers: every N days → daily notes, N weeks → weekly notes, N months →
// monthly notes. Pure and side-effect-free so the modal can preview the exact
// dates before anything is written.

import { moment } from 'obsidian';

export type RecurUnit = 'days' | 'weeks' | 'months';

/** Hard cap so a runaway interval can't flood the vault. */
export const RECUR_CAP = 100;

export interface Recurrence {
	dates: string[];                             // note dates: daily=exact, weekly=Monday, monthly=1st
	targetType: 'daily' | 'weekly' | 'monthly';
	capped: boolean;                             // true if the cap cut the series short
}

export function unitTargetType(unit: RecurUnit): 'daily' | 'weekly' | 'monthly' {
	return unit === 'days' ? 'daily' : unit === 'weeks' ? 'weekly' : 'monthly';
}

/**
 * Occurrence note-dates from `fromISO` (default today) up to and including
 * `untilISO`, stepping by `everyN` units. The first occurrence is one interval
 * after the start — the source task the user ran this on covers the current
 * period, so we don't duplicate it.
 */
export function computeRecurrence(
	everyN: number,
	unit: RecurUnit,
	untilISO: string,
	fromISO?: string,
): Recurrence {
	const targetType = unitTargetType(unit);
	const dates: string[] = [];
	let capped = false;

	const until = moment(untilISO, 'YYYY-MM-DD', true).startOf('day');
	const start = (fromISO ? moment(fromISO, 'YYYY-MM-DD', true) : moment()).startOf('day');
	if (!until.isValid() || !start.isValid() || !Number.isInteger(everyN) || everyN < 1) {
		return { dates, targetType, capped };
	}

	const seen = new Set<string>();
	const cursor = start.clone().add(everyN, unit);
	while (cursor.isSameOrBefore(until, 'day')) {
		if (dates.length >= RECUR_CAP) {
			capped = true;
			break;
		}
		let date: string;
		if (targetType === 'weekly') date = cursor.clone().startOf('isoWeek').format('YYYY-MM-DD');
		else if (targetType === 'monthly') date = cursor.clone().startOf('month').format('YYYY-MM-DD');
		else date = cursor.format('YYYY-MM-DD');

		if (!seen.has(date)) {
			seen.add(date);
			dates.push(date);
		}
		cursor.add(everyN, unit);
	}

	return { dates, targetType, capped };
}
