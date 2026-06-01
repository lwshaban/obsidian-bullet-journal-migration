// Time tracking — scan open tasks, start/stop timer, write [t] blocks back to markdown.

import { App, Notice, TFile, moment } from 'obsidian';
import { normalizeText, getTaskText, getIndentLevel, isBulletItem, isIncompleteTask } from './utils';

export interface TimerState {
	active: boolean;
	taskText: string;
	sourceFile: string;       // vault path to the file containing the task
	startTime: moment.Moment;
	statusBarEl?: HTMLElement;
}

export interface TrackedBlock {
	timeRange: string;         // e.g. "09:45-12:10"
	durationMinutes: number;
	parentTask: string;        // normalized task text
	file: string;              // vault path
}

// ── Task scanning ──────────────────────────────────────────────────────────────

export interface TrackableTask {
	text: string;
	file: string;          // vault path
	line: string;          // raw line (for matching later)
}

export async function scanOpenTasksFull(app: App): Promise<TrackableTask[]> {
	const results: TrackableTask[] = [];
	const files = app.vault.getMarkdownFiles();

	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		if (!cache?.listItems) continue;

		const content = await app.vault.read(file);
		const lines = content.split('\n');

		for (const item of cache.listItems) {
			if (item.parent >= 0) continue;  // top-level only
			if (item.task !== ' ') continue;   // incomplete only

			const lineNum = item.position.start.line;
			const line = lines[lineNum];
			if (!line) continue;

			const text = getTaskText(line);
			if (!text) continue;

			results.push({ text, file: file.path, line });
		}
	}

	return results.sort((a, b) => a.text.localeCompare(b.text));
}

// ── Timer management ───────────────────────────────────────────────────────────

let currentTimer: TimerState | null = null;

export function getActiveTimer(): TimerState | null {
	return currentTimer;
}

export function isTimerRunning(): boolean {
	return currentTimer?.active ?? false;
}

export function startTimer(task: TrackableTask): TimerState {
	if (currentTimer?.active) {
		stopTimerSilent(); // auto-stop previous
	}

	currentTimer = {
		active: true,
		taskText: task.text,
		sourceFile: task.file,
		startTime: moment(),
	};
	return currentTimer;
}

function stopTimerSilent(): TimerState | null {
	if (!currentTimer) return null;
	currentTimer.active = false;
	return { ...currentTimer };
}

/** Stop the timer and return the elapsed range as a string like "09:45-12:10" */
export function stopTimer(): { timer: TimerState; range: string } | null {
	if (!currentTimer?.active) return null;

	const start = currentTimer.startTime;
	const end = moment();
	const range = `${start.format('HH:mm')}-${end.format('HH:mm')}`;

	const timer = { ...currentTimer, active: false };
	currentTimer = null;

	return { timer, range };
}

/** Elapsed time formatted as "1h 23m" */
export function formatElapsed(timer: TimerState): string {
	const elapsed = moment.duration(moment().diff(timer.startTime));
	const h = Math.floor(elapsed.asHours());
	const m = elapsed.minutes();
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

// ── Writing [t] blocks ─────────────────────────────────────────────────────────

/**
 * Append a [t]HH:MM-HH:MM child under the matching parent task in the file.
 * If the task has existing children, the [t] block is appended after them.
 */
export async function writeTrackedBlock(
	app: App,
	filePath: string,
	parentTaskText: string,
	timeRange: string,
): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) {
		console.error(`[BuJo] File not found: ${filePath}`);
		return false;
	}

	const content = await app.vault.read(file);
	const lines = content.split('\n');

	// Find the parent task
	const normalizedParent = normalizeText(parentTaskText);
	let parentIndex = -1;
	let parentIndent = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line || !isBulletItem(line)) continue;
		if (!isIncompleteTask(line)) continue;

		const text = getTaskText(line);
		if (normalizeText(text) === normalizedParent) {
			parentIndex = i;
			parentIndent = getIndentLevel(line);
			break;
		}
	}

	if (parentIndex === -1) {
		console.error(`[BuJo] Parent task not found in ${filePath}: "${parentTaskText}"`);
		return false;
	}

	// Determine indent for the [t] child (parent indent + 1 tab)
	const childIndentStr = '\t'.repeat(Math.floor(parentIndent / 4) + 1);
	if (parentIndent % 4 !== 0) {
		// If parent uses spaces, convert to tabs for consistency
		// Actually, let's preserve the style: add one more level
	}
	// Simple: use the parent's indent character + one more level
	const indentChar = parentIndent > 0
		? (lines[parentIndex]?.match(/^(\s)/)?.[1] || '\t')
		: '\t';
	const childIndent = indentChar.repeat(Math.ceil(parentIndent / indentChar.length) + 1);

	const trackedLine = `${childIndent}- [t] ${timeRange}`;

	// Find the insertion point: after all existing children of this parent
	let insertIndex = parentIndex + 1;
	for (let i = parentIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line || !line.trim()) {
			// Skip empty lines but advance insertIndex past them
			insertIndex = i + 1;
			continue;
		}
		const lineIndent = getIndentLevel(line);
		if (lineIndent <= parentIndent) {
			// Reached a sibling or parent — insert before this
			insertIndex = i;
			break;
		}
		// This is a child — insert after it
		insertIndex = i + 1;
	}

	// Insert the tracked line
	lines.splice(insertIndex, 0, trackedLine);

	await app.vault.modify(file, lines.join('\n'));
	console.log(`[BuJo] Wrote [t] block: ${trackedLine} under "${parentTaskText}" in ${filePath}`);
	return true;
}

