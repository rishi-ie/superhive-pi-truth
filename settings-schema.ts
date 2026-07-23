/**
 * Per-agent truth split.
 *
 * Every agent directory carries four sibling JSON files, each owned by
 * superhive-pi-truth:
 *
 *   settings.json    runtime essentials: model, env, providers, runtime,
 *                    systemPrompt, tier-2 UI flags, advanced, truth-internal
 *                    bookkeeping (catalog, sessionsIndex, lastEvent, checklist)
 *   manage.json      user-tweakable surface: identity, behavior, permissions,
 *                    skills/extensions/prompts/packages/themes, planMode,
 *                    project (coordinator-only)
 *   overview.json    right-sidebar Overview snapshot: name + description
 *                    mirrored from manage.json's project block, plus
 *                    coordinator-authored health/team/focus/activity
 *   inbox.json       append-only feed: notifications, permission asks,
 *                    agent questions
 *
 * telemetry.jsonl is unchanged (append-only event stream, separate concern).
 *
 * Each of the four files has its own `managedBy` counter
 * (`superhive-pi-truth@1#N`) and atomic `tmp + rename` write. The schemas
 * are zero-dep (no TypeBox) so the extension can be vendored into a clone
 * without an `npm install` step.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type SteeringMode = "all" | "one-at-a-time";
export type Transport = "auto" | "stdio" | "sse" | "websocket";
export type ProjectTrust = "ask" | "always" | "never";
export type DoubleEscapeAction = "fork" | "tree" | "none";
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
export type OutputPad = 0 | 1;

export interface ModelRef {
	provider: string;
	name: string;
}

export interface Permissions {
	filesystem?: boolean;
	terminal?: boolean;
	network?: boolean;
}

export interface ProviderEntry {
	name?: string;
	baseUrl?: string | null;
	apiKey?: string;
}

export interface PackageSourceObject {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type PackageSource = string | PackageSourceObject;

export interface CatalogEntry {
	path: string;
	size?: number;
	active: boolean;
}

export interface Catalog {
	lastScanned?: string;
	scanRoots?: string[];
	skills?: CatalogEntry[];
	extensions?: CatalogEntry[];
	prompts?: CatalogEntry[];
}

export interface SessionIndexEntry {
	id: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	tokens: {
		input: number;
		output: number;
		total: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	cost: number;
	path: string;
}

export interface SessionsIndex {
	lastUpdated?: string;
	sessions: SessionIndexEntry[];
}

export interface ChecklistItem {
	text: string;
	done: boolean;
}

export interface ChecklistState {
	taskName: string;
	items: ChecklistItem[];
	lastUpdated?: string;
}

export interface Runtime {
	thinkingLevel?: ThinkingLevel;
	activeTools?: string[];
	currentSessionId?: string;
	lastReloadedAt?: string;
}

export interface LastEvent {
	type: string;
	sessionId?: string;
	entryId?: string;
	timestamp: string;
}

export interface CompactionSettings {
	enabled?: boolean;
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export interface BranchSummarySettings {
	reserveTokens?: number;
	skipPrompt?: boolean;
}

export interface ProviderRetrySettings {
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface RetrySettings {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
	showImages?: boolean;
	imageWidthCells?: number;
	clearOnShrink?: boolean;
	showTerminalProgress?: boolean;
}

export interface ImageSettings {
	autoResize?: boolean;
	blockImages?: boolean;
}

export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string;
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean;
}

// ---------------------------------------------------------------------------
// Plan mode (superhive-pi-plan extension)
// ---------------------------------------------------------------------------

export type PlanDefaultMode = "plan" | "build" | "auto";
export type PlanThinkingLevel =
	| "inherit"
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface PlanModeSettings {
	defaultMode: PlanDefaultMode;
	thinkingLevel: PlanThinkingLevel;
	defaultPlanTools?: string[];
	safeSubcommands?: {
		git?: string[];
		gh?: string[];
	};
}

// ---------------------------------------------------------------------------
// Project block (manage.json, coordinator-only)
// ---------------------------------------------------------------------------

export interface MemberRef {
	agentId: string;
	name: string;
	role?: string;
	model?: { provider: string; name: string };
	status: "idle" | "active" | "error";
	joinedAt: string;
	localPath?: string;
}

export interface ProjectBlock {
	id: string;
	name: string;
	description: string;
	members: MemberRef[];
	localPath?: string;
	coordinatorAgentId?: string;
}

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

export interface SettingsFile {
	version: 1;
	managedBy?: string;
	lastModified?: string;

	// LLM
	model?: ModelRef;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	enabledModels?: string[];
	systemPrompt?: string;

	// Environment + providers
	environment?: Record<string, string>;
	providers?: Record<string, ProviderEntry>;

	// Live runtime state
	runtime?: Runtime;

	// Tier-2 UI flags
	theme?: string;
	hideThinkingBlock?: boolean;
	quietStartup?: boolean;
	doubleEscapeAction?: DoubleEscapeAction;
	treeFilterMode?: TreeFilterMode;
	showHardwareCursor?: boolean;
	editorPaddingX?: number;
	outputPad?: OutputPad;
	autocompleteMaxVisible?: number;
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;

	// Advanced
	defaultProjectTrust?: ProjectTrust;
	collapseChangelog?: boolean;
	enableInstallTelemetry?: boolean;
	enableAnalytics?: boolean;
	trackingId?: string | null;
	enableSkillCommands?: boolean;
	shellPath?: string | null;
	shellCommandPrefix?: string | null;
	npmCommand?: string[];
	externalEditor?: string | null;
	transport?: Transport;
	sessionDir?: string | null;
	httpProxy?: string | null;
	httpIdleTimeoutMs?: number;
	websocketConnectTimeoutMs?: number;
	terminal?: TerminalSettings;
	images?: ImageSettings;
	thinkingBudgets?: ThinkingBudgets;

	// Truth-internal bookkeeping (extension writes, external reads)
	catalog?: Catalog;
	sessionsIndex?: SessionsIndex;
	checklist?: ChecklistState;
	lastEvent?: LastEvent;
}

// ---------------------------------------------------------------------------
// manage.json
// ---------------------------------------------------------------------------

export interface IdentityBlock {
	name?: string;
	description?: string;
	workspace?: string;
}

export interface BehaviorBlock {
	steeringMode?: SteeringMode;
	followUpMode?: SteeringMode;
	autoCompaction?: boolean;
	autoRetry?: boolean;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
}

export interface ManageFile {
	version: 1;
	managedBy?: string;
	lastModified?: string;

	identity?: IdentityBlock;
	permissions?: Permissions;
	behavior?: BehaviorBlock;

	skills?: string[];
	extensions?: string[];
	prompts?: string[];
	packages?: PackageSource[];
	themes?: string[];

	planMode?: PlanModeSettings;
	project?: ProjectBlock;
}

// ---------------------------------------------------------------------------
// overview.json (right-sidebar Overview snapshot)
// ---------------------------------------------------------------------------

export interface OverviewHealth {
	status: "healthy" | "attention" | "blocked";
	agents: number;
	active: number;
	idle: number;
	tasks: number;
	completed: number;
	waiting: number;
	lastUpdated: string;
}

export interface OverviewMemberCard {
	id: string;
	name: string;
	status: "idle" | "active" | "busy" | "waiting" | "error";
	work: string;
}

export interface OverviewActivityItem {
	id: string;
	time: string;
	text: string;
}

export interface OverviewFile {
	version: 1;
	managedBy?: string;
	lastModified?: string;

	// Mirrored from manage.json's project block on every update_manage.
	name: string;
	description: string;

	health?: OverviewHealth;
	team?: OverviewMemberCard[];
	focus?: string[];
	activity?: OverviewActivityItem[];
}

// ---------------------------------------------------------------------------
// inbox.json (append-only feed)
// ---------------------------------------------------------------------------

export type InboxItemKind = "notification" | "permission" | "question";
export type InboxItemStatus = "pending" | "read" | "answered" | "dismissed";
export type InboxItemSeverity = "info" | "warning" | "error";

export interface InboxItem {
	id: string;
	kind: InboxItemKind;
	severity?: InboxItemSeverity;
	message: string;
	/** Optional structured payload (tool schema for permission asks, choices for questions). */
	payload?: Record<string, unknown>;
	status: InboxItemStatus;
	createdAt: string;
	updatedAt?: string;
	answeredWith?: unknown;
}

