// "Schedule recurring task" modal — lay down every occurrence of a task from
// now until a chosen date, stepping by a customisable interval. The interval
// unit picks the note granularity (days→daily, weeks→weekly, months→monthly).

import { App, Modal, Setting, Notice, moment } from 'obsidian';
import { computeRecurrence, RecurUnit, RECUR_CAP } from './recurrence';

type ScheduleFn = (
	taskText: string,
	everyN: number,
	unit: RecurUnit,
	untilISO: string,
) => Promise<{ created: number; capped: boolean; targetType: string }>;

const NOTE_WORD: Record<string, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

export class RecurringScheduleModal extends Modal {
	private taskText: string;
	private everyN = 3;
	private unit: RecurUnit = 'weeks';
	private until: string;
	private schedule: ScheduleFn;
	private previewEl: HTMLElement | null = null;

	constructor(app: App, taskText: string, schedule: ScheduleFn) {
		super(app);
		this.taskText = taskText;
		this.schedule = schedule;
		this.until = moment().endOf('year').format('YYYY-MM-DD');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Schedule recurring task' });

		new Setting(contentEl)
			.setName('Task')
			.addText(t => t
				.setPlaceholder('Call grandma')
				.setValue(this.taskText)
				.onChange(v => { this.taskText = v; this.renderPreview(); }));

		new Setting(contentEl)
			.setName('Every')
			.addText(t => {
				t.inputEl.type = 'number';
				t.inputEl.min = '1';
				t.setValue(String(this.everyN)).onChange(v => {
					this.everyN = parseInt(v, 10) || 0;
					this.renderPreview();
				});
			})
			.addDropdown(d => d
				.addOptions({ days: 'days', weeks: 'weeks', months: 'months' })
				.setValue(this.unit)
				.onChange(v => { this.unit = v as RecurUnit; this.renderPreview(); }));

		new Setting(contentEl)
			.setName('Until')
			.setDesc('Occurrences are created up to and including this date.')
			.addText(t => {
				t.inputEl.type = 'date';
				t.setValue(this.until).onChange(v => { this.until = v; this.renderPreview(); });
			});

		this.previewEl = contentEl.createDiv({ cls: 'bujo-recur-preview' });

		new Setting(contentEl)
			.addButton(b => b.setButtonText('Schedule').setCta().onClick(() => this.submit()))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));

		this.renderPreview();
	}

	private renderPreview() {
		if (!this.previewEl) return;
		const { dates, targetType, capped } = computeRecurrence(this.everyN, this.unit, this.until);

		if (!this.taskText.trim() || dates.length === 0) {
			this.previewEl.setText('Nothing to schedule yet — check the interval and end date.');
			return;
		}

		const fmt = (d: string) => targetType === 'weekly'
			? moment(d).format('[W]WW')
			: targetType === 'monthly'
				? moment(d).format('MMM YYYY')
				: moment(d).format('MMM D');
		const range = dates.length === 1 ? fmt(dates[0]!) : `${fmt(dates[0]!)} → ${fmt(dates[dates.length - 1]!)}`;
		const capNote = capped ? ` (capped at ${RECUR_CAP})` : '';

		this.previewEl.setText(
			`Creates ${dates.length} occurrence${dates.length === 1 ? '' : 's'} in ${NOTE_WORD[targetType]} notes: ${range}${capNote}`,
		);
	}

	private async submit() {
		if (!this.taskText.trim()) {
			new Notice('Enter a task to schedule.');
			return;
		}
		const { created, capped, targetType } = await this.schedule(this.taskText, this.everyN, this.unit, this.until);
		if (created === 0) {
			new Notice('No occurrences to schedule — check the interval and end date.');
			return;
		}
		new Notice(
			`Scheduled ${created} occurrence${created === 1 ? '' : 's'} in ${NOTE_WORD[targetType]} notes${capped ? ` (capped at ${RECUR_CAP})` : ''}.`,
		);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
