// Console logging, gated on the "Debug logging" setting.
//
// Migration tracing is genuinely useful when a task lands in the wrong note,
// but it has no business running in every user's console by default. Warnings
// and errors always print — those signal something the user may need to act on.

let debugEnabled = false;

export function setDebugLogging(enabled: boolean): void {
	debugEnabled = enabled;
}

export function isDebugLogging(): boolean {
	return debugEnabled;
}

export const log = {
	debug(...args: unknown[]): void {
		if (debugEnabled) console.debug('[BuJo]', ...args);
	},
	warn(...args: unknown[]): void {
		console.warn('[BuJo]', ...args);
	},
	error(...args: unknown[]): void {
		console.error('[BuJo]', ...args);
	},
};
