// Test runner: bundles the TypeScript tests with esbuild (aliasing `obsidian`
// to a stub) and hands the output to node's built-in test runner.
//
// Bundling rather than transpiling keeps this dependency-free — esbuild is
// already the plugin's bundler — and lets the tests import src modules directly.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, '.build');
const stub = join(here, 'stubs', 'obsidian.ts');

const entryPoints = readdirSync(here)
	.filter(name => name.endsWith('.test.ts'))
	.map(name => join(here, name));

if (entryPoints.length === 0) {
	console.error('No *.test.ts files found in tests/');
	process.exit(1);
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await esbuild.build({
	entryPoints,
	outdir,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node18',
	sourcemap: 'inline',
	logLevel: 'warning',
	// Node builtins (node:test, node:assert) must stay external.
	packages: 'external',
	plugins: [{
		name: 'obsidian-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub }));
			// moment is bundled so the stub resolves without `packages: external`
			// sending it back out to the installed copy's CJS entry.
			build.onResolve({ filter: /^moment$/ }, () => ({
				path: join(here, '..', 'node_modules', 'moment', 'moment.js'),
			}));
		},
	}],
});

const built = readdirSync(outdir)
	.filter(name => name.endsWith('.js'))
	.map(name => join(outdir, name));

const result = spawnSync(process.execPath, ['--test', ...built], { stdio: 'inherit' });
process.exit(result.status ?? 1);
