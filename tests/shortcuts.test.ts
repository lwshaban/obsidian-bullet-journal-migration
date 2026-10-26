import test from 'node:test';
import assert from 'node:assert/strict';

import {
	markLineForMigration,
	isTaskLine,
	isOpenTaskLine,
	findTaskLine,
	checkboxRange,
} from '../src/task-nav';

test('markLineForMigration opens the checkbox and parks the cursor inside it', () => {
	const marked = markLineForMigration('- [ ] Buy milk');
	assert.ok(marked);
	assert.equal(marked.line, '- [>] Buy milk');
	// The suggester fires on the text before the cursor matching "- [>", so the
	// caret has to sit between the ">" and the "]".
	assert.equal(marked.line.slice(0, marked.ch), '- [>');
});

test('markLineForMigration replaces an existing marker rather than stacking one', () => {
	const marked = markLineForMigration('- [x] Already done');
	assert.ok(marked);
	assert.equal(marked.line, '- [>] Already done');

	const remark = markLineForMigration('\t- [>w] Marked last time');
	assert.ok(remark);
	assert.equal(remark.line, '\t- [>] Marked last time');
	assert.equal(remark.line.slice(0, remark.ch), '\t- [>');
});

test('markLineForMigration adds a checkbox to a plain bullet', () => {
	const marked = markLineForMigration('    - Call the dentist');
	assert.ok(marked);
	assert.equal(marked.line, '    - [>] Call the dentist');
	assert.equal(marked.line.slice(0, marked.ch), '    - [>');
});

test('markLineForMigration refuses lines that cannot hold a marker', () => {
	assert.equal(markLineForMigration('## Notes'), null);
	assert.equal(markLineForMigration(''), null);
	assert.equal(markLineForMigration('Just a paragraph'), null);
});

test('task line checks distinguish outstanding from finished', () => {
	assert.ok(isTaskLine('- [ ] Open'));
	assert.ok(isTaskLine('- [x] Done'));
	assert.ok(!isTaskLine('- plain bullet'));
	assert.ok(!isTaskLine('# Heading'));

	assert.ok(isOpenTaskLine('- [ ] Open'));
	assert.ok(!isOpenTaskLine('- [x] Done'));
	assert.ok(!isOpenTaskLine('- [>w] Migrated'));
});

const NOTE = [
	'# Daily',          // 0
	'- [ ] First',      // 1
	'- plain bullet',   // 2
	'- [x] Second',     // 3
	'',                 // 4
	'- [ ] Third',      // 5
];

test('findTaskLine walks forwards and backwards, skipping non-tasks', () => {
	assert.equal(findTaskLine(NOTE, 0, 1), 1);
	assert.equal(findTaskLine(NOTE, 1, 1), 3, 'plain bullets are not tasks');
	assert.equal(findTaskLine(NOTE, 3, 1), 5, 'blank lines are stepped over');
	assert.equal(findTaskLine(NOTE, 5, -1), 3);
	assert.equal(findTaskLine(NOTE, 1, -1), -1, 'nothing above the first task');
});

test('findTaskLine never returns the line it started on', () => {
	// Otherwise "next" would stick, and holding the key would do nothing.
	assert.equal(findTaskLine(NOTE, 1, 1), 3);
	assert.equal(findTaskLine(['- [ ] Only task'], 0, 1), -1);
});

test('findTaskLine can restrict to unfinished tasks', () => {
	assert.equal(findTaskLine(NOTE, 1, 1, true), 5, 'the [x] line is skipped');
	assert.equal(findTaskLine(NOTE, 5, 1, true), -1);
	assert.equal(findTaskLine(NOTE, 5, -1, true), 1);
});

test('checkboxRange spans the checkbox contents so typing replaces them', () => {
	const line = '- [ ] Buy milk';
	const range = checkboxRange(line);
	assert.ok(range);
	assert.equal(line.slice(range.from, range.to), ' ');
	// Replacing that span with ">" must yield the state the suggester triggers on.
	const typed = line.slice(0, range.from) + '>' + line.slice(range.to);
	assert.equal(typed, '- [>] Buy milk');
	assert.equal(typed.slice(0, range.from + 1), '- [>');
});

test('checkboxRange handles indentation and multi-character states', () => {
	const line = '\t\t- [>w] Already marked';
	const range = checkboxRange(line);
	assert.ok(range);
	assert.equal(line.slice(range.from, range.to), '>w');

	assert.equal(checkboxRange('- plain bullet'), null);
	assert.equal(checkboxRange('# Heading'), null);
});
