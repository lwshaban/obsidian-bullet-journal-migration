// Review generation: which notes a scope covers, which task states get listed,
// and where the document lands.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BulletJournalMigration, MAX_REVIEW_LINE } from '../src/bulletJournalMigration';
import { DEFAULT_SETTINGS } from '../src/settings';
import { BujoPaths } from '../src/paths';
import { rangeNotePaths } from '../src/reviews';
import { OUTSTANDING_ONLY, TaskInclusion } from '../src/types';
import { fakeApp } from './helpers/fake-vault';
import { moment } from 'obsidian';

const DAILY = DEFAULT_SETTINGS.dailyNotesPath;
const WEEKLY = DEFAULT_SETTINGS.weeklyNotesPath;
const MONTHLY = DEFAULT_SETTINGS.monthlyNotesPath;
const REVIEWS = DEFAULT_SETTINGS.reviewsPath;

function setup(files: Record<string, string> = {}) {
	const harness = fakeApp(files);
	const bujo = new BulletJournalMigration(harness.app, () => DEFAULT_SETTINGS);
	return { ...harness, bujo };
}

function include(extra: Partial<TaskInclusion> = {}): TaskInclusion {
	return { ...OUTSTANDING_ONLY, ...extra };
}

/** Every kind of entry a journal note can hold, in one note. */
const MIXED_NOTE = [
	'## Notes',
	'- [ ] Open task',
	'- [s] Scheduled task',
	'- [o] Event',
	'- [a] Appointment',
	'- [/] In progress',
	'- [>mon] Marked for Monday',
	'- Information point',
	'- [>] Already migrated',
	'- [<] Scheduled elsewhere',
	'- [+] New task created',
	'- [x] Completed task',
	'- [-] Cancelled task',
	'---',
	'',
].join('\n');

test('a scope collects only the states it asks for', async () => {
	const path = `${DAILY}/2026-10-30.md`;
	const { bujo } = setup({ [path]: MIXED_NOTE });

	// Outstanding is the whole page, not just the ticked-box kind: events,
	// appointments and information points are journal entries too.
	assert.deepEqual(await bujo.collectTasks(path, include()), [
		'- [ ] Open task',
		'- [s] Scheduled task',
		'- [o] Event',
		'- [a] Appointment',
		'- [/] In progress',
		'- [>mon] Marked for Monday',
		'- Information point',
	]);

	assert.deepEqual(await bujo.collectTasks(path, include({ completed: true, outstanding: false })), [
		'- [x] Completed task',
	]);

	assert.deepEqual(await bujo.collectTasks(path, include({ migrated: true, outstanding: false })), [
		'- [>] Already migrated',
		'- [<] Scheduled elsewhere',
		'- [+] New task created',
	]);

	assert.deepEqual(await bujo.collectTasks(path, include({ cancelled: true, outstanding: false })), [
		'- [-] Cancelled task',
	]);
});

test('every entry falls in exactly one group', () => {
	const { bujo } = setup();

	// Anything unfinished and unfiled is outstanding, whatever its checkbox
	for (const line of ['- [ ] x', '- [s] x', '- [o] x', '- [a] x', '- [/] x', '- [!] x', '- plain bullet']) {
		assert.equal(bujo.classifyTaskState(line), 'outstanding', line);
	}
	// [>mon] and [>-] are pending instructions, not filed tasks
	assert.equal(bujo.classifyTaskState('- [>w] x'), 'outstanding');
	assert.equal(bujo.classifyTaskState('- [>-] x'), 'outstanding');

	assert.equal(bujo.classifyTaskState('- [>] x'), 'migrated');
	assert.equal(bujo.classifyTaskState('- [<] x'), 'migrated');
	assert.equal(bujo.classifyTaskState('- [+] x'), 'migrated');
	assert.equal(bujo.classifyTaskState('- [x] x'), 'completed');
	assert.equal(bujo.classifyTaskState('- [-] x'), 'cancelled');

	// Not entries: headings, rules, prose, and bullets with nothing in them
	assert.equal(bujo.classifyTaskState('## heading'), null);
	assert.equal(bujo.classifyTaskState('---'), null);
	assert.equal(bujo.classifyTaskState('just prose'), null);
	assert.equal(bujo.classifyTaskState('- [ ]'), null);
	assert.equal(bujo.classifyTaskState('-'), null);
});

