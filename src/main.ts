import { Editor, Plugin } from 'obsidian';
import { BulletJournalMigration } from './bulletJournalMigration';
import { DEFAULT_SETTINGS, BujoPluginSettings } from './settings';
import { BujoSettingTab } from './settings-tab';
import { MigrationSuggest } from './migration-suggest';
import { RecurringScheduleModal } from './recurring-ui';
import { ReviewQuickPick } from './review-ui';
import { markForMigration, jumpToTask, setTaskState } from './shortcuts';
import { setDebugLogging } from './log';

export default class BujoMigrationPlugin extends Plugin {
	settings: BujoPluginSettings;
	bujo: BulletJournalMigration;
	suggest: MigrationSuggest;

	async onload() {
		await this.loadSettings();

		// Initialize the Bujo migration system. Settings are passed as a getter
		// so folder changes apply without a reload.
		this.bujo = new BulletJournalMigration(this.app, () => this.settings);

		// Autocomplete for migration markers: type "[>" in a task line, or run
		// "Mark task for migration". Advancing afterwards is driven from here
		// so the suggester stays unaware of the keyboard flow.
		this.suggest = new MigrationSuggest(this.app, () => this.settings);
		this.suggest.onApplied = (editor) => {
			if (this.settings.autoAdvance) jumpToTask(editor, 1, this.jumpOptions());
		};
		// "Repeating…" in the picker: the one destination that isn't a marker.
		this.suggest.onRepeat = (_editor, taskText) => {
			new RecurringScheduleModal(
				this.app,
				taskText,
				(text, everyN, unit, until) => this.bujo.scheduleRecurring(text, everyN, unit, until),
			).open();
		};
		this.registerEditorSuggest(this.suggest);

		// Register all commands
		this.registerCommands();

		// Add settings tab
		this.addSettingTab(new BujoSettingTab(this.app, this));
	}

	/** Shared by every jump: land ready to act when the setting allows it. */
	jumpOptions(extra: { onlyOpen?: boolean } = {}) {
		return {
			...extra,
			openPicker: this.settings.advanceOpensPicker,
			suggest: this.suggest,
		};
	}

	/**
	 * The editor only when something is selected. "Migrate tasks" and
	 * "Schedule tasks" act on a selection when there is one and on the whole
	 * note otherwise, so each is one command rather than two — a selection is
	 * a narrowing of the same intent, not a different one.
	 */
	selectionEditor(): Editor | null {
		const editor = this.app.workspace.activeEditor?.editor;
		return editor && editor.getSelection().trim() !== '' ? editor : null;
	}

	registerCommands() {
		// The three note-level actions share a "Run:" prefix so one query
		// narrows the palette to them. Obsidian's style guide wants sentence
		// case throughout, but the capital after the prefix is what makes the
		// group read as a group rather than as a sentence fragment.
		/* eslint-disable obsidianmd/ui/sentence-case -- deliberate "Run: Verb" grouping */

		// Reviews have one entry point. It opens a short list — month, week,
		// global, between dates — so the common ones cost a keystroke, with
		// the full form (which entries to list) behind "More options…".
		this.addCommand({
			id: 'bujo-generate-review',
			icon: 'calendar-search',
			name: 'Run: Generate review',
			callback: () => new ReviewQuickPick(
				this.app,
				(request) => this.bujo.generateReview(request),
			).open()
		});

		this.addCommand({
			id: 'bujo-migrate-tasks',
			icon: 'forward',
			name: 'Run: Migrate tasks',
			callback: () => {
				const editor = this.selectionEditor();
				return editor ? this.bujo.migrateSelectedTasks(editor) : this.bujo.migrateTasks();
			}
		});

		this.addCommand({
			id: 'bujo-schedule-tasks',
			icon: 'clock',
			name: 'Run: Schedule tasks',
			callback: () => {
				const editor = this.selectionEditor();
				return editor ? this.bujo.scheduleSelectedTasks(editor) : this.bujo.scheduleTasks();
			}
		});

		/* eslint-enable obsidianmd/ui/sentence-case */

		this.addCommand({
			id: 'bujo-mark-for-migration',
			icon: 'calendar-clock',
			name: 'Mark task for migration',
			editorCallback: (editor) => markForMigration(editor, this.suggest)
		});

		this.addCommand({
			id: 'bujo-next-task',
			icon: 'chevron-down',
			name: 'Go to next task',
			editorCallback: (editor) => jumpToTask(editor, 1, this.jumpOptions())
		});

		this.addCommand({
			id: 'bujo-prev-task',
			icon: 'chevron-up',
			name: 'Go to previous task',
			editorCallback: (editor) => jumpToTask(editor, -1, this.jumpOptions())
		});

		this.addCommand({
			id: 'bujo-next-open-task',
			icon: 'chevrons-down',
			name: 'Go to next unfinished task',
			editorCallback: (editor) => jumpToTask(editor, 1, this.jumpOptions({ onlyOpen: true }))
		});

		this.addCommand({
			id: 'bujo-complete-task',
			icon: 'check',
			name: 'Complete task',
			editorCallback: (editor) => setTaskState(editor, 'x', this.settings.autoAdvance)
		});

		this.addCommand({
			id: 'bujo-cancel-task',
			icon: 'x',
			name: 'Cancel task',
			editorCallback: (editor) => setTaskState(editor, '-', this.settings.autoAdvance)
		});
	}

	// ── Settings ──

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<BujoPluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
		setDebugLogging(this.settings.debugLogging);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		setDebugLogging(this.settings.debugLogging);
	}
}
