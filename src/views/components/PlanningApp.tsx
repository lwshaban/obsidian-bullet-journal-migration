// PlanningApp — root component. Connects Obsidian data to the UI.

import { useState, useCallback } from 'react';
import { App, moment, Notice, TFile } from 'obsidian';
import { useWeekData, TaskWithBlocks, Block, persistBlock, removeBlockFromFile, minToTimeStr } from '../hooks';
import { TaskPool } from './TaskPool';
import { Calendar } from './Calendar';

export function PlanningApp({ app }: { app: App }) {
	const [weekStart, setWeekStart] = useState(() => moment().startOf('isoWeek'));
	const [sidebarVisible, setSidebarVisible] = useState(true);
	const [doneCollapsed, setDoneCollapsed] = useState(true);
	const { tasks, setTasks } = useWeekData(app, weekStart);
	const weekEnd = weekStart.clone().add(6, 'days');

	const handleCreateBlock = useCallback(async (taskText: string, sourceFile: string, day: number, startMin: number, endMin: number) => {
		const block: Block = { id: `b${Date.now()}`, taskText, day, startMin, endMin, durationMin: endMin - startMin, sourceFile, color: COLORS[Math.floor(Math.random() * COLORS.length)]! };
		setTasks(prev => prev.map(t => t.task.text === taskText ? { ...t, blocks: [...t.blocks, block] } : t));
		await persistBlock(app, block, weekStart);
	}, [tasks, weekStart]);

	const handleUpdateBlock = useCallback(async (block: Block) => {
		await persistBlock(app, block, weekStart);
		setTasks(prev => [...prev]);
	}, [weekStart]);

	const handleDeleteBlock = useCallback(async (block: Block) => {
		setTasks(prev => prev.map(t => t.task.text === block.taskText ? { ...t, blocks: t.blocks.filter(b => b.id !== block.id) } : t));
		await removeBlockFromFile(app, block.sourceFile, block.taskText, block.startMin, block.endMin);
	}, []);

	const handleDuplicateBlock = useCallback(async (block: Block) => {
		const dup: Block = { ...block, id: `b${Date.now()}`, startMin: block.startMin + 60, endMin: block.endMin + 60 };
		setTasks(prev => prev.map(t => t.task.text === block.taskText ? { ...t, blocks: [...t.blocks, dup] } : t));
		await persistBlock(app, dup, weekStart);
	}, [weekStart]);

	const handleToggleDone = useCallback(async (task: TaskWithBlocks) => {
		const file = app.vault.getAbstractFileByPath(task.task.file);
		if (!(file instanceof TFile)) return;
		const content = await app.vault.read(file);
		const lines = content.split('\n');
		const norm = task.task.text.toLowerCase().trim();
		for (let i = 0; i < lines.length; i++) {
			const text = (lines[i]?.trim().replace(/^-\s*\[[^\]]*\]\s*/, '') || '').toLowerCase();
			if (text === norm) {
				const isCancelled = /^-\s*\[-\]/.test(lines[i]!);
				lines[i] = isCancelled
					? lines[i]!.replace(/^(\s*-\s*)\[-\]/, '$1[ ]')
					: lines[i]!.replace(/^(\s*-\s*)\[[^\]]+\]/, '$1[-]');
				await app.vault.modify(file, lines.join('\n'));
				task.done = !isCancelled;
				setTasks(prev => [...prev]);
				return;
			}
		}
	}, []);

	return (
		<div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--background-primary)' }}>
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', borderBottom: '1px solid var(--background-modifier-border)', flexShrink: 0 }}>
				<span style={{ fontSize: 15, fontWeight: 600 }}>{weekStart.format('MMM D')} – {weekEnd.format('MMM D, YYYY')}</span>
				<div style={{ display: 'flex', gap: 6 }}>
					<button onClick={() => setSidebarVisible(v => !v)} style={btnStyle}>☰</button>
					<button onClick={() => setWeekStart(w => w.clone().subtract(1, 'week'))} style={btnStyle}>←</button>
					<button onClick={() => setWeekStart(moment().startOf('isoWeek'))} style={btnStyle}>Today</button>
					<button onClick={() => setWeekStart(w => w.clone().add(1, 'week'))} style={btnStyle}>→</button>
				</div>
			</div>

			<div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
				{sidebarVisible && (
					<TaskPool tasks={tasks} app={app} doneCollapsed={doneCollapsed} onToggleDoneCollapsed={() => setDoneCollapsed(v => !v)} onToggleDone={handleToggleDone} />
				)}
				<Calendar
					weekStart={weekStart}
					tasks={tasks}
					onCreateBlock={handleCreateBlock}
					onUpdateBlock={handleUpdateBlock}
					onDeleteBlock={handleDeleteBlock}
					onDuplicateBlock={handleDuplicateBlock}
				/>
			</div>
		</div>
	);
}

const btnStyle = { padding: '4px 10px', border: '1px solid var(--background-modifier-border)', borderRadius: 5, background: 'var(--background-primary)', cursor: 'pointer', fontSize: 12, color: 'var(--text-normal)' };
const COLORS = ['oklch(65% 0.15 35)', 'oklch(58% 0.14 270)', 'oklch(55% 0.08 150)', 'oklch(50% 0.10 100)', 'oklch(60% 0.12 200)', 'oklch(55% 0.09 310)'];
