/**
 * Settings file schema for superhive-pi-truth.
 *
 * The file `Superhive-pi-{foldername}.json` is the single source of truth for
 * all Pi agent configuration after the first launch. It is a superset of:
 *
 * - The boot-time `Manifest` schema (skills, extensions, prompts, model,
 *   environment, permissions, workspace, system prompt)
 * - The runtime `Settings` interface (theme, compaction, retry, UI flags,
 *   providers, keybindings, telemetry, etc.)
 * - Live runtime state (current thinking level, active tools, current session)
 * - The catalog of addable skills/extensions/prompts
 * - A sessions index for external readers (Superhive, RPC consumers)
 * - A small live event tail
 *
 * The schema is zero-dep (no TypeBox) so the extension can be dropped into
 * a clone without an `npm install` step. The validator does shallow
 * structural checks; the migration step deep-merges over defaults so new
 * fields are populated automatically.
 */

import nodePath from "node:path";

// ---------------------------------------------------------------------------
// Type definitions
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

export interface Logging {
	enabled?: boolean;
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

export interface PackageSourceObject {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type PackageSource = string | PackageSourceObject;

export interface ProviderEntry {
	name?: string;
	baseUrl?: string | null;
	apiKey?: string;
}

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

export interface SettingsFile {
	version: 1;
	managedBy?: string;
	lastModified?: string;

	// Agent identity
	name?: string;
	description?: string;
	workspace?: string;

	// LLM
	model?: ModelRef;
	systemPrompt?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	enabledModels?: string[];

	// Resources
	skills?: string[];
	extensions?: string[];
	prompts?: string[];
	packages?: PackageSource[];
	themes?: string[];

	// Environment + permissions
	environment?: Record<string, string>;
	permissions?: Permissions;

	// Providers (auth + custom)
	providers?: Record<string, ProviderEntry>;

	// Tools
	activeTools?: string[];

	// Behavior
	steeringMode?: SteeringMode;
	followUpMode?: SteeringMode;
	autoCompaction?: boolean;
	autoRetry?: boolean;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;

	// UI
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

	// Manifest leftovers (cosmetic / future)
	memory?: Record<string, unknown>;
	context?: Record<string, unknown>;
	logging?: Logging;

	// Live runtime state
	runtime?: Runtime;

	// Catalog (extension writes, external reads)
	catalog?: Catalog;

	// Sessions index (extension writes, external reads)
	sessionsIndex?: SessionsIndex;

	// Last event (small ring buffer)
	lastEvent?: LastEvent;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: SettingsFile = {
	version: 1,
	managedBy: "superhive-pi-truth@1",
	name: "",
	description: "",
	workspace: "./workspace",
	model: { provider: "", name: "" },
	systemPrompt: "",
	defaultProvider: "",
	defaultModel: "",
	defaultThinkingLevel: "medium",
	enabledModels: [],
	skills: [],
	extensions: [],
	prompts: [],
	packages: [],
	themes: [],
	environment: {},
	permissions: { filesystem: true, terminal: true, network: true },
	providers: {},
	activeTools: [],
	steeringMode: "all",
	followUpMode: "all",
	autoCompaction: true,
	autoRetry: true,
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	branchSummary: { reserveTokens: 16384, skipPrompt: false },
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
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
	memory: {},
	context: {},
	logging: { enabled: true },
	runtime: { thinkingLevel: "medium", activeTools: [] },
	catalog: { lastScanned: "", scanRoots: [], skills: [], extensions: [], prompts: [] },
	sessionsIndex: { lastUpdated: "", sessions: [] },
};

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Resolve the settings file path for a given workspace.
 *
 * The file lives one level up from the workspace (at the agent root), named
 * `Superhive-pi-{foldername}.json` where {foldername} is the basename of the
 * agent root.
 *
 *   /path/my-agent/workspace  ->  /path/my-agent/Superhive-pi-my-agent.json
 *   /path/agent/workspace     ->  /path/agent/Superhive-pi-agent.json
 */
export function settingsFilePathFor(workspace: string): string {
	const agentRoot = nodePath.dirname(workspace);
	const folder = nodePath.basename(agentRoot);
	return nodePath.join(agentRoot, `Superhive-pi-${folder}.json`);
}

// ---------------------------------------------------------------------------
// Migration + validation
// ---------------------------------------------------------------------------

/**
 * Migrate a raw settings object to the current version and merge over
 * defaults. Throws on a future-version file.
 */
export function migrateToCurrent(raw: Record<string, unknown>): SettingsFile {
	const version = typeof raw.version === "number" ? raw.version : 0;
	if (version > 1) {
		throw new Error(
			`Settings file version ${version} is newer than this extension supports. Upgrade superhive-pi-truth.`,
		);
	}
	return deepMerge(structuredClone(DEFAULT_SETTINGS), raw) as SettingsFile;
}

/**
 * Validate a settings object. Returns the normalized SettingsFile on success;
 * throws a path-tagged error on failure.
 */
export function validateSettings(raw: unknown): SettingsFile {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Settings file must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (!("version" in obj)) {
		throw new Error("Settings file missing required field: version");
	}
	if (typeof obj.version !== "number") {
		throw new Error(`Settings file version must be a number, got ${typeof obj.version}`);
	}
	if (obj.version > 1) {
		throw new Error(
			`Settings file version ${obj.version} is newer than this extension supports. Upgrade superhive-pi-truth.`,
		);
	}
	if (obj.version < 1) {
		throw new Error(`Settings file version must be 1, got ${obj.version}`);
	}
	return migrateToCurrent(obj);
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
// Serialization
// ---------------------------------------------------------------------------

/**
 * Stable JSON serialization with tabs + trailing newline.
 */
export function serializeSettings(settings: SettingsFile): string {
	return `${JSON.stringify(settings, null, "\t")}\n`;
}
