// Settings data: the shape of what is persisted and its defaults.
// Deliberately free of Obsidian UI imports so path logic (and its tests)
// can depend on this without pulling in the settings tab.

export interface BujoPluginSettings {
	dailyNotesPath: string;
	weeklyNotesPath: string;
	monthlyNotesPath: string;
	yearlyNotesPath: string;
	futureLogPath: string;
	reviewsPath: string;
	templatesPath: string;
	debugLogging: boolean;
	/** Jump to the next task after a marker is applied. */
	autoAdvance: boolean;
	/** On advancing, open the next task's destination picker immediately. */
	advanceOpensPicker: boolean;
}

export const DEFAULT_SETTINGS: BujoPluginSettings = {
	dailyNotesPath: 'Journal/001 Daily Notes',
	weeklyNotesPath: 'Journal/002 Weekly Notes',
	monthlyNotesPath: 'Journal/003 Monthly Notes',
	yearlyNotesPath: 'Journal/004 Yearly Notes',
	futureLogPath: 'Journal/006 Future Log',
	reviewsPath: 'Journal/Bujo Reviews',
	templatesPath: 'Obsidian/Templator/Journal',
	debugLogging: false,
	autoAdvance: true,
	advanceOpensPicker: true,
};