test('an entry too long to type beside is held back, not copied in', async () => {
	// A single 240KB bullet (a pasted data URI) made a generated review take
	// seconds per keystroke: CodeMirror re-tokenizes the whole line on each
	// one. Held back rather than truncated — processing matches a task by its
	// text, so a shortened copy could never be acted on.
	const path = `${DAILY}/2026-10-30.md`;
	const huge = `- [ ] ${'x'.repeat(MAX_REVIEW_LINE)}`;
	const { bujo } = setup({
		[path]: ['## Notes', '- [ ] Normal task', huge, ''].join('\n'),
	});

	const stats = { oversized: 0 };
	assert.deepEqual(await bujo.collectTasks(path, include(), stats), ['- [ ] Normal task']);
	assert.equal(stats.oversized, 1);
});

test('an entry right at the limit is still listed', async () => {
	const path = `${DAILY}/2026-10-30.md`;
	const prefix = '- [ ] ';
	const exact = prefix + 'y'.repeat(MAX_REVIEW_LINE - prefix.length);
	assert.equal(exact.length, MAX_REVIEW_LINE);

	const { bujo } = setup({ [path]: ['## Notes', exact, ''].join('\n') });

	const stats = { oversized: 0 };
	assert.deepEqual(await bujo.collectTasks(path, include(), stats), [exact]);
	assert.equal(stats.oversized, 0);
});

test('a review says what it held back', async () => {
	const { bujo, vault } = setup({
		[`${DAILY}/2026-10-30.md`]: [
			'## Notes',
			'- [ ] Normal task',
			`- [ ] ${'z'.repeat(MAX_REVIEW_LINE)}`,
			'',
		].join('\n'),
	});

	await bujo.generateReview({ scope: { kind: 'monthly', month: '2026-10' }, include: include() });

	const review = vault.files.get(`${REVIEWS}/Monthly/2026-10-Review.md`) ?? '';
	assert.ok(review.includes('- [ ] Normal task'));
	assert.ok(!review.includes('zzz'), 'the oversized entry is not copied in');
	assert.match(review, /1 entry was too long to list/);
	// A silent omission is the same failure as a silently dropped migration
	assert.match(review, new RegExp(`over ${MAX_REVIEW_LINE} characters`));
});

test('a week covers its dailies and its weekly note, not the month', () => {
	const paths = new BujoPaths(DEFAULT_SETTINGS);
	const week = moment('2026-W44', 'GGGG-[W]WW');
	const covered = rangeNotePaths(paths, week.clone().startOf('isoWeek'), week.clone().endOf('isoWeek'), { monthly: false });

	assert.equal(covered.filter(p => p.startsWith(DAILY)).length, 7);
	assert.deepEqual(covered.filter(p => p.startsWith(WEEKLY)), [`${WEEKLY}/2026-W44.md`]);
	assert.deepEqual(covered.filter(p => p.startsWith(MONTHLY)), []);
});

test('a month covers its dailies, overlapping weeks and its monthly note', () => {
	const paths = new BujoPaths(DEFAULT_SETTINGS);
	const month = moment('2026-01', 'YYYY-MM');
	const covered = rangeNotePaths(paths, month.clone().startOf('month'), month.clone().endOf('month'));

	assert.equal(covered.filter(p => p.startsWith(DAILY)).length, 31);
	assert.deepEqual(covered.filter(p => p.startsWith(MONTHLY)), [`${MONTHLY}/2026-01.md`]);
	// January 2026 starts in ISO week 1 of 2026 and ends in week 5 — a week
	// range that a numeric loop over week numbers gets wrong at year ends.
	const weeks = covered.filter(p => p.startsWith(WEEKLY));
	assert.ok(weeks.length >= 5, `expected the month's weeks, got ${weeks.join(', ')}`);
	assert.ok(weeks.includes(`${WEEKLY}/2026-W01.md`));
});

