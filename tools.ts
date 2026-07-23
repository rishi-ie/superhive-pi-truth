/**
 * Agent-callable tools for superhive-pi-truth.
 *
 * The 13 tools split across the four truth files:
 *   settings.json (slim):  get_current_settings, update_settings,
 *                          list_sessions, get_session_detail,
 *                          get_session_tree, get_session_stats,
 *                          list_catalog, update_checklist
 *   manage.json:           update_manage, toggle_resource
 *   overview.json:         update_overview
 *   inbox.json:            append_inbox, mark_inbox_read, clear_inbox
 *
 * Mutations go through `setSettings/setManage/setOverview/setInbox` which
 * bump the file's writer counter so the watcher knows the change was made
 * by the agent itself (no echo loop).
 *
 * Conventions:
 * - All parameter schemas use TypeBox (aliased by jiti to the fork's copy).
 * - Tools return a single text content block with a JSON-stringified payload.
 */

import { Type, type Static } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getInbox, getInboxPath, getManage, getManagePath, getOverview, getOverviewPath, getSettings,
	getSettingsPath, setInbox, setManage, setOverview, setSettings,
} from "./state.ts";
import {
	clearChecklist,
	emitChecklistToJournal,
	getChecklist,
	setChecklist,
	type ChecklistItem,
} from "./checklist.ts";
import type { InboxFile, InboxItem, ManageFile, OverviewFile, SettingsFile } from "./settings-schema.ts";

function jsonResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

// ---------------------------------------------------------------------------
// settings.json — get + read + write the runtime essentials
// ---------------------------------------------------------------------------

const getCurrentSettingsTool = defineTool({
	name: "get_current_settings",
	label: "Get Current Settings",
	description:
		"Return the contents of `<agentDir>/settings.json` (model, env, providers, runtime, tier-2 UI flags, sessions index, catalog).",
	parameters: Type.Object({}),

	async execute(_id, _params, _signal, _onUpdate, _ctx) {
		return jsonResult({ ok: true, settings: getSettings() });
	},
});

const UpdateSettingsParams = Type.Object({
	patch: Type.Any({ description: "Partial settings object to merge (JSON Merge Patch, RFC 7396)" }),
});

const updateSettingsTool = defineTool({
	name: "update_settings",
	label: "Update Settings",
	description:
		"Apply a partial update to settings.json. The patch is deep-merged into the current settings. Tier-1 fields (model, env, runtime) take effect immediately; tier-2 UI/advanced flags set a /reload flag.",
	parameters: UpdateSettingsParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const current = getSettings();
		const merged = deepMerge(current, params.patch) as SettingsFile;
		const nextCounter = setSettings(merged);
		return jsonResult({
			ok: true,
			writtenVersion: nextCounter,
			path: getSettingsPath(),
			message: "Settings updated. Some changes may require a /reload to take full effect.",
		});
	},
});

const ListSessionsParams = Type.Object({
	project: Type.Optional(Type.String({ description: "Optional project filter" })),
	limit: Type.Optional(Type.Number({ description: "Max sessions to return (default 50)" })),
	offset: Type.Optional(Type.Number({ description: "Pagination offset (default 0)" })),
});

const listSessionsTool = defineTool({
	name: "list_sessions",
	label: "List Sessions",
	description: "List all sessions in the current workspace, most recent first. Reads settings.json's sessionsIndex.",
	parameters: ListSessionsParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const settings = getSettings();
		const sessions = settings.sessionsIndex?.sessions ?? [];
		const limit = params.limit ?? 50;
		const offset = params.offset ?? 0;
		return jsonResult({ ok: true, total: sessions.length, limit, offset, sessions: sessions.slice(offset, offset + limit) });
	},
});

const GetSessionDetailParams = Type.Object({
	sessionId: Type.String({ description: "The session id" }),
});

const getSessionDetailTool = defineTool({
	name: "get_session_detail",
	label: "Get Session Detail",
	description: "Return the metadata for a session from sessionsIndex.",
	parameters: GetSessionDetailParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const settings = getSettings();
		const meta = settings.sessionsIndex?.sessions.find((s) => s.id === params.sessionId);
		if (!meta) {
			return jsonResult({ ok: false, error: `Session not found: ${params.sessionId}` });
		}
		return jsonResult({ ok: true, meta, note: "Full entry streaming available via the agent session itself." });
	},
});

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

const ListCatalogParams = Type.Object({
	type: Type.Union([Type.Literal("skill"), Type.Literal("extension"), Type.Literal("prompt")], {
		description: "Which catalog to list",
	}),
});

