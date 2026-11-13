// "Generate review" modal — the single entry point for building a review
// document. Everything that used to need its own command (which period, and
// whether to include already-filed or finished work) is a choice in here.

import { App, Modal, Setting, SuggestModal, Notice, moment } from 'obsidian';
import { TaskInclusion, OUTSTANDING_ONLY } from './types';
import { ReviewRequest, ReviewScope } from './reviews';

type GenerateFn = (request: ReviewRequest) => Promise<void>;

interface PeriodDefaults {
	choice: RangeChoice;
	week: string;
	month: string;
	from: string;
	to: string;
}

/**
 * What to offer before the user chooses anything: the period that has just
 * ended, unless a journal note is open — running this from 2026-10.md should
 * offer October, and from a daily note, the month it sits in.
 */
function periodDefaults(app: App): PeriodDefaults {
	const lastWeek = moment().subtract(1, 'week');
	const lastMonth = moment().subtract(1, 'month');
	const defaults: PeriodDefaults = {
		choice: 'monthly',
		week: lastWeek.format('GGGG-[W]WW'),
		month: lastMonth.format('YYYY-MM'),
		from: lastMonth.clone().startOf('month').format('YYYY-MM-DD'),
		to: lastMonth.clone().endOf('month').format('YYYY-MM-DD'),
	};

	const path = app.workspace.getActiveFile()?.path;
	if (!path) return defaults;

	const weekMatch = path.match(/(\d{4})-W(\d{2})\.md$/);
	if (weekMatch && weekMatch[1] && weekMatch[2]) {
		defaults.week = moment()
			.isoWeekYear(parseInt(weekMatch[1], 10))
			.isoWeek(parseInt(weekMatch[2], 10))
			.format('GGGG-[W]WW');
		defaults.choice = 'weekly';
		return defaults;
	}

	// A monthly note, or a daily note: review the month it belongs to
	const monthMatch = path.match(/(\d{4}-\d{2})(?:-\d{2})?\.md$/);
	if (monthMatch && monthMatch[1]) {
		defaults.month = monthMatch[1];
		defaults.choice = 'monthly';
	}
	return defaults;
}

type RangeChoice = 'weekly' | 'monthly' | 'range' | 'global';

/**
 * Step one: the common reviews as a one-keystroke list, with the full form
 * behind the last two rows. Generating last month's review shouldn't cost a
 * dialog, and a date range shouldn't cost a command of its own.
 */
interface ReviewChoice {
	title: string;
	sub: string;
	/** Generate straight away, or open the form to fill in the rest. */
	run: (modal: ReviewQuickPick) => void;
}

export class ReviewQuickPick extends SuggestModal<ReviewChoice> {
	constructor(app: App, private generate: GenerateFn) {
		super(app);
		this.setPlaceholder('Generate a review of…');
	}

	/**
	 * Presets follow the note you are in: from 2026-10.md the month row offers
	 * October, not last month. Same rule as the form (see adoptActiveNote).
	 */
	private choices(): ReviewChoice[] {
		const form = () => new GenerateReviewModal(this.app, this.generate);
		const plain = (scope: ReviewScope) => this.generate({ scope, include: { ...OUTSTANDING_ONLY } });

		const defaults = periodDefaults(this.app);
		const month = moment(defaults.month, 'YYYY-MM');
		const week = moment(defaults.week, 'GGGG-[W]WW');

		return [
			{
				title: 'Week',
				sub: `${week.format('[W]WW')} · starts ${week.clone().startOf('isoWeek').format('MMM D')}`,
				run: () => void plain({ kind: 'weekly', week: defaults.week }),
			},
			{
				title: 'Month',
				sub: month.format('MMMM YYYY'),
				run: () => void plain({ kind: 'monthly', month: defaults.month }),
			},
			{
				title: 'Global',
				sub: 'every journal note whose period has passed',
				run: () => void plain({ kind: 'global' }),
			},
			{
				title: 'Between dates…',
				sub: 'any from → to range',
				run: () => form().openAt('range'),
			},
			{
				title: 'More options…',
				sub: 'choose the period and which entries to list',
				run: () => form().open(),
			},
		];
	}

