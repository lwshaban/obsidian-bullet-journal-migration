import { App, PluginSettingTab, Setting } from 'obsidian';
import BujoMigrationPlugin from './main';
import { BujoPluginSettings, DEFAULT_SETTINGS } from './settings';

interface PathSetting {
	key: keyof BujoPluginSettings;
	name: string;
	desc: string;
}

const PATH_SETTINGS: PathSetting[] = [
	{ key: 'dailyNotesPath', name: 'Daily notes folder', desc: 'Folder holding your daily notes, named YYYY-MM-DD.md.' },
	{ key: 'weeklyNotesPath', name: 'Weekly notes folder', desc: 'Folder holding your weekly notes, named YYYY-Www.md.' },
	{ key: 'monthlyNotesPath', name: 'Monthly notes folder', desc: 'Folder holding your monthly notes, named YYYY-MM.md.' },
	{ key: 'yearlyNotesPath', name: 'Yearly notes folder', desc: 'Folder holding your yearly notes, named YYYY.md.' },
	{ key: 'futureLogPath', name: 'Future log folder', desc: 'Folder holding your future log, named "YYYY - Future Log.md".' },
	{ key: 'reviewsPath', name: 'Reviews folder', desc: 'Generated reviews are written to Weekly, Monthly, and Global subfolders here.' },
	{ key: 'templatesPath', name: 'Templates folder', desc: 'Folder holding Daily-Template.md, Weekly-Template.md, Monthly-Template.md, and Future-Log-Template.md. Used when a note has to be created.' },
];

export class BujoSettingTab extends PluginSettingTab {
	plugin: BujoMigrationPlugin;

	constructor(app: App, plugin: BujoMigrationPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl).setName('Folders').setHeading();

		for (const { key, name, desc } of PATH_SETTINGS) {
			const fallback = DEFAULT_SETTINGS[key] as string;
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText(text => text
					.setPlaceholder(fallback)
					.setValue(this.plugin.settings[key] as string)
					.onChange(async (value) => {
						// An empty box means "use the default", not "use the vault root".
						(this.plugin.settings[key] as string) = value.trim() || fallback;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Write detailed migration traces to the developer console. Leave off unless you are diagnosing a problem.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}));
	}
}
