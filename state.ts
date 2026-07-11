/**
 * Singleton state shared between the extension entry point and the tools.
 *
 * Tools can't access the extension's private state through the typed
 * ExtensionContext, so we use a module-level singleton. The extension
 * initializes it on `session_start` and tears it down on `session_shutdown`.
 */

import { writeSettings as ioWriteSettings } from "./file-io.ts";
import type { SettingsFile } from "./settings-schema.ts";

let settingsFilePath: string | null = null;
let currentSettings: SettingsFile | null = null;
let notifier: ((message: string, level?: "info" | "warning" | "error") => void) | null = null;

export function initState(opts: {
	settingsFilePath: string;
	settings: SettingsFile;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
}): void {
	settingsFilePath = opts.settingsFilePath;
	currentSettings = opts.settings;
	notifier = opts.notify;
}

export function disposeState(): void {
	settingsFilePath = null;
	currentSettings = null;
	notifier = null;
}

export function getSettings(): SettingsFile {
	if (!currentSettings) {
		throw new Error("superhive-pi-truth: state not initialized");
	}
	return currentSettings;
}

export function setSettings(settings: SettingsFile): number {
	if (!settingsFilePath) {
		throw new Error("superhive-pi-truth: state not initialized");
	}
	currentSettings = settings;
	return ioWriteSettings(settingsFilePath, settings);
}

export function getSettingsPath(): string {
	if (!settingsFilePath) {
		throw new Error("superhive-pi-truth: state not initialized");
	}
	return settingsFilePath;
}

export function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
	notifier?.(message, level);
}

export function isInitialized(): boolean {
	return settingsFilePath !== null && currentSettings !== null;
}
