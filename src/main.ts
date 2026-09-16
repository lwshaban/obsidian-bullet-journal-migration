import { Plugin } from 'obsidian';
import { BulletJournalMigration } from './bulletJournalMigration';
import { DEFAULT_SETTINGS, BujoPluginSettings } from './settings';
import { BujoSettingTab } from './settings-tab';
import { MigrationSuggest } from './migration-suggest';
import { RecurringScheduleModal } from './recurring-ui';
import { getTaskText } from './utils';
import { setDebugLogging } from './log';

export default class BujoMigrationPlugin extends Plugin {
	settings: BujoPluginSettings;
	bujo: BulletJournalMigration;

	async onload() {
		await this.loadSettings();

		// Initialize the Bujo migration system. Settings are passed as a getter
		// so folder changes apply without a reload.
		this.bujo = new BulletJournalMigration(this.app, () => this.settings);

		// Autocomplete for migration markers: type "[>" in a task line
		this.registerEditorSuggest(new MigrationSuggest(this.app));

		// Register all commands
		this.registerCommands();

		// Add settings tab
		this.addSettingTab(new BujoSettingTab(this.app, this));
	}

	registerCommands() {
		this.addCommand({
			id: 'bujo-generate-monthly-review',
			name: 'Generate monthly review',
			callback: () => this.bujo.generateMonthlyReview()
		});

		this.addCommand({
			id: 'bujo-generate-weekly-review',
			name: 'Generate weekly review',
			callback: () => this.bujo.generateWeeklyReview()
		});

		this.addCommand({
			id: 'bujo-migrate-selected-tasks',
			name: 'Migrate selected tasks',
			editorCallback: (editor) => this.bujo.migrateSelectedTasks(editor)
		});

		this.addCommand({
			id: 'bujo-migrate-tasks',
			name: 'Migrate tasks',
			callback: () => this.bujo.migrateTasks()
		});

		this.addCommand({
			id: 'bujo-schedule-selected-tasks',
			name: 'Schedule selected tasks',
			editorCallback: (editor) => this.bujo.scheduleSelectedTasks(editor)
		});

		this.addCommand({
			id: 'bujo-schedule-tasks',
			name: 'Schedule tasks',
			callback: () => this.bujo.scheduleTasks()
		});

		this.addCommand({
			id: 'bujo-generate-global-review',
			name: 'Generate global review',
			callback: () => this.bujo.generateGlobalReview()
		});

		this.addCommand({
			id: 'bujo-schedule-recurring',
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
