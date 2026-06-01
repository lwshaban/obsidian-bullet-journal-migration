// Weekly planner — calendar grid for scheduling [@] time blocks onto tasks.

import { App, Modal, Notice, moment, TFile } from 'obsidian';
import { scanOpenTasksFull, TrackableTask } from './timeTracking';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScheduleSlot {
	day: number;           // 0=Mon..6=Sun
	hour: number;          // 0-23
	taskId: string | null; // task text (used as key)
}

interface WeekDay {
	date: string;          // YYYY-MM-DD
	label: string;         // "Mon 2"
}

// ── The Modal ──────────────────────────────────────────────────────────────────

export class WeeklyPlannerModal extends Modal {
	private tasks: TrackableTask[] = [];
	private slots: Map<string, ScheduleSlot> = new Map(); // key = "day-hour"
	private selectedTask: TrackableTask | null = null;

	constructor(app: App) {
		super(app);
	}

	async onOpen() {
		const { contentEl } = this;

		contentEl.empty();
		contentEl.addClass('bujo-planner-modal');
		contentEl.style.cssText = 'max-width: 95vw; width: 900px; max-height: 85vh; overflow: hidden;';

		// Header
		const header = contentEl.createDiv({ cls: 'bujo-planner-header' });
		header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--background-modifier-border);';

		const weekStart = moment().startOf('isoWeek');
		const weekEnd = weekStart.clone().add(6, 'days');
		header.createEl('h2', {
			text: `Plan Week: ${weekStart.format('MMM D')} – ${weekEnd.format('MMM D')}`,
		}).style.cssText = 'margin:0;font-size:18px;';

		// Action buttons
		const btnRow = header.createDiv();
		btnRow.style.cssText = 'display:flex;gap:8px;';

		const saveBtn = btnRow.createEl('button', { text: 'Save All' });
		saveBtn.style.cssText = 'padding:6px 14px;background:var(--interactive-accent);color:var(--text-on-accent);border:none;border-radius:6px;cursor:pointer;font-weight:500;';
		saveBtn.onclick = () => this.saveAll();

		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.style.cssText = 'padding:6px 14px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:6px;cursor:pointer;';
		cancelBtn.onclick = () => this.close();

		// Body: calendar + task pool
		const body = contentEl.createDiv();
		body.style.cssText = 'display:flex;height:calc(85vh - 60px);';

		// Calendar grid
		const calendar = body.createDiv({ cls: 'bujo-calendar' });
		calendar.style.cssText = 'flex:1;overflow-y:auto;padding:8px;';

		// Task pool (right sidebar)
		const pool = body.createDiv({ cls: 'bujo-task-pool' });
		pool.style.cssText = 'width:260px;border-left:1px solid var(--background-modifier-border);overflow-y:auto;padding:8px;flex-shrink:0;';

		// Load tasks
		this.tasks = await scanOpenTasksFull(this.app);

		const poolHeader = pool.createEl('h3', { text: 'Open Tasks' });
		poolHeader.style.cssText = 'margin:0 0 8px;font-size:13px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;';

		for (const task of this.tasks) {
			const taskEl = pool.createDiv({ cls: 'bujo-pool-task' });
			taskEl.style.cssText = 'padding:6px 8px;margin-bottom:4px;border-radius:4px;cursor:pointer;font-size:13px;border:1px solid transparent;';
			taskEl.textContent = task.text.slice(0, 60);
			taskEl.onclick = () => {
				pool.querySelectorAll('.bujo-pool-task').forEach(el => (el as HTMLElement).style.background = '');
				taskEl.style.background = 'var(--interactive-accent)';
				taskEl.style.color = 'var(--text-on-accent)';
				this.selectedTask = task;
			};
		}

		// Build calendar
		this.renderCalendar(calendar, weekStart);

