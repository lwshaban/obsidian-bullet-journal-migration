import test from 'node:test';
import assert from 'node:assert/strict';

import { locateTaskLine, ancestorLines, descendantLines } from '../src/locate';

// Minimal stand-in for the slice of CachedMetadata these functions read.
// `parent` is a line number when positive, negative when the item is top-level.
function cacheOf(items: { line: number; parent: number }[]) {
	return {
		listItems: items.map(({ line, parent }) => ({
			position: { start: { line, col: 0, offset: 0 }, end: { line, col: 0, offset: 0 } },
			parent,
		})),
	} as never;
}

test('ancestorLines returns the chain outermost first', () => {
	const cache = cacheOf([
		{ line: 0, parent: -1 },
		{ line: 1, parent: 0 },
		{ line: 2, parent: 1 },
	]);
	assert.deepEqual(ancestorLines(cache, 2), [0, 1]);
	assert.deepEqual(ancestorLines(cache, 0), []);
});

test('ancestorLines refuses a cycle instead of returning a bogus chain', () => {
	// A mid-rebuild cache can point two items at each other. The old counter
	// guard returned a 1000-long chain here, which the caller wrote out as 1000
	// nested context bullets — enough to overflow Obsidian's tokenizer.
	const cycle = cacheOf([
		{ line: 0, parent: 1 },
		{ line: 1, parent: 0 },
	]);
	assert.equal(ancestorLines(cycle, 0), null, 'cycle must fall back to the indent walk');

	// Self-parenting is the degenerate case of the same thing.
	const selfLoop = cacheOf([{ line: 5, parent: 5 }]);
	assert.equal(ancestorLines(selfLoop, 5), null);
});

test('ancestorLines refuses absurd depth', () => {
	// A legal but pathological chain, 100 deep, still beats MAX_NESTING (64).
	const deep = cacheOf(
		Array.from({ length: 100 }, (_, i) => ({ line: i, parent: i === 0 ? -1 : i - 1 })),
	);
	assert.equal(ancestorLines(deep, 99), null);
	// Something ordinary still works.
	assert.deepEqual(ancestorLines(deep, 3), [0, 1, 2]);
});

test('descendantLines collects a subtree and survives a cycle', () => {
	const cache = cacheOf([
		{ line: 0, parent: -1 },
		{ line: 1, parent: 0 },
		{ line: 2, parent: 1 },
		{ line: 3, parent: -1 },
	]);
	assert.deepEqual(descendantLines(cache, 0), [1, 2]);
	assert.deepEqual(descendantLines(cache, 3), []);

	const cycle = cacheOf([
		{ line: 0, parent: -1 },
		{ line: 1, parent: 2 },
		{ line: 2, parent: 1 },
	]);
	// The looping pair is simply unusable; the call must return, not hang.
	assert.deepEqual(descendantLines(cycle, 0), []);
});

test('locateTaskLine prefers an exact match, then normalized text', () => {
	const lines = [
		'- [ ] Buy milk',
		'- [ ] Call [[Alice Smith]] (from: 2026-01-01)',
	];
	const cache = cacheOf([{ line: 0, parent: -1 }, { line: 1, parent: -1 }]);

	assert.equal(locateTaskLine(lines, '- [ ] Buy milk', cache), 0);
	// Checkbox state and (from: …) metadata are ignored when matching.
	assert.equal(locateTaskLine(lines, '- [>] Call [[Alice Smith]]', cache), 1);
	assert.equal(locateTaskLine(lines, '- [ ] Not here', cache), -1);
});

test('locateTaskLine falls back to a full scan when the cache is stale', () => {
	const lines = ['- [ ] Buy milk', '- [ ] Pay rent'];
	// Cache knows nothing about line 1 yet.
	assert.equal(locateTaskLine(lines, '- [ ] Pay rent', cacheOf([{ line: 0, parent: -1 }])), 1);
	assert.equal(locateTaskLine(lines, '- [ ] Pay rent', null), 1);
});
