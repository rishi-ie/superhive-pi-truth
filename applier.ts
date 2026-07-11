/**
 * Applier: diff → runtime API calls.
 *
 * Compares the previous and current settings, then applies the diff into the
 * running Pi session:
 *
 *   Tier 1 (live-apply): model, thinking level, env, providers, tools,
 *     permissions, active tools. Pushes into the session immediately.
 *
 *   Tier 2 (store + reload-flag): UI flags (theme, hideThinkingBlock, etc.),
 *     advanced (shellPath, httpProxy, etc.), telemetry, keybindings. Stored
 *     in the file and applied on the next `/reload` (Pi built-in). The
 *     applier sets a `pendingReload: true` flag and surfaces a UI notification.
 *
 *   Tier 3 (store only): fields the agent doesn't mutate (catalog,
 *     sessionsIndex, lastEvent). Written but never applied — they're
 *     extension-generated, external-read.
 *
 * The applier is best-effort: every step is wrapped in try/catch so a single
 * failed call (e.g. setModel with missing API key) doesn't break the rest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { apiForProvider } from "./provider-map.ts";
import type { SettingsFile } from "./settings-schema.ts";

const FILESYSTEM_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];
const TERMINAL_TOOLS = ["bash"];

const API_KEY_PATTERN = /_API_KEY$/;

export interface ApplyResult {
	/** True if any Tier 2 fields changed and a reload is required. */
	needsReload: boolean;
	/** Names of Tier 1 fields that were applied. */
	applied: string[];
	/** Names of fields that failed to apply (with reason). */
	failed: Array<{ field: string; reason: string }>;
	/** Names of Tier 2 fields that require a reload. */
	reloadFields: string[];
}

