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
		const m = moment().year(parseInt(wk[1], 10)).isoWeek(parseInt(wk[2], 10)).startOf('isoWeek');
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
		const m = moment().year(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek');
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

	constructor(app: App) {
		super(app);
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
		if (explicit) return [explicit];

		const all = buildSuggestions(anchor);
		if (!query) return all;

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
			return all.filter(s => s.code === PICK_DATE);
		}
		return filtered;
	}

	renderSuggestion(item: DestSuggestion, el: HTMLElement): void {
		el.addClass('mod-complex');
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
		};

		if (item.code === PICK_DATE) {
			this.close();
			new DateDestinationModal(this.app, insertMarker).open();
			return;
		}

		insertMarker(item.code);
	}
}

// ── Calendar modal: pick a day, a week, or a month ─────────────────────────────

export class DateDestinationModal extends Modal {
	private onPick: (code: string) => void;
	private viewDate: moment.Moment;

	constructor(app: App, onPick: (code: string) => void) {
		super(app);
		this.onPick = onPick;
		this.viewDate = moment().startOf('month');
	}

	onOpen() {
		this.render();
	}

	private pick(code: string) {
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
	}
}
