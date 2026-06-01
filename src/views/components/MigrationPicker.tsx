// MigrationPicker — overlay for choosing a migration destination.
// Replaces the raw-DOM MigrationPickerModal with a React component.

import { useState } from 'react';
import { App, moment } from 'obsidian';
import { TaskWithBlocks } from '../hooks';

interface Props {
	task: TaskWithBlocks;
	app: App;
	onClose: () => void;
	onMigrate: (marker: string) => void;
}

type DestType = 'task' | 'event' | 'appointment' | 'info';

const QUICK_DATES = [
	{ label: 'Today', sub: '→ current daily note', marker: ':' },
	{ label: 'Tomorrow', sub: moment().add(1, 'day').format('ddd MMM D'), marker: '>' },
	{ label: 'This week', sub: '→ current weekly note', marker: ':w' },
	{ label: 'Next week', sub: moment().add(7, 'days').startOf('isoWeek').format('ddd MMM D'), marker: 'w' },
	{ label: 'This month', sub: '→ current monthly note', marker: ':m' },
	{ label: 'Next month', sub: moment().add(1, 'month').startOf('month').format('MMM YYYY'), marker: 'm' },
	{ label: 'Future log', sub: 'long-term parking', marker: 'fut' },
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DEST_TYPES = [
	{ id: 'task' as DestType, label: 'Task', glyph: '•' },
	{ id: 'event' as DestType, label: 'Event', glyph: '○' },
	{ id: 'appointment' as DestType, label: 'Appt', glyph: '△' },
	{ id: 'info' as DestType, label: 'Info', glyph: '—' },
];

export function MigrationPicker({ task, onClose, onMigrate }: Props) {
	const [marker, setMarker] = useState('>');
	const [destType, setDestType] = useState<DestType>('task');
	const [source, setSource] = useState<string | null>(null);
	const [pickedDate, setPickedDate] = useState<string | null>(null);

	const destPart = destType === 'event' ? '{o}' : destType === 'appointment' ? '{a}' : destType === 'info' ? '{.}' : '';
	const srcPart = source ? `(${source})` : '';
	const fullMarker = `[>${marker}${srcPart}${destPart}]`;

	const destLabel = QUICK_DATES.find(q => q.marker === marker)?.label
		|| DAYS.find(d => d === marker)?.charAt(0).toUpperCase() + marker.slice(1)
		|| marker;

	return (
		<>
			{/* Backdrop */}
			<div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.3)' }} />

			{/* Panel */}
			<div style={{
				position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
				width: 400, maxHeight: '80vh', overflowY: 'auto',
				background: 'var(--background-primary)', borderRadius: 14, padding: 24,
				zIndex: 101, boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
			}}>
				{/* Task preview */}
				<div style={{ marginBottom: 16, padding: 10, background: 'var(--background-secondary)', borderRadius: 8 }}>
					<div style={{ fontSize: 15, fontWeight: 500 }}>{task.task.text}</div>
				</div>

				{/* Quick dates */}
				<div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>Destination</div>
				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 12 }}>
					{QUICK_DATES.map(q => (
						<button key={q.marker} onClick={() => { setMarker(q.marker); setPickedDate(null); }}
							style={chipStyle(marker === q.marker)}>
							<div style={{ fontSize: 12, fontWeight: 500 }}>{q.label}</div>
							<div style={{ fontSize: 10, opacity: 0.7 }}>{q.sub}</div>
						</button>
					))}
				</div>

				{/* Specific day */}
				<div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>Specific day</div>
				<div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 12 }}>
					{DAYS.map(d => (
						<button key={d} onClick={() => { setMarker(d); setPickedDate(null); }}
							style={smallChip(marker === d)}>
							{d.slice(0, 3)}
						</button>
					))}
				</div>

				{/* Destination type */}
				<div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>Type</div>
				<div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
					{DEST_TYPES.map(t => (
						<button key={t.id} onClick={() => setDestType(t.id)} style={smallChip(destType === t.id)}>
							{t.glyph} {t.label}
						</button>
					))}
				</div>

				{/* Source marker */}
				<div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>
					Source (after migration)
				</div>
				<div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
					{[{ id: null, label: '[>] Migrated' }, { id: '/', label: '[/] In-progress' }, { id: 'x', label: '[x] Done' }, { id: 'skip', label: 'Skip' }].map(s => (
						<button key={s.id || 'default'} onClick={() => setSource(s.id)} style={smallChip(source === s.id)}>
							{s.label}
						</button>
					))}
				</div>

				{/* Preview */}
				<div style={{ padding: 10, background: 'var(--background-secondary)', borderRadius: 8, marginBottom: 16 }}>
					<div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>PREVIEW</div>
					<code style={{ fontSize: 13, color: 'var(--text-accent)' }}>- {fullMarker} {task.task.text}</code>
					<div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
						→ {destLabel}{destType !== 'task' ? ` (${destType})` : ''}
					</div>
				</div>

				{/* Actions */}
				<div style={{ display: 'flex', gap: 8 }}>
					<button onClick={() => onMigrate(fullMarker)}
						style={{ flex: 1, padding: 10, background: 'var(--interactive-accent)', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
						Migrate →
					</button>
					<button onClick={onClose}
						style={{ padding: '10px 20px', background: 'var(--background-secondary)', border: '1px solid var(--background-modifier-border)', borderRadius: 8, cursor: 'pointer' }}>
						Cancel
					</button>
				</div>
			</div>
		</>
	);
}

const chipStyle = (active: boolean) => ({
	padding: '8px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid',
	borderColor: active ? 'var(--interactive-accent)' : 'var(--background-modifier-border)',
	background: active ? 'var(--interactive-accent)' : 'var(--background-primary)',
	color: active ? 'white' : 'var(--text-normal)', textAlign: 'left' as const,
});

const smallChip = (active: boolean) => ({
	padding: '4px 8px', borderRadius: 5, cursor: 'pointer', border: '1px solid',
	borderColor: active ? 'var(--interactive-accent)' : 'var(--background-modifier-border)',
	background: active ? 'var(--interactive-accent)' : 'var(--background-primary)',
	color: active ? 'white' : 'var(--text-normal)', fontSize: 11, fontWeight: 500,
});
