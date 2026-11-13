// Stand-in for the `obsidian` module when running tests outside Obsidian.
//
// Most of the plugin's tested surface is pure, and the only runtime import
// those modules share is moment — which Obsidian re-exports from the same
// library. The engine tests additionally need `TFile` (used in `instanceof`
// checks against whatever the fake vault hands back) and `Notice` (constructed
// by the command layer), so both are minimal stand-ins here.

import momentLib from 'moment';

export const moment = momentLib;

/**
 * Matches the shape the engine reads. Zero-arg like the real TFile, so test
 * helpers that fill the fields in type-check against either.
 */
export class TFile {
	path = '';
	name = '';
	basename = '';
	extension = '';
}

/** Collects what would have been shown to the user, for assertions. */
export class Notice {
	static shown: string[] = [];
	constructor(message: string, _timeout?: number) {
		Notice.shown.push(message);
	}
}
