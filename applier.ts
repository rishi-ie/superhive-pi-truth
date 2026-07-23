/**
 * Applier: diff → runtime API calls.
 *
 * Two diff entrypoints, one per truth file the agent mutates directly:
 *
 *   applySettingsDiff(prev, next) — reads settings.json
 *     Tier 1 (live-apply): model, thinkingLevel, env, providers, activeTools,
 *       permissions-driven tool exclusion.
 *     Tier 2 (store + reload-flag): UI flags (theme, hideThinkingBlock,
 *       etc.), advanced flags (shellPath, httpProxy, etc.), behavior knobs
 *       (autoCompaction, compaction, retry, ...).
 *
 *   applyManageDiff(prev, next) — reads manage.json
 *     Tier 1 (live-apply): permissions → setActiveTools exclusion.
 *     Tier 2 (store + reload-flag): skills / extensions / prompts /
 *       packages / themes path changes. Also surfaces a /reload flag when
 *       they change.
 *
 * The applier is best-effort: every step is wrapped in try/catch so a
 * single failed call doesn't break the rest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { apiForProvider } from "./provider-map.ts";
import type { ManageFile, SettingsFile } from "./settings-schema.ts";

const FILESYSTEM_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];
const TERMINAL_TOOLS = ["bash"];

const API_KEY_PATTERN = /_API_KEY$/;

/**
 * Operator-curated fallback context windows for providers whose models
 * Pi's bundled registry does not list.
 */
export const HARDCODED_CONTEXT_WINDOWS: Record<string, Record<string, number>> = {
	minimax: {
		"minimax-m3": 1_000_000,
		"minimax-m2.7": 1_000_000,
	},
};

export interface ApplyResult {
	needsReload: boolean;
	applied: string[];
	failed: Array<{ field: string; reason: string }>;
	reloadFields: string[];
}

export interface ApplyContext {
	pi: ExtensionAPI;
	hasUI: boolean;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	resolveContextWindow?: (
		provider: string,
		name: string,
	) => Promise<number | undefined>;
}

// ---------------------------------------------------------------------------
// applySettingsDiff — settings.json
// ---------------------------------------------------------------------------

