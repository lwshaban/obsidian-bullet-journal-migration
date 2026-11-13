// The commit rule: a source task is marked migrated only once the item has
// been read back from its destination. Every test here is a way that used to
// fail — the source got crossed out and the task existed nowhere.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BulletJournalMigration } from '../src/bulletJournalMigration';
import { DEFAULT_SETTINGS } from '../src/settings';
import { OUTSTANDING_ONLY } from '../src/types';
import { fakeApp } from './helpers/fake-vault';

const DAILY = DEFAULT_SETTINGS.dailyNotesPath;
const MONTHLY = DEFAULT_SETTINGS.monthlyNotesPath;

const SOURCE = `${DAILY}/2026-10-30.md`;
const DEST = `${DAILY}/2026-12-15.md`;

/** A source note holding one task marked for an explicit destination date. */
function sourceNote(marker = '>2026-12-15') {
	return ['## Notes', `- [${marker}] Pay invoice`, ''].join('\n');
}

function setup(files: Record<string, string>) {
	const harness = fakeApp(files);
	const bujo = new BulletJournalMigration(harness.app, () => DEFAULT_SETTINGS);
	return { ...harness, bujo };
}

test('a crossed-out copy at the destination does not satisfy a migration', async () => {
	// The destination already mentions this task, but only as a [>] record of
	// a previous cycle. Deduping against it marked the source migrated and
	// left nothing anywhere that could still be done.
	const { bujo, lines } = setup({
		[SOURCE]: sourceNote(),
		[DEST]: ['## Notes', '- [>] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask(`- [>2026-12-15] Pay invoice`, SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.ok(!result.deduped);
	assert.ok(lines(DEST).includes('- [ ] Pay invoice'), 'a live copy must be written');
	assert.ok(lines(SOURCE).includes('- [>] Pay invoice'), 'source is marked migrated');
});

test('a live copy at the destination satisfies the migration, and says so', async () => {
	const { bujo, lines } = setup({
		[SOURCE]: sourceNote(),
		[DEST]: ['## Notes', '- [ ] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask(`- [>2026-12-15] Pay invoice`, SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.equal(result.deduped, true);
	assert.equal(
		lines(DEST).filter(l => l === '- [ ] Pay invoice').length, 1,
		'no second copy of a task that is already open there',
	);
	assert.ok(lines(SOURCE).includes('- [>] Pay invoice'));
});

test('a destination write that does not land leaves the source alone', async () => {
	const { bujo, vault, lines } = setup({
		[SOURCE]: sourceNote(),
		[DEST]: ['## Notes', ''].join('\n'),
	});
	vault.swallowWrites = true;

	const result = await bujo.migrateTask(`- [>2026-12-15] Pay invoice`, SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, false);
	assert.match(result.error ?? '', /not confirmed/);
	assert.ok(
		lines(SOURCE).includes('- [>2026-12-15] Pay invoice'),
		'the marker survives so the task can be retried',
	);
});

test('a marker resolving to the note the task is already in is refused', async () => {
	// [>2026-12-15] written in 2026-12-15.md: the append would dedup against
	// the task itself, then the source update would cross it out.
	const { bujo, lines } = setup({
		[DEST]: ['## Notes', '- [>2026-12-15] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask(`- [>2026-12-15] Pay invoice`, DEST, '2026-12-15', 'daily');

	assert.equal(result.success, false);
	assert.match(result.error ?? '', /resolves to this note itself/);
	assert.ok(lines(DEST).includes('- [>2026-12-15] Pay invoice'), 'task is left untouched');
});

test('scheduling into the note the task is already in is refused too', async () => {
	const monthly = `${MONTHLY}/2026-12.md`;
	const { bujo, lines } = setup({
		[monthly]: ['## Plan', '- [>2026-12] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTaskForPlan(`- [>2026-12] Pay invoice`, monthly, '2026-12-01', 'monthly');

	assert.equal(result.success, false);
	assert.match(result.error ?? '', /resolves to this note itself/);
	assert.ok(lines(monthly).includes('- [>2026-12] Pay invoice'));
});

test('a confirmed migration writes the destination before marking the source', async () => {
	// Destination note does not exist yet: it gets created (no template in the
	// fake vault, so from empty) and the task must be in it afterwards.
	const { bujo, vault, lines } = setup({ [SOURCE]: sourceNote() });

	const result = await bujo.migrateTask(`- [>2026-12-15] Pay invoice`, SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.equal(result.destFile, DEST);
	assert.ok(vault.files.has(DEST));
	assert.ok(lines(DEST).includes('- [ ] Pay invoice'));
	assert.ok(lines(SOURCE).includes('- [>] Pay invoice'));
});

test('migrated items are hidden from reviews unless recovery is asked for', async () => {
	const { bujo } = setup({
		[SOURCE]: [
			'## Notes',
			'- [ ] Still open',
			'- [>] Marked migrated, may have gone nowhere',
			'- [<] Scheduled elsewhere',
			'- [+] New task created',
			'- [x] Done',
			'- [-] Cancelled',
			'',
		].join('\n'),
	});

	const normal = await bujo.collectTasks(SOURCE, OUTSTANDING_ONLY);
	assert.deepEqual(normal, ['- [ ] Still open']);

	const recovery = await bujo.collectTasks(SOURCE, { ...OUTSTANDING_ONLY, migrated: true });
	assert.deepEqual(recovery, [
		'- [ ] Still open',
		'- [>] Marked migrated, may have gone nowhere',
		'- [<] Scheduled elsewhere',
		'- [+] New task created',
	]);
});

test('[s] is outstanding work, so it counts as a copy at the destination', async () => {
	// Scheduled means the task has a date, not a resolution — it is still open
	// where it sits, so it dedups like any other open task.
	const { bujo, lines } = setup({
		[SOURCE]: sourceNote(),
		[DEST]: ['## Notes', '- [s] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask(`- [>2026-12-15] Pay invoice`, SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.equal(result.deduped, true);
	assert.ok(lines(DEST).includes('- [s] Pay invoice'), 'the scheduled task is left as it is');
	assert.ok(!lines(DEST).includes('- [ ] Pay invoice'), 'no second copy alongside it');
	assert.ok(lines(SOURCE).includes('- [>] Pay invoice'));
});

test('a review marker overrides a scheduled task, not just an open one', async () => {
	// The one that bit in October: marking an [s] task [<] in a review found
	// nothing to change (the match and the rewrite both insisted on "[ ]"), so
	// the review claimed the task was dealt with and the source never moved.
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [s] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask('- [<] Pay invoice', SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.ok(lines(SOURCE).includes('- [<] Pay invoice'), 'the [s] was overridden');
});

test('[<] carries over a scheduled task\'s children too', async () => {
	const { bujo, lines } = setup({
		[SOURCE]: [
			'## Notes',
			'- [s] Plan vacation',
			'\t- [s] Book flights',
			'\t- [ ] Check passport',
			'\t- [x] Book time off',
			'',
		].join('\n'),
	});

	const result = await bujo.migrateTask('- [<] Plan vacation', SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.equal(result.childrenMarked, 2);
	const after = lines(SOURCE);
	assert.ok(after.includes('- [<] Plan vacation'));
	assert.ok(after.includes('\t- [<] Book flights'), 'a scheduled child is overridden');
	assert.ok(after.includes('\t- [<] Check passport'));
	assert.ok(after.includes('\t- [x] Book time off'), 'finished work stays finished');
});

test('[>-] marks a scheduled task migrated', async () => {
	// [>-] parses as the skip marker, which marks the parent only.
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [s] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask('- [>-] Pay invoice', SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.ok(lines(SOURCE).includes('- [>] Pay invoice'));
});

test('marking a task that has since been completed leaves it alone', async () => {
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [x] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask('- [<] Pay invoice', SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.equal(result.skipped, true);
	assert.ok(lines(SOURCE).includes('- [x] Pay invoice'));
});

test('a destination checkbox the user asked for counts as landed', async () => {
	// [>…{s}] deliberately writes [s] at the destination. That is the state we
	// were told to write, so it must verify rather than look like a carcass.
	const { bujo, lines } = setup({ [SOURCE]: sourceNote('>2026-12-15{s}') });

	const result = await bujo.migrateTask('- [>2026-12-15{s}] Pay invoice', SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.ok(lines(DEST).includes('- [s] Pay invoice'));
	assert.ok(lines(SOURCE).includes('- [>] Pay invoice'));
});

test('planning never walks a task backwards into [s]', async () => {
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [x] Already done', '- [<] Already scheduled', ''].join('\n'),
	});

	const done = await bujo.markAsScheduled('- [>skip] Already done', SOURCE);
	const scheduled = await bujo.markAsScheduled('- [>skip] Already scheduled', SOURCE);

	assert.equal(done.success, true);
	assert.equal(done.skipped, true);
	assert.equal(scheduled.success, true);
	assert.equal(scheduled.skipped, true);
	assert.ok(lines(SOURCE).includes('- [x] Already done'));
	assert.ok(lines(SOURCE).includes('- [<] Already scheduled'));
});

test('completing a task that is already ticked is not an error', async () => {
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [x] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.completeTask('- [x] Pay invoice', SOURCE);

	assert.equal(result.success, true);
	assert.equal(result.skipped, true);
	assert.ok(lines(SOURCE).includes('- [x] Pay invoice'));
});

test('re-asserting a state a task is already in is not an error', async () => {
	// A recovery review lists [<] items; the ones the user leaves alone must
	// not fail the run and keep the review from being filed away.
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [<] Scheduled elsewhere', ''].join('\n'),
	});

	const result = await bujo.migrateTask('- [<] Scheduled elsewhere', SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.equal(result.skipped, true);
	assert.ok(lines(SOURCE).includes('- [<] Scheduled elsewhere'));
});

test('a recovered [>] task can be re-migrated from a review', async () => {
	// What the recovery review produces: the source line is still [>], and the
	// review line carries a fresh destination marker.
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [>] Pay invoice', ''].join('\n'),
	});

	const result = await bujo.migrateTask(`- [>2026-12-15] Pay invoice`, SOURCE, '2026-10-30', 'daily');

	assert.equal(result.success, true);
	assert.ok(lines(DEST).includes('- [ ] Pay invoice'));
});

test('a batch of migrations arrives in the order it was marked up', async () => {
	// Each task used to be inserted straight after the section heading, so the
	// second landed above the first and a batch arrived upside down.
	const { bujo, lines } = setup({
		[SOURCE]: [
			'## Notes',
			'- [>2026-12-15] First',
			'- [>2026-12-15] Second',
			'- [>2026-12-15] Third',
			'',
		].join('\n'),
		[DEST]: ['# 2026-12-15', '', '## Notes', '', '## Log', ''].join('\n'),
	});

	for (const task of ['First', 'Second', 'Third']) {
		const result = await bujo.migrateTask(`- [>2026-12-15] ${task}`, SOURCE, '2026-10-30', 'daily');
		assert.equal(result.success, true, task);
	}

	const body = lines(DEST);
	assert.deepEqual(body.filter(l => l.startsWith('- ')), [
		'- [ ] First',
		'- [ ] Second',
		'- [ ] Third',
	]);
	// …and inside the right section, not spilled into the one after it
	assert.ok(body.indexOf('- [ ] Third') < body.indexOf('## Log'));
});

test('migrations join an existing list rather than jumping above it', async () => {
	const { bujo, lines } = setup({
		[SOURCE]: ['## Notes', '- [>2026-12-15] Newcomer', ''].join('\n'),
		[DEST]: ['## Notes', '- [ ] Already here', '- [x] Done earlier', '', ''].join('\n'),
	});

	await bujo.migrateTask('- [>2026-12-15] Newcomer', SOURCE, '2026-10-30', 'daily');

	assert.deepEqual(lines(DEST).filter(l => l.startsWith('- ')), [
		'- [ ] Already here',
		'- [x] Done earlier',
		'- [ ] Newcomer',
	]);
});
