/**
 * Atomic file I/O for the settings file.
 *
 * - `readSettings` reads, parses, validates, and migrates the file. Returns
 *   null if the file doesn't exist yet.
 * - `writeSettings` writes atomically (tmp file + rename) and stamps
 *   `lastModified` and bumps the `version` integer used by the watcher as a
 *   writer-tag guard.
 *
 * The writer-tag mechanism: every write increments the `version` field in the
 * file. The watcher remembers the last-seen `version` and only re-applies
 * changes when the new `version` is higher. This prevents the agent's own
 * writes (which bump the version) from being treated as external changes
 * when the watcher fires on its own atomic rename.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SettingsFile } from "./settings-schema.ts";
import { serializeSettings, validateSettings } from "./settings-schema.ts";

const WRITER_TAG = "superhive-pi-truth@1";

/**
 * Read the settings file. Returns null if it does not exist. Throws on parse
 * or validation errors.
 */
export function readSettings(filePath: string): SettingsFile | null {
	if (!existsSync(filePath)) {
		return null;
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new Error(`Cannot read settings file ${filePath}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in settings file ${filePath}: ${(error as Error).message}`);
	}
	return validateSettings(parsed);
}

/**
 * Write the settings file atomically. Stamps `lastModified`, sets
 * `managedBy`, and bumps the writer counter (used by the watcher as a
 * writer-tag guard).
 *
 * Returns the new counter value so the caller can update its in-memory
 * last-seen counter.
 */
export function writeSettings(filePath: string, settings: SettingsFile): number {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const prevCounter = writerCounter(settings);
	const nextCounter = prevCounter + 1;
	const next: SettingsFile = {
		...settings,
		version: 1, // schema version (always 1 in v1)
		managedBy: `${WRITER_TAG}#${nextCounter}`,
		lastModified: new Date().toISOString(),
	};
	const json = serializeSettings(next);
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, json, "utf-8");
	renameSync(tmp, filePath);
	return nextCounter;
}

/**
 * Extract the writer counter from a settings object. Returns 0 if not set.
 */
export function writerCounter(settings: SettingsFile): number {
	const tag = settings.managedBy ?? "";
	const match = /#(\d+)$/.exec(tag);
	if (!match) return 0;
	return Number.parseInt(match[1], 10);
}
