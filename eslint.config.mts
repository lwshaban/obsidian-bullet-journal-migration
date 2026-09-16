import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Tests run outside Obsidian, under node's built-in runner. `test()`
		// returns a promise the runner itself awaits, and the plugin-guideline
		// rules (UI copy, vault APIs) have nothing to say about them.
		files: ['tests/**/*.ts', 'tests/**/*.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
			// node:test / node:assert are the runner; moment is imported
			// directly only by the stub that stands in for Obsidian's re-export.
			'import/no-nodejs-modules': 'off',
			'no-restricted-imports': 'off',
			'import/no-extraneous-dependencies': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"tests/.build",
	]),
);
