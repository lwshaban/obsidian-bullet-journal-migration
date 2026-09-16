import test from 'node:test';
import assert from 'node:assert/strict';
import { moment } from 'obsidian';

import { resolveRelativeMarker, describeMarker } from '../src/markers';

// A Thursday, so "next occurrence of X" has a non-trivial answer in both
// directions, and ISO week 3 of 2026.
const anchor = () => moment('2026-01-15', 'YYYY-MM-DD');

test('">>" resolves to the day after the anchor, not tomorrow', () => {
	const result = resolveRelativeMarker('>', anchor());
	assert.deepEqual(result, { date: '2026-01-16', targetType: 'daily' });
});

test('"w" resolves to the Monday of the anchor\'s following week', () => {
	const result = resolveRelativeMarker('w', anchor());
	assert.deepEqual(result, { date: '2026-01-19', targetType: 'weekly' });
});

test('numbered weeks step from the anchor', () => {
	assert.equal(resolveRelativeMarker('w1', anchor())?.date, '2026-01-19');
	assert.equal(resolveRelativeMarker('w2', anchor())?.date, '2026-01-26');
	assert.equal(resolveRelativeMarker('w4', anchor())?.date, '2026-02-09');
});

test('"m" resolves to the first of the next month', () => {
	assert.deepEqual(resolveRelativeMarker('m', anchor()), {
		date: '2026-02-01',
		targetType: 'monthly',
	});
});

test('weekday markers pick the next strictly-future occurrence', () => {
	// Anchor is a Thursday.
	assert.equal(resolveRelativeMarker('fri', anchor())?.date, '2026-01-16');
	assert.equal(resolveRelativeMarker('mon', anchor())?.date, '2026-01-19');
	// Same weekday as the anchor rolls a full week forward rather than
	// resolving to the anchor itself.
	assert.equal(resolveRelativeMarker('thu', anchor())?.date, '2026-01-22');
});

test('weekday aliases match their canonical form', () => {
	assert.equal(
		resolveRelativeMarker('tues', anchor())?.date,
		resolveRelativeMarker('tue', anchor())?.date,
	);
	assert.equal(
		resolveRelativeMarker('thurs', anchor())?.date,
		resolveRelativeMarker('thu', anchor())?.date,
	);
});

test('"mNw" targets the Monday of the month\'s Nth week', () => {
	// Nth week is approximated by day 4/11/18/25 and snapped back to its
	// Monday. From 2026-01-05 the 3rd week (around Jan 18, a Sunday, so week
	// starting Jan 12) is still ahead.
	assert.deepEqual(resolveRelativeMarker('m3w', moment('2026-01-05', 'YYYY-MM-DD')), {
		date: '2026-01-12',
		targetType: 'weekly',
	});
});

test('"mNw" rolls into next month once that week has started', () => {
	// From 2026-01-15 the 3rd week already began (Jan 12), so it rolls forward.
	assert.equal(resolveRelativeMarker('m3w', anchor())?.date, '2026-02-16');
	// The 1st week is long past, so it rolls too.
	assert.equal(resolveRelativeMarker('m1w', anchor())?.date, '2026-02-02');
});

test('"mNw" rejects week numbers outside 1–4', () => {
	assert.equal(resolveRelativeMarker('m5w', anchor()), null);
	assert.equal(resolveRelativeMarker('m0w', anchor()), null);
});

test('a near month goes to that monthly note, a far month to the future log', () => {
	// February is the month right after the anchor → monthly note.
	assert.deepEqual(resolveRelativeMarker('feb', anchor()), {
		date: '2026-02-01',
		targetType: 'monthly',
	});

	// August is further out → future log, carrying the month name.
	assert.deepEqual(resolveRelativeMarker('aug', anchor()), {
		date: '2026-08-01',
		targetType: 'future',
		monthName: 'August',
	});
});

test('a month at or before the anchor month resolves to next year', () => {
	assert.equal(resolveRelativeMarker('jan', anchor())?.date, '2027-01-01');
});

test('"fut" resolves to the future log with no date', () => {
	assert.deepEqual(resolveRelativeMarker('fut', anchor()), {
		date: null,
		targetType: 'future',
	});
});

test('unknown codes resolve to null', () => {
	for (const code of ['', 'zzz', 'w', 'mon'].slice(1, 2)) {
		assert.equal(resolveRelativeMarker(code, anchor()), null);
	}
	assert.equal(resolveRelativeMarker('nonsense', anchor()), null);
	assert.equal(resolveRelativeMarker('', anchor()), null);
});

test('markers anchor on the note date, not on today', () => {
	// The behaviour the suggester and the engine must agree on: ">w" inside a
	// past note means the week after that note, not the week after today.
	const pastNote = moment('2025-07-31', 'YYYY-MM-DD');
	assert.equal(resolveRelativeMarker('w', pastNote)?.date, '2025-08-04');
});

test('resolveRelativeMarker does not mutate the anchor', () => {
	const a = anchor();
	const before = a.format('YYYY-MM-DD');
	resolveRelativeMarker('m3w', a);
	resolveRelativeMarker('w2', a);
	resolveRelativeMarker('aug', a);
	assert.equal(a.format('YYYY-MM-DD'), before);
});

test('describeMarker previews the resolved destination', () => {
	assert.deepEqual(describeMarker('w', anchor()), {
		label: 'Week of Jan 19',
		sub: 'W04 · 2026',
	});
	assert.deepEqual(describeMarker('m', anchor()), {
		label: 'February 2026',
		sub: 'monthly note',
	});
	assert.deepEqual(describeMarker('fut', anchor()), {
		label: 'Future log',
		sub: 'future log',
	});
	assert.equal(describeMarker('nonsense', anchor()), null);
});