export async function applySettingsDiff(
	prev: SettingsFile,
	next: SettingsFile,
	ctx: ApplyContext,
): Promise<ApplyResult> {
	const result: ApplyResult = { needsReload: false, applied: [], failed: [], reloadFields: [] };

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

	if (next.runtime?.thinkingLevel && next.runtime.thinkingLevel !== prev.runtime?.thinkingLevel) {
		try {
			ctx.pi.setThinkingLevel(next.runtime.thinkingLevel);
			result.applied.push("runtime.thinkingLevel");
		} catch (err) {
			result.failed.push({ field: "runtime.thinkingLevel", reason: (err as Error).message });
		}
	}

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

	// Note: permissions live in manage.json only. The applyManageDiff
	// path handles the Tier-1 activeTools exclusion. Nothing here.

	if (!shallowEqualRecord(prev.environment ?? {}, next.environment ?? {})) {
		try {
			applyEnvironment(next.environment ?? {}, prev.environment ?? {}, ctx);
			result.applied.push("environment");
		} catch (err) {
			result.failed.push({ field: "environment", reason: (err as Error).message });
		}
	}

	if (providersChanged(prev.providers ?? {}, next.providers ?? {})) {
		try {
			applyProviders(next.providers ?? {}, prev.providers ?? {}, ctx);
			result.applied.push("providers");
		} catch (err) {
			result.failed.push({ field: "providers", reason: (err as Error).message });
		}
	}

	if (
		prev.defaultProvider !== next.defaultProvider ||
		prev.defaultModel !== next.defaultModel ||
		prev.defaultThinkingLevel !== next.defaultThinkingLevel
	) {
		result.reloadFields.push("defaultProvider/defaultModel/defaultThinkingLevel");
	}

	const tier2Fields: Array<keyof SettingsFile> = [
		"theme", "hideThinkingBlock", "quietStartup", "doubleEscapeAction", "treeFilterMode",
		"showHardwareCursor", "editorPaddingX", "outputPad", "autocompleteMaxVisible",
		"markdown", "warnings",
		"defaultProjectTrust", "collapseChangelog", "enableInstallTelemetry",
		"enableAnalytics", "enableSkillCommands",
		"shellPath", "shellCommandPrefix", "npmCommand", "externalEditor",
		"transport", "sessionDir", "httpProxy", "httpIdleTimeoutMs",
		"websocketConnectTimeoutMs", "terminal", "images", "thinkingBudgets",
		"enabledModels",
	];
	for (const field of tier2Fields) {
		if (!deepEqual(prev[field], next[field])) {
			result.reloadFields.push(field);
		}
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
// applyManageDiff — manage.json
// ---------------------------------------------------------------------------

export async function applyManageDiff(
	prev: ManageFile,
	next: ManageFile,
	ctx: ApplyContext,
): Promise<ApplyResult> {
	const result: ApplyResult = { needsReload: false, applied: [], failed: [], reloadFields: [] };

	// Tier 1: permissions → activeTools exclusion
	if (permissionsChanged(prev.permissions, next.permissions)) {
		try {
			const excluded = computeExcludeToolsFromPermissions(next.permissions);
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

	// Tier 2: skills / extensions / prompts / packages / themes path changes
	if (!arraysEqual(prev.skills ?? [], next.skills ?? [])) result.reloadFields.push("skills");
	if (!arraysEqual(prev.extensions ?? [], next.extensions ?? [])) result.reloadFields.push("extensions");
	if (!arraysEqual(prev.prompts ?? [], next.prompts ?? [])) result.reloadFields.push("prompts");
	if (!arraysEqual(prev.packages ?? [], next.packages ?? [])) result.reloadFields.push("packages");
	if (!arraysEqual(prev.themes ?? [], next.themes ?? [])) result.reloadFields.push("themes");

	// Tier 2: behavior field changes (compaction/retry — need a reload to
	// be re-read by the runtime).
	if (!deepEqual(prev.behavior, next.behavior)) result.reloadFields.push("behavior");

	if (result.reloadFields.length > 0) {
		result.needsReload = true;
		if (ctx.hasUI) {
			ctx.notify(
				`Manage changed: ${result.reloadFields.join(", ")} require /reload.`,
				"warning",
			);
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Helpers (shared)
// ---------------------------------------------------------------------------

function modelChanged(a: SettingsFile["model"], b: SettingsFile["model"], ctx: ApplyContext): boolean {
	if (!b || !b.provider || !b.name) {
		ctx.notify("No model selected in settings", "warning");
		return false;
	}
	if (!a || a.provider !== b.provider || a.name !== b.name) return true;
	return false;
}

export async function applyModel(target: SettingsFile["model"], ctx: ApplyContext): Promise<boolean> {
	if (!target?.provider || !target.name) return false;
	const resolvedWindow = ctx.resolveContextWindow
		? await ctx.resolveContextWindow(target.provider, target.name)
		: undefined;
	const providerLc = target.provider.toLowerCase();
	const fallbackWindow = HARDCODED_CONTEXT_WINDOWS[providerLc]?.[target.name.toLowerCase()];
	const effectiveWindow =
		typeof resolvedWindow === "number" && resolvedWindow > 0
			? resolvedWindow
			: typeof fallbackWindow === "number" && fallbackWindow > 0
				? fallbackWindow
				: undefined;
	const model: Record<string, unknown> = {
		id: target.name,
		name: target.name,
		provider: target.provider,
		api: apiForProvider(target.provider),
		baseUrl: undefined,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	if (typeof effectiveWindow === "number") {
		model.contextWindow = effectiveWindow;
	}
	// biome-ignore lint/suspicious/noExplicitAny: fields are optional/partial for type compat
	return await ctx.pi.setModel(model as Model<any>);
}

function permissionsChanged(a: ManageFile["permissions"], b: ManageFile["permissions"]): boolean {
	if (!b) return false;
	if (!a) return true;
	return a.filesystem !== b.filesystem || a.terminal !== b.terminal || a.network !== b.network;
}

function computeExcludeToolsFromPermissions(permissions: ManageFile["permissions"] | undefined): string[] {
	const p = permissions ?? {};
	const excluded: string[] = [];
	if (p.filesystem === false) excluded.push(...FILESYSTEM_TOOLS);
	if (p.terminal === false) excluded.push(...TERMINAL_TOOLS);
	return Array.from(new Set(excluded));
}

function applyEnvironment(
	next: Record<string, string>,
	prev: Record<string, string>,
	ctx: ApplyContext,
): void {
	for (const key of Object.keys(prev)) {
		if (!(key in next)) {
			delete process.env[key];
		}
	}
	for (const [key, value] of Object.entries(next)) {
		process.env[key] = value;
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

function providersChanged(a: Record<string, { name?: string; baseUrl?: string | null; apiKey?: string }>, b: typeof a): boolean {
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
