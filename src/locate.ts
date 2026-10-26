// Task location built on Obsidian's metadata cache instead of raw regex scans.
//
// The cache (app.metadataCache.getFileCache) already knows every list item in a
// file — its position, its checkbox character, and its parent — so we use it to
// narrow the search to real list items (a regex scan can match task-looking
// lines inside code blocks) and to read the parent/child hierarchy directly.
//
// The cache updates asynchronously after writes, so it is never trusted
// blindly: every candidate is verified against the actual current file
// content, and callers fall back to a full scan / indent walk when the cache
// is missing or stale.

import type { CachedMetadata } from 'obsidian';
import { normalizeText, getTaskText, removeMetadata } from './utils';

/**
 * Line numbers of list items according to the metadata cache, or null when the
 * cache has none to offer.
 */
function cachedListItemLines(cache: CachedMetadata | null | undefined, lineCount: number): number[] | null {
	const items = cache?.listItems;
	if (!items || items.length === 0) return null;
	const lines = items
		.map(item => item.position.start.line)
		.filter(n => n >= 0 && n < lineCount);
	return lines.length > 0 ? lines : null;
}

function findIn(
	lines: string[],
	candidates: number[],
	targetTrimmed: string,
	targetNorm: string,
	filterFn: (line: string) => boolean,
): number {
	// Pass 1: exact line match
	for (const n of candidates) {
		const line = lines[n];
		if (line !== undefined && filterFn(line) && line.trim() === targetTrimmed) return n;
	}
	// Pass 2: normalized task-text match (checkbox and (from: ...) metadata ignored)
	if (!targetNorm) return -1;
	for (const n of candidates) {
		const line = lines[n];
		if (line === undefined || !filterFn(line)) continue;
		if (normalizeText(removeMetadata(getTaskText(line))) === targetNorm) return n;
	}
	return -1;
}

/**
 * Locate the line for a task: exact match first, then normalized-text match.
 * Candidates come from the cache's list items when available (verified against
 * current content), with a full-scan fallback in case the cache is stale.
 * No fuzzy matching — returns -1 so callers fail loudly instead of guessing.
 */
export function locateTaskLine(
	lines: string[],
	targetLine: string,
	cache: CachedMetadata | null | undefined,
	filterFn: (line: string) => boolean = () => true,
): number {
	const targetTrimmed = targetLine.trim();
	const targetNorm = normalizeText(removeMetadata(getTaskText(targetLine)));

	const cached = cachedListItemLines(cache, lines.length);
	if (cached) {
		const idx = findIn(lines, cached, targetTrimmed, targetNorm, filterFn);
		if (idx !== -1) return idx;
	}

	const all = Array.from({ length: lines.length }, (_, i) => i);
	return findIn(lines, all, targetTrimmed, targetNorm, filterFn);
}

/**
 * Deepest list nesting we treat as real. Anything past this is a symptom of a
 * stale or corrupt cache, not a bullet journal — bail to the indent walk.
 */
const MAX_NESTING = 64;

/**
 * Ancestor list-item line numbers for the item at `line`, outermost first
 * (e.g. [grandparent, parent]). Empty array = top-level item. Returns null
 * when the cache has no list items, doesn't know this line, or describes a
 * hierarchy we refuse to trust, so callers can fall back to indent detection.
 */
export function ancestorLines(cache: CachedMetadata | null | undefined, line: number): number[] | null {
	const items = cache?.listItems;
	if (!items || items.length === 0) return null;

	const byLine = new Map(items.map(i => [i.position.start.line, i]));
	const self = byLine.get(line);
	if (!self) return null;

	const chain: number[] = [];
	// listItem.parent is the parent's line number when positive; a negative
	// value means the item is top-level (points at its containing section).
	//
	// A mid-rebuild cache can hand back parent pointers that form a cycle. A
	// counter guard would "succeed" with a chain as long as the limit, and the
	// caller would faithfully write out that many nested context bullets — a
	// 1000-deep list that overflows Obsidian's own markdown tokenizer. Track
	// what we've visited instead and refuse the whole answer on a cycle.
	const seen = new Set<number>([line]);
	let parent = self.parent;
	while (parent >= 0) {
		if (seen.has(parent)) return null;      // cycle — don't trust the cache
		if (chain.length >= MAX_NESTING) return null;
		seen.add(parent);
		chain.push(parent);
		parent = byLine.get(parent)?.parent ?? -1;
	}
	return chain.reverse();
}

/**
 * Line numbers of all descendants of the list item at parentLine, read from
 * the cache's parent pointers. Returns null when the cache has no list items
 * or doesn't know this parent — callers should fall back to indent walking.
 */
export function descendantLines(cache: CachedMetadata | null | undefined, parentLine: number): number[] | null {
	const items = cache?.listItems;
	if (!items || items.length === 0) return null;

	const byLine = new Map(items.map(i => [i.position.start.line, i]));
	if (!byLine.has(parentLine)) return null;

	const result: number[] = [];
	for (const item of items) {
		const self = item.position.start.line;
		// Walk up the parent chain (negative parent = top-level item), with the
		// same cycle guard as ancestorLines — a counter would silently treat a
		// looping chain as "not a descendant" after 1000 wasted hops.
		const seen = new Set<number>([self]);
		let parent = item.parent;
		while (parent >= 0) {
			if (seen.has(parent)) break;        // cycle — this item is unusable
			seen.add(parent);
			if (parent === parentLine) {
				result.push(self);
				break;
			}
			parent = byLine.get(parent)?.parent ?? -1;
		}
	}
	return result.sort((a, b) => a - b);
}
