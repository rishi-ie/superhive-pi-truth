/**
 * Singleton state shared between the truth extension entry point and its tools.
 *
 * Tools can't access the extension's private state through the typed
 * ExtensionContext, so we use module-level singletons. The extension
 * initializes them on `session_start` and tears them down on
 * `session_shutdown`.
 *
 * The four files (`settings.json`, `manage.json`, `overview.json`, `inbox.json`)
 * each have their own in-memory cache and file path. They live as parallel
 * singletons; `initState` is called once per session and stamps all four.
 */

import {
	writeInbox as ioWriteInbox,
	writeManage as ioWriteManage,
	writeOverview as ioWriteOverview,
	writeSettings as ioWriteSettings,
} from "./file-io.ts";
import type { InboxFile, ManageFile, OverviewFile, SettingsFile } from "./settings-schema.ts";
import { truthPathsForAgentDir } from "./settings-schema.ts";
import { dirname } from "node:path";

interface FourPaths {
	settings: string;
	manage: string;
	overview: string;
	inbox: string;
}

interface FourCaches {
	settings: SettingsFile;
	manage: ManageFile;
	overview: OverviewFile;
	inbox: InboxFile;
}

let paths: FourPaths | null = null;
let caches: FourCaches | null = null;
let notifier: ((message: string, level?: "info" | "warning" | "error") => void) | null = null;

export interface InitStateInput {
	settingsFilePath: string;
	manageFilePath: string;
	overviewFilePath: string;
	inboxFilePath: string;
	settings: SettingsFile;
	manage: ManageFile;
	overview: OverviewFile;
	inbox: InboxFile;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
}

export function initState(input: InitStateInput): void {
	paths = {
		settings: input.settingsFilePath,
		manage: input.manageFilePath,
		overview: input.overviewFilePath,
		inbox: input.inboxFilePath,
	};
	caches = {
		settings: input.settings,
		manage: input.manage,
		overview: input.overview,
		inbox: input.inbox,
	};
	notifier = input.notify;
}

export function disposeState(): void {
	paths = null;
	caches = null;
	notifier = null;
}

function require<T>(value: T | null, name: string): T {
	if (value === null) {
		throw new Error(`superhive-pi-truth: state not initialized (${name})`);
	}
	return value;
}

// ---- Read -----------------------------------------------------------------

export function getSettings(): SettingsFile {
	return require(caches, "settings").settings;
}

export function getManage(): ManageFile {
	return require(caches, "manage").manage;
}

export function getOverview(): OverviewFile {
	return require(caches, "overview").overview;
}

export function getInbox(): InboxFile {
	return require(caches, "inbox").inbox;
}

// ---- Write (returns the new counter) --------------------------------------

export function setSettings(next: SettingsFile): number {
	const c = require(caches, "settings");
	const p = require(paths, "settings");
	c.settings = next;
	return ioWriteSettings(p.settings, next);
}

export function setManage(next: ManageFile): number {
	const c = require(caches, "manage");
	const p = require(paths, "manage");
	c.manage = next;
	return ioWriteManage(p.manage, next);
}

export function setOverview(next: OverviewFile): number {
	const c = require(caches, "overview");
	const p = require(paths, "overview");
	c.overview = next;
	return ioWriteOverview(p.overview, next);
}

export function setInbox(next: InboxFile): number {
	const c = require(caches, "inbox");
	const p = require(paths, "inbox");
	c.inbox = next;
	return ioWriteInbox(p.inbox, next);
}

// ---- Path accessors ------------------------------------------------------

export function getSettingsPath(): string {
	return require(paths, "settings").settings;
}

export function getManagePath(): string {
	return require(paths, "manage").manage;
}

export function getOverviewPath(): string {
	return require(paths, "overview").overview;
}

export function getInboxPath(): string {
	return require(paths, "inbox").inbox;
}

export function getAllPaths() {
	return {
		settings: require(paths, "settings").settings,
		manage: require(paths, "manage").manage,
		overview: require(paths, "overview").overview,
		inbox: require(paths, "inbox").inbox,
	};
}

// ---- Notification --------------------------------------------------------

export function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
	notifier?.(message, level);
}

export function isInitialized(): boolean {
	return paths !== null && caches !== null;
}

// ---- Internal: update in-memory caches from re-read values --------------
// (used by the watcher)

export function reloadCaches(input: {
	settings: SettingsFile;
	manage: ManageFile;
	overview: OverviewFile;
	inbox: InboxFile;
}): void {
	const c = require(caches, "caches");
	c.settings = input.settings;
	c.manage = input.manage;
	c.overview = input.overview;
	c.inbox = input.inbox;
}

// ---- Internal: agent-root shortcuts --------------------------------------

/** Compute the four file paths from a workspace cwd (no I/O). */
export function pathsFromWorkspace(workspace: string) {
	const agentRoot = dirname(workspace);
	return truthPathsForAgentDir(agentRoot);
}