	getSuggestions(query: string): ReviewChoice[] {
		const needle = query.toLowerCase().trim();
		if (!needle) return this.choices();
		return this.choices().filter(c =>
			c.title.toLowerCase().includes(needle) || c.sub.toLowerCase().includes(needle));
	}

	renderSuggestion(choice: ReviewChoice, el: HTMLElement) {
		el.addClass('mod-complex');
		const content = el.createDiv({ cls: 'suggestion-content' });
		content.createDiv({ cls: 'suggestion-title', text: choice.title });
		content.createDiv({ cls: 'suggestion-note', text: choice.sub });
	}

	onChooseSuggestion(choice: ReviewChoice) {
		choice.run(this);
	}
}

const RANGE_LABELS: Record<RangeChoice, string> = {
	weekly: 'Week',
	monthly: 'Month',
	range: 'Between dates',
	global: 'Global',
};

const INCLUDE_FIELDS: { key: keyof TaskInclusion; name: string; short: string; desc: string }[] = [
	{
		key: 'outstanding', name: 'Open work', short: 'open work',
		desc: '[ ] tasks, [s] scheduled, [/] in progress, and anything already carrying a marker',
	},
	{
		key: 'timebound', name: 'Events and the like', short: 'events',
		desc: '[o] events, [a] appointments, [i] ideas and other types — they belong to the day they happened, so they are not migrated by default',
	},
	{
		key: 'migrated', name: 'Already filed', short: 'already filed',
		desc: '[>], [<], [+] — for recovering a migration that never landed',
	},
	{
		key: 'completed', name: 'Completed', short: 'completed',
		desc: '[x] — listed for reference, not reprocessed',
	},
	{ key: 'cancelled', name: 'Cancelled', short: 'cancelled', desc: '[-]' },
];

export class GenerateReviewModal extends Modal {
	private rangeChoice: RangeChoice;
	private week: string;
	private month: string;
	private from: string;
	private to: string;
	private include: TaskInclusion = { ...OUTSTANDING_ONLY };

	private generate: GenerateFn;
	private rangeFieldsEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;

	constructor(app: App, generate: GenerateFn) {
		super(app);
		this.generate = generate;

		const defaults = periodDefaults(app);
		this.rangeChoice = defaults.choice;
		this.week = defaults.week;
		this.month = defaults.month;
		this.from = defaults.from;
		this.to = defaults.to;
	}

