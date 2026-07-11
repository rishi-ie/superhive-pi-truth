/**
 * Sessions indexer.
 *
 * Scans the agent's session directory on `session_start` and on every
 * `entry_appended` event (throttled to 1Hz), then writes a compact summary
 * of all sessions into the settings file's `sessionsIndex` block.
 *
 * Also updates `lastEvent` with the most recent event seen.
 *
 * The index is what Superhive reads to render its sessions list without
 * needing to call into the agent or scan the file system itself.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeSettings, writerCounter } from "./file-io.ts";
import type { LastEvent, SessionIndexEntry, SessionsIndex, SettingsFile } from "./settings-schema.ts";

const THROTTLE_MS = 1000;
const MAX_SESSIONS = 200;

export interface SessionsIndexerOptions {
	agentDir: string;
	workspace: string;
	settingsFilePath: string;
	/** Read-modify-write helper that supplies the current settings object. */
	getSettings(): SettingsFile;
	/** Save the settings back to disk atomically. */
	setSettings(settings: SettingsFile): void;
	/** Optional: notification hook for the user. */
	notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface SessionsIndexer {
	/** Run a full scan and write the index. */
	refresh(): void;
	/** Handle a session-entry event (throttled). */
	onEntryAppended(event: { type: string; sessionId?: string; entryId?: string; timestamp?: string }): void;
	/** Tear down (no resources to release; kept for symmetry). */
	dispose(): void;
}

export function createSessionsIndexer(options: SessionsIndexerOptions): SessionsIndexer {
	let lastWriteAt = 0;
	let pendingTimer: NodeJS.Timeout | null = null;
	let lastEvent: LastEvent | undefined;

	function getSessionDir(): string {
		return join(options.agentDir, "sessions");
	}

	function readSessionSummary(filePath: string): SessionIndexEntry | null {
		try {
			const stat = statSync(filePath);
			const content = readFileSync(filePath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0) return null;

			let header: { id?: string; cwd?: string; timestamp?: string } | null = null;
			let messageCount = 0;
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheRead = 0;
			let cacheWrite = 0;
			let cost = 0;
			let firstUserText = "";
			let name: string | undefined;

			for (const line of lines) {
				let entry: { type: string; [k: string]: unknown };
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.type === "session" && !header) {
					header = entry as { id?: string; cwd?: string; timestamp?: string };
				} else if (entry.type === "message") {
					messageCount++;
					const message = (entry as { message?: { role?: string; content?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } }).message;
					if (message?.role === "user" && !firstUserText) {
						const content = message.content;
						if (typeof content === "string") {
							firstUserText = content.slice(0, 200);
						} else if (Array.isArray(content)) {
							const textPart = content.find((c: { type?: string; text?: string }) => c.type === "text");
							if (textPart && typeof (textPart as { text?: string }).text === "string") {
								firstUserText = (textPart as { text: string }).text.slice(0, 200);
							}
						}
					}
					if (message?.usage) {
						inputTokens += message.usage.input ?? 0;
						outputTokens += message.usage.output ?? 0;
						cacheRead += message.usage.cacheRead ?? 0;
						cacheWrite += message.usage.cacheWrite ?? 0;
						cost += message.usage.cost?.total ?? 0;
					}
				} else if (entry.type === "session_info") {
					const info = entry as { name?: string };
					if (info.name) name = info.name;
				}
			}

			if (!header?.id) return null;

			return {
				id: header.id,
				name: name ?? (firstUserText.slice(0, 60) || "(empty)"),
				created: header.timestamp ?? stat.birthtime.toISOString(),
				modified: stat.mtime.toISOString(),
				messageCount,
				tokens: {
					input: inputTokens,
					output: outputTokens,
					total: inputTokens + outputTokens,
					cacheRead: cacheRead || undefined,
					cacheWrite: cacheWrite || undefined,
				},
				cost,
				path: relative(options.workspace, filePath) || filePath,
			};
		} catch {
			return null;
		}
	}

	function scan(): SessionIndexEntry[] {
		const dir = getSessionDir();
		let files: string[] = [];
		try {
			files = readdirSync(dir);
		} catch {
			// Session dir doesn't exist yet (fresh workspace). Return empty.
			return [];
		}
		const summaries: SessionIndexEntry[] = [];
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const full = join(dir, file);
			const summary = readSessionSummary(full);
			if (summary) summaries.push(summary);
			if (summaries.length >= MAX_SESSIONS) break;
		}
		// Most recent first
		summaries.sort((a, b) => (a.modified < b.modified ? 1 : -1));
		return summaries;
	}

	function writeIndex() {
		const sessions = scan();
		const current = options.getSettings();
		const next: SettingsFile = {
			...current,
			sessionsIndex: {
				lastUpdated: new Date().toISOString(),
				sessions,
			},
			lastEvent,
		};
		options.setSettings(next);
		if (options.notify) {
			options.notify(`Indexed ${sessions.length} session(s)`, "info");
		}
	}

	function throttledWrite() {
		const now = Date.now();
		const sinceLast = now - lastWriteAt;
		if (sinceLast >= THROTTLE_MS) {
			lastWriteAt = now;
			writeIndex();
		} else if (!pendingTimer) {
			pendingTimer = setTimeout(() => {
				pendingTimer = null;
				lastWriteAt = Date.now();
				writeIndex();
			}, THROTTLE_MS - sinceLast);
		}
	}

	return {
		refresh() {
			lastWriteAt = Date.now();
			writeIndex();
		},
		onEntryAppended(event) {
			lastEvent = {
				type: event.type,
				sessionId: event.sessionId,
				entryId: event.entryId,
				timestamp: event.timestamp ?? new Date().toISOString(),
			};
			throttledWrite();
		},
		dispose() {
			if (pendingTimer) {
				clearTimeout(pendingTimer);
				pendingTimer = null;
			}
		},
	};
}

// Re-export for type convenience
export type { LastEvent, SessionIndexEntry, SessionsIndex };
// Provide writeSettings + writerCounter for callers that want the file I/O layer
export { writeSettings, writerCounter };

// Path utility for cross-module use
export function agentSessionsDir(agentDir: string): string {
	return join(agentDir, "sessions");
}

export function isWithinWorkspace(workspace: string, filePath: string): boolean {
	const rel = relative(workspace, filePath);
	return !rel.startsWith("..") && !rel.startsWith("/");
}

export function _dirname(p: string): string {
	return dirname(p);
}
