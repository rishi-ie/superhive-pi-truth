/**
 * cascade — manage.json + per-extension-file cascade engine.
 *
 * Truth ext is the canonical owner of every cascade. When the user edits
 * a knob in manage.json, this module projects the relevant blocks into
 * the right per-extension file (atomically, with counter bump). The
 * orch ext's `systemPrompt` cascades OUT into settings.json (where the
 * Pi runtime reads it). Symmetric: when the orch file's systemPrompt
 * changes, this module mirrors it into settings.json.
 *
 * Triggered by the manage.json watcher in `index.ts` (cascade within
 * ~30ms of any manage.json write). Each per-extension file is also a
 * counter-bumped atomic write, so its own watcher can detect self-writes.
 */

import { existsSync } from "node:fs";
import {
	DEFAULT_ORCH_EXTENSION,
	DEFAULT_PLAN_EXTENSION,
	DEFAULT_SPAWN_EXTENSION,
	orchestrationExtensionPathFor,
	planExtensionPathFor,
	spawnExtensionPathFor,
	truthPathsForAgentDir,
	type ManageFile,
	type OrchExtensionFile,
	type PlanExtensionFile,
	type SpawnExtensionFile,
} from "./settings-schema.ts";
import {
	readManage,
	readOrchestrationExtension,
	readPlanExtension,
	readSpawnExtension,
	writeOrchestrationExtension,
	writePlanExtension,
	writeSettings,
	writeSpawnExtension,
} from "./file-io.ts";

const CASCADE_DEBOUNCE_MS = 30;

/**
 * IN-cascade: project `manage.json` into each per-extension file.
 *
 * - `manage.planMode` → `superhive-pi-plan.json.planMode`
 * - `manage.project` (full block) → `superhive-pi-orchestration.json.project`
 *
 * The cascade is idempotent. Files that aren't relevant (no managed
 * knob present, or no `project` block) are left untouched.
 */
export async function cascadeManageToExtensions(agentDir: string): Promise<void> {
	const managePath = truthPathsForAgentDir(agentDir).manage;
	if (!existsSync(managePath)) return;

	let manage: ManageFile;
	try {
		const loaded = readManage(managePath);
		if (!loaded) return;
		manage = loaded;
	} catch {
		return;
	}

	// planMode → plan extension file
	if (manage.planMode) {
		await cascadePlanModeIntoPlanFile(agentDir, manage);
	}

	// project block → orchestration extension file (full block). Only fires
	// if manage has a `project` block AND the orch file currently lives at
	// <agentDir>/superhive-pi-orchestration.json. If the orch file doesn't
	// exist yet, seed it.
	if (manage.project) {
		await cascadeProjectIntoOrchFile(agentDir, manage);
	}

	// spawn ext: manage.extensions[] gain/lose superhive-pi-spawn →
	// create or disable <agentDir>/superhive-pi-spawn.json. The
	// ext is project-coordinator-only; we run the cascade for
	// every agent (the spawn ext's own gate enforces project
	// membership at tool-call time) so the file is in place when
	// the project-coordinator toggle is on.
	await cascadeSpawnExtensionFromManage(agentDir, manage);
}

/**
 * OUT-cascade: mirror systemPrompt from the orch file into settings.json
 * so the Pi runtime reads it. Only fires when the file actually exists
 * (i.e. orch ext has bootstrapped at least once).
 */
export async function cascadeOrchFileIntoSettings(agentDir: string): Promise<void> {
	const orchPath = orchestrationExtensionPathFor(agentDir);
	if (!existsSync(orchPath)) return;

	let orch: OrchExtensionFile;
	try {
		const loaded = readOrchestrationExtension(orchPath);
		if (!loaded) return;
		orch = loaded;
	} catch {
		return;
	}

	if (typeof orch.systemPrompt !== "string") return;

	const paths = truthPathsForAgentDir(agentDir);
	if (!existsSync(paths.settings)) return;

	try {
		const raw = (await import("node:fs")).readFileSync(paths.settings, "utf-8");
		const parsed = JSON.parse(raw) as { systemPrompt?: string; managedBy?: string; lastModified?: string };
		if (parsed.systemPrompt === orch.systemPrompt) return;
		const next = { ...parsed, systemPrompt: orch.systemPrompt };
		writeSettings(paths.settings, next as Parameters<typeof writeSettings>[1]);
	} catch {
		// best-effort; if settings.json is malformed the orch ext's existing
		// behavior on session_start takes over.
	}
}