// ── Scoreboard data ────────────────────────────────────────────────────────────

/** Parse a time range like "09:45-12:10" into minutes */
export function parseTimeRange(range: string): { start: string; end: string; minutes: number } | null {
	const match = range.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
	if (!match) return null;

	const start = match[1]!;
	const end = match[2]!;

	const [sh, sm] = start.split(':').map(Number);
	const [eh, em] = end.split(':').map(Number);

	const minutes = (eh! * 60 + em!) - (sh! * 60 + sm!);
	return { start, end, minutes: minutes > 0 ? minutes : minutes + 1440 }; // handle overnight
}

/** Collect all tracked time blocks from a set of files */
export async function collectTrackedBlocks(
	app: App,
	files: TFile[],
): Promise<TrackedBlock[]> {
	const results: TrackedBlock[] = [];

	for (const file of files) {
		const content = await app.vault.read(file);
		const lines = content.split('\n');

		// Walk lines, track current parent, collect [t] children
		let currentParent: string | null = null;
		let currentParentIndent = -1;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			const trimmed = line.trim();

			// Check for [t] time block
			const trackedMatch = trimmed.match(/^-\s*\[t\]\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2})/);
			if (trackedMatch && trackedMatch[1]) {
				const parsed = parseTimeRange(trackedMatch[1]);
				if (parsed) {
					results.push({
						timeRange: trackedMatch[1],
						durationMinutes: parsed.minutes,
						parentTask: currentParent || '(uncategorized)',
						file: file.path,
					});
				}
				continue;
			}

			// Track parent: any task (not [@] or [t]) at indent level that's a new parent
			if (isBulletItem(line) && !trimmed.startsWith('- [@]') && !trimmed.startsWith('- [t]')) {
				const indent = getIndentLevel(line);
				// New parent if indent <= currentParentIndent (or no parent yet)
				if (currentParent === null || indent <= currentParentIndent) {
					currentParent = getTaskText(line);
					currentParentIndent = indent;
				}
			}
		}
	}

	return results;
}

/** Collect planned [@] blocks for comparison */
export async function collectPlannedBlocks(
	app: App,
	files: TFile[],
): Promise<TrackedBlock[]> {
	const results: TrackedBlock[] = [];

	for (const file of files) {
		const content = await app.vault.read(file);
		const lines = content.split('\n');

		let currentParent: string | null = null;
		let currentParentIndent = -1;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			const trimmed = line.trim();

			const plannedMatch = trimmed.match(/^-\s*\[@\]\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2})/);
			if (plannedMatch && plannedMatch[1]) {
				const parsed = parseTimeRange(plannedMatch[1]);
				if (parsed) {
					results.push({
						timeRange: plannedMatch[1],
						durationMinutes: parsed.minutes,
						parentTask: currentParent || '(uncategorized)',
						file: file.path,
					});
				}
				continue;
			}

			if (isBulletItem(line) && !trimmed.startsWith('- [@]') && !trimmed.startsWith('- [t]')) {
				const indent = getIndentLevel(line);
				if (currentParent === null || indent <= currentParentIndent) {
					currentParent = getTaskText(line);
					currentParentIndent = indent;
				}
			}
		}
	}

	return results;
}
