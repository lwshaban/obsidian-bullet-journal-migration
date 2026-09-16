import test from 'node:test';
import assert from 'node:assert/strict';

import { computeRecurrence, unitTargetType, RECUR_CAP } from '../src/recurrence';

test('unit decides the note granularity', () => {
	assert.equal(unitTargetType('days'), 'daily');
	assert.equal(unitTargetType('weeks'), 'weekly');
	assert.equal(unitTargetType('months'), 'monthly');
});

test('daily recurrence starts one interval after the source date', () => {
	const { dates, targetType, capped } = computeRecurrence(3, 'days', '2026-01-15', '2026-01-01');

	// The source task already covers 2026-01-01, so the series starts on the 4th.
	assert.deepEqual(dates, ['2026-01-04', '2026-01-07', '2026-01-10', '2026-01-13']);
	assert.equal(targetType, 'daily');
	assert.equal(capped, false);
});

test('weekly recurrence snaps each occurrence to its Monday', () => {
	// 2026-01-01 is a Thursday; +2 weeks is Thursday the 15th, whose week
	// starts Monday the 12th.
	const { dates } = computeRecurrence(2, 'weeks', '2026-02-28', '2026-01-01');
	assert.deepEqual(dates, ['2026-01-12', '2026-01-26', '2026-02-09', '2026-02-23']);
});

test('monthly recurrence snaps each occurrence to the 1st', () => {
	const { dates } = computeRecurrence(1, 'months', '2026-05-31', '2026-01-15');
	assert.deepEqual(dates, ['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01']);
});

test('the until date is compared against the occurrence, not the snapped note', () => {
	// Stepping monthly from the 15th, the May occurrence is the 15th — past an
	// until of May 10 — even though its note (May 1) would not be.
	const { dates } = computeRecurrence(1, 'months', '2026-05-10', '2026-01-15');
	assert.deepEqual(dates, ['2026-02-01', '2026-03-01', '2026-04-01']);
});

test('an occurrence landing exactly on the until date is included', () => {
	const { dates } = computeRecurrence(7, 'days', '2026-01-08', '2026-01-01');
	assert.deepEqual(dates, ['2026-01-08']);
});

test('an until date before the first occurrence yields nothing', () => {
	const { dates, capped } = computeRecurrence(7, 'days', '2026-01-05', '2026-01-01');
	assert.deepEqual(dates, []);
	assert.equal(capped, false);
});

test('snapping never emits the same note twice', () => {
	// Every 3 days for a month, snapped to Mondays: several occurrences share a
	// week and must collapse to one entry.
	const { dates } = computeRecurrence(3, 'weeks', '2026-03-01', '2026-01-01');
	assert.equal(new Set(dates).size, dates.length);
});

test('a long series is capped rather than flooding the vault', () => {
	const { dates, capped } = computeRecurrence(1, 'days', '2030-01-01', '2026-01-01');
	assert.equal(dates.length, RECUR_CAP);
	assert.equal(capped, true);
});

test('invalid input produces an empty series instead of throwing', () => {
	assert.deepEqual(computeRecurrence(0, 'days', '2026-02-01', '2026-01-01').dates, []);
	assert.deepEqual(computeRecurrence(-1, 'days', '2026-02-01', '2026-01-01').dates, []);
	assert.deepEqual(computeRecurrence(1.5, 'days', '2026-02-01', '2026-01-01').dates, []);
	assert.deepEqual(computeRecurrence(1, 'days', 'not-a-date', '2026-01-01').dates, []);
	assert.deepEqual(computeRecurrence(1, 'days', '2026-02-01', 'not-a-date').dates, []);
});
