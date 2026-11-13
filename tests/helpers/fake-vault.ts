// A minimal in-memory stand-in for the slice of Obsidian's App the migration
// engine touches: vault reads/writes, the metadata cache, file trashing and
// the active file. Enough to drive whole migrations and assert on the
// resulting note contents.

import { App, TFile } from 'obsidian';

/**
 * A TFile standing for a path. Built field-by-field rather than through a
 * constructor argument: `tsc` checks these tests against the real obsidian
 * types, where TFile takes none.
 */
function fileAt(path: string): TFile {
	const file = new TFile();
	const name = path.split('/').pop() ?? '';
	const dot = name.lastIndexOf('.');
	file.path = path;
	file.name = name;
	file.basename = dot > 0 ? name.slice(0, dot) : name;
	file.extension = dot > 0 ? name.slice(dot + 1) : '';
	return file;
}

export class FakeVault {
	files = new Map<string, string>();
	folders = new Set<string>();

	/**
	 * When true, `process` runs the callback but discards its result — a write
	 * that reports success and changes nothing. This is the failure the ACID
	 * guarantee exists for, so it has to be reproducible.
	 */
	swallowWrites = false;

	getAbstractFileByPath(path: string): TFile | { path: string } | null {
		if (this.files.has(path)) return fileAt(path);
		if (this.folders.has(path)) return { path };
		return null;
	}

	async read(file: TFile): Promise<string> {
		const content = this.files.get(file.path);
		if (content === undefined) throw new Error(`FakeVault: no such file ${file.path}`);
		return content;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	async process(file: TFile, fn: (content: string) => string): Promise<string> {
		const current = this.files.get(file.path) ?? '';
		const next = fn(current);
		if (!this.swallowWrites) this.files.set(file.path, next);
		return next;
	}

	async create(path: string, content: string): Promise<TFile> {
		if (this.files.has(path)) throw new Error(`FakeVault: ${path} already exists`);
		this.files.set(path, content);
		return fileAt(path);
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async modify(file: TFile, content: string): Promise<void> {
		this.files.set(file.path, content);
	}

	getFiles(): TFile[] {
		return [...this.files.keys()].map(fileAt);
	}
}

export interface FakeApp {
	app: App;
	vault: FakeVault;
	trashed: string[];
	// Property-style so destructuring them doesn't trip the unbound-method rule.
	setActive: (path: string | null) => void;
	/** The note's lines, for assertions. */
	lines: (path: string) => string[];
}

export function fakeApp(files: Record<string, string> = {}): FakeApp {
	const vault = new FakeVault();
	for (const [path, content] of Object.entries(files)) vault.files.set(path, content);

	const trashed: string[] = [];
	let active: TFile | null = null;

	const app = {
		vault,
		// No cache: every lookup falls back to the full scan / indent walk,
		// which is the path that has to work when Obsidian's cache is stale.
		metadataCache: { getFileCache: () => null },
		fileManager: {
			trashFile: async (file: TFile) => {
				trashed.push(file.path);
				vault.files.delete(file.path);
			},
		},
		workspace: {
			getActiveFile: () => active,
			getLeaf: () => ({ openFile: async () => undefined }),
		},
	};

	return {
		app: app as unknown as App,
		vault,
		trashed,
		setActive: (path) => { active = path === null ? null : fileAt(path); },
		lines: (path) => (vault.files.get(path) ?? '').split('\n'),
	};
}