test('a date range spans the notes it touches and nothing else', () => {
	const paths = new BujoPaths(DEFAULT_SETTINGS);
	const covered = rangeNotePaths(
		paths,
		moment('2026-10-29', 'YYYY-MM-DD'),
		moment('2026-11-02', 'YYYY-MM-DD'),
	);

	assert.deepEqual(covered.filter(p => p.startsWith(DAILY)), [
		`${DAILY}/2026-10-29.md`,
		`${DAILY}/2026-10-30.md`,
		`${DAILY}/2026-10-31.md`,
		`${DAILY}/2026-11-01.md`,
		`${DAILY}/2026-11-02.md`,
	]);
	assert.deepEqual(covered.filter(p => p.startsWith(MONTHLY)), [
		`${MONTHLY}/2026-10.md`,
		`${MONTHLY}/2026-11.md`,
	]);
});

test('a monthly review gathers its month and groups by source', async () => {
	const { bujo, vault } = setup({
		[`${DAILY}/2026-10-30.md`]: ['## Notes', '- [ ] Pay invoice', ''].join('\n'),
		[`${MONTHLY}/2026-10.md`]: ['## Plan', '- [ ] Book flights', ''].join('\n'),
		[`${DAILY}/2026-09-30.md`]: ['## Notes', '- [ ] Last month, not included', ''].join('\n'),
	});

	await bujo.generateReview({ scope: { kind: 'monthly', month: '2026-10' }, include: include() });

	const review = vault.files.get(`${REVIEWS}/Monthly/2026-10-Review.md`);
	assert.ok(review, 'review written to the Monthly folder');
	assert.match(review, /# Monthly Review - 2026-10\n/);
	assert.match(review, /## \[\[2026-10-30\]\]\n- \[ \] Pay invoice/);
	assert.match(review, /## \[\[2026-10\]\]\n- \[ \] Book flights/);
	assert.ok(!review.includes('Last month'), 'notes outside the month are left out');
});

test('a review of extra states goes to its own note, so an annotated one survives', async () => {
	const { bujo, vault } = setup({
		[`${DAILY}/2026-10-30.md`]: MIXED_NOTE,
	});

	await bujo.generateReview({ scope: { kind: 'monthly', month: '2026-10' }, include: include() });
	await bujo.generateReview({
		scope: { kind: 'monthly', month: '2026-10' },
		include: include({ migrated: true, completed: true }),
	});

	const plain = vault.files.get(`${REVIEWS}/Monthly/2026-10-Review.md`);
	const all = vault.files.get(`${REVIEWS}/Monthly/2026-10-Review-all.md`);
	assert.ok(plain && !plain.includes('[x] Completed task'), 'the plain review is untouched');
	assert.ok(all, 'the extended review is a separate note');
	assert.match(all, /# Monthly Review - 2026-10 \(incl\. already filed, completed\)/);
	assert.ok(all.includes('- [x] Completed task'));
	assert.ok(all.includes('- [>] Already migrated'));
	assert.ok(!all.includes('- [-] Cancelled task'), 'states not asked for stay out');
	assert.match(all, /Finished items are listed for reference/);
});

test('a range review lands in its own folder, named for the dates', async () => {
	const { bujo, vault } = setup({
		[`${DAILY}/2026-10-30.md`]: ['## Notes', '- [ ] Pay invoice', ''].join('\n'),
		[`${DAILY}/2026-11-05.md`]: ['## Notes', '- [ ] Outside the range', ''].join('\n'),
	});

	await bujo.generateReview({
		scope: { kind: 'range', from: '2026-10-29', to: '2026-11-02' },
		include: include(),
	});

	const review = vault.files.get(`${REVIEWS}/Range/2026-10-29_2026-11-02-Review.md`);
	assert.ok(review);
	assert.match(review, /# Review - 2026-10-29 → 2026-11-02/);
	assert.ok(review.includes('- [ ] Pay invoice'));
	assert.ok(!review.includes('Outside the range'));
});

test('a backwards range is read the right way round', async () => {
	const { bujo, vault } = setup({
		[`${DAILY}/2026-10-30.md`]: ['## Notes', '- [ ] Pay invoice', ''].join('\n'),
	});

	await bujo.generateReview({
		scope: { kind: 'range', from: '2026-11-02', to: '2026-10-29' },
		include: include(),
	});

	assert.ok(vault.files.has(`${REVIEWS}/Range/2026-10-29_2026-11-02-Review.md`));
});

test('an absurd range is refused rather than swept', async () => {
	const { bujo, vault } = setup();

	await bujo.generateReview({
		scope: { kind: 'range', from: '2020-01-01', to: '2026-01-01' },
		include: include(),
	});

	assert.equal(vault.files.size, 0, 'nothing written');
});

test('asking for no states at all is refused', async () => {
	const { bujo, vault } = setup({ [`${DAILY}/2026-10-30.md`]: MIXED_NOTE });

	await bujo.generateReview({
		scope: { kind: 'monthly', month: '2026-10' },
		include: include({ outstanding: false }),
	});

	assert.equal(vault.files.size, 1, 'only the source note exists');
});

test('a range review processes like any other review', async () => {
	// The whole round trip: generate, mark a task up, process it back.
	const source = `${DAILY}/2026-10-30.md`;
	// Asking for completed items too, so the review goes to the "-all" note
	const reviewPath = `${REVIEWS}/Range/2026-10-29_2026-11-02-Review-all.md`;
	const { bujo, vault, setActive, lines, trashed } = setup({
		[source]: ['## Notes', '- [ ] Pay invoice', '- [x] Already done', ''].join('\n'),
	});

	await bujo.generateReview({
		scope: { kind: 'range', from: '2026-10-29', to: '2026-11-02' },
		include: include({ completed: true }),
	});

	const generated = vault.files.get(reviewPath);
	assert.ok(generated, `review not found at ${reviewPath}`);
	assert.ok(generated.includes('- [x] Already done'), 'the completed item is listed');

	// Mark the open task for an explicit date, leave the completed one alone
	vault.files.set(reviewPath, generated.replace('- [ ] Pay invoice', '- [>2026-12-15] Pay invoice'));
	setActive(reviewPath);

	await bujo.migrateTasks();

	assert.ok(lines(`${DAILY}/2026-12-15.md`).includes('- [ ] Pay invoice'), 'task landed');
	assert.ok(lines(source).includes('- [>] Pay invoice'), 'source marked');
	assert.ok(lines(source).includes('- [x] Already done'), 'finished work untouched');
	assert.deepEqual(trashed, [reviewPath], 'review filed away once everything landed');
});

test('a review is kept when something in it fails', async () => {
	const reviewPath = `${REVIEWS}/Range/2026-10-29_2026-11-02-Review.md`;
	const { bujo, vault, setActive, trashed } = setup({
		// The review names a source note that no longer holds the task
		[reviewPath]: [
			'# Review - 2026-10-29 → 2026-11-02',
			'',
			'## [[2026-10-30]]',
			'- [>2026-12-15] Vanished task',
			'',
		].join('\n'),
		[`${DAILY}/2026-10-30.md`]: ['## Notes', ''].join('\n'),
	});
	setActive(reviewPath);

	await bujo.migrateTasks();

	assert.deepEqual(trashed, [], 'the review survives as the record of what is outstanding');
	assert.ok(vault.files.has(reviewPath));
});
