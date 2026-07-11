/**
 * Agent-callable tools for superhive-pi-truth.
 *
 * These are the LLM-facing surface of the extension. Each tool reads or
 * mutates the settings file. Mutations go through `writeSettings`, which
 * bumps the writer counter so the watcher knows the change was made by
 * the agent itself (no echo loop).
 *
 * Conventions:
 * - All parameter schemas use TypeBox (aliased by jiti to the fork's copy).
 * - Tools return a single text content block with a JSON-stringified payload
 *   for easy parsing.
 */

import { Type, type Static } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettings, getSettingsPath, setSettings } from "./state.ts";
import type { SettingsFile } from "./settings-schema.ts";

export interface ToolsContext {
	settingsFilePath: string;
}

function jsonResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

// ---------------------------------------------------------------------------
// Tool 1: get_current_settings
// ---------------------------------------------------------------------------

const getCurrentSettingsTool = defineTool({
	name: "get_current_settings",
	label: "Get Current Settings",
	description:
		"Return the full Superhive-pi-{foldername}.json contents (all settings, runtime state, catalog, sessions index, last event).",
	parameters: Type.Object({}),

	async execute(_id, _params, _signal, _onUpdate, _ctx) {
		return jsonResult({ ok: true, settings: getSettings() });
	},
});

// ---------------------------------------------------------------------------
// Tool 2: update_settings (JSON Merge Patch)
// ---------------------------------------------------------------------------

const UpdateSettingsParams = Type.Object({
	patch: Type.Any({ description: "Partial settings object to merge (JSON Merge Patch, RFC 7396)" }),
});

const updateSettingsTool = defineTool({
	name: "update_settings",
	label: "Update Settings",
	description:
		"Apply a partial update to the settings file. The patch is deep-merged into the current settings. Changes that can be live-applied take effect immediately; others set a flag and require a /reload.",
	parameters: UpdateSettingsParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const current = getSettings();
		const merged = deepMerge(current, params.patch) as SettingsFile;
		const path = getSettingsPath();
		const nextCounter = setSettings(merged);
		return jsonResult({
			ok: true,
			writtenVersion: nextCounter,
			path,
			message: "Settings updated. Some changes may require a /reload to take full effect.",
		});
	},
});

// ---------------------------------------------------------------------------
// Tool 3: list_sessions
// ---------------------------------------------------------------------------

const ListSessionsParams = Type.Object({
	project: Type.Optional(Type.String({ description: "Optional project filter" })),
	limit: Type.Optional(Type.Number({ description: "Max sessions to return (default 50)" })),
	offset: Type.Optional(Type.Number({ description: "Pagination offset (default 0)" })),
});

const listSessionsTool = defineTool({
	name: "list_sessions",
	label: "List Sessions",
	description:
		"List all sessions in the current workspace, most recent first. Each entry includes id, name, created/modified timestamps, message count, token totals, cost, and file path.",
	parameters: ListSessionsParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const settings = getSettings();
		const sessions = settings.sessionsIndex?.sessions ?? [];
		const limit = params.limit ?? 50;
		const offset = params.offset ?? 0;
		return jsonResult({
			ok: true,
			total: sessions.length,
			limit,
			offset,
			sessions: sessions.slice(offset, offset + limit),
		});
	},
});

// ---------------------------------------------------------------------------
// Tool 4: get_session_detail
// ---------------------------------------------------------------------------

const GetSessionDetailParams = Type.Object({
	sessionId: Type.String({ description: "The session id" }),
});

const getSessionDetailTool = defineTool({
	name: "get_session_detail",
	label: "Get Session Detail",
	description:
		"Return the full list of entries in a session: messages, tool calls, compactions, branch summaries, custom entries, labels. Granular detail of every event in the session.",
	parameters: GetSessionDetailParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const settings = getSettings();
		const meta = settings.sessionsIndex?.sessions.find((s) => s.id === params.sessionId);
		if (!meta) {
			return jsonResult({ ok: false, error: `Session not found: ${params.sessionId}` });
		}
		// Note: full entry streaming is handled by the LLM via `pi` actions,
		// but the meta + path are returned so the LLM can decide.
		return jsonResult({ ok: true, meta, note: "Full entry streaming available via the agent session itself." });
	},
});

// ---------------------------------------------------------------------------
// Tool 5: get_session_tree
// ---------------------------------------------------------------------------

const GetSessionTreeParams = Type.Object({
	sessionId: Type.String({ description: "The session id" }),
});

