// Shared marker → destination resolution.
//
// The migration engine and the editor suggester both need to turn a relative
// marker code (">>", "w", "w2", "m3w", "fri", "aug", "fut") into a concrete
// destination. Keeping that logic in one pure function means the popup preview
// can never disagree with what "Process" actually does — the class of bug
// where the suggester computed from today() while the engine computed from a
// different base.
//
// Codes are anchored to a date rather than "today": ">w" in a 2026-W31 note
// resolves to W32, not "one week from now". Callers pass the note's date as the
// anchor (falling back to today for non-journal notes).

import { moment } from 'obsidian';
import { DestinationDate } from './types';

const DAYS_OF_WEEK: Record<string, number> = {
	mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thurs: 4, fri: 5, sat: 6, sun: 7,
};

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Resolve a forward/relative marker code against an anchor date. Returns null
 * for codes that aren't relative markers (explicit dates and "current period"
 * markers like ":" or "<w" are handled by the caller). The code must be lower-
 * cased with the ">" prefix already stripped.
 */
export function resolveRelativeMarker(code: string, anchor: moment.Moment): DestinationDate | null {
	// Tomorrow [>>]
	if (code === '>') {
		return { date: anchor.clone().add(1, 'day').format('YYYY-MM-DD'), targetType: 'daily' };
	}

	// Numbered weeks from the anchor (w1 = 1 week, w2 = 2 weeks, …)
	const weekNumberMatch = code.match(/^w(\d+)$/);
	if (weekNumberMatch && weekNumberMatch[1]) {
		const weekNum = parseInt(weekNumberMatch[1], 10);
		if (weekNum >= 1) {
			return {
				date: anchor.clone().add(weekNum, 'weeks').startOf('isoWeek').format('YYYY-MM-DD'),
				targetType: 'weekly',
			};
		}
	}

	// Nth week of the month (m3w = 3rd week), rolling to next month if past
	const monthWeekMatch = code.match(/^m(\d+)w$/);
	if (monthWeekMatch && monthWeekMatch[1]) {
		const weekNum = parseInt(monthWeekMatch[1], 10);
		const weekDayMap: Record<number, number> = { 1: 4, 2: 11, 3: 18, 4: 25 };
		const targetDay = weekDayMap[weekNum];
		if (targetDay === undefined) return null;

		const month = anchor.clone().startOf('month');
		const mondayThisMonth = month.clone().date(targetDay).startOf('isoWeek');
		if (mondayThisMonth.isBefore(anchor, 'day')) {
			const mondayNextMonth = month.clone().add(1, 'month').date(targetDay).startOf('isoWeek');
			return { date: mondayNextMonth.format('YYYY-MM-DD'), targetType: 'weekly' };
		}
		return { date: mondayThisMonth.format('YYYY-MM-DD'), targetType: 'weekly' };
	}

	// Next week [>w]
	if (code === 'w') {
		return {
			date: anchor.clone().add(1, 'week').startOf('isoWeek').format('YYYY-MM-DD'),
			targetType: 'weekly',
		};
	}

	// Next month [>m]
	if (code === 'm') {
		return {
			date: anchor.clone().add(1, 'month').startOf('month').format('YYYY-MM-DD'),
			targetType: 'monthly',
		};
	}

	// Specific weekday [>mon] … — next occurrence strictly after the anchor
	if (Object.prototype.hasOwnProperty.call(DAYS_OF_WEEK, code)) {
		const targetDay = DAYS_OF_WEEK[code]!;
		let daysToAdd = targetDay - anchor.isoWeekday();
		if (daysToAdd <= 0) daysToAdd += 7;
		return {
			date: anchor.clone().add(daysToAdd, 'days').format('YYYY-MM-DD'),
			targetType: 'daily',
		};
	}

	// Specific month [>aug] … — next occurrence after the anchor's month
	if (Object.prototype.hasOwnProperty.call(MONTHS, code)) {
		const targetMonth = MONTHS[code]!;
		let targetYear = anchor.year();
		if (targetMonth <= anchor.month() + 1) targetYear += 1;

		const targetDate = moment(`${targetYear}-${String(targetMonth).padStart(2, '0')}-01`);
		const nextMonth = anchor.clone().add(1, 'month').startOf('month');
		if (targetDate.isAfter(nextMonth, 'month')) {
			return { date: targetDate.format('YYYY-MM-DD'), targetType: 'future', monthName: MONTH_NAMES[targetMonth - 1] };
		}
		return { date: targetDate.format('YYYY-MM-DD'), targetType: 'monthly' };
	}

	// Future log [>fut]
	if (code === 'fut') {
		return { date: null, targetType: 'future' };
	}

	return null;
}

/**
 * Does a destination match what the user has typed?
 *
 * Matching on a word's start rather than anywhere in the label is what turns
 * the flat list into a drill-down: "w" narrows to the week rows instead of
 * also dragging in "Tomorrow", which merely ends in a w. So "w" is the week
 * sub-level and "m" the month one, with no nested menu to walk.
 */
export function matchesQuery(code: string, label: string, query: string): boolean {
	if (!query) return true;
	const needle = query.toLowerCase();
	if (code.toLowerCase().startsWith(needle)) return true;
	return label.toLowerCase().split(/[^a-z0-9]+/).some(word => word.startsWith(needle));
}

/** A short human label + resolved-date sub-label for a code, for UI previews. */
export function describeMarker(code: string, anchor: moment.Moment): { label: string; sub: string } | null {
	const resolved = resolveRelativeMarker(code, anchor);
	if (!resolved) return null;

	if (resolved.targetType === 'future') {
		return { label: resolved.monthName ?? 'Future log', sub: 'future log' };
	}
	if (!resolved.date) return null;
	const m = moment(resolved.date, 'YYYY-MM-DD');

	switch (resolved.targetType) {
		case 'weekly':
			return { label: `Week of ${m.format('MMM D')}`, sub: m.format('[W]WW · GGGG') };
		case 'monthly':
			return { label: m.format('MMMM YYYY'), sub: 'monthly note' };
		default:
			return { label: m.format('dddd, MMM D'), sub: m.format('GGGG') };
	}
}
