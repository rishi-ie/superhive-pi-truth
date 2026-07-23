/**
 * superhive-pi-truth extension entry point.
 *
 * On `session_start`:
 *   1. Resolve the four truth file paths under `<agentDir>`:
 *      settings.json, manage.json, overview.json, inbox.json.
 *   2. Check for a legacy `Superhive-pi-{foldername}.json`. If present
 *      and none of the four files exist, run the one-shot migrator
 *      (split the legacy blob across the four files, then delete the
 *      legacy file).
 *   3. Read + validate each file. Seed with defaults if missing.
 *   4. Init the four-slot state singleton.
 *   5. Sync project name/description from manage.json into overview.json
 *      (so the right-sidebar Overview tab doesn't drift from the source
 *      block in manage.json).
 *   6. Surface inherited *_API_KEY env vars into settings.json.
 *   7. Register initial providers from settings.json.
 *   8. Start four watchers; on external change → re-read → diff → apply.
 *   9. Apply the model from settings.json.
 *  10. Initial catalog scan + sessions index.
 *  11. Register all 13 agent-callable tools.
 *  12. Subscribe to entry_appended to keep the sessions index fresh.
 *
 * On `session_shutdown`: tear down the watchers + indexers, dispose state.
 *
 * The extension never reads from `manifest.json` directly — that's the
 * launcher's job. This extension is downstream of `--manifest`.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyInitialProviders,
	applyManageDiff,
	applyModel,
	applySettingsDiff,
	type ApplyContext,
} from "./applier.ts";
import { createCatalogScanner } from "./catalog-scanner.ts";
import {
	CASCADE_CONFIG,
	cascadeManageToExtensions,
	cascadeOrchFileIntoSettings,
} from "./cascade.ts";
import { clearChecklist } from "./checklist.ts";
import {
	readInbox,
	readManage,
	readOverview,
	readSettings,
	writeInbox,
	writeManage,
	writeOverview,
	writeSettings,
} from "./file-io.ts";
import { orchestrationExtensionPathFor } from "./settings-schema.ts";
import { createSessionsIndexer } from "./sessions-indexer.ts";
import {
	DEFAULT_INBOX,
	DEFAULT_MANAGE,
	DEFAULT_OVERVIEW,
	DEFAULT_SETTINGS,
	migrateLegacyToFour,
	truthPathsForAgentDir,
	type InboxFile,
	type ManageFile,
	type OverviewFile,
	type SettingsFile,
} from "./settings-schema.ts";
import {
	disposeState,
	getAllPaths,
	initState,
	reloadCaches,
} from "./state.ts";
import { registerAllTools } from "./tools.ts";
import { createWatcher, type Watcher } from "./watcher.ts";

interface FourFiles {
	settings: SettingsFile;
	manage: ManageFile;
	overview: OverviewFile;
	inbox: InboxFile;
}

interface RuntimeState {
	paths: ReturnType<typeof truthPathsForAgentDir>;
	watchers: {
		settings: Watcher | null;
		manage: Watcher | null;
		overview: Watcher | null;
		inbox: Watcher | null;
		orchestration: Watcher | null;
	};
	sessionsIndexer: ReturnType<typeof createSessionsIndexer> | null;
	catalogScanner: ReturnType<typeof createCatalogScanner> | null;
	previous: FourFiles;
}

const state: RuntimeState = {
	paths: { settings: "", manage: "", overview: "", inbox: "", legacy: "" },
	watchers: { settings: null, manage: null, overview: null, inbox: null, orchestration: null },
	sessionsIndexer: null,
	catalogScanner: null,
	previous: { settings: DEFAULT_SETTINGS, manage: DEFAULT_MANAGE, overview: DEFAULT_OVERVIEW, inbox: DEFAULT_INBOX },
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

// ---------------------------------------------------------------------------
// File loading + seeding + legacy migration
// ---------------------------------------------------------------------------

function seedSettings(): SettingsFile {
	return {
		...structuredClone(DEFAULT_SETTINGS),
		managedBy: "superhive-pi-truth@1#0",
		lastModified: new Date().toISOString(),
	};
}

function seedManage(): ManageFile {
	return {
		...structuredClone(DEFAULT_MANAGE),
		managedBy: "superhive-pi-truth@1#0",
		lastModified: new Date().toISOString(),
	};
}

function seedOverview(): OverviewFile {
	return {
		...structuredClone(DEFAULT_OVERVIEW),
		managedBy: "superhive-pi-truth@1#0",
		lastModified: new Date().toISOString(),
	};
}

function seedInbox(): InboxFile {
	return {
		...structuredClone(DEFAULT_INBOX),
		managedBy: "superhive-pi-truth@1#0",
		lastModified: new Date().toISOString(),
	};
}

/**
 * Mirror manage.json's project block into overview.json. Returns the
 * synced OverviewFile if anything changed, null otherwise.
 */
