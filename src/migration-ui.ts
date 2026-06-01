// Migration UI — visual destination picker modal. Replaces typing markers by hand.
// Triggers from the current cursor line. Shorthand: Cmd+P → "Migrate task..."

import { App, Editor, Modal, moment } from 'obsidian';
import { isBulletItem, getTaskText } from './utils';

// ── Marker construction ────────────────────────────────────────────────────────

type DestType = 'task' | 'event' | 'appointment' | 'info';

interface MigrationChoice {
	marker: string;        // e.g. ">w", ">fri", ">>", ">:"
	destType: DestType;    // what {} gets in destination
	sourceMarker: string | null; // what () gets in source (null = default)
}

function buildMarker(choice: MigrationChoice): string {
	let marker = `>${choice.marker}`;

	// Source marker: e.g. (/) or (/o)
	const sourcePart = choice.sourceMarker ? `(${choice.sourceMarker})` : '';

	// Destination type: e.g. {o}, {a}, {.}
	const destPart = choice.destType !== 'task'
		? `{${choice.destType === 'event' ? 'o' : choice.destType === 'appointment' ? 'a' : '.'}}`
		: '';

	return `[>${choice.marker}${sourcePart}${destPart}]`;
}

// ── Quick date chips ───────────────────────────────────────────────────────────

interface QuickDate {
	label: string;
	sub: string;
	marker: string;      // e.g. ">>" for tomorrow, "w" for next week
}

function getQuickDates(): QuickDate[] {
	const today = moment();
	const tomorrow = today.clone().add(1, 'day');
	const nextMonday = today.clone().day(8); // next Monday
	const nextMonth = today.clone().add(1, 'month').startOf('month');

	return [
		{ label: 'Today',        sub: '→ current daily note', marker: ':' },
		{ label: 'Tomorrow',     sub: tomorrow.format('ddd MMM D'), marker: '>' },
		{ label: 'This week',    sub: '→ current weekly note', marker: ':w' },
		{ label: 'Next week',    sub: nextMonday.format('ddd MMM D'), marker: 'w' },
		{ label: 'This month',   sub: '→ current monthly note', marker: ':m' },
		{ label: 'Next month',   sub: nextMonth.format('MMM YYYY'), marker: 'm' },
		{ label: 'Future log',   sub: 'long-term parking', marker: 'fut' },
	];
}

// ── Day-of-week chips ──────────────────────────────────────────────────────────

const DAYS = [
	{ label: 'Mon', marker: 'mon' },
	{ label: 'Tue', marker: 'tue' },
	{ label: 'Wed', marker: 'wed' },
	{ label: 'Thu', marker: 'thu' },
	{ label: 'Fri', marker: 'fri' },
	{ label: 'Sat', marker: 'sat' },
	{ label: 'Sun', marker: 'sun' },
];

// ── The modal ──────────────────────────────────────────────────────────────────

export class MigrationPickerModal extends Modal {
	private editor: Editor;
	private taskText: string;
	private originalLine: string;
	private lineStart: number;

	// State
	private selectedMarker: string = '>';
	private selectedDestType: DestType = 'task';
	private selectedSourceMarker: string | null = null;
	private selectedDate: string | null = null; // ISO date from calendar

