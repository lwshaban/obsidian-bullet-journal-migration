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
 * Ancestor list-item line numbers for the item at `line`, outermost first
 * (e.g. [grandparent, parent]). Empty array = top-level item. Returns null
 * when the cache has no list items or doesn't know this line, so callers can
 * fall back to indent-based detection.
 */
export function ancestorLines(cache: CachedMetadata | null | undefined, line: number): number[] | null {
	const items = cache?.listItems;
	if (!items || items.length === 0) return null;

	const byLine = new Map(items.map(i => [i.position.start.line, i]));
	const self = byLine.get(line);
	if (!self) return null;

	const chain: number[] = [];
	// listItem.parent is the parent's line number when positive; a negative
	// value means the item is top-level (points at its containing section)
	let parent = self.parent;
	let guard = 0;
	while (parent >= 0 && guard++ < 1000) {
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
		let parent = item.parent;
		let guard = 0;
		// Walk up the parent chain (negative parent = top-level item)
		while (parent >= 0 && guard++ < 1000) {
			if (parent === parentLine) {
				result.push(item.position.start.line);
				break;
			}
			parent = byLine.get(parent)?.parent ?? -1;
		}
	}
	return result.sort((a, b) => a - b);
}
