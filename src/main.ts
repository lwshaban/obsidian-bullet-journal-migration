import { Plugin, Notice, TFile, App, moment, FuzzySuggestModal } from 'obsidian';
import { BulletJournalMigration } from './bulletJournalMigration';
import { DEFAULT_SETTINGS, BujoPluginSettings, BujoSettingTab } from './settings';
import {
	scanOpenTasksFull,
	startTimer,
	stopTimer,
	isTimerRunning,
	getActiveTimer,
	formatElapsed,
	writeTrackedBlock,
	collectTrackedBlocks,
	collectPlannedBlocks,
	TrackableTask,
	parseTimeRange,
} from './timeTracking';
import { WeeklyPlannerModal } from './planner';
import { MigrationPickerModal } from './migration-ui';
import { PlanningWorkspaceView, VIEW_TYPE_PLANNING } from './planning-view';

export default class BujoMigrationPlugin extends Plugin {
	settings: BujoPluginSettings;
	bujo: BulletJournalMigration;
	statusBarTimerEl: HTMLElement | null = null;
	timerInterval: number | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize the Bujo migration system
		this.bujo = new BulletJournalMigration(this.app);

		// Register planning workspace view
		this.registerView(
			VIEW_TYPE_PLANNING,
			(leaf) => new PlanningWorkspaceView(leaf)
		);

		// Ribbon icon to open planning workspace
		this.addRibbonIcon('calendar-days', 'Bujo Planning', () => {
			this.activateView();
		});

		// Register all commands
		this.registerCommands();

		// Add settings tab
		this.addSettingTab(new BujoSettingTab(this.app, this));

		// Status bar timer display
		this.updateStatusBar();
		this.timerInterval = this.registerInterval(
			window.setInterval(() => this.updateStatusBar(), 1000)
		);

