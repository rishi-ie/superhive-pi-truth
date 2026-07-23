/**
 * Per-file watcher for the four truth files.
 *
 * Watches the parent directory of the target file (handles atomic-rename
 * writes — `fs.watch` on a single file breaks after inode change). Debounces
 * events by 100ms (Node's `fs.watch` can fire multiple times per write).
 *
 * Writer-tag guard: every write bumps a counter encoded in the file's
 * `managedBy` field. The watcher remembers the last-seen counter; events
 * with a counter <= the last-seen one are ignored (they were caused by
 * the agent's own write, not by an external change).
 *
 * Fallback: if `fs.watch` errors, switches to `fs.watchFile` polling at
 * 1s intervals.
 */

import { existsSync, readFileSync, watch, type FSWatcher, watchFile } from "node:fs";
import { basename, dirname } from "node:path";

export interface WatcherOptions {
	debounceMs?: number;
	onChange: () => void;
	onError?: (error: Error) => void;
}

export interface Watcher {
	start(): void;
	stop(): void;
	markSelfWrite(): void;
	lastSeen(): number;
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

	function readCounter(): number {
		if (!existsSync(targetPath)) return 0;
		try {
			const raw = readFileSync(targetPath, "utf-8");
			const parsed = JSON.parse(raw) as { managedBy?: string };
			const tag = parsed.managedBy ?? "";
			const match = /#(\d+)$/.exec(tag);
			if (!match || !match[1]) return 0;
			return Number.parseInt(match[1], 10);
		} catch {
			return 0;
		}
	}

	function fire() {
		if (stopped) return;
		try {
			if (!existsSync(targetPath)) {
				options.onChange();
				return;
			}
			const counter = readCounter();
			if (counter > lastSeenCounter) {
				lastSeenCounter = counter;
				options.onChange();
			}
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

	function seedCounter() {
		lastSeenCounter = readCounter();
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
			lastSeenCounter = readCounter();
		},
		lastSeen() {
			return lastSeenCounter;
		},
		running() {
			return running;
		},
	};
}