	/** Open with a particular range preselected (the "Between dates…" row). */
	openAt(choice: RangeChoice) {
		this.rangeChoice = choice;
		this.open();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Generate review' });

		new Setting(contentEl)
			.setName('Covering')
			.addDropdown(d => d
				.addOptions(RANGE_LABELS)
				.setValue(this.rangeChoice)
				.onChange(value => {
					this.rangeChoice = value as RangeChoice;
					this.renderRangeFields();
					this.renderSummary();
				}));

		this.rangeFieldsEl = contentEl.createDiv();

		contentEl.createEl('h4', { text: 'Include' });
		for (const field of INCLUDE_FIELDS) {
			new Setting(contentEl)
				.setName(field.name)
				.setDesc(field.desc)
				.addToggle(t => t
					.setValue(this.include[field.key])
					.onChange(value => {
						this.include[field.key] = value;
						this.renderSummary();
					}));
		}

		this.summaryEl = contentEl.createDiv({ cls: 'bujo-review-summary' });

		new Setting(contentEl)
			.addButton(b => b.setButtonText('Generate').setCta().onClick(() => this.submit()))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));

		this.renderRangeFields();
		this.renderSummary();
	}

	/** Only the inputs the chosen range needs, re-rendered on every switch. */
	private renderRangeFields() {
		const host = this.rangeFieldsEl;
		if (!host) return;
		host.empty();

		if (this.rangeChoice === 'weekly') {
			new Setting(host)
				.setName('Week')
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "2026-W41" is an ISO week code, not prose
				.setDesc('Which week, e.g. 2026-W41')
				.addText(t => t
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- as above
					.setPlaceholder('2026-W41')
					.setValue(this.week)
					.onChange(v => { this.week = v.trim(); this.renderSummary(); }));
		} else if (this.rangeChoice === 'monthly') {
			new Setting(host)
				.setName('Month')
				.setDesc('Which month, e.g. 2026-10')
				.addText(t => t
					.setPlaceholder('2026-10')
					.setValue(this.month)
					.onChange(v => { this.month = v.trim(); this.renderSummary(); }));
		} else if (this.rangeChoice === 'range') {
			new Setting(host)
				.setName('From')
				.addText(t => {
					t.inputEl.type = 'date';
					t.setValue(this.from).onChange(v => { this.from = v; this.renderSummary(); });
				});
			new Setting(host)
				.setName('To')
				.setDesc('Inclusive.')
				.addText(t => {
					t.inputEl.type = 'date';
					t.setValue(this.to).onChange(v => { this.to = v; this.renderSummary(); });
				});
		} else {
			host.createDiv({ text: 'Every journal note whose period has already passed.' });
		}
	}

	/** Say in words what will be collected, so the choices read back plainly. */
	private renderSummary() {
		if (!this.summaryEl) return;

		const states = INCLUDE_FIELDS.filter(f => this.include[f.key]).map(f => f.short);
		if (states.length === 0) {
			this.summaryEl.setText('Pick at least one kind of entry to include.');
			return;
		}

		let covering: string;
		switch (this.rangeChoice) {
			case 'weekly': {
				const week = moment(this.week, 'GGGG-[W]WW');
				covering = week.isValid()
					? `week of ${week.clone().startOf('isoWeek').format('MMM D')}`
					: `"${this.week}" — expected e.g. 2026-W41`;
				break;
			}
			case 'monthly': {
				const month = moment(this.month, 'YYYY-MM');
				covering = month.isValid() ? month.format('MMMM YYYY') : `"${this.month}" — expected e.g. 2026-10`;
				break;
			}
			case 'range': {
				const from = moment(this.from, 'YYYY-MM-DD', true);
				const to = moment(this.to, 'YYYY-MM-DD', true);
				covering = from.isValid() && to.isValid()
					? `${from.format('MMM D')} → ${to.format('MMM D, YYYY')}`
					: 'both dates, e.g. 2026-10-01';
				break;
			}
			default:
				covering = 'the whole journal';
		}

		this.summaryEl.setText(`Collecting ${states.join(', ')} from ${covering}.`);
	}

	private async submit() {
		const scope = this.chosenScope();
		if (!scope) return;
		this.close();
		await this.generate({ scope, include: { ...this.include } });
	}

	/** The chosen scope, or null (with a notice) when the inputs don't parse. */
	private chosenScope(): ReviewScope | null {
		switch (this.rangeChoice) {
			case 'weekly':
				if (!moment(this.week, 'GGGG-[W]WW').isValid()) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- as above
					new Notice('Enter the week like 2026-W41.');
					return null;
				}
				return { kind: 'weekly', week: this.week };
			case 'monthly':
				if (!moment(this.month, 'YYYY-MM').isValid()) {
					new Notice('Enter the month like 2026-10.');
					return null;
				}
				return { kind: 'monthly', month: this.month };
			case 'range':
				if (!moment(this.from, 'YYYY-MM-DD', true).isValid() || !moment(this.to, 'YYYY-MM-DD', true).isValid()) {
					new Notice('Enter both dates, e.g. 2026-10-01.');
					return null;
				}
				return { kind: 'range', from: this.from, to: this.to };
			default:
				return { kind: 'global' };
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
