/**
 * Per-file atomic I/O for the four truth files.
 *
 * Each call performs a `tmp + rename` write and stamps the file's
 * `managedBy` field with the next counter. The watcher uses the counter
 * to distinguish self-writes from external edits.
 *
 * The four files share identical atomic semantics but live at different
 * paths and use independent counters. Helpers here are thin wrappers
 * over the same primitive (`writeAtomic`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	serializeTruthFile,
	validateAndNormalizeInbox,
	validateAndNormalizeManage,
	validateAndNormalizeOrchestrationExtension,
	validateAndNormalizeOverview,
	validateAndNormalizePlanExtension,
	validateAndNormalizeSettings,
	type InboxFile,
	type ManageFile,
	type OrchExtensionFile,
	type OverviewFile,
	type PlanExtensionFile,
	type SettingsFile,
} from "./settings-schema.ts";

const WRITER_TAG = "superhive-pi-truth@1";
const COUNTER_RE = /#(\d+)$/;

function readCounter(managedBy: string | undefined): number {
	if (!managedBy) return 0;
	const match = COUNTER_RE.exec(managedBy);
	if (!match || !match[1]) return 0;
	return Number.parseInt(match[1], 10);
}

/**
 * Atomic write. Writes `tmpPath`, then renames it onto `finalPath`. Stamps
 * `managedBy` with the next counter and updates `lastModified`.
 *
 * Returns the new counter value.
 */
function writeAtomic(filePath: string, file: { version: 1; managedBy?: string; lastModified?: string }): number {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const prev = (file.managedBy ?? `${WRITER_TAG}#0`) as string;
	const next = readCounter(prev) + 1;
	file.managedBy = `${WRITER_TAG}#${next}`;
	file.lastModified = new Date().toISOString();
	const json = serializeTruthFile(file);
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, json, "utf-8");
	renameSync(tmp, filePath);
	return next;
}

/**
 * Read + validate. Returns null if file doesn't exist. Throws on parse/validate.
 */
function readValidated(filePath: string, validate: (raw: unknown) => unknown): unknown {
	if (!existsSync(filePath)) return null;
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		throw new Error(`Cannot read ${filePath}: ${(err as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
	}
	return validate(parsed);
}

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

export function readSettings(filePath: string): SettingsFile | null {
	return readValidated(filePath, validateAndNormalizeSettings) as SettingsFile | null;
}

export function writeSettings(filePath: string, file: SettingsFile): number {
	return writeAtomic(filePath, file);
}

// ---------------------------------------------------------------------------
// manage.json
// ---------------------------------------------------------------------------

export function readManage(filePath: string): ManageFile | null {
	return readValidated(filePath, validateAndNormalizeManage) as ManageFile | null;
}

export function writeManage(filePath: string, file: ManageFile): number {
	return writeAtomic(filePath, file);
}

// ---------------------------------------------------------------------------
// overview.json
// ---------------------------------------------------------------------------

export function readOverview(filePath: string): OverviewFile | null {
	return readValidated(filePath, validateAndNormalizeOverview) as OverviewFile | null;
}

export function writeOverview(filePath: string, file: OverviewFile): number {
	return writeAtomic(filePath, file);
}

// ---------------------------------------------------------------------------
// inbox.json
// ---------------------------------------------------------------------------

export function readInbox(filePath: string): InboxFile | null {
	return readValidated(filePath, validateAndNormalizeInbox) as InboxFile | null;
}

export function writeInbox(filePath: string, file: InboxFile): number {
	return writeAtomic(filePath, file);
}

// ---------------------------------------------------------------------------
// Per-extension settings files
//
// Each Pi extension loaded for an agent gets its own settings file at
// `<agentDir>/<ext-name>.json`. Truth ext is the canonical writer via the
// cascade engine; each extension reads its own file via fs.
// ---------------------------------------------------------------------------

export function readPlanExtension(filePath: string): PlanExtensionFile | null {
	return readValidated(filePath, validateAndNormalizePlanExtension) as PlanExtensionFile | null;
}

export function writePlanExtension(filePath: string, file: PlanExtensionFile): number {
	return writeAtomic(filePath, file);
}

export function readOrchestrationExtension(filePath: string): OrchExtensionFile | null {
	return readValidated(filePath, validateAndNormalizeOrchestrationExtension) as OrchExtensionFile | null;
}

export function writeOrchestrationExtension(filePath: string, file: OrchExtensionFile): number {
	return writeAtomic(filePath, file);
}
