// Stand-in for the `obsidian` module when running tests outside Obsidian.
//
// Only the pure pieces of the plugin are unit-tested, and the sole runtime
// import they share is moment — which Obsidian re-exports from the same
// library. Anything else this stub is asked for is a signal that the module
// under test is not actually pure.

import momentLib from 'moment';

export const moment = momentLib;
