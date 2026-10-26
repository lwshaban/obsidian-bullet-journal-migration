import { Plugin } from 'obsidian';
import { BulletJournalMigration } from './bulletJournalMigration';
import { DEFAULT_SETTINGS, BujoPluginSettings } from './settings';
import { BujoSettingTab } from './settings-tab';
import { MigrationSuggest } from './migration-suggest';
import { RecurringScheduleModal } from './recurring-ui';
import { getTaskText } from './utils';
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
		this.suggest = new MigrationSuggest(this.app);
		this.suggest.onApplied = (editor) => {
			if (this.settings.autoAdvance) jumpToTask(editor, 1, this.jumpOptions());
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

	registerCommands() {
		this.addCommand({
			id: 'bujo-generate-monthly-review',
			icon: 'calendar',
			name: 'Generate monthly review',
			callback: () => this.bujo.generateMonthlyReview()
		});

		this.addCommand({
			id: 'bujo-generate-weekly-review',
			icon: 'calendar-days',
			name: 'Generate weekly review',
			callback: () => this.bujo.generateWeeklyReview()
		});

		this.addCommand({
			id: 'bujo-migrate-selected-tasks',
			icon: 'list-checks',
			name: 'Migrate selected tasks',
			editorCallback: (editor) => this.bujo.migrateSelectedTasks(editor)
		});

		this.addCommand({
			id: 'bujo-migrate-tasks',
			icon: 'forward',
			name: 'Migrate tasks',
			callback: () => this.bujo.migrateTasks()
		});

		this.addCommand({
			id: 'bujo-schedule-selected-tasks',
			icon: 'alarm-clock',
			name: 'Schedule selected tasks',
			editorCallback: (editor) => this.bujo.scheduleSelectedTasks(editor)
		});

		this.addCommand({
			id: 'bujo-schedule-tasks',
			icon: 'clock',
			name: 'Schedule tasks',
			callback: () => this.bujo.scheduleTasks()
		});

		this.addCommand({
			id: 'bujo-generate-global-review',
			icon: 'list',
			name: 'Generate global review',
			callback: () => this.bujo.generateGlobalReview()
		});

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

		this.addCommand({
			id: 'bujo-schedule-recurring',
			icon: 'repeat',
			name: 'Schedule recurring task',
			editorCallback: (editor) => {
				const taskText = getTaskText(editor.getLine(editor.getCursor().line)) || '';
				new RecurringScheduleModal(
					this.app,
					taskText,
					(text, everyN, unit, until) => this.bujo.scheduleRecurring(text, everyN, unit, until),
				).open();
			}
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
