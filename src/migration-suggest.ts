// Autocomplete for migration markers: type "[>" in a bullet and pick a
// destination by name instead of remembering marker codes.
// Also supports "[+>" (new task) and "[->" (info point) prefixes, explicit
// dates typed as YYYY-MM-DD, and a calendar modal ("Pick a date…") whose
// days, week numbers, and month header are all clickable destinations.

import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Modal,
	TFile,
	moment,
} from 'obsidian';
import { describeMarker } from './markers';

interface DestSuggestion {
	label: string;
	sub: string;
	code: string; // bracket content after the ">" prefix, e.g. "w", "mon", "2026-07-30", "2026-W32"
}

const PICK_DATE = '__pick__';

/** How many entries get an Alt+N shortcut. */
const QUICK_SELECT_MAX = 9;

/**
 * Anchor date the relative markers resolve against — the note's own date when
 * it's a journal note (daily / weekly / monthly), otherwise today. So "next
 * week" in a 2026-W31 note previews (and migrates) as W32.
 */
function anchorFromFile(file: TFile | null): moment.Moment {
	const today = moment().startOf('day');
	if (!file) return today;
	const name = file.basename;

	if (/^\d{4}-\d{2}-\d{2}$/.test(name)) {
		const m = moment(name, 'YYYY-MM-DD', true);
		if (m.isValid()) return m;
	}
	const wk = name.match(/^(\d{4})-W(\d{2})$/i);
	if (wk && wk[1] && wk[2]) {
		const m = moment().isoWeekYear(parseInt(wk[1], 10)).isoWeek(parseInt(wk[2], 10)).startOf('isoWeek');
		if (m.isValid()) return m;
	}
	if (/^\d{4}-\d{2}$/.test(name)) {
		const m = moment(`${name}-01`, 'YYYY-MM-DD', true);
		if (m.isValid()) return m.startOf('month');
	}
	return today;
}

function buildSuggestions(anchor: moment.Moment): DestSuggestion[] {
	const tomorrow = describeMarker('>', anchor);
	const nextWeek = describeMarker('w', anchor);
	const nextMonth = describeMarker('m', anchor);
	return [
		// "Today" is always the literal today, not the anchor: pulling a task
		// into the current day is the one destination that ignores which note
		// you happen to be standing in. ":" is the engine's today marker.
		{ label: 'Today', sub: moment().format('ddd, MMM D'), code: ':' },
		{ label: 'Tomorrow', sub: tomorrow?.label ?? '', code: '>' },
		{ label: 'Next week', sub: nextWeek?.sub ?? '', code: 'w' },
		{ label: 'Next month', sub: nextMonth?.label ?? '', code: 'm' },
		{ label: 'Pick a date…', sub: 'calendar · day / week / month', code: PICK_DATE },
	];
}

