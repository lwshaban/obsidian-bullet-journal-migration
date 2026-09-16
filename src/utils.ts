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
