import { App, PluginSettingTab, Setting } from 'obsidian';
import BujoMigrationPlugin from './main';

export interface BujoPluginSettings {
	dailyNotesPath: string;
	weeklyNotesPath: string;
	monthlyNotesPath: string;
	futureLogPath: string;
	templatesPath: string;
}

export const DEFAULT_SETTINGS: BujoPluginSettings = {
	dailyNotesPath: 'Journal/001 Daily Notes',
	weeklyNotesPath: 'Journal/002 Weekly Notes',
	monthlyNotesPath: 'Journal/003 Monthly Notes',
	futureLogPath: 'Journal/006 Future Log',
	templatesPath: 'Obsidian/Templator/Journal',
};

export class BujoSettingTab extends PluginSettingTab {
	plugin: BujoMigrationPlugin;

	constructor(app: App, plugin: BujoMigrationPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Bujo Settings' });

		new Setting(containerEl)
			.setName('Daily Notes Path')
			.setDesc('Path to your daily notes folder')
			.addText(text => text
				.setPlaceholder('Journal/001 Daily Notes')
				.setValue(this.plugin.settings.dailyNotesPath)
				.onChange(async (value) => {
					this.plugin.settings.dailyNotesPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Weekly Notes Path')
			.setDesc('Path to your weekly notes folder')
			.addText(text => text
				.setPlaceholder('Journal/002 Weekly Notes')
				.setValue(this.plugin.settings.weeklyNotesPath)
				.onChange(async (value) => {
					this.plugin.settings.weeklyNotesPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Monthly Notes Path')
			.setDesc('Path to your monthly notes folder')
			.addText(text => text
				.setPlaceholder('Journal/003 Monthly Notes')
				.setValue(this.plugin.settings.monthlyNotesPath)
				.onChange(async (value) => {
					this.plugin.settings.monthlyNotesPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Future Log Path')
			.setDesc('Path to your future log folder')
			.addText(text => text
				.setPlaceholder('Journal/006 Future Log')
				.setValue(this.plugin.settings.futureLogPath)
				.onChange(async (value) => {
					this.plugin.settings.futureLogPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Templates Path')
			.setDesc('Path to your journal templates folder')
			.addText(text => text
				.setPlaceholder('Obsidian/Templator/Journal')
				.setValue(this.plugin.settings.templatesPath)
				.onChange(async (value) => {
					this.plugin.settings.templatesPath = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', {
			text: 'Bujo provides bullet journal migration commands for daily, weekly, and monthly notes.',
			cls: 'setting-item-description'
		});
	}
}