	constructor(app: App, editor: Editor) {
		super(app);
		this.editor = editor;
		const cursor = editor.getCursor('from');
		this.lineStart = cursor.line;
		const line = editor.getLine(this.lineStart);
		this.originalLine = line;
		this.taskText = isBulletItem(line) ? getTaskText(line) : line.trim();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.style.cssText = 'max-width: 440px; padding: 20px 24px;';

		// ── Task preview ──
		const preview = contentEl.createDiv();
		preview.style.cssText = 'margin-bottom: 18px; padding: 10px 14px; background: var(--background-secondary); border-radius: 8px;';

		preview.createEl('div', {
			text: this.taskText,
		}).style.cssText = 'font-size: 16px; font-weight: 500;';

		preview.createEl('div', {
			text: `Line ${this.lineStart + 1} — ${this.originalLine.trim().slice(0, 60)}`,
		}).style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px;';

		// ── Quick date chips ──
		contentEl.createEl('div', {
			text: 'Destination',
			cls: 'setting-item-heading',
		}).style.cssText = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; letter-spacing: 1px;';

		const quickRow = contentEl.createDiv();
		quickRow.style.cssText = 'display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 14px;';

		for (const qd of getQuickDates()) {
			const chip = quickRow.createEl('button');
			chip.style.cssText = this.chipStyle(this.selectedMarker === qd.marker);
			chip.innerHTML = `<div style="font-size:13px;font-weight:500;">${qd.label}</div><div style="font-size:10px;opacity:0.7;">${qd.sub}</div>`;
			chip.onclick = () => {
				this.selectedMarker = qd.marker;
				this.selectedDate = null;
				this.renderPreview(contentEl);
				this.rerenderChips(quickRow);
			};
		}

		// ── Day-of-week chips ──
		contentEl.createEl('div', {
			text: 'Specific day',
			cls: 'setting-item-heading',
		}).style.cssText = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; letter-spacing: 1px;';

		const dayRow = contentEl.createDiv();
		dayRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 14px; flex-wrap: wrap;';

		for (const day of DAYS) {
			const dayChip = dayRow.createEl('button');
			dayChip.style.cssText = this.smallChipStyle(this.selectedMarker === day.marker);
			dayChip.textContent = day.label;
			dayChip.onclick = () => {
				this.selectedMarker = day.marker;
				this.selectedDate = null;
				this.renderPreview(contentEl);
				this.rerenderChips(quickRow);
				this.rerenderDayChips(dayRow);
			};
		}

		// ── Mini calendar ──
		contentEl.createEl('div', {
			text: 'Or pick a date',
			cls: 'setting-item-heading',
		}).style.cssText = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; letter-spacing: 1px;';

		const calContainer = contentEl.createDiv({ cls: 'bujo-minical' });

		// ── Destination type ──
		contentEl.createEl('div', { cls: 'setting-item-heading' })
			.style.cssText = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin: 14px 0 8px; letter-spacing: 1px;';
		contentEl.querySelectorAll('.setting-item-heading').forEach(el => {
			if ((el as HTMLElement).textContent === '') el.textContent = 'Destination type';
		});

		const typeRow = contentEl.createDiv();
		typeRow.style.cssText = 'display: flex; gap: 6px; margin-bottom: 10px;';

		const types: Array<{ id: DestType; label: string; glyph: string }> = [
			{ id: 'task',        label: 'Task',        glyph: '•' },
			{ id: 'event',       label: 'Event',       glyph: '○' },
			{ id: 'appointment', label: 'Appointment', glyph: '△' },
			{ id: 'info',        label: 'Info point',  glyph: '—' },
		];

		for (const t of types) {
			const typeChip = typeRow.createEl('button');
			const active = this.selectedDestType === t.id;
			typeChip.style.cssText = this.smallChipStyle(active);
			typeChip.innerHTML = `<span class="mono" style="margin-right:4px;">${t.glyph}</span>${t.label}`;
			typeChip.onclick = () => {
				this.selectedDestType = t.id;
				this.renderPreview(contentEl);
				this.rerenderTypeChips(typeRow);
			};
		}

		// ── Source marker ──
		contentEl.createEl('div', {
			text: 'Source marker (what it becomes after migration)',
			cls: 'setting-item-heading',
		}).style.cssText = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin: 14px 0 8px; letter-spacing: 1px;';

		const srcRow = contentEl.createDiv();
		srcRow.style.cssText = 'display: flex; gap: 6px; margin-bottom: 16px;';

		const srcMarkers: Array<{ id: string | null; label: string; glyph: string }> = [
			{ id: null,        label: 'Migrated [>]',   glyph: '→' },
			{ id: '/',    label: 'In-progress [/]', glyph: '/' },
			{ id: '=',   label: 'Custom [=]',       glyph: '=' },
			{ id: 'x',   label: 'Completed [x]',    glyph: '✓' },
			{ id: 'skip', label: 'Skip [>skip]',     glyph: '∅' },
		];

		for (const sm of srcMarkers) {
			const srcChip = srcRow.createEl('button');
			const active = this.selectedSourceMarker === sm.id;
			srcChip.style.cssText = this.smallChipStyle(active);
			srcChip.innerHTML = `<span class="mono" style="margin-right:4px;">${sm.glyph}</span>${sm.label}`;
			srcChip.onclick = () => {
				this.selectedSourceMarker = sm.id;
				this.renderPreview(contentEl);
				this.rerenderSrcChips(srcRow);
			};
		}

		// ── Preview ──
		const previewBox = contentEl.createDiv({ cls: 'bujo-marker-preview' });
		previewBox.style.cssText = 'padding: 10px 14px; background: var(--background-secondary); border-radius: 8px; margin-bottom: 16px;';

		// ── Buttons ──
		const btnRow = contentEl.createDiv();
		btnRow.style.cssText = 'display: flex; gap: 8px;';

		const migrateBtn = btnRow.createEl('button', { text: 'Migrate →' });
		migrateBtn.style.cssText = 'flex:1; padding:10px; background:var(--interactive-accent); color:var(--text-on-accent); border:none; border-radius:8px; cursor:pointer; font-weight:600; font-size:14px;';
		migrateBtn.onclick = () => this.execute();

		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.style.cssText = 'padding:10px 20px; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:8px; cursor:pointer;';
		cancelBtn.onclick = () => this.close();

		// Render calendar + preview
		this.renderMiniCalendar(calContainer);
		this.renderPreview(contentEl);
	}