function syncOverviewFromManage(manage: ManageFile, overview: OverviewFile): OverviewFile | null {
	let next: OverviewFile | null = null;
	if (manage.project) {
		if (manage.project.name !== overview.name) {
			next ??= { ...overview };
			next.name = manage.project.name;
		}
		if (manage.project.description !== overview.description) {
			next ??= { ...overview };
			next.description = manage.project.description;
		}
	}
	if (!manage.project && manage.identity) {
		if (manage.identity.name && !overview.name) {
			next ??= { ...overview };
			next.name = manage.identity.name;
		}
		if (manage.identity.description && !overview.description) {
			next ??= { ...overview };
			next.description = manage.identity.description;
		}
	}
	return next;
}

/**
 * Load the four truth files: legacy migration if needed, otherwise
 * per-file read+validate+seed. Always returns a complete FourFiles.
 */
function loadFourFiles(
	paths: RuntimeState["paths"],
	notify: ReturnType<typeof makeNotifier>,
): FourFiles {
	const allNew =
		existsSync(paths.settings) &&
		existsSync(paths.manage) &&
		existsSync(paths.overview) &&
		existsSync(paths.inbox);

	if (!allNew && existsSync(paths.legacy)) {
		try {
			const raw = readFileSync(paths.legacy, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const migrated = migrateLegacyToFour(parsed);
			writeSettings(paths.settings, migrated.settings);
			writeManage(paths.manage, migrated.manage);
			writeOverview(paths.overview, migrated.overview);
			writeInbox(paths.inbox, migrated.inbox);
			try {
				unlinkSync(paths.legacy);
			} catch {
				// best-effort cleanup
			}
			notify("Migrated legacy settings file to settings.json + manage.json + overview.json + inbox.json", "info");
			return migrated;
		} catch (err) {
			notify(`Legacy migration failed; falling back to per-file defaults: ${(err as Error).message}`, "warning");
		}
	}

	const settings = existsSync(paths.settings)
		? readSettings(paths.settings) ?? seedSettings()
		: seedAndWrite(paths.settings, seedSettings, writeSettings, notify, "settings.json");
	const manage = existsSync(paths.manage)
		? readManage(paths.manage) ?? seedManage()
		: seedAndWrite(paths.manage, seedManage, writeManage, notify, "manage.json");
	const overview = existsSync(paths.overview)
		? readOverview(paths.overview) ?? seedOverview()
		: seedAndWrite(paths.overview, seedOverview, writeOverview, notify, "overview.json");
	const inbox = existsSync(paths.inbox)
		? readInbox(paths.inbox) ?? seedInbox()
		: seedAndWrite(paths.inbox, seedInbox, writeInbox, notify, "inbox.json");

	return { settings, manage, overview, inbox };
}

function seedAndWrite<T extends { managedBy?: string }>(
	path: string,
	seed: () => T,
	write: (path: string, file: T) => number,
	notify: ReturnType<typeof makeNotifier>,
	label: string,
): T {
	const file = seed();
	write(path, file);
	notify(`Seeded ${label}`, "info");
	return file;
}

// ---------------------------------------------------------------------------
// Watcher change handlers
// ---------------------------------------------------------------------------

function handleSettingsWatcher(pi: ExtensionAPI, applyContext: ApplyContext, notify: ReturnType<typeof makeNotifier>): void {
	const paths = getAllPaths();
	let next: SettingsFile;
	try {
		const loaded = readSettings(paths.settings);
		if (!loaded) return;
		next = loaded;
	} catch (err) {
		notify(`Failed to re-read settings.json: ${(err as Error).message}`, "error");
		return;
	}

	const prev = state.previous.settings;
	const prevCounter = Number(/(\d+)$/.exec(prev.managedBy ?? "")?.[1] ?? "0");
	const nextCounter = Number(/(\d+)$/.exec(next.managedBy ?? "")?.[1] ?? "0");
	if (nextCounter <= prevCounter) {
		state.previous.settings = next;
		return;
	}

	// Apply the diff and bump the in-memory state.
	applySettingsDiff(prev, next, applyContext).then((result) => {
		reportApplyResult(result, "settings.json", notify);
	});
	state.previous.settings = next;
	reloadCaches({ settings: next, manage: state.previous.manage, overview: state.previous.overview, inbox: state.previous.inbox });
	writeSettings(paths.settings, next);
	state.watchers.settings?.markSelfWrite();
	if (pi) {
		// Apply model if it changed.
		try {
			void applyModel(next.model, applyContext);
		} catch {
			// ignored — applyModel reports its own failures via notify.
		}
	}
}

function handleManageWatcher(pi: ExtensionAPI, applyContext: ApplyContext, notify: ReturnType<typeof makeNotifier>): void {
	const paths = getAllPaths();
	let next: ManageFile;
	try {
		const loaded = readManage(paths.manage);
		if (!loaded) return;
		next = loaded;
	} catch (err) {
		notify(`Failed to re-read manage.json: ${(err as Error).message}`, "error");
		return;
	}

	const prev = state.previous.manage;
	const prevCounter = Number(/(\d+)$/.exec(prev.managedBy ?? "")?.[1] ?? "0");
	const nextCounter = Number(/(\d+)$/.exec(next.managedBy ?? "")?.[1] ?? "0");
	if (nextCounter <= prevCounter) {
		state.previous.manage = next;
		return;
	}

	applyManageDiff(prev, next, applyContext).then((result) => {
		reportApplyResult(result, "manage.json", notify);
	});
	state.previous.manage = next;

	// Sync overview from manage when project fields changed.
	const synced = syncOverviewFromManage(next, state.previous.overview);
	if (synced) {
		const counter = writeOverview(paths.overview, synced);
		state.watchers.overview?.markSelfWrite();
		state.previous.overview = synced;
		notify(`Synced overview.json from manage.json (writer #${counter})`, "info");
	}

	reloadCaches({ settings: state.previous.settings, manage: next, overview: state.previous.overview, inbox: state.previous.inbox });
	writeManage(paths.manage, next);
	state.watchers.manage?.markSelfWrite();

	// Cascades: project manage.json's managed knobs into each per-extension
	// file's own slot. Bound to the manage watcher so it fires on every
	// externally-driven write (~30 ms after the file settles).
	void cascadeManageToExtensions(dirname(paths.settings));
}

function handleOverviewWatcher(notify: ReturnType<typeof makeNotifier>): void {
	const paths = getAllPaths();
	let next: OverviewFile;
	try {
		const loaded = readOverview(paths.overview);
		if (!loaded) return;
		next = loaded;
	} catch (err) {
		notify(`Failed to re-read overview.json: ${(err as Error).message}`, "error");
		return;
	}
	const prev = state.previous.overview;
	const prevCounter = Number(/(\d+)$/.exec(prev.managedBy ?? "")?.[1] ?? "0");
	const nextCounter = Number(/(\d+)$/.exec(next.managedBy ?? "")?.[1] ?? "0");
	if (nextCounter <= prevCounter) {
		state.previous.overview = next;
		return;
	}
	state.previous.overview = next;
	reloadCaches({ settings: state.previous.settings, manage: state.previous.manage, overview: next, inbox: state.previous.inbox });
	writeOverview(paths.overview, next);
	state.watchers.overview?.markSelfWrite();
}

function handleInboxWatcher(notify: ReturnType<typeof makeNotifier>): void {
	const paths = getAllPaths();
	let next: InboxFile;
	try {
		const loaded = readInbox(paths.inbox);
		if (!loaded) return;
		next = loaded;
	} catch (err) {
		notify(`Failed to re-read inbox.json: ${(err as Error).message}`, "error");
		return;
	}
	const prev = state.previous.inbox;
	const prevCounter = Number(/(\d+)$/.exec(prev.managedBy ?? "")?.[1] ?? "0");
	const nextCounter = Number(/(\d+)$/.exec(next.managedBy ?? "")?.[1] ?? "0");
	if (nextCounter <= prevCounter) {
		state.previous.inbox = next;
		return;
	}
	state.previous.inbox = next;
	reloadCaches({ settings: state.previous.settings, manage: state.previous.manage, overview: state.previous.overview, inbox: next });
	writeInbox(paths.inbox, next);
	state.watchers.inbox?.markSelfWrite();
}

/**
 * Out-cascade: when the orch file's `systemPrompt` changes (the orch
 * extension wrote a new CEO prompt or member role fragment), mirror it
 * into settings.json (which is what the Pi runtime actually reads). The
 * watcher only exists if the orch ext has bootstrapped at least once.
 */
function handleOrchestrationWatcher(notify: ReturnType<typeof makeNotifier>): void {
	const agentDir = dirname(getAllPaths().settings);
	void cascadeOrchFileIntoSettings(agentDir).catch(err => {
		notify(`orchestration→settings cascade failed: ${(err as Error).message}`, "warning");
	});
}

function reportApplyResult(
	result: { applied: string[]; failed: Array<{ field: string; reason: string }>; needsReload: boolean },
	label: string,
	notify: ReturnType<typeof makeNotifier>,
): void {
	if (result.applied.length > 0) notify(`[${label}] Applied: ${result.applied.join(", ")}`, "info");
	for (const f of result.failed) {
		notify(`[${label}] Failed: ${f.field} — ${f.reason}`, "warning");
		try {
			process.stderr.write(`[superhive-pi-truth] apply failed: ${f.field} — ${f.reason}\n`);
		} catch {
			// ignore
		}
	}
	if (result.needsReload) notify(`${label}: some changes require /reload`, "warning");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function runExtension(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const workspace = ctx.cwd;
	const paths = truthPathsForAgentDir(dirname(workspace));
	state.paths = paths;

	const notify = makeNotifier(ctx);

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
			const providerLc = provider.toLowerCase();
			const nameLc = name.toLowerCase();
			const match = catalog.find(
				m => m.provider.toLowerCase() === providerLc && m.id.toLowerCase() === nameLc,
			);
			return match?.contextWindow;
		} catch (err) {
			notify(`resolveContextWindow failed: ${(err as Error).message}`, "warning");
			return undefined;
		}
	};

	const applyContext: ApplyContext = { pi, hasUI: ctx.hasUI, notify, resolveContextWindow };

	// 1. Load (or seed + migrate) the four truth files.
	const four = loadFourFiles(paths, notify);

	// 2. Sync overview.json from manage.json.
	const syncedOverview = syncOverviewFromManage(four.manage, four.overview);
	if (syncedOverview) {
		writeOverview(paths.overview, syncedOverview);
		state.watchers.overview?.markSelfWrite();
		four.overview = syncedOverview;
		notify("Synced overview.json from manage.json", "info");
	}

	state.previous = four;

	// 3. Init the four-slot state singleton.
	initState({
		settingsFilePath: paths.settings,
		manageFilePath: paths.manage,
		overviewFilePath: paths.overview,
		inboxFilePath: paths.inbox,
		settings: four.settings,
		manage: four.manage,
		overview: four.overview,
		inbox: four.inbox,
		notify,
	});

	// 4. First-launch env migration into settings.json.
	{
		const envPatch: Record<string, string> = {};
		const currentEnv = four.settings.environment ?? {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v && typeof v === "string" && /_API_KEY$/.test(k) && !currentEnv[k]) envPatch[k] = v;
		}
		if (Object.keys(envPatch).length > 0) {
			const merged: SettingsFile = {
				...four.settings,
				environment: { ...currentEnv, ...envPatch },
			};
			const counter = writeSettings(paths.settings, merged);
			state.watchers.settings?.markSelfWrite();
			state.previous.settings = merged;
			four.settings = merged;
			notify(`Seeded ${Object.keys(envPatch).length} API key(s) from process.env into settings.json (writer #${counter})`, "info");
		}
	}

	// 5. Register initial providers from settings.json.
	applyInitialProviders(four.settings.providers, applyContext);

	// 6. Watchers — one per file.
	const settingsWatcher = createWatcher(paths.settings, {
		debounceMs: 100,
		onChange: () => handleSettingsWatcher(pi, applyContext, notify),
		onError: err => notify(`settings.json watcher error: ${err.message}`, "error"),
	});
	settingsWatcher.start();
	state.watchers.settings = settingsWatcher;

	const manageWatcher = createWatcher(paths.manage, {
		debounceMs: 100,
		onChange: () => handleManageWatcher(pi, applyContext, notify),
		onError: err => notify(`manage.json watcher error: ${err.message}`, "error"),
	});
	manageWatcher.start();
	state.watchers.manage = manageWatcher;

	const overviewWatcher = createWatcher(paths.overview, {
		debounceMs: 100,
		onChange: () => handleOverviewWatcher(notify),
		onError: err => notify(`overview.json watcher error: ${err.message}`, "error"),
	});
	overviewWatcher.start();
	state.watchers.overview = overviewWatcher;

	const inboxWatcher = createWatcher(paths.inbox, {
		debounceMs: 100,
		onChange: () => handleInboxWatcher(notify),
		onError: err => notify(`inbox.json watcher error: ${err.message}`, "error"),
	});
	inboxWatcher.start();
	state.watchers.inbox = inboxWatcher;

	// Orch extension file watcher — only starts if the file exists
	// (orch ext may not be loaded for this agent). Drives the
	// out-cascade (orchestration.systemPrompt → settings.json).
	const orchestrationPath = orchestrationExtensionPathFor(agentRoot);
	if (existsSync(orchestrationPath)) {
		const orchWatcher = createWatcher(orchestrationPath, {
			debounceMs: 100,
			onChange: () => handleOrchestrationWatcher(notify),
			onError: err => notify(`superhive-pi-orchestration.json watcher error: ${err.message}`, "error"),
		});
		orchWatcher.start();
		state.watchers.orchestration = orchWatcher;
	}

	// 7. Apply the session model from settings.json.
	if (four.settings.model?.provider && four.settings.model.name) {
		void applyModel(
			{ provider: four.settings.model.provider, name: four.settings.model.name },
			applyContext,
		);
	}

	// 8. Initial catalog scan + sessions index (writes back to settings.json).
	const agentDir = agentRoot;
	state.catalogScanner = createCatalogScanner({
		workspace,
		getSettings: () => state.previous.settings,
		setSettings: (s) => {
			writeSettings(paths.settings, s);
			state.watchers.settings?.markSelfWrite();
			state.previous.settings = s;
		},
		getManage: () => state.previous.manage,
		notify,
	});
	state.catalogScanner.refresh();

	state.sessionsIndexer = createSessionsIndexer({
		agentDir,
		workspace,
		settingsFilePath: paths.settings,
		getSettings: () => state.previous.settings,
		setSettings: (s) => {
			writeSettings(paths.settings, s);
			state.watchers.settings?.markSelfWrite();
			state.previous.settings = s;
		},
		notify,
	});
	state.sessionsIndexer.refresh();

	// 9. Register the 13 tools.
	registerAllTools(pi);

	// 10. Subscribe to entry_appended for live sessions index updates.
	pi.on("entry_appended", (event) => {
		const e = event as unknown as { type: string; sessionId?: string; entryId?: string; timestamp?: string };
		state.sessionsIndexer?.onEntryAppended({
			type: e.type,
			sessionId: e.sessionId,
			entryId: e.entryId,
			timestamp: e.timestamp,
		});
	});

	// 11. Slash command to force rescan.
	pi.registerCommand("superhive-rescan", {
		description: "Rescan the catalog of skills/extensions/prompts and rebuild the sessions index.",
		handler: async (_args, _ctx) => {
			state.catalogScanner?.refresh();
			state.sessionsIndexer?.refresh();
		},
	});

	notify("superhive-pi-truth: 4-file split active (settings.json / manage.json / overview.json / inbox.json)", "info");
}

function teardown(): void {
	state.watchers.settings?.stop();
	state.watchers.manage?.stop();
	state.watchers.overview?.stop();
	state.watchers.inbox?.stop();
	state.watchers.orchestration?.stop();
	state.watchers = { settings: null, manage: null, overview: null, inbox: null, orchestration: null };
	state.sessionsIndexer?.dispose();
	state.sessionsIndexer = null;
	state.catalogScanner?.dispose();
	state.catalogScanner = null;
	state.previous = { settings: DEFAULT_SETTINGS, manage: DEFAULT_MANAGE, overview: DEFAULT_OVERVIEW, inbox: DEFAULT_INBOX };
	clearChecklist();
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
