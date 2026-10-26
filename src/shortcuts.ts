// Keyboard-driven task triage.
//
// The model is an inbox: move to a task, act on it, land on the next one. The
// acting part reuses the editor suggester rather than duplicating it — the
// "mark" command only rewrites the checkbox to "[>]" and parks the cursor
// inside the bracket, which is exactly the state onTrigger looks for, so the
// destination picker opens by itself.

import { Editor, Notice } from 'obsidian';
import { markLineForMigration, findTaskLine, checkboxRange, isOpenTaskLine, TASK_LINE } from './task-nav';

/** The slice of MigrationSuggest these commands need, kept narrow for testing. */
export interface RevertArmer {
	armRevert(editor: Editor, line: number, text: string): void;
}

/**
 * Move to the next/previous task and select its checkbox contents. Landing on
 * the checkbox rather than the end of the line means the very next keystroke
 * acts on the task: typing ">" replaces the selection and opens the
 * destination picker, exactly as if it had been typed by hand.
 *
 * Returns true when it moved, so callers can decide whether to report that
 * there is nothing left.
 */
export interface JumpOptions {
	/** Only stop on unticked "[ ]" tasks. */
	onlyOpen?: boolean;
	/** On landing, open the destination picker (unticked tasks only). */
	openPicker?: boolean;
	/** Needed to make a dismissed picker undoable. */
	suggest?: RevertArmer;
}

export function jumpToTask(editor: Editor, dir: 1 | -1, options: JumpOptions = {}): boolean {
	const lines = editor.getValue().split('\n');
	const target = findTaskLine(lines, editor.getCursor().line, dir, options.onlyOpen ?? false);

	if (target === -1) {
		new Notice(dir === 1 ? 'No further tasks in this note' : 'No earlier tasks in this note');
		return false;
	}

	editor.scrollIntoView({ from: { line: target, ch: 0 }, to: { line: target, ch: 0 } }, true);

	// Priming writes "[>]", so it is restricted to unticked tasks: a done,
	// cancelled or already-marked task must survive being navigated past.
	if (options.openPicker && primePicker(editor, target, options.suggest)) return true;

	const line = lines[target] ?? '';
	const box = checkboxRange(line);
	if (box) {
		editor.setSelection({ line: target, ch: box.from }, { line: target, ch: box.to });
	} else {
		editor.setCursor({ line: target, ch: line.length });
	}
	return true;
}

/**
 * Put an unticked task into "[>]" and open the picker on it, arming the undo.
 * Returns false (changing nothing) for any line that isn't an open task.
 */
export function primePicker(editor: Editor, line: number, suggest?: RevertArmer): boolean {
	if (!isOpenTaskLine(editor.getLine(line))) return false;

	const original = openPickerOnLine(editor, line);
	if (original === null) return false;

	suggest?.armRevert(editor, line, original);
	return true;
}

/**
 * Put the cursor line into "[>]" and leave the caret inside the bracket, which
 * is the state the suggester triggers on. Returns the line's previous text so
 * the caller can undo it if the picker is dismissed — a bare "[>]" is on the
 * review exclusion list, so a task abandoned in that state would quietly stop
 * appearing in reviews.
 */
export function openPickerOnLine(editor: Editor, line: number): string | null {
	const original = editor.getLine(line);
	const marked = markLineForMigration(original);
	if (!marked) return null;

	editor.setLine(line, marked.line);
	editor.setCursor({ line, ch: marked.ch });
	return original;
}

/**
 * Set the cursor line's checkbox to "[>]" and position the caret so the
 * destination suggester opens. Does nothing to lines that can't hold a marker.
 */
export function markForMigration(editor: Editor, suggest?: RevertArmer): void {
	const { line } = editor.getCursor();
	const original = openPickerOnLine(editor, line);

	if (original === null) {
		new Notice('Not a task line — put the cursor on a bullet');
		return;
	}

	suggest?.armRevert(editor, line, original);
}

/**
 * Replace the cursor line's checkbox with a fixed state ("x", "-", "d"), then
 * optionally advance. This is the quick-verb half of the keyboard flow.
 */
export function setTaskState(editor: Editor, state: string, advance: boolean): void {
	const { line } = editor.getCursor();
	const match = editor.getLine(line).match(TASK_LINE);

	if (!match || match[1] === undefined || match[3] === undefined) {
		new Notice('Not a task line — put the cursor on a bullet');
		return;
	}

	editor.setLine(line, `${match[1]}[${state}]${match[3]}`);
	if (advance) jumpToTask(editor, 1);
}
