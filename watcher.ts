/**
 * File watcher for the settings file.
 *
 * Watches the parent directory of the settings file (handles atomic-rename
 * writes — `fs.watch` on a single file breaks after inode change). Debounces
 * events by 100ms (Node's `fs.watch` can fire multiple times per write).
 *
 * Writer-tag guard: every write bumps a counter encoded in the file's
 * `managedBy` field. The watcher remembers the last-seen counter; events
 * with a counter <= the last-seen one are ignored (they were caused by
 * the agent's own write, not by an external change).
 *
 * Fallback: if `fs.watch` errors, switches to `fs.watchFile` polling at
 * 1s intervals (per the `fs-watch.ts` pattern in the fork).
 */

import { existsSync, readFileSync, watch, type FSWatcher, watchFile } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writerCounter } from "./file-io.ts";

export interface WatcherOptions {
	/** Debounce window in ms (default 100) */
	debounceMs?: number;
	/** Called whenever a meaningful change is detected. */
	onChange: () => void;
	/** Called on watcher errors (for diagnostics). */
	onError?: (error: Error) => void;
}

export interface Watcher {
	/** Start watching. Idempotent. */
	start(): void;
	/** Stop watching. Idempotent. */
	stop(): void;
	/** Update the last-seen writer counter. Use after an agent-initiated write. */
	markSelfWrite(): void;
	/** Return the current last-seen writer counter. */
	lastSeen(): number;
	/** True if the watcher is currently running. */
	running(): boolean;
}

const DEFAULT_DEBOUNCE_MS = 100;

export function createWatcher(targetPath: string, options: WatcherOptions): Watcher {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const parent = dirname(targetPath);
	const targetBasename = basename(targetPath);

	let fsWatcher: FSWatcher | null = null;
	let pollTimer: NodeJS.Timeout | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;
	let lastSeenCounter = 0;
	let running = false;
	let stopped = false;

	function fire() {
		if (stopped) return;
		try {
			if (!existsSync(targetPath)) {
				// File was deleted; treat as a change (caller will seed defaults)
				options.onChange();
				return;
			}
			const raw = readFileSync(targetPath, "utf-8");
			let counter = 0;
			try {
				const parsed = JSON.parse(raw);
				counter = writerCounter(parsed);
			} catch {
				// Partial read mid-write; treat as change and let caller re-validate
				options.onChange();
				return;
			}
			if (counter > lastSeenCounter) {
				lastSeenCounter = counter;
				options.onChange();
			}
			// else: this was the agent's own write — skip
		} catch (error) {
			options.onError?.(error as Error);
		}
	}

	function debouncedFire() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			fire();
		}, debounceMs);
	}

	function startNative() {
		try {
			fsWatcher = watch(parent, (_eventType, filename) => {
				if (!filename) {
					debouncedFire();
					return;
				}
				// Fire on any event that touches our target file or a rename
				if (filename === targetBasename || filename.startsWith(`${targetBasename}.`)) {
					debouncedFire();
				}
			});
			fsWatcher.on("error", (err) => {
				options.onError?.(err);
				if (running) {
					stopNative();
					startPolling();
				}
			});
		} catch (error) {
			options.onError?.(error as Error);
			startPolling();
		}
	}

	function stopNative() {
		if (fsWatcher) {
			try {
				fsWatcher.close();
			} catch {
				// ignore
			}
			fsWatcher = null;
		}
	}

	function startPolling() {
		pollTimer = setInterval(() => {
			debouncedFire();
		}, 1000);
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// Seed the last-seen counter from the current file (if any) so the first
	// read after the agent writes the file doesn't trigger a self-applied diff.
	function seedCounter() {
		if (!existsSync(targetPath)) return;
		try {
			const raw = readFileSync(targetPath, "utf-8");
			const parsed = JSON.parse(raw);
			lastSeenCounter = writerCounter(parsed);
		} catch {
			// ignore
		}
	}

	return {
		start() {
			if (running || stopped) return;
			seedCounter();
			running = true;
			startNative();
		},
		stop() {
			if (stopped) return;
			stopped = true;
			running = false;
			stopNative();
			stopPolling();
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
		},
		markSelfWrite() {
			// After the agent writes, bump the counter so the next watcher
			// fire is treated as a self-write.
			lastSeenCounter = lastSeenCounter + 1;
		},
		lastSeen() {
			return lastSeenCounter;
		},
		running() {
			return running;
		},
	};
}

/**
 * Convenience helper: derive the file path one level up given a workspace,
 * matching the convention used everywhere else in this extension.
 */
export function settingsFilePath(workspace: string): string {
	const agentRoot = dirname(workspace);
	const folder = basename(agentRoot);
	return join(agentRoot, `Superhive-pi-${folder}.json`);
}
