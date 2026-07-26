import { Plugin } from 'obsidian';
import { BulletJournalMigration } from './bulletJournalMigration';
import { DEFAULT_SETTINGS, BujoPluginSettings, BujoSettingTab } from './settings';
import { MigrationSuggest } from './migration-suggest';
import { RecurringScheduleModal } from './recurring-ui';
import { getTaskText } from './utils';

export default class BujoMigrationPlugin extends Plugin {
	settings: BujoPluginSettings;
	bujo: BulletJournalMigration;

	async onload() {
		await this.loadSettings();

		// Initialize the Bujo migration system
		this.bujo = new BulletJournalMigration(this.app);

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
			name: 'Generate Monthly Review',
			callback: () => this.bujo.generateMonthlyReview()
		});

		this.addCommand({
			id: 'bujo-generate-weekly-review',
			name: 'Generate Weekly Review',
			callback: () => this.bujo.generateWeeklyReview()
		});

		this.addCommand({
			id: 'bujo-migrate-selected-tasks',
			name: 'Migrate Selected Tasks',
			editorCallback: (editor) => this.bujo.migrateSelectedTasks(editor)
		});

		this.addCommand({
			id: 'bujo-migrate-tasks',
			name: 'Migrate Tasks',
			callback: () => this.bujo.migrateTasks()
		});

		this.addCommand({
			id: 'bujo-schedule-selected-tasks',
			name: 'Schedule Selected Tasks',
			editorCallback: (editor) => this.bujo.scheduleSelectedTasks(editor)
		});

		this.addCommand({
			id: 'bujo-schedule-tasks',
			name: 'Schedule Tasks',
			callback: () => this.bujo.scheduleTasks()
		});

		this.addCommand({
			id: 'bujo-generate-global-review',
			name: 'Generate Global Review',
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