const listCatalogTool = defineTool({
	name: "list_catalog",
	label: "List Catalog",
	description: "List all addable skills, extensions, or prompts discovered in the workspace, with current active state.",
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

const UpdateChecklistParams = Type.Object({
	taskName: Type.String({ description: "Short name of the task" }),
	items: Type.Array(
		Type.Object({
			text: Type.String({ description: "One step in the plan" }),
			done: Type.Boolean({ description: "True if the step is complete" }),
		}),
		{ description: "Ordered checklist rows" },
	),
});

const updateChecklistTool = defineTool({
	name: "update_checklist",
	label: "Update Checklist",
	description:
		"Replace the agent's current task checklist. The right sidebar's 'Active checklist' accordion mirrors these rows live.",
	parameters: UpdateChecklistParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const path = getSettingsPath();
		const items: ChecklistItem[] = params.items.map((i) => ({
			text: i.text,
			done: i.done,
		}));
		setChecklist({ taskName: params.taskName, items });
		emitChecklistToJournal(path, params.taskName, items);
		return jsonResult({
			ok: true,
			taskName: params.taskName,
			total: items.length,
			done: items.filter((i) => i.done).length,
			message: `Checklist updated: ${items.filter((i) => i.done).length}/${items.length} done`,
		});
	},
});

// ---------------------------------------------------------------------------
// manage.json — get + read + write user-tweakable surface
// ---------------------------------------------------------------------------

const getCurrentManageTool = defineTool({
	name: "get_current_manage",
	label: "Get Current Manage",
	description: "Return the contents of `<agentDir>/manage.json` (identity, behavior, permissions, resources, planMode, project).",
	parameters: Type.Object({}),

	async execute(_id, _params, _signal, _onUpdate, _ctx) {
		return jsonResult({ ok: true, manage: getManage() });
	},
});

const UpdateManageParams = Type.Object({
	patch: Type.Any({ description: "Partial manage object to merge (JSON Merge Patch, RFC 7396)" }),
});

const updateManageTool = defineTool({
	name: "update_manage",
	label: "Update Manage",
	description:
		"Apply a partial update to manage.json. Deep-merges over the current state. Used to edit identity, behavior, permissions, planMode, project metadata.",
	parameters: UpdateManageParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const current = getManage();
		const merged = deepMerge(current, params.patch) as ManageFile;
		const nextCounter = setManage(merged);
		return jsonResult({
			ok: true,
			writtenVersion: nextCounter,
			path: getManagePath(),
			message: "manage.json updated. Path or permission changes may require a /reload.",
		});
	},
});

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
		"Enable or disable a skill, extension, or prompt. Adds/removes the path in manage.json's corresponding array. A /reload is required to bind the resource into the running session.",
	parameters: ToggleResourceParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const manage = getManage();
		const arrayKey = params.type === "skill" ? "skills" : params.type === "extension" ? "extensions" : "prompts";
		const current = (manage[arrayKey] as string[] | undefined) ?? [];
		let next: string[];
		if (params.active) {
			next = current.includes(params.path) ? current : [...current, params.path];
		} else {
			next = current.filter((p) => p !== params.path);
		}
		const merged = { ...manage, [arrayKey]: next } as ManageFile;
		const nextCounter = setManage(merged);
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
// overview.json — get + read + write right-sidebar snapshot
// ---------------------------------------------------------------------------

const getCurrentOverviewTool = defineTool({
	name: "get_current_overview",
	label: "Get Current Overview",
	description: "Return the contents of `<agentDir>/overview.json` (name, description, health, team, focus, activity).",
	parameters: Type.Object({}),

	async execute(_id, _params, _signal, _onUpdate, _ctx) {
		return jsonResult({ ok: true, overview: getOverview() });
	},
});

const UpdateOverviewParams = Type.Object({
	patch: Type.Any({ description: "Partial overview object to merge (JSON Merge Patch, RFC 7396)" }),
});

const updateOverviewTool = defineTool({
	name: "update_overview",
	label: "Update Overview",
	description:
		"Apply a partial update to overview.json. The right sidebar's Overview tab reads from this file. Use it to set focus items, log activity, snapshot project health.",
	parameters: UpdateOverviewParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const current = getOverview();
		const merged = deepMerge(current, params.patch) as OverviewFile;
		const nextCounter = setOverview(merged);
		return jsonResult({
			ok: true,
			writtenVersion: nextCounter,
			path: getOverviewPath(),
			message: "overview.json updated.",
		});
	},
});