export interface InboxFile {
	version: 1;
	managedBy?: string;
	lastModified?: string;
	items: InboxItem[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

import nodePath from "node:path";

export interface TruthPaths {
	settings: string;
	manage: string;
	overview: string;
	inbox: string;
	legacy: string;
}

/**
 * Resolve the four truth file paths plus the legacy
 * `Superhive-pi-{foldername}.json` for a given agent directory.
 */
export function truthPathsForAgentDir(agentDir: string): TruthPaths {
	const folder = nodePath.basename(agentDir);
	return {
		settings: nodePath.join(agentDir, "settings.json"),
		manage: nodePath.join(agentDir, "manage.json"),
		overview: nodePath.join(agentDir, "overview.json"),
		inbox: nodePath.join(agentDir, "inbox.json"),
		legacy: nodePath.join(agentDir, `Superhive-pi-${folder}.json`),
	};
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: SettingsFile = {
	version: 1,
	managedBy: "superhive-pi-truth@1",
	model: { provider: "", name: "" },
	defaultProvider: "",
	defaultModel: "",
	defaultThinkingLevel: "medium",
	enabledModels: [],
	systemPrompt: "",
	environment: {},
	providers: {},
	runtime: { thinkingLevel: "medium", activeTools: [] },
	theme: "",
	hideThinkingBlock: false,
	quietStartup: false,
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	showHardwareCursor: true,
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	markdown: { codeBlockIndent: "  " },
	warnings: { anthropicExtraUsage: true },
	defaultProjectTrust: "ask",
	collapseChangelog: false,
	enableInstallTelemetry: true,
	enableAnalytics: false,
	trackingId: null,
	enableSkillCommands: true,
	shellPath: null,
	shellCommandPrefix: null,
	externalEditor: null,
	transport: "auto",
	sessionDir: null,
	httpProxy: null,
	httpIdleTimeoutMs: 60000,
	websocketConnectTimeoutMs: 10000,
	terminal: { showImages: true, imageWidthCells: 60, clearOnShrink: false, showTerminalProgress: false },
	images: { autoResize: true, blockImages: false },
	thinkingBudgets: { minimal: 0, low: 1024, medium: 4096, high: 16384 },
	catalog: { lastScanned: "", scanRoots: [], skills: [], extensions: [], prompts: [] },
	sessionsIndex: { lastUpdated: "", sessions: [] },
};

export const DEFAULT_MANAGE: ManageFile = {
	version: 1,
	managedBy: "superhive-pi-truth@1",
	identity: { name: "", description: "", workspace: "./workspace" },
	permissions: { filesystem: true, terminal: true, network: true },
	behavior: {
		steeringMode: "all",
		followUpMode: "all",
		autoCompaction: true,
		autoRetry: true,
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		branchSummary: { reserveTokens: 16384, skipPrompt: false },
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
	},
	skills: [],
	extensions: [],
	prompts: [],
	packages: [],
	themes: [],
	planMode: { defaultMode: "auto", thinkingLevel: "inherit" },
};

export const DEFAULT_OVERVIEW: OverviewFile = {
	version: 1,
	managedBy: "superhive-pi-truth@1",
	name: "",
	description: "",
	team: [],
	focus: [],
	activity: [],
};

export const DEFAULT_INBOX: InboxFile = {
	version: 1,
	managedBy: "superhive-pi-truth@1",
	items: [],
};

// ---------------------------------------------------------------------------
// Validation + per-file normalize
// ---------------------------------------------------------------------------

const VERSION = 1 as const;

export function validateAndNormalizeSettings(raw: unknown): SettingsFile {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("settings.json must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number") {
		throw new Error("settings.json missing required field: version");
	}
	if (obj.version > VERSION) {
		throw new Error(`settings.json version ${obj.version} is newer than this extension supports. Upgrade superhive-pi-truth.`);
	}
	if (obj.version < VERSION) {
		throw new Error(`settings.json version must be ${VERSION}, got ${obj.version}`);
	}
	return deepMerge(structuredClone(DEFAULT_SETTINGS), obj) as SettingsFile;
}

export function validateAndNormalizeManage(raw: unknown): ManageFile {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("manage.json must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number") {
		throw new Error("manage.json missing required field: version");
	}
	if (obj.version > VERSION) {
		throw new Error(`manage.json version ${obj.version} is newer than this extension supports. Upgrade superhive-pi-truth.`);
	}
	if (obj.version < VERSION) {
		throw new Error(`manage.json version must be ${VERSION}, got ${obj.version}`);
	}
	return deepMerge(structuredClone(DEFAULT_MANAGE), obj) as ManageFile;
}

export function validateAndNormalizeOverview(raw: unknown): OverviewFile {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("overview.json must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number") {
		throw new Error("overview.json missing required field: version");
	}
	if (obj.version > VERSION) {
		throw new Error(`overview.json version ${obj.version} is newer than this extension supports. Upgrade superhive-pi-truth.`);
	}
	if (obj.version < VERSION) {
		throw new Error(`overview.json version must be ${VERSION}, got ${obj.version}`);
	}
	return deepMerge(structuredClone(DEFAULT_OVERVIEW), obj) as OverviewFile;
}

export function validateAndNormalizeInbox(raw: unknown): InboxFile {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("inbox.json must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number") {
		throw new Error("inbox.json missing required field: version");
	}
	if (obj.version > VERSION) {
		throw new Error(`inbox.json version ${obj.version} is newer than this extension supports. Upgrade superhive-pi-truth.`);
	}
	if (obj.version < VERSION) {
		throw new Error(`inbox.json version must be ${VERSION}, got ${obj.version}`);
	}
	const merged = deepMerge(structuredClone(DEFAULT_INBOX), obj) as InboxFile;
	if (!Array.isArray(merged.items)) {
		throw new Error("inbox.json items must be an array");
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Counter helpers
// ---------------------------------------------------------------------------

const COUNTER_RE = /#(\d+)$/;

/**
 * Extract the writer counter from a `managedBy` string like
 * "superhive-pi-truth@1#5". Returns 0 if not set.
 */
export function writerCounter(managedBy: string | undefined | null): number {
	if (!managedBy) return 0;
	const match = COUNTER_RE.exec(managedBy);
	if (!match || !match[1]) return 0;
	return Number.parseInt(match[1], 10);
}

/**
 * Build the next counter string for a given file prefix.
 */
export function nextManagedBy(
	prevManagedBy: string | undefined,
	tag = "superhive-pi-truth@1",
): string {
	const next = writerCounter(prevManagedBy) + 1;
	return `${tag}#${next}`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeTruthFile<T>(file: T): string {
	return `${JSON.stringify(file, null, "\t")}\n`;
}

// ---------------------------------------------------------------------------
// Legacy migrator
// ---------------------------------------------------------------------------

/**
 * Split a legacy `Superhive-pi-{foldername}.json` blob into the four new
 * truth shapes. Used once per agent, on first launch after the split.
 *
 * Caller is responsible for writing each file (with its own counter) and
 * deleting the legacy file.
 */
export interface MigratedTruth {
	settings: SettingsFile;
	manage: ManageFile;
	overview: OverviewFile;
	inbox: InboxFile;
}

export function migrateLegacyToFour(raw: Record<string, unknown>): MigratedTruth {
	// Build a deep-cloned legacy base, then strip fields that belong in
	// each new file so deepMerge doesn't shadow them.
	const settingsRaw = deepStrip({ ...raw }, [
		"name", "description", "workspace",
		"permissions",
		"skills", "extensions", "prompts", "packages", "themes",
		"steeringMode", "followUpMode", "autoCompaction", "autoRetry", "compaction", "branchSummary", "retry",
		"planMode",
		"project",
		"managedBy", "lastModified", "version", // re-stamped on each new file
	]) as Record<string, unknown>;
	const manageRaw = deepStrip({ ...raw }, [
		"model", "defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels",
		"systemPrompt", "environment", "providers", "runtime",
		"theme", "hideThinkingBlock", "quietStartup", "doubleEscapeAction", "treeFilterMode",
		"showHardwareCursor", "editorPaddingX", "outputPad", "autocompleteMaxVisible",
		"markdown", "warnings",
		"defaultProjectTrust", "collapseChangelog", "enableInstallTelemetry", "enableAnalytics",
		"trackingId", "enableSkillCommands", "shellPath", "shellCommandPrefix",
		"npmCommand", "externalEditor", "transport", "sessionDir", "httpProxy",
		"httpIdleTimeoutMs", "websocketConnectTimeoutMs", "terminal", "images", "thinkingBudgets",
		"catalog", "sessionsIndex", "lastEvent", "checklist",
		"managedBy", "lastModified", "version",
	]) as Record<string, unknown>;

	// settings.json — strip the bookkeeping and merge over defaults.
	const settingsMerged = deepMerge(structuredClone(DEFAULT_SETTINGS), settingsRaw) as SettingsFile;
	// Catalog/sessionsIndex/lastEvent preserved from raw.

	// manage.json — keep identity-name/desc/workspace, permissions, skills etc, behavior, planMode, project.
	const manageMerged = deepMerge(structuredClone(DEFAULT_MANAGE), manageRaw) as ManageFile;
	// identity block: read from top-level legacy keys if not nested.
	if (!manageRaw.identity) {
		manageMerged.identity = {
			name: typeof raw.name === "string" ? raw.name : "",
			description: typeof raw.description === "string" ? raw.description : "",
			workspace: typeof raw.workspace === "string" ? raw.workspace : "./workspace",
		};
	}
	// behavior block: top-level legacy fields populate if not nested.
	if (!manageRaw.behavior) {
		const b: BehaviorBlock = {};
		if (raw.steeringMode !== undefined) b.steeringMode = raw.steeringMode as SteeringMode;
		if (raw.followUpMode !== undefined) b.followUpMode = raw.followUpMode as SteeringMode;
		if (raw.autoCompaction !== undefined) b.autoCompaction = raw.autoCompaction as boolean;
		if (raw.autoRetry !== undefined) b.autoRetry = raw.autoRetry as boolean;
		if (raw.compaction !== undefined) b.compaction = raw.compaction as CompactionSettings;
		if (raw.branchSummary !== undefined) b.branchSummary = raw.branchSummary as BranchSummarySettings;
		if (raw.retry !== undefined) b.retry = raw.retry as RetrySettings;
		manageMerged.behavior = b;
	}
	// skills / extensions / prompts at top level were the legacy array — copy in.
	if (!manageRaw.skills && Array.isArray(raw.skills)) manageMerged.skills = raw.skills as string[];
	if (!manageRaw.extensions && Array.isArray(raw.extensions)) manageMerged.extensions = raw.extensions as string[];
	if (!manageRaw.prompts && Array.isArray(raw.prompts)) manageMerged.prompts = raw.prompts as string[];
	if (!manageRaw.packages && Array.isArray(raw.packages)) manageMerged.packages = raw.packages as PackageSource[];
	if (!manageRaw.themes && Array.isArray(raw.themes)) manageMerged.themes = raw.themes as string[];

	// overview.json — start with mirrored name/description from the project block,
	// or fall back to identity.
	const overview: OverviewFile = {
		...structuredClone(DEFAULT_OVERVIEW),
		name: typeof raw.name === "string" ? raw.name : "",
		description: "",
	};
	const project = (raw.project ?? null) as { name?: unknown; description?: unknown } | null;
	if (project && typeof project.name === "string") overview.name = project.name;
	if (project && typeof project.description === "string") overview.description = project.description;
	if (!overview.description && typeof raw.description === "string") {
		overview.description = raw.description;
	}

	const inbox: InboxFile = {
		...structuredClone(DEFAULT_INBOX),
		items: [],
	};

	// Reset version + managed counters; the writer stamps them.
	settingsMerged.version = VERSION;
	settingsMerged.managedBy = "superhive-pi-truth@1";
	manageMerged.version = VERSION;
	manageMerged.managedBy = "superhive-pi-truth@1";
	overview.version = VERSION;
	overview.managedBy = "superhive-pi-truth@1";
	inbox.version = VERSION;
	inbox.managedBy = "superhive-pi-truth@1";

	return { settings: settingsMerged, manage: manageMerged, overview, inbox };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deepStrip<T extends Record<string, unknown>>(obj: T, keys: string[]): T {
	for (const k of keys) delete obj[k];
	return obj;
}

function deepMerge<T>(base: T, overrides: unknown): T {
	if (overrides === null || overrides === undefined) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return (overrides as T) ?? base;
	}
	if (typeof overrides !== "object" || Array.isArray(overrides)) {
		return (overrides as T) ?? base;
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
	return result as T;
}

// ---------------------------------------------------------------------------
// Per-extension settings files
//
// Every Pi extension loaded for an agent gets its own settings file at
// `<agentDir>/<ext-name>.json`. Truth (this extension) is the canonical
// writer via the cascade engine. The user-editable `manage.json` cascades
// the relevant knobs into each extension's file, and each extension
// reads its file directly via fs — no IPC bridge.
//
// Today only `superhive-pi-plan` and `superhive-pi-orchestration` are
// wired up. New extensions add a new file type + cascade entry below.
// ---------------------------------------------------------------------------

/**
 * The plan extension's settings file. Mirrors `manage.json.planMode` plus
 * whatever plan writes itself (none today).
 */
export interface PlanExtensionFile {
	version: 1;
	managedBy?: string;
	lastModified?: string;
	planMode?: PlanModeSettings;
}

/**
 * The orchestration extension's settings file. Holds the `project` block
 * (mirrored from manage.json), the CEO/system prompt the orchestrator
 * builds, and any orchestration-internal state.
 *
 * Truth's cascade engine mirrors `orchestration.systemPrompt` into
 * `settings.json` because the Pi runtime reads systemPrompt from there.
 */
export interface OrchExtensionFile {
	version: 1;
	managedBy?: string;
	lastModified?: string;
	project?: ProjectBlock;
	systemPrompt?: string;
	roleFragmentAppended?: "coordinator" | "member" | null;
}

export const DEFAULT_PLAN_EXTENSION: PlanExtensionFile = {
	version: 1,
	managedBy: "superhive-pi-truth@1",
	planMode: { defaultMode: "auto", thinkingLevel: "inherit" },
};

export const DEFAULT_ORCH_EXTENSION: OrchExtensionFile = {
	version: 1,
	managedBy: "superhive-pi-truth@1",
	project: undefined,
	systemPrompt: "",
	roleFragmentAppended: null,
};

/**
 * Per-extension file path helpers.
 *
 * Naming convention: `<agentDir>/<ext-name>.json`. Truth ext owns these
 * paths — extensions read them but never compute paths themselves.
 */
export function planExtensionPathFor(agentDir: string): string {
	return nodePath.join(agentDir, "superhive-pi-plan.json");
}

export function orchestrationExtensionPathFor(agentDir: string): string {
	return nodePath.join(agentDir, "superhive-pi-orchestration.json");
}

export function validateAndNormalizePlanExtension(raw: unknown): PlanExtensionFile {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("superhive-pi-plan.json must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number") {
		throw new Error("superhive-pi-plan.json missing required field: version");
	}
	if (obj.version > VERSION) {
		throw new Error(`superhive-pi-plan.json version ${obj.version} is newer than this extension supports.`);
	}
	return deepMerge(structuredClone(DEFAULT_PLAN_EXTENSION), obj) as PlanExtensionFile;
}

export function validateAndNormalizeOrchestrationExtension(raw: unknown): OrchExtensionFile {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("superhive-pi-orchestration.json must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number") {
		throw new Error("superhive-pi-orchestration.json missing required field: version");
	}
	if (obj.version > VERSION) {
		throw new Error(`superhive-pi-orchestration.json version ${obj.version} is newer than this extension supports.`);
	}
	return deepMerge(structuredClone(DEFAULT_ORCH_EXTENSION), obj) as OrchExtensionFile;
}
