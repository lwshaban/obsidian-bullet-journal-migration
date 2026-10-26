// Shared utility functions extracted to eliminate duplication across the codebase.
// Every function here was previously defined inline (sometimes 7+ times).

export function normalizeText(text: string): string {
	return text.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.trim();
}

// ── Task type checks ──────────────────────────────────────────────────────────

export function isIncompleteTask(line: string): boolean {
	return /^-\s*\[\s\]/.test(line.trim());
}

export function isCompletedTask(line: string): boolean {
	return /^-\s*\[x\]/i.test(line.trim());
}

export function isDeletedTask(line: string): boolean {
	return /^-\s*\[-\]/.test(line.trim());
}

export function isScheduledTask(line: string): boolean {
	return /^-\s*\[s\]/.test(line.trim());
}

export function isBulletItem(line: string): boolean {
	const trimmed = line.trim();
	return /^\s*-\s*(\[[^\]]+\]|.+)/.test(trimmed) || /^\s*-\s+/.test(trimmed);
}

// ── Line helpers ───────────────────────────────────────────────────────────────

export function getTaskText(line: string): string {
	const taskMatch = line.match(/^\s*-\s*\[[^\]]+\]\s*(.+)$/);
	if (taskMatch && taskMatch[1]) return taskMatch[1].trim();

	const plainMatch = line.match(/^\s*-\s+(.+)$/);
	if (plainMatch && plainMatch[1]) return plainMatch[1].trim();

	return '';
}

export function getBulletMarker(line: string): string | null {
	const match = line.match(/^\s*-\s*\[([^\]]+)\]/);
	return (match && match[1]) ? match[1].trim() : null;
}

export function getIndentLevel(line: string): number {
	const match = line.match(/^(\s*)/);
	return (match && match[1]) ? match[1].length : 0;
}

export function removeMetadata(line: string): string {
	return line.replace(/\s*\(from:\s*[^)]+\)/, '');
}

// ── Ancestor context ───────────────────────────────────────────────────────────

/**
 * How many parent levels are worth carrying to a destination as context. More
 * than this is noise, and a chain longer than this means something upstream is
 * wrong rather than that the user nested eight lists deep on purpose.
 */
export const MAX_ANCESTOR_CONTEXT = 8;

/** Hard ceiling on indentation the plugin will write, in tabs. */
export const MAX_WRITE_INDENT = 12;

/**
 * Clean a collected ancestor chain before it is written out as context bullets.
 *
 * Drops blanks, drops any "ancestor" that is really the task itself (a task
 * whose own text starts with a bullet dash collapses onto its context line, so
 * nothing downstream can tell the two apart), collapses repeats, and keeps only
 * the innermost few. Chain order is outermost-first and preserved.
 */
export function sanitizeAncestorContext(ancestors: string[], taskText: string): string[] {
	const taskNorm = normalizeText(taskText.replace(/^-\s+/, ''));
	const seen = new Set<string>();
	const kept: string[] = [];

	for (const raw of ancestors) {
		const text = raw.trim();
		if (!text) continue;
		const norm = normalizeText(text.replace(/^-\s+/, ''));
		if (!norm) continue;
		if (norm === taskNorm) continue;  // self-parenting — would nest forever
		if (seen.has(norm)) continue;     // same parent twice — a cache artefact
		seen.add(norm);
		kept.push(text);
	}

	return kept.slice(-MAX_ANCESTOR_CONTEXT);
}

/**
 * Last-resort clamp on a batch about to be written. Indentation past
 * MAX_WRITE_INDENT is never intentional, and deeply nested lists are what
 * overflow Obsidian's markdown tokenizer, so flatten rather than emit them.
 */
export function clampIndent(lines: string[], max: number = MAX_WRITE_INDENT): string[] {
	return lines.map(line => {
		const lead = line.match(/^[\t ]*/)?.[0] ?? '';
		const depth = (lead.match(/\t/g) ?? []).length + Math.floor(lead.replace(/\t/g, '').length / 4);
		if (depth <= max) return line;
		return '\t'.repeat(max) + line.slice(lead.length);
	});
}

// ── Child collection ───────────────────────────────────────────────────────────

export interface ChildTaskRef {
	line: string;
	index: number;
	indent: number;
}

/**
 * Collect child tasks (lines with greater indentation) following a parent task.
 */
export function collectChildTasks(
	lines: string[],
	parentIndex: number,
	parentIndent: number
): ChildTaskRef[] {
	const children: ChildTaskRef[] = [];
	for (let i = parentIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const lineIndent = getIndentLevel(line);

		if (lineIndent <= parentIndent) break;
		if (!line.trim() || !isBulletItem(line)) continue;

		children.push({ line, index: i, indent: lineIndent });
	}
	return children;
}