// ---------------------------------------------------------------------------
// inbox.json — append-only feed for notifications, permission asks, questions
// ---------------------------------------------------------------------------

const AppendInboxParams = Type.Object({
	kind: Type.Union([Type.Literal("notification"), Type.Literal("permission"), Type.Literal("question")], {
		description: "Inbox item type",
	}),
	message: Type.String({ description: "Human-readable content (one or two sentences)" }),
	severity: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")], {
		description: "Severity for notifications and permission asks",
	})),
	payload: Type.Optional(Type.Any({ description: "Optional structured data (tool schema for permission, choices for question)" })),
});

const appendInboxTool = defineTool({
	name: "append_inbox",
	label: "Append Inbox Item",
	description:
		"Append an item to inbox.json. Use notifications for human-facing status updates, permission asks for tool approval requests, questions for clarifications the user must answer.",
	parameters: AppendInboxParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const current = getInbox();
		const now = new Date().toISOString();
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const item: InboxItem = {
			id,
			kind: params.kind,
			severity: params.severity,
			message: params.message,
			payload: params.payload as Record<string, unknown> | undefined,
			status: "pending",
			createdAt: now,
		};
		const next: InboxFile = {
			...current,
			items: [...current.items, item],
		};
		const nextCounter = setInbox(next);
		return jsonResult({
			ok: true,
			writtenVersion: nextCounter,
			id,
			item,
			message: `Appended ${params.kind} to inbox.json`,
		});
	},
});

const MarkInboxReadParams = Type.Object({
	id: Type.String({ description: "Inbox item id" }),
	answeredWith: Type.Optional(Type.Any({ description: "Optional answer payload for question items" })),
});

const markInboxReadTool = defineTool({
	name: "mark_inbox_read",
	label: "Mark Inbox Item Read",
	description:
		"Flip a pending inbox item to read (or answered if a payload was supplied). The right sidebar's Inbox tab updates live.",
	parameters: MarkInboxReadParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const current = getInbox();
		const idx = current.items.findIndex((i) => i.id === params.id);
		if (idx === -1) {
			return jsonResult({ ok: false, error: `Inbox item not found: ${params.id}` });
		}
		const items = current.items.slice();
		const existing = items[idx]!;
		const updated: InboxItem = {
			...existing,
			status: params.answeredWith !== undefined ? "answered" : "read",
			updatedAt: new Date().toISOString(),
			answeredWith: params.answeredWith,
		};
		items[idx] = updated;
		const next: InboxFile = { ...current, items };
		const nextCounter = setInbox(next);
		return jsonResult({ ok: true, writtenVersion: nextCounter, item: updated });
	},
});

const ClearInboxParams = Type.Object({
	status: Type.Optional(Type.Union([
		Type.Literal("read"), Type.Literal("answered"), Type.Literal("dismissed"), Type.Literal("pending"),
	], { description: "Only clear items in this status; omit to clear all" })),
});

const clearInboxTool = defineTool({
	name: "clear_inbox",
	label: "Clear Inbox",
	description: "Drop inbox items. By default clears all; pass a status to drop only matching items.",
	parameters: ClearInboxParams,

	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const current = getInbox();
		const before = current.items.length;
		const items = params.status === undefined
			? []
			: current.items.filter((i) => i.status !== params.status);
		const next: InboxFile = { ...current, items };
		const nextCounter = setInbox(next);
		return jsonResult({ ok: true, writtenVersion: nextCounter, removed: before - items.length, remaining: items.length });
	},
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerAllTools(pi: ExtensionAPI): void {
	// settings.json
	pi.registerTool(getCurrentSettingsTool);
	pi.registerTool(updateSettingsTool);
	pi.registerTool(listSessionsTool);
	pi.registerTool(getSessionDetailTool);
	pi.registerTool(getSessionTreeTool);
	pi.registerTool(getSessionStatsTool);
	pi.registerTool(listCatalogTool);
	pi.registerTool(updateChecklistTool);

	// manage.json
	pi.registerTool(getCurrentManageTool);
	pi.registerTool(updateManageTool);
	pi.registerTool(toggleResourceTool);

	// overview.json
	pi.registerTool(getCurrentOverviewTool);
	pi.registerTool(updateOverviewTool);

	// inbox.json
	pi.registerTool(appendInboxTool);
	pi.registerTool(markInboxReadTool);
	pi.registerTool(clearInboxTool);
}

export { clearChecklist };

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