		// Footer hint
		const footer = contentEl.createDiv();
		footer.style.cssText = 'padding:8px 16px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--background-modifier-border);';
		footer.textContent = 'Click a time slot, then click a task in the pool to schedule it. Click scheduled slots to unschedule.';
	}

	private renderCalendar(container: HTMLElement, weekStart: moment.Moment) {
		container.empty();

		const days: WeekDay[] = [];
		for (let d = 0; d < 7; d++) {
			const day = weekStart.clone().add(d, 'days');
			days.push({
				date: day.format('YYYY-MM-DD'),
				label: day.format('ddd D'),
			});
		}

		const hours = Array.from({ length: 17 }, (_, i) => i + 6); // 06:00–22:00

		// Day headers
		const headerRow = container.createDiv();
		headerRow.style.cssText = 'display:grid;grid-template-columns:50px repeat(7, 1fr);gap:2px;margin-bottom:4px;position:sticky;top:0;background:var(--background-primary);z-index:1;padding:4px 0;';

		headerRow.createDiv(); // empty corner
		for (const day of days) {
			const dayEl = headerRow.createDiv();
			dayEl.style.cssText = 'text-align:center;font-size:12px;font-weight:600;padding:4px 0;';
			dayEl.textContent = day.label;

			// Highlight today
			if (day.date === moment().format('YYYY-MM-DD')) {
				dayEl.style.cssText += 'color:var(--interactive-accent);';
			}
		}

		// Time rows
		const grid = container.createDiv();
		grid.style.cssText = 'display:grid;grid-template-columns:50px repeat(7, 1fr);gap:2px;';

		for (const hour of hours) {
			// Time label
			const timeLabel = grid.createDiv();
			timeLabel.style.cssText = 'text-align:right;font-size:10px;color:var(--text-muted);padding:4px 6px;';
			timeLabel.textContent = `${String(hour).padStart(2, '0')}:00`;

			// Slot for each day
			for (let d = 0; d < 7; d++) {
				const slotKey = `${d}-${hour}`;
				const slot = this.slots.get(slotKey);
				const slotEl = grid.createDiv({ cls: 'bujo-slot' });

				const isToday = days[d]!.date === moment().format('YYYY-MM-DD');
				const isPast = days[d]!.date < moment().format('YYYY-MM-DD');

				slotEl.style.cssText = `
					min-height: 28px; padding: 2px 4px; border-radius: 3px;
					cursor: pointer; font-size: 10px;
					border: 1px solid var(--background-modifier-border);
					background: ${isPast ? 'var(--background-secondary)' : 'var(--background-primary)'};
					overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
					transition: background 0.1s;
				`;

				if (slot) {
					slotEl.style.background = 'var(--interactive-accent)';
					slotEl.style.color = 'var(--text-on-accent)';
					slotEl.style.borderColor = 'var(--interactive-accent)';
					slotEl.textContent = slot.taskId?.slice(0, 25) || '';
				}

				slotEl.onmouseenter = () => {
					if (!slot) slotEl.style.background = 'var(--background-modifier-hover)';
				};
				slotEl.onmouseleave = () => {
					if (!slot) slotEl.style.background = isPast ? 'var(--background-secondary)' : 'var(--background-primary)';
				};

				slotEl.onclick = () => {
					if (isPast) return;
					if (slot) {
						// Click to remove
						this.slots.delete(slotKey);
						this.renderCalendar(container, weekStart);
					} else if (this.selectedTask) {
						// Schedule selected task
						this.slots.set(slotKey, {
							day: d,
							hour,
							taskId: this.selectedTask.text,
						});
						this.renderCalendar(container, weekStart);
					}
				};
			}
		}
	}

	private async saveAll() {
		if (this.slots.size === 0) {
			this.close();
			return;
		}

		const weekStart = moment().startOf('isoWeek');

		// Group slots by day and task
		const byDayTask = new Map<string, Map<string, number[]>>();
		// key: "day-taskText", value: hours[]

		for (const [slotKey, slot] of this.slots) {
			if (!slot.taskId) continue;
			const dayDate = weekStart.clone().add(slot.day, 'days').format('YYYY-MM-DD');
			const compositeKey = `${dayDate}::${slot.taskId}`;
			if (!byDayTask.has(compositeKey)) {
				byDayTask.set(compositeKey, new Map());
			}
			const dayMap = byDayTask.get(compositeKey)!;
			if (!dayMap.has(dayDate)) dayMap.set(dayDate, []);
			dayMap.get(dayDate)!.push(slot.hour);
		}

		// Actually, let me restructure: group by (taskText, dayDate) → contiguous hour blocks
		const taskBlocks: Array<{
			taskText: string;
			sourceFile: string;
			dayDate: string;
			startHour: number;
			endHour: number;
		}> = [];

		for (const [compositeKey, dayMap] of byDayTask) {
			const [dayDate, taskText] = compositeKey.split('::');
			if (!dayDate || !taskText) continue;

			for (const [date, hours] of dayMap) {
				hours.sort((a, b) => a - b);

				// Merge contiguous hours into blocks
				let blockStart = hours[0]!;
				let prev = blockStart;

				for (let i = 1; i < hours.length; i++) {
					const h = hours[i]!;
					if (h === prev + 1) {
						prev = h;
					} else {
						// End current block
						const task = this.tasks.find(t => t.text === taskText);
						taskBlocks.push({
							taskText,
							sourceFile: task?.file || '',
							dayDate: date,
							startHour: blockStart,
							endHour: prev + 1,
						});
						blockStart = h;
						prev = h;
					}
				}
				// Final block
				const task = this.tasks.find(t => t.text === taskText);
				taskBlocks.push({
					taskText,
					sourceFile: task?.file || '',
					dayDate,
					startHour: blockStart,
					endHour: prev + 1,
				});
			}
		}

		// Write [@] blocks to daily notes
		let written = 0;
		for (const block of taskBlocks) {
			const filePath = `Journal/001 Daily Notes/${block.dayDate}.md`;
			let file = this.app.vault.getAbstractFileByPath(filePath);

			// Ensure file exists
			if (!file) {
				const folderPath = 'Journal/001 Daily Notes';
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (!folder) await this.app.vault.createFolder(folderPath);
				file = await this.app.vault.create(filePath, '');
			}

			if (!(file instanceof TFile)) continue;

			const content = await this.app.vault.read(file);
			const lines = content.split('\n');

			// Find or create the parent task
			const normalizedTask = block.taskText.toLowerCase().trim();
			let parentIndex = -1;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line || !/^\s*- \[/.test(line.trim())) continue;
				const text = line.trim().replace(/^-\s*\[[^\]]*\]\s*/, '').toLowerCase();
				if (text === normalizedTask) {
					parentIndex = i;
					break;
				}
			}

			const timeStr = `${String(block.startHour).padStart(2, '0')}:00-${String(block.endHour).padStart(2, '0')}:00`;
			const trackedLine = `\t- [@] ${timeStr}`;

			if (parentIndex === -1) {
				// Task not in this day's note — add it with time block
				lines.push(`- [ ] ${block.taskText}`);
				lines.push(trackedLine);
			} else {
				// Find insertion point after parent's children
				const parentIndent = (lines[parentIndex]?.match(/^(\s*)/)?.[1]?.length) || 0;
				let insertIdx = parentIndex + 1;
				for (let i = parentIndex + 1; i < lines.length; i++) {
					const li = lines[i];
					if (!li || !li.trim()) { insertIdx = i + 1; continue; }
					const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
					if (indent <= parentIndent) { insertIdx = i; break; }
					insertIdx = i + 1;
				}
				lines.splice(insertIdx, 0, trackedLine);
			}

			await this.app.vault.modify(file, lines.join('\n'));
			written++;
		}

		new Notice(`Scheduled ${written} time blocks across ${new Set(taskBlocks.map(b => b.dayDate)).size} days`);
		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