export interface ApplyContext {
	pi: ExtensionAPI;
	hasUI: boolean;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

/**
 * Apply the diff between `prev` and `next` into the running session.
 */
export async function applySettingsDiff(
	prev: SettingsFile,
	next: SettingsFile,
	ctx: ApplyContext,
): Promise<ApplyResult> {
	const result: ApplyResult = { needsReload: false, applied: [], failed: [], reloadFields: [] };

	// --- Tier 1: model ---
	if (modelChanged(prev.model, next.model, ctx)) {
		try {
			const ok = await applyModel(next.model, ctx);
			if (ok) {
				result.applied.push("model");
			} else {
				result.failed.push({ field: "model", reason: "No API key for that model" });
			}
		} catch (err) {
			result.failed.push({ field: "model", reason: (err as Error).message });
		}
	}

	// --- Tier 1: thinking level ---
	if (next.runtime?.thinkingLevel && next.runtime.thinkingLevel !== prev.runtime?.thinkingLevel) {
		try {
			ctx.pi.setThinkingLevel(next.runtime.thinkingLevel);
			result.applied.push("runtime.thinkingLevel");
		} catch (err) {
			result.failed.push({ field: "runtime.thinkingLevel", reason: (err as Error).message });
		}
	}

	// --- Tier 1: active tools (from runtime.activeTools) ---
	if (
		next.runtime?.activeTools &&
		!arraysEqual(next.runtime.activeTools, prev.runtime?.activeTools ?? [])
	) {
		try {
			ctx.pi.setActiveTools(next.runtime.activeTools);
			result.applied.push("runtime.activeTools");
		} catch (err) {
			result.failed.push({ field: "runtime.activeTools", reason: (err as Error).message });
		}
	}

	// --- Tier 1: permissions (recompute excludeTools + setActiveTools) ---
	if (permissionsChanged(prev.permissions, next.permissions)) {
		try {
			const excluded = computeExcludeTools(next);
			const current = ctx.pi.getActiveTools();
			const filtered = current.filter((t) => !excluded.includes(t));
			if (filtered.length !== current.length) {
				ctx.pi.setActiveTools(filtered);
			}
			result.applied.push("permissions");
		} catch (err) {
			result.failed.push({ field: "permissions", reason: (err as Error).message });
		}
	}

	// --- Tier 1: environment ---
	if (!shallowEqualRecord(prev.environment ?? {}, next.environment ?? {})) {
		try {
			applyEnvironment(next.environment ?? {}, prev.environment ?? {}, ctx);
			result.applied.push("environment");
		} catch (err) {
			result.failed.push({ field: "environment", reason: (err as Error).message });
		}
	}

	// --- Tier 1: providers ---
	if (providersChanged(prev.providers ?? {}, next.providers ?? {})) {
		try {
			applyProviders(next.providers ?? {}, prev.providers ?? {}, ctx);
			result.applied.push("providers");
		} catch (err) {
			result.failed.push({ field: "providers", reason: (err as Error).message });
		}
	}

	// --- Tier 1: defaultProvider / defaultModel / defaultThinkingLevel ---
	// These flow through SettingsManager. ExtensionAPI doesn't expose direct
	// setters, but the settings manager will pick them up on the next reload.
	// We track them as Tier 2 so the reload flag is set when they change.
	if (
		prev.defaultProvider !== next.defaultProvider ||
		prev.defaultModel !== next.defaultModel ||
		prev.defaultThinkingLevel !== next.defaultThinkingLevel
	) {
		result.reloadFields.push("defaultProvider/defaultModel/defaultThinkingLevel");
	}

	// --- Tier 2 detection: any of these fields changing → needs reload ---
	const tier2Fields: Array<keyof SettingsFile> = [
		"theme",
		"hideThinkingBlock",
		"quietStartup",
		"doubleEscapeAction",
		"treeFilterMode",
		"showHardwareCursor",
		"editorPaddingX",
		"outputPad",
		"autocompleteMaxVisible",
		"markdown",
		"warnings",
		"defaultProjectTrust",
		"collapseChangelog",
		"enableInstallTelemetry",
		"enableAnalytics",
		"enableSkillCommands",
		"shellPath",
		"shellCommandPrefix",
		"npmCommand",
		"externalEditor",
		"transport",
		"sessionDir",
		"httpProxy",
		"httpIdleTimeoutMs",
		"websocketConnectTimeoutMs",
		"terminal",
		"images",
		"thinkingBudgets",
		"steeringMode",
		"followUpMode",
		"autoCompaction",
		"autoRetry",
		"compaction",
		"branchSummary",
		"retry",
		"enabledModels",
	];
	for (const field of tier2Fields) {
		if (!deepEqual(prev[field], next[field])) {
			result.reloadFields.push(field);
		}
	}

	// --- Tier 2: skills / extensions / prompts (path add/remove) ---
	if (!arraysEqual(prev.skills ?? [], next.skills ?? [])) {
		result.reloadFields.push("skills");
	}
	if (!arraysEqual(prev.extensions ?? [], next.extensions ?? [])) {
		result.reloadFields.push("extensions");
	}
	if (!arraysEqual(prev.prompts ?? [], next.prompts ?? [])) {
		result.reloadFields.push("prompts");
	}
	if (!arraysEqual(prev.packages ?? [], next.packages ?? [])) {
		result.reloadFields.push("packages");
	}
	if (!arraysEqual(prev.themes ?? [], next.themes ?? [])) {
		result.reloadFields.push("themes");
	}

	if (result.reloadFields.length > 0) {
		result.needsReload = true;
		if (ctx.hasUI) {
			ctx.notify(
				`Settings changed: ${result.reloadFields.length} field(s) need a /reload: ${result.reloadFields.slice(0, 5).join(", ")}${result.reloadFields.length > 5 ? "..." : ""}`,
				"warning",
			);
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modelChanged(a: SettingsFile["model"], b: SettingsFile["model"], ctx: ApplyContext): boolean {
	if (!b || !b.provider || !b.name) {
		// Empty model: do not apply, but warn the user that no model is selected.
		// Without this notification, the UI guard ("Pick a model first") is the
		// only signal and the agent quietly falls through to the env-var fallback.
		ctx.notify("No model selected in settings", "warning");
		return false;
	}
	if (!a || a.provider !== b.provider || a.name !== b.name) return true;
	return false;
}

async function applyModel(target: SettingsFile["model"], ctx: ApplyContext): Promise<boolean> {
	if (!target?.provider || !target.name) return false;
	// Use the public ExtensionAPI to look up the model
	// The model registry isn't directly exposed, so we use a well-known shape
	// and call setModel with a typed Model object.
	// The `api` field must match the provider's wire protocol — derive it
	// from the provider name via the shared lookup table.
	const model: Model<any> = {
		id: target.name,
		name: target.name,
		provider: target.provider,
		// biome-ignore lint/suspicious/noExplicitAny: Model is generic over Api; we don't constrain here
		api: apiForProvider(target.provider) as any,
		baseUrl: undefined,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
		// biome-ignore lint/suspicious/noExplicitAny: fields are optional/partial for type compat
	} as any;
	return await ctx.pi.setModel(model);
}

function permissionsChanged(a: SettingsFile["permissions"], b: SettingsFile["permissions"]): boolean {
	if (!b) return false;
	if (!a) return true;
	return a.filesystem !== b.filesystem || a.terminal !== b.terminal || a.network !== b.network;
}

function computeExcludeTools(s: SettingsFile): string[] {
	const permissions = s.permissions ?? {};
	const excluded: string[] = [];
	if (permissions.filesystem === false) excluded.push(...FILESYSTEM_TOOLS);
	if (permissions.terminal === false) excluded.push(...TERMINAL_TOOLS);
	return Array.from(new Set(excluded));
}

function applyEnvironment(
	next: Record<string, string>,
	prev: Record<string, string>,
	ctx: ApplyContext,
): void {
	// Remove keys that no longer exist
	for (const key of Object.keys(prev)) {
		if (!(key in next)) {
			delete process.env[key];
		}
	}
	// Add/update keys
	for (const [key, value] of Object.entries(next)) {
		process.env[key] = value;
		// If it looks like an API key, also push into the active provider auth.
		// The provider name is derived from the env var: strip _API_KEY and
		// lower-case it (e.g. ANTHROPIC_API_KEY -> anthropic).
		if (API_KEY_PATTERN.test(key)) {
			const provider = key.slice(0, -"_API_KEY".length).toLowerCase();
			try {
				ctx.pi.registerProvider(provider, { apiKey: value });
			} catch (err) {
				ctx.notify(`Failed to register provider ${provider}: ${(err as Error).message}`, "warning");
			}
		}
	}
}

function providersChanged(a: Record<string, SettingsFile["providers"] extends string ? never : any>, b: typeof a): boolean {
	return !deepEqual(a, b);
}

function applyProviders(
	next: Record<string, { name?: string; baseUrl?: string | null; apiKey?: string }>,
	_prev: typeof next,
	ctx: ApplyContext,
): void {
	for (const [name, config] of Object.entries(next)) {
		try {
			ctx.pi.registerProvider(name, {
				name: config.name,
				baseUrl: config.baseUrl ?? undefined,
				apiKey: config.apiKey,
			});
		} catch (err) {
			ctx.notify(`Failed to register provider ${name}: ${(err as Error).message}`, "warning");
		}
	}
}

/**
 * Initial-load provider registration. Called once on `session_start` after the
 * settings file is loaded, so that the `providers` block in the file becomes
 * the source of truth for `pi.registerProvider` from the very first turn.
 *
 * The watcher-driven `applySettingsDiff` only fires on external file changes,
 * so without this call the first LLM request would have no provider auth
 * (the model-resolver would fall back to env-var keys from `.env.local`).
 */
export function applyInitialProviders(
	providers: Record<string, { name?: string; baseUrl?: string | null; apiKey?: string }> | undefined,
	ctx: ApplyContext,
): void {
	applyProviders(providers ?? {}, {}, ctx);
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function shallowEqualRecord(a: Record<string, string>, b: Record<string, string>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) {
		if (a[k] !== b[k]) return false;
	}
	return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) {
		if (!deepEqual(aObj[k], bObj[k])) return false;
	}
	return true;
}