async function cascadePlanModeIntoPlanFile(
	agentDir: string,
	manage: ManageFile,
): Promise<void> {
	const planPath = planExtensionPathFor(agentDir);
	const existing = readPlanExtension(planPath);
	const base: PlanExtensionFile = existing ?? structuredClone(DEFAULT_PLAN_EXTENSION);

	if (deepEqualManaged((base.planMode ?? null) as unknown, manage.planMode as unknown)) {
		return;
	}

	const next: PlanExtensionFile = {
		...base,
		planMode: manage.planMode,
	};
	writePlanExtension(planPath, next);
}

async function cascadeProjectIntoOrchFile(
	agentDir: string,
	manage: ManageFile,
): Promise<void> {
	const orchPath = orchestrationExtensionPathFor(agentDir);
	const existing = readOrchestrationExtension(orchPath);
	const base: OrchExtensionFile = existing ?? structuredClone(DEFAULT_ORCH_EXTENSION);

	if (deepEqualManaged(base.project, manage.project)) {
		return;
	}

	const next: OrchExtensionFile = {
		...base,
		project: manage.project,
	};
	writeOrchestrationExtension(orchPath, next);
}

/**
 * Loose equality check — avoid touching the file if the cascaded block
 * is byte-equivalent at the top level. The writer counter still bumps,
 * but only when there's an actual change.
 */
function deepEqualManaged(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ak = Object.keys(a as Record<string, unknown>);
	const bk = Object.keys(b as Record<string, unknown>);
	if (ak.length !== bk.length) return false;
	for (const k of ak) {
		const av = (a as Record<string, unknown>)[k];
		const bv = (b as Record<string, unknown>)[k];
		if (typeof av === "object" && av !== null && typeof bv === "object" && bv !== null) {
			if (!deepEqualManaged(av, bv)) return false;
			continue;
		}
		if (Array.isArray(av) && Array.isArray(bv)) {
			if (av.length !== bv.length) return false;
			for (let i = 0; i < av.length; i++) {
				if (!deepEqualManaged(av[i], bv[i])) return false;
			}
			continue;
		}
		if (av !== bv) return false;
	}
	return true;
}

export const CASCADE_CONFIG = {
	debounceMs: CASCADE_DEBOUNCE_MS,
};

/**
 * OUT-cascade: project manage.extensions[] into the per-spawn file.
 *
 * Phase E: when the user toggles `superhive-pi-spawn` on in the
 * Manage tab, manage.extensions[] gains the entry. The cascade
 * creates <agentDir>/superhive-pi-spawn.json with
 * DEFAULT_SPAWN_EXTENSION (enabled: true, allow-all, no approval).
 *
 * When the user toggles it OFF, manage.extensions[] loses the
 * entry. The cascade sets enabled: false in the file, but
 * preserves the user's `allowedTemplates` + `requireApproval`
 * overrides so the next toggle-on restores their config.
 *
 * Idempotent: if the file is already in the desired state, no
 * write happens (no counter bump). Deep-merges the user's
 * existing sub-settings so a toggle-off → toggle-on → toggle-off
 * cycle preserves the user's allowedTemplates.
 */
async function cascadeSpawnExtensionFromManage(
	agentDir: string,
	manage: ManageFile,
): Promise<void> {
	const spawnPath = spawnExtensionPathFor(agentDir);
	const extLoaded = isSpawnExtInExtensions(manage.extensions);
	const existing = readSpawnExtension(spawnPath);
	const base: SpawnExtensionFile = existing ?? structuredClone(DEFAULT_SPAWN_EXTENSION);

	let next: SpawnExtensionFile;

	if (extLoaded) {
		// Toggle on (or already on): the user wants this ext
		// available. Preserve their sub-settings (allowedTemplates,
		// requireApproval); only flip enabled to true if it was
		// false. If a file was missing and they're enabling for
		// the first time, write DEFAULT_SPAWN_EXTENSION as-is.
		if (existing && existing.enabled === true) {
			return; // no change
		}
		next = {
			...base,
			enabled: true,
		};
	} else {
		// Toggle off: disable the ext but keep the user's config
		// (allowedTemplates + requireApproval) so a future
		// toggle-on restores it. If there's no file at all, no-op
		// (nothing to disable).
		if (!existing) {
			return;
		}
		if (existing.enabled === false) {
			return; // no change
		}
		next = {
			...base,
			enabled: false,
		};
	}

	writeSpawnExtension(spawnPath, next);
}

function isSpawnExtInExtensions(extensions: ManageFile["extensions"]): boolean {
	if (!Array.isArray(extensions)) return false;
	return extensions.some((e) => {
		if (typeof e !== "string") return false;
		// Match either the bare name (UI toggle) or the
		// ./extensions/ prefixed form (manifest convention)
		return e === "superhive-pi-spawn" || e === "./extensions/superhive-pi-spawn";
	});
}