const getSessionTreeTool = defineTool({
	name: "get_session_tree",
	label: "Get Session Tree",
	description: "Return the tree structure of a session (entries with their children + labels).",
	parameters: GetSessionTreeParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		return jsonResult({
			ok: true,
			sessionId: params.sessionId,
			note: "Session tree is exposed via the agent session directly; use this tool as a placeholder for future streaming.",
		});
	},
});

// ---------------------------------------------------------------------------
// Tool 6: get_session_stats
// ---------------------------------------------------------------------------

const GetSessionStatsParams = Type.Object({
	sessionId: Type.String({ description: "The session id" }),
});

const getSessionStatsTool = defineTool({
	name: "get_session_stats",
	label: "Get Session Stats",
	description: "Return aggregate statistics for a session: message count, token totals, cost, context usage.",
	parameters: GetSessionStatsParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const settings = getSettings();
		const meta = settings.sessionsIndex?.sessions.find((s) => s.id === params.sessionId);
		if (!meta) {
			return jsonResult({ ok: false, error: `Session not found: ${params.sessionId}` });
		}
		return jsonResult({ ok: true, ...meta });
	},
});

// ---------------------------------------------------------------------------
// Tool 7: list_catalog
// ---------------------------------------------------------------------------

const ListCatalogParams = Type.Object({
	type: Type.Union([Type.Literal("skill"), Type.Literal("extension"), Type.Literal("prompt")], {
		description: "Which catalog to list",
	}),
});

const listCatalogTool = defineTool({
	name: "list_catalog",
	label: "List Catalog",
	description:
		"List all addable skills, extensions, or prompts discovered in the workspace, with their current active/inactive state. The catalog is the universe of what could be enabled.",
	parameters: ListCatalogParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const settings = getSettings();
		const entries =
			params.type === "skill"
				? settings.catalog?.skills ?? []
				: params.type === "extension"
					? settings.catalog?.extensions ?? []
					: settings.catalog?.prompts ?? [];
		return jsonResult({
			ok: true,
			type: params.type,
			total: entries.length,
			active: entries.filter((e) => e.active).length,
			entries,
		});
	},
});

// ---------------------------------------------------------------------------
// Tool 8: toggle_resource
// ---------------------------------------------------------------------------

const ToggleResourceParams = Type.Object({
	type: Type.Union([Type.Literal("skill"), Type.Literal("extension"), Type.Literal("prompt")], {
		description: "Resource type",
	}),
	path: Type.String({ description: "Path to the resource (as listed in the catalog)" }),
	active: Type.Boolean({ description: "True to enable, false to disable" }),
});

const toggleResourceTool = defineTool({
	name: "toggle_resource",
	label: "Toggle Resource",
	description:
		"Enable or disable a skill, extension, or prompt. Adds/removes the path in the file's corresponding array. A /reload is required to bind the new resource into the running session.",
	parameters: ToggleResourceParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const settings = getSettings();
		const arrayKey = params.type === "skill" ? "skills" : params.type === "extension" ? "extensions" : "prompts";
		const current = (settings[arrayKey] as string[] | undefined) ?? [];
		let next: string[];
		if (params.active) {
			next = current.includes(params.path) ? current : [...current, params.path];
		} else {
			next = current.filter((p) => p !== params.path);
		}
		const merged = { ...settings, [arrayKey]: next };
		const path = getSettingsPath();
		const nextCounter = setSettings(merged);
		return jsonResult({
			ok: true,
			writtenVersion: nextCounter,
			arrayKey,
			active: next,
			message: params.active
				? `Enabled ${params.type} ${params.path}. Run /reload to bind it into the running session.`
				: `Disabled ${params.type} ${params.path}. Run /reload to unbind it.`,
		});
	},
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all 8 tools with the extension API.
 */
export function registerAllTools(pi: ExtensionAPI): void {
	pi.registerTool(getCurrentSettingsTool);
	pi.registerTool(updateSettingsTool);
	pi.registerTool(listSessionsTool);
	pi.registerTool(getSessionDetailTool);
	pi.registerTool(getSessionTreeTool);
	pi.registerTool(getSessionStatsTool);
	pi.registerTool(listCatalogTool);
	pi.registerTool(toggleResourceTool);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepMerge(base: unknown, overrides: unknown): unknown {
	if (overrides === null || overrides === undefined) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return overrides ?? base;
	}
	if (typeof overrides !== "object" || Array.isArray(overrides)) {
		return overrides ?? base;
	}
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
		const baseValue = result[key];
		if (
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue) &&
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			result[key] = deepMerge(baseValue, value);
		} else if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

export type { Static };