	private renderMiniCalendar(container: HTMLElement) {
		container.empty();

		const today = moment();
		const viewDate = this.selectedDate ? moment(this.selectedDate) : today.clone();
		const [y, m] = [viewDate.year(), viewDate.month()];
		const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
		const first = moment([y, m, 1]);
		const lastDay = first.daysInMonth();
		const startWeekday = (first.day() + 6) % 7; // Mon=0

		const rerender = () => this.renderMiniCalendar(container);

		// Month nav
		const nav = container.createDiv();
		nav.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';

		const prevBtn = nav.createEl('button', { text: '‹' });
		prevBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:16px;padding:2px 8px;';
		prevBtn.onclick = () => {
			this.selectedDate = moment([y, m - 1, 1]).format('YYYY-MM-DD');
			rerender();
		};

		nav.createEl('span', {
			text: `${months[m]} ${y}`,
		}).style.cssText = 'font-size:14px;font-weight:500;';

		const nextBtn = nav.createEl('button', { text: '›' });
		nextBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:16px;padding:2px 8px;';
		nextBtn.onclick = () => {
			this.selectedDate = moment([y, m + 1, 1]).format('YYYY-MM-DD');
			rerender();
		};

		// Day headers
		const dowRow = container.createDiv();
		dowRow.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:1px;margin-bottom:2px;';
		['M','T','W','T','F','S','S'].forEach(d => {
			dowRow.createEl('div', {
				text: d,
			}).style.cssText = 'text-align:center;font-size:9px;color:var(--text-muted);padding:2px 0;';
		});

		// Day grid
		const grid = container.createDiv();
		grid.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:1px;';

		// Empty cells before first day
		for (let i = 0; i < startWeekday; i++) {
			grid.createDiv();
		}

		const todayStr = today.format('YYYY-MM-DD');

		for (let d = 1; d <= lastDay; d++) {
			const dateStr = moment([y, m, d]).format('YYYY-MM-DD');
			const isToday = dateStr === todayStr;
			const isPast = dateStr < todayStr;
			const isSelected = dateStr === this.selectedDate;

			const dayBtn = grid.createEl('button');
			dayBtn.textContent = String(d);
			dayBtn.style.cssText = `
				height: 28px; border: none; border-radius: 4px; cursor: ${isPast ? 'default' : 'pointer'};
				font-size: 11px; padding: 0; text-align: center;
				background: ${isSelected ? 'var(--interactive-accent)' : isToday ? 'var(--background-modifier-hover)' : 'transparent'};
				color: ${isSelected ? 'var(--text-on-accent)' : isPast ? 'var(--text-faint)' : 'var(--text-normal)'};
				font-weight: ${isToday || isSelected ? '600' : '400'};
				opacity: ${isPast ? 0.5 : 1};
			`;

			if (!isPast) {
				dayBtn.onclick = () => {
					this.selectedDate = dateStr;
					this.selectedMarker = dateStr;
					rerender();
					this.renderPreview(this.contentEl);
				};
			}
		}
	}

	private renderPreview(contentEl: HTMLElement) {
		const previewBox = contentEl.querySelector('.bujo-marker-preview') as HTMLElement;
		if (!previewBox) return;

		const choice: MigrationChoice = {
			marker: this.selectedMarker,
			destType: this.selectedDestType,
			sourceMarker: this.selectedSourceMarker,
		};

		const marker = buildMarker(choice);
		const destLabel = this.getDestLabel(choice);

		previewBox.innerHTML = `
			<div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">PREVIEW</div>
			<div style="font-family: monospace; font-size: 14px; color: var(--text-accent); margin-bottom: 4px;">
				- ${marker} ${this.taskText}
			</div>
			<div style="font-size: 11px; color: var(--text-muted);">
				→ ${destLabel}
				${choice.sourceMarker ? ` · Source: [${choice.sourceMarker}]` : ' · Source: [>]'}
			</div>
		`;
	}

