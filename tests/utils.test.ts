import test from 'node:test';
import assert from 'node:assert/strict';

import {
	normalizeText,
	isIncompleteTask,
	isCompletedTask,
	isDeletedTask,
	isScheduledTask,
	isBulletItem,
	getTaskText,
	getBulletMarker,
	getIndentLevel,
	removeMetadata,
	collectChildTasks,
} from '../src/utils';

test('normalizeText folds case, whitespace, and wikilinks', () => {
	assert.equal(normalizeText('  Call   [[Alice Smith]]  '), 'call alice smith');
	// Matching happens on normalized text, so these two must collapse together.
	assert.equal(normalizeText('Review [[Q1 Plan]]'), normalizeText('review  q1 plan'));
});

test('task state checks read the checkbox, not the text', () => {
	assert.ok(isIncompleteTask('- [ ] Write tests'));
	assert.ok(isIncompleteTask('    - [ ] Indented'));
	assert.ok(!isIncompleteTask('- [x] Done'));

	assert.ok(isCompletedTask('- [x] Done'));
	assert.ok(isCompletedTask('- [X] Done'));
	assert.ok(isDeletedTask('- [-] Cancelled'));
	assert.ok(isScheduledTask('- [s] Scheduled'));
	assert.ok(!isScheduledTask('- [ ] Not scheduled'));
});

test('bullet items include plain list items and marked ones', () => {
	assert.ok(isBulletItem('- [>w] Migrate me'));
	assert.ok(isBulletItem('- Just a note'));
	assert.ok(!isBulletItem('## A heading'));
	assert.ok(!isBulletItem('Plain paragraph'));
});

test('getTaskText strips the checkbox or the bare bullet', () => {
	assert.equal(getTaskText('- [ ] Write tests'), 'Write tests');
	assert.equal(getTaskText('  - [>w{o}] Team sync'), 'Team sync');
	assert.equal(getTaskText('- Information point'), 'Information point');
	assert.equal(getTaskText('Not a bullet'), '');
});

test('getBulletMarker returns the checkbox contents', () => {
	assert.equal(getBulletMarker('- [ ] Task'), '');
	assert.equal(getBulletMarker('- [>w] Task'), '>w');
	assert.equal(getBulletMarker('  - [>fri{a}] Task'), '>fri{a}');
	assert.equal(getBulletMarker('- Plain bullet'), null);
});

test('getIndentLevel counts leading whitespace characters', () => {
	assert.equal(getIndentLevel('- [ ] Top level'), 0);
	assert.equal(getIndentLevel('    - [ ] Four spaces'), 4);
	assert.equal(getIndentLevel('\t- [ ] One tab'), 1);
});

test('removeMetadata strips the source annotation', () => {
	assert.equal(removeMetadata('- [ ] Task (from: Journal/001 Daily Notes/2026-01-15.md)'), '- [ ] Task');
	assert.equal(removeMetadata('- [ ] Task'), '- [ ] Task');
});

test('collectChildTasks takes the indented block under a task', () => {
	const lines = [
		'- [>w] Parent task',
		'    - [ ] First child',
		'    - [ ] Second child',
		'        - [ ] Grandchild',
		'- [ ] Next sibling',
	];

	const children = collectChildTasks(lines, 0, 0);

	assert.deepEqual(children.map(c => c.line.trim()), [
		'- [ ] First child',
		'- [ ] Second child',
		'- [ ] Grandchild',
	]);
	assert.deepEqual(children.map(c => c.indent), [4, 4, 8]);
	assert.deepEqual(children.map(c => c.index), [1, 2, 3]);
});

test('collectChildTasks stops at the first line back at the parent level', () => {
	const lines = [
		'- [>w] Parent',
		'    - [ ] Child',
		'- [ ] Sibling',
		'    - [ ] Sibling child',
	];

	assert.equal(collectChildTasks(lines, 0, 0).length, 1);
});

test('a task with no indented block has no children', () => {
	assert.deepEqual(collectChildTasks(['- [>w] Lonely', '- [ ] Other'], 0, 0), []);
});

test('children are collected relative to the parent\'s own indent', () => {
	const lines = [
		'    - [>w] Nested parent',
		'        - [ ] Its child',
		'    - [ ] Nested sibling',
	];

	assert.deepEqual(collectChildTasks(lines, 0, 4).map(c => c.line.trim()), ['- [ ] Its child']);
});
