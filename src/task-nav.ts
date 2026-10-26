// Line-level reasoning for keyboard task triage: which lines are tasks, where
// the next one is, and how to open a line's checkbox for the destination
// picker. Kept free of Obsidian imports so it is unit-testable; the editor
// commands that use it live in shortcuts.ts.

/** A task line is a bullet carrying a checkbox: "- [ ] …", "- [>w] …". */
export const TASK_LINE = /^(\s*-\s*)\[([^\]]*)\](.*)$/;
/** A plain bullet with no checkbox: "- buy milk". */
const PLAIN_BULLET = /^(\s*-\s+)(.*)$/;

export interface MarkedLine {
	/** The rewritten line, with the checkbox set to the open marker "[>]". */
	line: string;
	/** Column to place the cursor at — between the ">" and the "]". */
	ch: number;
}

/**
 * Rewrite a line so the migration suggester will fire on it: checkbox becomes
 * "[>]" and the caller puts the cursor just after the ">". Returns null when
 * the line isn't something that can hold a marker.
 */
export function markLineForMigration(line: string): MarkedLine | null {
	const task = line.match(TASK_LINE);
	if (task && task[1] !== undefined && task[3] !== undefined) {
		return { line: `${task[1]}[>]${task[3]}`, ch: task[1].length + 2 };
	}

	const bullet = line.match(PLAIN_BULLET);
	if (bullet && bullet[1] !== undefined && bullet[2] !== undefined) {
		return { line: `${bullet[1]}[>] ${bullet[2]}`, ch: bullet[1].length + 2 };
	}

	return null;
}

/** Column span of a checkbox's contents — the bit between "[" and "]". */
export interface CheckboxRange {
	from: number;
	to: number;
}

/**
 * Where a line's checkbox contents sit, or null when there is no checkbox.
 * Selecting this span means the next character typed replaces the checkbox
 * state, which is exactly how a hand-typed "[>" opens the destination picker.
 */
export function checkboxRange(line: string): CheckboxRange | null {
	const match = line.match(TASK_LINE);
	if (!match || match[1] === undefined || match[2] === undefined) return null;
	const from = match[1].length + 1;      // just past the "["
	return { from, to: from + match[2].length };
}

/** True when the line carries a checkbox of any state. */
export function isTaskLine(line: string): boolean {
	return TASK_LINE.test(line);
}

/** True when the line carries an empty checkbox — an outstanding task. */
export function isOpenTaskLine(line: string): boolean {
	const match = line.match(TASK_LINE);
	return !!match && (match[2] ?? '').trim() === '';
}

/**
 * Index of the next task line from `from` in direction `dir` (+1/-1), or -1
 * when there is none. `from` itself is never returned, so repeated calls walk.
 */
export function findTaskLine(
	lines: string[],
	from: number,
	dir: 1 | -1,
	onlyOpen = false,
): number {
	const matches = onlyOpen ? isOpenTaskLine : isTaskLine;
	for (let i = from + dir; i >= 0 && i < lines.length; i += dir) {
		const line = lines[i];
		if (line !== undefined && matches(line)) return i;
	}
	return -1;
}