	private getDestLabel(choice: MigrationChoice): string {
		const destTypeStr = choice.destType === 'event' ? ' (event)'
			: choice.destType === 'appointment' ? ' (appointment)'
			: choice.destType === 'info' ? ' (info point)'
			: '';

		const today = moment();
		switch (choice.marker) {
			case ':': return `Today${destTypeStr}`;
			case '>': return `Tomorrow (${today.clone().add(1,'day').format('ddd MMM D')})${destTypeStr}`;
			case ':w': return `This week${destTypeStr}`;
			case 'w': return `Next week${destTypeStr}`;
			case ':m': return `This month${destTypeStr}`;
			case 'm': return `Next month${destTypeStr}`;
			case 'fut': return `Future log${destTypeStr}`;
			default:
				if (DAYS.find(d => d.marker === choice.marker)) {
					return `Next ${choice.marker.charAt(0).toUpperCase() + choice.marker.slice(1)}${destTypeStr}`;
				}
				return `${choice.marker}${destTypeStr}`;
		}
	}

	private execute() {
		const choice: MigrationChoice = {
			marker: this.selectedMarker,
			destType: this.selectedDestType,
			sourceMarker: this.selectedSourceMarker,
		};

		const marker = `- ${buildMarker(choice)} ${this.taskText}`;
		const line = this.editor.getLine(this.lineStart);
		const indentMatch = line.match(/^(\s*)/);
		const indent = indentMatch ? indentMatch[0] : '';

		// Replace the entire line
		this.editor.setLine(this.lineStart, `${indent}${marker}`);

		this.close();
	}

	// ── Chip styles ──

	private chipStyle(active: boolean): string {
		return `
			padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid;
			font-family: var(--font-text); text-align: left;
			background: ${active ? 'var(--interactive-accent)' : 'var(--background-primary)'};
			color: ${active ? 'var(--text-on-accent)' : 'var(--text-normal)'};
			border-color: ${active ? 'var(--interactive-accent)' : 'var(--background-modifier-border)'};
			transition: all 0.1s;
		`;
	}

	private smallChipStyle(active: boolean): string {
		return `
			padding: 5px 10px; border-radius: 6px; cursor: pointer; border: 1px solid;
			font-size: 12px; font-weight: 500;
			background: ${active ? 'var(--interactive-accent)' : 'var(--background-primary)'};
			color: ${active ? 'var(--text-on-accent)' : 'var(--text-normal)'};
			border-color: ${active ? 'var(--interactive-accent)' : 'var(--background-modifier-border)'};
			transition: all 0.1s;
		`;
	}

	private rerenderChips(row: HTMLElement) {
		const chips = row.querySelectorAll('button');
		chips.forEach(chip => {
			const label = chip.querySelector('div')?.textContent?.toLowerCase() || '';
			const qds = getQuickDates();
			const match = qds.find(qd => qd.label.toLowerCase() === label);
			if (match) {
				chip.setAttribute('style', this.chipStyle(this.selectedMarker === match.marker));
			}
		});
	}

	private rerenderDayChips(row: HTMLElement) {
		const chips = row.querySelectorAll('button');
		chips.forEach(chip => {
			const label = chip.textContent?.toLowerCase() || '';
			chip.setAttribute('style', this.smallChipStyle(this.selectedMarker === label));
		});
	}

	private rerenderTypeChips(row: HTMLElement) {
		const types = ['task', 'event', 'appointment', 'info'];
		const chips = row.querySelectorAll('button');
		chips.forEach((chip, i) => {
			chip.setAttribute('style', this.smallChipStyle(this.selectedDestType === types[i]));
		});
	}

	private rerenderSrcChips(row: HTMLElement) {
		const ids = [null, '/', '=', 'x', 'skip'];
		const chips = row.querySelectorAll('button');
		chips.forEach((chip, i) => {
			chip.setAttribute('style', this.smallChipStyle(this.selectedSourceMarker === ids[i]));
		});
	}
}