/** Suggestion for an explicitly typed destination: 2026-07-30, 2026-W32, 2026-08. */
function explicitSuggestion(query: string): DestSuggestion | null {
	if (/^\d{4}-\d{2}-\d{2}$/.test(query)) {
		const m = moment(query, 'YYYY-MM-DD', true);
		if (m.isValid()) return { label: m.format('dddd, MMM D YYYY'), sub: 'daily note', code: query };
		return null;
	}
	const weekMatch = query.match(/^(\d{4})-w(\d{2})$/i);
	if (weekMatch && weekMatch[1] && weekMatch[2]) {
		const m = moment().isoWeekYear(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek');
		if (m.isValid()) return { label: `Week ${weekMatch[2]}, ${weekMatch[1]}`, sub: m.format('[starts] MMM D'), code: query.toUpperCase() };
		return null;
	}
	if (/^\d{4}-\d{2}$/.test(query)) {
		const m = moment(query + '-01', 'YYYY-MM-DD', true);
		if (m.isValid()) return { label: m.format('MMMM YYYY'), sub: 'monthly note', code: query };
		return null;
	}
	return null;
}

export class MigrationSuggest extends EditorSuggest<DestSuggestion> {
	private prefix = '>';

	/**
	 * Called after a marker is actually written, including once the calendar
	 * modal closes. Lets the keyboard flow advance to the next task only when
	 * the user finished the job, never on a cancelled pick.
	 */
	onApplied: ((editor: Editor) => void) | null = null;

	/** The list currently on screen, so a number key can index straight into it. */
	private shown: DestSuggestion[] = [];

	/**
	 * Line to put back if the picker is dismissed without choosing. Opening the
	 * picker writes a bare "[>]", which getIncompleteTasks treats as already
	 * handled — walking away from it would drop the task out of every future
	 * review. Armed by the keyboard flow, cleared the moment a marker lands.
	 */
	private pendingRevert: { editor: Editor; line: number; text: string } | null = null;

	/** Arm the undo described on pendingRevert. */
	armRevert(editor: Editor, line: number, text: string): void {
		this.pendingRevert = { editor, line, text };
	}

	private takeRevert(): { editor: Editor; line: number; text: string } | null {
		const pending = this.pendingRevert;
		this.pendingRevert = null;
		return pending;
	}

	/** Restore the line, but only if it is still the untouched "[>]" we wrote. */
	private undo(pending: { editor: Editor; line: number; text: string } | null): void {
		if (!pending) return;
		const current = pending.editor.getLine(pending.line);
		if (current !== undefined && /^\s*-\s*\[>\s*\]/.test(current)) {
			pending.editor.setLine(pending.line, pending.text);
		}
	}

	close(): void {
		const pending = this.takeRevert();
		super.close();
		this.undo(pending);
	}

	constructor(app: App) {
		super(app);

		// Alt+1…9 picks the nth entry. Bare digits are off limits: the query
		// accepts typed dates ("2026-10-26"), so digits have to reach the editor.
		//
		// Matched on evt.code rather than a registered key, because Scope
		// compares KeyboardEvent.key — and on macOS Option+1 reports "¡", not
		// "1", so a per-digit registration silently never fires there.
		this.scope.register(['Alt'], null, (evt: KeyboardEvent) => {
			const item = this.accelerated(evt.code);
			if (!item) return;

			evt.preventDefault();
			this.selectSuggestion(item);
			this.close();
			return false;
		});
	}

	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const beforeCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
		// Only fire in checkbox position at the start of a bullet: "- [>", "- [+>", "- [->"
		const match = beforeCursor.match(/^\s*-\s*\[([+-]?>)([^\]]*)$/);
		if (!match || match[1] === undefined || match[2] === undefined) return null;

		this.prefix = match[1];
		return {
			start: { line: cursor.line, ch: cursor.ch - match[1].length - match[2].length },
			end: cursor,
			query: match[2],
		};
	}

	getSuggestions(context: EditorSuggestContext): DestSuggestion[] {
		const query = context.query.toLowerCase();
		const anchor = anchorFromFile(context.file);

		const explicit = explicitSuggestion(query);
		if (explicit) return this.remember([explicit]);

		const all = buildSuggestions(anchor);
		if (!query) return this.remember(all);

		const filtered = all.filter(s => s.code.startsWith(query) || s.label.toLowerCase().includes(query));

		// Progressive: if the typed code resolves as a relative marker that isn't
		// already one of the base entries (e.g. "w2", "mon", "m3w", "aug"), show
		// its live-computed date at the top.
		const described = describeMarker(query, anchor);
		if (described && !filtered.some(s => s.code === query)) {
			filtered.unshift({ label: described.label, sub: described.sub, code: query });
		}

		// While typing a partial explicit date, keep the picker entry reachable
		if (filtered.length === 0 && /^\d/.test(query)) {
			return this.remember(all.filter(s => s.code === PICK_DATE));
		}
		return this.remember(filtered);
	}

	private remember(items: DestSuggestion[]): DestSuggestion[] {
		this.shown = items;
		return items;
	}

	/**
	 * Entries reachable by Alt+number. The calendar is excluded and given a
	 * letter instead: it is always the last row, so numbering it would put the
	 * most-reached entry on the longest stretch (Alt+5).
	 */
	private numbered(): DestSuggestion[] {
		return this.shown.filter(s => s.code !== PICK_DATE);
	}

	/** The entry an Alt+<code> keystroke selects, if any. */
	private accelerated(code: string): DestSuggestion | undefined {
		if (code === 'KeyD') return this.shown.find(s => s.code === PICK_DATE);

		const digit = /^Digit([1-9])$/.exec(code);
		if (!digit || digit[1] === undefined) return undefined;
		return this.numbered()[parseInt(digit[1], 10) - 1];
	}

	/** The accelerator shown on the left of a row: "1".."9", or "D" for the calendar. */
	private badgeFor(item: DestSuggestion): string | null {
		if (item.code === PICK_DATE) return 'D';
		const index = this.numbered().indexOf(item);
		return index >= 0 && index < QUICK_SELECT_MAX ? String(index + 1) : null;
	}

	renderSuggestion(item: DestSuggestion, el: HTMLElement): void {
		el.addClass('mod-complex');

		const badge = this.badgeFor(item);
		if (badge) el.createDiv({ cls: 'bujo-suggest-index', text: badge });

		const content = el.createDiv({ cls: 'suggestion-content' });
		content.createDiv({ cls: 'suggestion-title', text: item.label });
		content.createDiv({ cls: 'suggestion-note', text: item.sub });
		el.createDiv({
			cls: 'suggestion-aux',
			text: item.code === PICK_DATE ? '📅' : `[${this.prefix}${item.code}]`,
		});
	}

	selectSuggestion(item: DestSuggestion): void {
		const context = this.context;
		if (!context) return;
		const { editor, start } = context;

		let end = context.end;
		const line = editor.getLine(end.line);
		// Consume the auto-paired closing bracket if the editor inserted one
		if (line[end.ch] === ']') {
			end = { line: end.line, ch: end.ch + 1 };
		}
		const needsSpace = line[end.ch] !== ' ';
		const prefix = this.prefix;

		const insertMarker = (code: string) => {
			const insert = `${prefix}${code}]${needsSpace ? ' ' : ''}`;
			editor.replaceRange(insert, start, end);
			this.onApplied?.(editor);
		};

		if (item.code === PICK_DATE) {
			// Hand the undo to the modal: closing the suggester must not revert
			// the line while the calendar is still open on top of it.
			const pending = this.takeRevert();
			this.close();
			new DateDestinationModal(this.app, insertMarker, () => this.undo(pending)).open();
			return;
		}

		// A marker is about to land, so there is nothing to undo.
		this.takeRevert();

		insertMarker(item.code);
	}
}