		console.log('Bujo plugin loaded');
	}

	onunload() {
		if (this.timerInterval) window.clearInterval(this.timerInterval);
		console.log('Bujo plugin unloaded');
	}

	updateStatusBar() {
		const timer = getActiveTimer();
		if (timer?.active) {
			if (!this.statusBarTimerEl) {
				this.statusBarTimerEl = this.addStatusBarItem();
			}
			this.statusBarTimerEl.setText(`⏱ ${formatElapsed(timer)} — ${timer.taskText.slice(0, 30)}`);
		} else {
			this.statusBarTimerEl?.remove();
			this.statusBarTimerEl = null;
		}
	}

	registerCommands() {
		// ── Time tracking ──

		this.addCommand({
			id: 'bujo-open-planning',
			name: 'Open planning workspace',
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: 'bujo-plan-week',
			name: 'Plan week (quick calendar)',
			callback: () => new WeeklyPlannerModal(this.app).open(),
		});

		this.addCommand({
			id: 'bujo-migrate-task-ui',
			name: 'Migrate task (visual picker)',
			editorCallback: (editor) => new MigrationPickerModal(this.app, editor).open(),
		});

		this.addCommand({
			id: 'bujo-track-time',
			name: 'Track time on task',
			callback: () => this.trackTime(),
		});

		this.addCommand({
			id: 'bujo-stop-tracking',
			name: 'Stop time tracking',
			callback: () => this.stopTracking(),
		});

		this.addCommand({
			id: 'bujo-weekly-scoreboard',
			name: 'Weekly time scoreboard',
			callback: () => this.generateScoreboard(),
		});

		// ── Migration ──

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
	}

	// ── Time tracking methods ──────────────────────────────────────────────

	async trackTime() {
		if (isTimerRunning()) {
			new Notice('Timer already running. Stop it first.');
			return;
		}

		new Notice('Scanning tasks...');
		const tasks = await scanOpenTasksFull(this.app);

		if (tasks.length === 0) {
			new Notice('No open tasks found.');
			return;
		}

		// Show fuzzy suggest modal
		const modal = new TrackTaskModal(this.app, tasks, (task) => {
			startTimer(task);
			new Notice(`Tracking: ${task.text.slice(0, 40)}`);
		});
		modal.open();
	}

	async stopTracking() {
		const result = stopTimer();
		if (!result) {
			new Notice('No timer running.');
			return;
		}

		const { timer, range } = result;

		// Write [t] block to the file containing the task
		const success = await writeTrackedBlock(
			this.app,
			timer.sourceFile,
			timer.taskText,
			range,
		);

		if (success) {
			new Notice(`Tracked: ${timer.taskText.slice(0, 30)} — ${range}`);
		} else {
			// Fallback: write to current daily note
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				const content = await this.app.vault.read(activeFile);
				await this.app.vault.modify(activeFile, content + `\n- [t] ${range} — ${timer.taskText}\n`);
				new Notice(`Tracked (fallback): ${range}`);
			} else {
				new Notice('Could not write time block.');
			}
		}

		this.updateStatusBar();
	}

	async generateScoreboard() {
		new Notice('Generating scoreboard...');

		// Get this week's daily notes
		const weekStart = moment().startOf('isoWeek');
		const files: TFile[] = [];

		for (let i = 0; i < 7; i++) {
			const day = weekStart.clone().add(i, 'days');
			const dateStr = day.format('YYYY-MM-DD');
			const path = `Journal/001 Daily Notes/${dateStr}.md`;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				files.push(file);
			}
		}

		const tracked = await collectTrackedBlocks(this.app, files);
		const planned = await collectPlannedBlocks(this.app, files);

		// Aggregate by parent task
		const byTask = new Map<string, { trackedMin: number; plannedMin: number; blocks: string[] }>();

		for (const b of tracked) {
			const existing = byTask.get(b.parentTask) || { trackedMin: 0, plannedMin: 0, blocks: [] };
			existing.trackedMin += b.durationMinutes;
			existing.blocks.push(b.timeRange);
			byTask.set(b.parentTask, existing);
		}

		for (const b of planned) {
			const existing = byTask.get(b.parentTask) || { trackedMin: 0, plannedMin: 0, blocks: [] };
			existing.plannedMin += b.durationMinutes;
			byTask.set(b.parentTask, existing);
		}

		// Build report
		const weekLabel = `${weekStart.format('MMM D')} – ${weekStart.clone().add(6, 'days').format('MMM D, YYYY')}`;
		const lines: string[] = [
			`# Time Scoreboard — ${weekLabel}`,
			'',
		];

		let totalTracked = 0;
		let totalPlanned = 0;

		const sorted = [...byTask.entries()].sort((a, b) => b[1].trackedMin - a[1].trackedMin);

		for (const [taskName, data] of sorted) {
			totalTracked += data.trackedMin;
			totalPlanned += data.plannedMin;

			const trackedStr = formatMinutes(data.trackedMin);
			const plannedStr = data.plannedMin > 0 ? ` / ${formatMinutes(data.plannedMin)} planned` : '';
			const accuracy = data.plannedMin > 0
				? Math.round((data.trackedMin / data.plannedMin) * 100)
				: null;
			const accuracyBar = accuracy !== null
				? ` [${accuracy}% ${accuracyBar10(accuracy)}]`
				: '';

			lines.push(`- [ ] **${taskName}** — ${trackedStr}${plannedStr}${accuracyBar}`);
			if (data.blocks.length > 0) {
				const blockList = data.blocks.map(b => `  - ${b}`).join('\n');
				lines.push(blockList);
			}
		}

		lines.push('');
		lines.push('---');
		lines.push(`**Total tracked:** ${formatMinutes(totalTracked)}`);
		if (totalPlanned > 0) {
			lines.push(`**Total planned:** ${formatMinutes(totalPlanned)}`);
		}

		// Write report
		const weekStr = weekStart.format('YYYY-[W]WW');
		const reviewPath = `Journal/Bujo Reviews/Time/${weekStr}-Scoreboard.md`;
		const folder = this.app.vault.getAbstractFileByPath('Journal/Bujo Reviews/Time');
		if (!folder) await this.app.vault.createFolder('Journal/Bujo Reviews/Time');

		const existingFile = this.app.vault.getAbstractFileByPath(reviewPath);
		if (existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, lines.join('\n'));
		} else {
			await this.app.vault.create(reviewPath, lines.join('\n'));
		}

		const file = this.app.vault.getAbstractFileByPath(reviewPath);
		if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);

		new Notice(`Scoreboard: ${formatMinutes(totalTracked)} tracked this week`);
	}

	// ── Planning workspace ──

	async activateView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_PLANNING)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({ type: VIEW_TYPE_PLANNING, active: true });
				leaf = rightLeaf;
			}
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	// ── Settings ──

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMinutes(mins: number): string {
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	if (h > 0 && m > 0) return `${h}h ${m}m`;
	if (h > 0) return `${h}h`;
	return `${m}m`;
}

function accuracyBar10(pct: number): string {
	const filled = Math.round(pct / 10);
	return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ── Fuzzy suggest modal for task selection ────────────────────────────────────

class TrackTaskModal extends FuzzySuggestModal<TrackableTask> {
	tasks: TrackableTask[];
	onSelect: (task: TrackableTask) => void;

	constructor(app: App, tasks: TrackableTask[], onSelect: (task: TrackableTask) => void) {
		super(app);
		this.tasks = tasks;
		this.onSelect = onSelect;
		this.setPlaceholder('Search open tasks to track...');
	}

	getItems(): TrackableTask[] {
		return this.tasks;
	}

	getItemText(task: TrackableTask): string {
		return task.text;
	}

	onChooseItem(task: TrackableTask): void {
		this.onSelect(task);
	}
}
