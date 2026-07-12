/**
 * superhive-pi-truth extension entry point.
 *
 * On `session_start`:
 *   1. Compute the settings file path: `Superhive-pi-{foldername}.json` at the
 *      agent root (parent of the workspace cwd).
 *   2. If the file doesn't exist, run the first-run migration: read the
 *      current SettingsManager state and seed the file with defaults.
 *   3. Load the file (validates + migrates over defaults).
 *   4. Initialize the state singleton (used by tools.ts).
 *   5. Start the watcher; on external change, re-read and apply the diff.
 *   6. Run an initial catalog scan + sessions index.
 *   7. Register the 8 agent-callable tools.
 *   8. Subscribe to `entry_appended` to keep the sessions index fresh.
 *
 * On `session_shutdown`: tear down the watcher + indexers, dispose state.
 *
 * The extension never reads from `manifest.json` directly — that's the
 * launcher's job. This extension is downstream of `--manifest`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySettingsDiff, applyInitialProviders } from "./applier.ts";
import { createCatalogScanner } from "./catalog-scanner.ts";
import { readSettings, writeSettings, writerCounter } from "./file-io.ts";
import { createSessionsIndexer } from "./sessions-indexer.ts";
import { DEFAULT_SETTINGS, type SettingsFile, settingsFilePathFor } from "./settings-schema.ts";
import { disposeState, getSettings, initState } from "./state.ts";
import { registerAllTools } from "./tools.ts";
import { createWatcher } from "./watcher.ts";

const MANAGED_BY = "superhive-pi-truth@1";

interface RuntimeState {
	watcher: ReturnType<typeof createWatcher> | null;
	sessionsIndexer: ReturnType<typeof createSessionsIndexer> | null;
	catalogScanner: ReturnType<typeof createCatalogScanner> | null;
	previousSettings: SettingsFile | null;
	settingsFilePath: string;
}

const state: RuntimeState = {
	watcher: null,
	sessionsIndexer: null,
	catalogScanner: null,
	previousSettings: null,
	settingsFilePath: "",
};

function makeNotifier(ctx: ExtensionContext) {
	return (message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) {
			try {
				ctx.ui.notify(message, level);
			} catch {
				// ignore notification failures
			}
		}
	};
}

function buildInitialSettings(ctx: ExtensionContext): SettingsFile {
	// Seed the settings file from the manifest-applied state. We can't read
	// the in-memory SettingsManager directly from the ExtensionContext, so
	// we start from defaults. The actual values from the manifest have
	// already been applied via --manifest in cli.ts; this file is the
	// snapshot of "what is currently active" plus the catalog and sessions
	// index the agent will fill in.
	//
	// Pin both extensions into the active manifest so Pi's loadExtensions
	// takes the deterministic "explicit paths" branch instead of relying
	// on directory auto-discovery — the latter silently drops one of two
	// symlinked extensions in some Pi builds on macOS. We reach into
	// the settings file because truth owns the manifest lifecycle; cli.ts
	// reads `manifest.extensions` from this file at every boot.
	const settings: SettingsFile = {
		...DEFAULT_SETTINGS,
		managedBy: MANAGED_BY,
		lastModified: new Date().toISOString(),
		extensions: [
			"./extensions/superhive-pi-truth",
			"./extensions/superhive-pi-telemetry",
		],
	};
	return settings;
}

async function runExtension(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const workspace = ctx.cwd;
	state.settingsFilePath = settingsFilePathFor(workspace);

	const notify = makeNotifier(ctx);

	// Surface the agent dir to peer extensions via env. The telemetry
	// extension uses this as a fallback when ctx.cwd is empty.
	const agentRoot = dirname(workspace);
	process.env.AGENT_DIR = agentRoot;
	process.env.PI_AGENT_DIR = agentRoot;

	const resolveContextWindow = async (
		provider: string,
		name: string,
	): Promise<number | undefined> => {
		try {
			const catalog = await ctx.modelRegistry?.getAvailable?.();
			if (!catalog) return undefined;
			const match = catalog.find(
				(m) => m.provider === provider && m.id === name,
			);
			return match?.contextWindow;
		} catch (err) {
			notify(
				`resolveContextWindow failed: ${(err as Error).message}`,
				"warning",
			);
			return undefined;
		}
	};

	const applyContext = { pi, hasUI: ctx.hasUI, notify, resolveContextWindow };

	// 1. First-run migration: if the file doesn't exist, seed it.
	if (!existsSync(state.settingsFilePath)) {
		notify("First run: seeding settings file", "info");
		const initial = buildInitialSettings(ctx);
		writeSettings(state.settingsFilePath, initial);
	}

	// 1a. Backfill: existing settings files created before this commit
	// may have an empty `extensions` block. We need both truth and
	// telemetry in the active manifest so Pi's loadExtensions takes the
	// explicit paths branch; without this, only directory auto-discovery
	// runs and one of the two symlinked extensions is silently dropped
	// on some Pi/macOS combinations.
	const REQUIRED_EXTENSIONS = [
		"./extensions/superhive-pi-truth",
		"./extensions/superhive-pi-telemetry",
	] as const;
	{
		let loaded: SettingsFile | null = null;
		try {
			loaded = readSettings(state.settingsFilePath);
		} catch {
			loaded = null;
		}
		const have = Array.isArray(loaded?.extensions) ? loaded!.extensions : [];
		const missing = REQUIRED_EXTENSIONS.filter((e) => !have.includes(e));
		if (missing.length > 0 && loaded) {
			const next: SettingsFile = {
				...loaded,
				extensions: [...have, ...missing],
				lastModified: new Date().toISOString(),
			};
			try {
				writeSettings(state.settingsFilePath, next);
				notify(
					`Backfilled extensions in settings file (added: ${missing.join(", ")})`,
					"info",
				);
			} catch (err) {
				notify(
					`Failed to backfill extensions: ${(err as Error).message}`,
					"warning",
				);
			}
		}
	}

	// 2. Load + validate.
	let current: SettingsFile;
	try {
		const loaded = readSettings(state.settingsFilePath);
		if (!loaded) {
			throw new Error("readSettings returned null after first-run seed");
		}
		current = loaded;
	} catch (err) {
		notify(`Failed to load settings: ${(err as Error).message}`, "error");
		// Fall back to defaults so the agent can still run
		current = { ...DEFAULT_SETTINGS, managedBy: MANAGED_BY };
	}

	// 3. Init state singleton.
	initState({
		settingsFilePath: state.settingsFilePath,
		settings: current,
		notify,
	});
	state.previousSettings = current;

	// 3a. First-launch env migration: surface inherited *_API_KEY env vars
	//     into the settings JSON so the file becomes the source of truth.
	//     This runs every session; the no-op case is when the JSON already
	//     contains the keys (subsequent launches). Newly seen keys get persisted.
	{
		const envPatch: Record<string, string> = {};
		const currentEnv = current.environment ?? {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v && /_API_KEY$/.test(k) && !currentEnv[k]) {
				envPatch[k] = v;
			}
		}
		if (Object.keys(envPatch).length > 0) {
			const merged: SettingsFile = {
				...current,
				environment: { ...currentEnv, ...envPatch },
			};
			try {
				writeSettings(state.settingsFilePath, merged);
				applySettingsDiff(current, merged, applyContext);
				state.previousSettings = merged;
				notify(
					`Seeded ${Object.keys(envPatch).length} API key(s) from process.env into settings`,
					"info",
				);
			} catch (err) {
				notify(
					`Failed to seed env keys: ${(err as Error).message}`,
					"error",
				);
			}
		}
	}

	// 3b. Register the providers block on first load. The watcher only
	//     triggers on external file changes, so without this call the
	//     first LLM request would have no provider auth and would fall
	//     through to the env-var fallback. This makes the file's
	//     `providers` block the source of truth from the very first turn.
	applyInitialProviders(current.providers, applyContext);

	// 4. Start watcher. On external change → re-read → diff → apply.
	state.watcher = createWatcher(state.settingsFilePath, {
		debounceMs: 100,
		onChange: () => {
			handleWatcherChange(pi, ctx, notify);
		},
		onError: (err) => {
			notify(`Settings watcher error: ${err.message}`, "error");
		},
	});
	state.watcher.start();

	// 5. Initial catalog scan + sessions index.
	const workspaceRoot = dirname(workspace);
	const agentDir = join(workspaceRoot, ".pi", "agent");

	state.catalogScanner = createCatalogScanner({
		workspace,
		getSettings,
		setSettings: (s) => {
			const counter = writeSettings(state.settingsFilePath, s);
			state.watcher?.markSelfWrite();
			notify(`Settings written (writer #${counter})`, "info");
		},
		notify,
	});
	state.catalogScanner.refresh();

	state.sessionsIndexer = createSessionsIndexer({
		agentDir,
		workspace,
		settingsFilePath: state.settingsFilePath,
		getSettings,
		setSettings: (s) => {
			writeSettings(state.settingsFilePath, s);
			state.watcher?.markSelfWrite();
		},
		notify,
	});
	state.sessionsIndexer.refresh();

	// 6. Register tools.
	registerAllTools(pi);

	// 7. Subscribe to entry_appended for live sessions index updates.
	pi.on("entry_appended", (event) => {
		const e = event as unknown as { type: string; sessionId?: string; entryId?: string; timestamp?: string };
		state.sessionsIndexer?.onEntryAppended({
			type: e.type,
			sessionId: e.sessionId,
			entryId: e.entryId,
			timestamp: e.timestamp,
		});
	});

	// 8. (Optional) Register a slash command to force-rescan the catalog.
	pi.registerCommand("superhive-rescan", {
		description: "Rescan the catalog of skills/extensions/prompts and rebuild the sessions index.",
		handler: async (_args, _ctx) => {
			state.catalogScanner?.refresh();
			state.sessionsIndexer?.refresh();
		},
	});

	notify("superhive-pi-truth: settings file is the single source of truth", "info");
}

function handleWatcherChange(pi: ExtensionAPI, ctx: ExtensionContext, notify: (msg: string, level?: "info" | "warning" | "error") => void): void {
	let next: SettingsFile;
	try {
		const loaded = readSettings(state.settingsFilePath);
		if (!loaded) return;
		next = loaded;
	} catch (err) {
		notify(`Failed to re-read settings: ${(err as Error).message}`, "error");
		return;
	}

	const prev = state.previousSettings ?? next;
	if (writerCounter(next) <= writerCounter(prev)) {
		// Self-write or no-op change.
		state.previousSettings = next;
		return;
	}

	// Update in-memory state immediately so tools see the new value.
	// The write goes through the same atomic write + counter bump, so
	// the watcher will treat this as a self-write and skip.
	initState({ settingsFilePath: state.settingsFilePath, settings: next, notify });
	state.previousSettings = next;
	writeSettings(state.settingsFilePath, next);
	state.watcher?.markSelfWrite();

	// Apply the diff to the running session.
	applySettingsDiff(prev, next, applyContext).then((result) => {
		if (result.applied.length > 0) {
			notify(`Applied: ${result.applied.join(", ")}`, "info");
		}
		if (result.failed.length > 0) {
			for (const f of result.failed) {
				notify(`Failed: ${f.field} — ${f.reason}`, "warning");
			}
		}
		if (result.needsReload) {
			notify("Some changes require /reload to take full effect", "warning");
		}
	});
}

function teardown(): void {
	state.watcher?.stop();
	state.watcher = null;
	state.sessionsIndexer?.dispose();
	state.sessionsIndexer = null;
	state.catalogScanner?.dispose();
	state.catalogScanner = null;
	state.previousSettings = null;
	disposeState();
}

export default function superhivePiTruthExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await runExtension(pi, ctx);
		} catch (err) {
			ctx.ui.notify(`superhive-pi-truth failed to start: ${(err as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", () => {
		teardown();
	});
}