// ── Calendar modal: pick a day, a week, or a month ─────────────────────────────

export class DateDestinationModal extends Modal {
	private onPick: (code: string) => void;
	private onCancel: (() => void) | undefined;
	private picked = false;
	private viewDate: moment.Moment;

	constructor(app: App, onPick: (code: string) => void, onCancel?: () => void) {
		super(app);
		this.onPick = onPick;
		this.onCancel = onCancel;
		this.viewDate = moment().startOf('month');
	}

	onOpen() {
		this.render();
	}

	private pick(code: string) {
		this.picked = true;
		this.close();
		this.onPick(code);
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('bujo-datepick');

		const today = moment();
		const y = this.viewDate.year();
		const m = this.viewDate.month();
		const first = moment([y, m, 1]);

		// ── Header: ‹ [Month YYYY → monthly note] › ──
		const nav = contentEl.createDiv({ cls: 'bujo-datepick-nav' });

		const prevBtn = nav.createEl('button', { text: '‹', cls: 'bujo-datepick-arrow' });
		prevBtn.onclick = () => { this.viewDate.subtract(1, 'month'); this.render(); };

		const monthBtn = nav.createEl('button', { text: first.format('MMMM YYYY'), cls: 'bujo-datepick-month' });
		monthBtn.setAttribute('aria-label', `Send to monthly note ${first.format('YYYY-MM')}`);
		monthBtn.onclick = () => this.pick(first.format('YYYY-MM'));

		const nextBtn = nav.createEl('button', { text: '›', cls: 'bujo-datepick-arrow' });
		nextBtn.onclick = () => { this.viewDate.add(1, 'month'); this.render(); };

		// ── Grid: week column + 7 day columns ──
		const headerRow = contentEl.createDiv({ cls: 'bujo-datepick-grid' });
		['Wk', 'M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(d => {
			headerRow.createEl('div', { text: d, cls: 'bujo-datepick-dow' });
		});

		const grid = contentEl.createDiv({ cls: 'bujo-datepick-grid' });

		const todayStr = today.format('YYYY-MM-DD');
		const lastDay = first.daysInMonth();

		// Iterate week rows starting from the Monday of the first week of the month
		const cursor = first.clone().startOf('isoWeek');
		while (cursor.isSameOrBefore(moment([y, m, lastDay]), 'day')) {
			// Week-number cell → weekly note
			const weekCode = cursor.format('GGGG-[W]WW');
			const weekBtn = grid.createEl('button', { text: cursor.format('[W]WW'), cls: 'bujo-datepick-week' });
			weekBtn.setAttribute('aria-label', `Send to weekly note ${weekCode}`);
			weekBtn.onclick = () => this.pick(weekCode);

			// Day cells
			for (let d = 0; d < 7; d++) {
				const day = cursor.clone().add(d, 'days');
				if (day.month() !== m) {
					grid.createDiv();
					continue;
				}
				const dateStr = day.format('YYYY-MM-DD');
				const isToday = dateStr === todayStr;
				const isPast = dateStr < todayStr;

				const dayBtn = grid.createEl('button', { text: String(day.date()), cls: 'bujo-datepick-day' });
				if (isToday) dayBtn.addClass('is-today');
				if (isPast) {
					dayBtn.addClass('is-past');
				} else {
					dayBtn.onclick = () => this.pick(dateStr);
				}
			}
			cursor.add(1, 'week');
		}

		contentEl.createEl('div', {
			text: 'Click a day for the daily note, a week number for the weekly note, or the month title for the monthly note.',
			cls: 'bujo-datepick-hint',
		});
	}

	onClose() {
		this.contentEl.empty();
		// Dismissed without choosing — let the caller put the line back.
		if (!this.picked) this.onCancel?.();
	}
}
