/**
 * cascade — spawn ext tests.
 *
 * Covers the spawn cascade (Phase E T-E-12):
 *   - toggle on: file created with DEFAULT_SPAWN_EXTENSION
 *   - toggle off: enabled: false + sub-settings preserved
 *   - idempotent: no change → no write (no counter bump)
 *   - cycle: off → on → off preserves user-customized
 *     allowedTemplates
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cascadeManageToExtensions } from "../cascade.ts";
import { spawnExtensionPathFor } from "../settings-schema.ts";
import { writerCounter } from "../settings-schema.ts";

let agentDir: string;
let managePath: string;

function writeManage(extensions: string[] | undefined, extras: Record<string, unknown> = {}): void {
	const manage = {
		version: 1 as const,
		managedBy: "superhive-pi-truth@1#0",
		lastModified: new Date().toISOString(),
		...(extensions !== undefined && { extensions }),
		...extras,
	};
	writeFileSync(managePath, JSON.stringify(manage, null, "\t") + "\n");
}

function readSpawnFile(): Record<string, unknown> | null {
	const path = spawnExtensionPathFor(agentDir);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

before(() => {
	agentDir = mkdtempSync(join(tmpdir(), "cascade-spawn-"));
	mkdirSync(join(agentDir, "workspace"), { recursive: true });
	managePath = join(agentDir, "manage.json");
});

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("cascadeSpawnExtensionFromManage — toggle on", () => {
	it("creates the spawn file with DEFAULT_SPAWN_EXTENSION when ext is added and file is missing", async () => {
		writeManage(["superhive-pi-spawn"]);
		await cascadeManageToExtensions(agentDir);
		const file = readSpawnFile();
		assert.ok(file, "expected spawn file to be created");
		assert.equal(file!.enabled, true);
		assert.equal(file!.allowedTemplates, null);
		assert.equal(file!.requireApproval, false);
		assert.equal(file!.version, 1);
	});

	it("accepts the ./extensions/-prefixed form of the ext name", async () => {
		// fresh agent dir
		const fresh = mkdtempSync(join(tmpdir(), "cascade-spawn-2-"));
		mkdirSync(join(fresh, "workspace"), { recursive: true });
		const freshManage = join(fresh, "manage.json");
		writeFileSync(
			freshManage,
			JSON.stringify({
				version: 1,
				managedBy: "superhive-pi-truth@1#0",
				lastModified: new Date().toISOString(),
				extensions: ["./extensions/superhive-pi-spawn"],
			}),
		);
		await cascadeManageToExtensions(fresh);
		const file = readFileSync(join(fresh, "superhive-pi-spawn.json"), "utf8");
		const parsed = JSON.parse(file) as Record<string, unknown>;
		assert.equal(parsed.enabled, true);
		rmSync(fresh, { recursive: true, force: true });
	});

	it("is a no-op when ext is already on and file already has enabled: true", async () => {
		// already-on state from previous test
		const before = readSpawnFile();
		const beforeCounter = writerCounter(before!.managedBy as string);
		await cascadeManageToExtensions(agentDir);
		const after = readSpawnFile();
		const afterCounter = writerCounter(after!.managedBy as string);
		assert.equal(afterCounter, beforeCounter, "counter should not bump on no-op");
	});
});

describe("cascadeSpawnExtensionFromManage — toggle off", () => {
	it("sets enabled: false when ext is removed and file exists with enabled: true", async () => {
		// Start in the on state
		writeManage(["superhive-pi-spawn"]);
		await cascadeManageToExtensions(agentDir);
		const onFile = readSpawnFile();
		assert.equal(onFile!.enabled, true);

		// Toggle off
		writeManage([]);
		await cascadeManageToExtensions(agentDir);
		const offFile = readSpawnFile();
		assert.equal(offFile!.enabled, false);
	});

	it("preserves the user's allowedTemplates + requireApproval on toggle off", async () => {
		// On with a custom allowlist
		writeManage(["superhive-pi-spawn"]);
		await cascadeManageToExtensions(agentDir);
		writeFileSync(
			spawnExtensionPathFor(agentDir),
			JSON.stringify(
				{
					version: 1,
					managedBy: "superhive-pi-truth@1#0",
					enabled: true,
					allowedTemplates: ["research", "marketing"],
					requireApproval: true,
				},
				null,
				"\t",
			) + "\n",
		);

		// Toggle off
		writeManage([]);
		await cascadeManageToExtensions(agentDir);
		const offFile = readSpawnFile();
		assert.equal(offFile!.enabled, false);
		assert.deepEqual(offFile!.allowedTemplates, ["research", "marketing"]);
		assert.equal(offFile!.requireApproval, true);
	});

	it("is a no-op when ext is off and file is missing", async () => {
		// fresh agent dir, no spawn file
		const fresh = mkdtempSync(join(tmpdir(), "cascade-spawn-3-"));
		mkdirSync(join(fresh, "workspace"), { recursive: true });
		writeFileSync(
			join(fresh, "manage.json"),
			JSON.stringify({
				version: 1,
				managedBy: "superhive-pi-truth@1#0",
				lastModified: new Date().toISOString(),
				extensions: [],
			}),
		);
		await cascadeManageToExtensions(fresh);
		assert.equal(existsSync(join(fresh, "superhive-pi-spawn.json")), false);
		rmSync(fresh, { recursive: true, force: true });
	});

	it("is a no-op when ext is off and file already has enabled: false", async () => {
		writeManage(["superhive-pi-spawn"]);
		await cascadeManageToExtensions(agentDir);
		writeManage([]);
		await cascadeManageToExtensions(agentDir);
		const offFile = readSpawnFile();
		const beforeCounter = writerCounter(offFile!.managedBy as string);
		// Re-run with the same manage state
		await cascadeManageToExtensions(agentDir);
		const afterFile = readSpawnFile();
		const afterCounter = writerCounter(afterFile!.managedBy as string);
		assert.equal(afterCounter, beforeCounter, "counter should not bump on no-op");
	});
});

describe("cascadeSpawnExtensionFromManage — cycle: off → on → off", () => {
	it("preserves user-customized allowedTemplates across the cycle", async () => {
		// fresh agent dir
		const fresh = mkdtempSync(join(tmpdir(), "cascade-spawn-4-"));
		mkdirSync(join(fresh, "workspace"), { recursive: true });
		const freshManage = join(fresh, "manage.json");
		const freshSpawnPath = spawnExtensionPathFor(fresh);

		// 1. On (cascade creates with defaults)
		writeFileSync(
			freshManage,
			JSON.stringify({
				version: 1,
				managedBy: "superhive-pi-truth@1#0",
				lastModified: new Date().toISOString(),
				extensions: ["superhive-pi-spawn"],
			}),
		);
		await cascadeManageToExtensions(fresh);
		// 2. User edits the file to set a custom allowlist
		writeFileSync(
			freshSpawnPath,
			JSON.stringify(
				{
					version: 1,
					managedBy: "superhive-pi-truth@1#0",
					enabled: true,
					allowedTemplates: ["research", "general"],
					requireApproval: true,
				},
				null,
				"\t",
			) + "\n",
		);
		// 3. Off — should disable but preserve allowlist
		writeFileSync(
			freshManage,
			JSON.stringify({
				version: 1,
				managedBy: "superhive-pi-truth@1#0",
				lastModified: new Date().toISOString(),
				extensions: [],
			}),
		);
		await cascadeManageToExtensions(fresh);
		const offFile = JSON.parse(readFileSync(freshSpawnPath, "utf8")) as Record<string, unknown>;
		assert.equal(offFile.enabled, false);
		assert.deepEqual(offFile.allowedTemplates, ["research", "general"]);
		assert.equal(offFile.requireApproval, true);
		// 4. On again — should re-enable and STILL preserve the allowlist
		writeFileSync(
			freshManage,
			JSON.stringify({
				version: 1,
				managedBy: "superhive-pi-truth@1#0",
				lastModified: new Date().toISOString(),
				extensions: ["superhive-pi-spawn"],
			}),
		);
		await cascadeManageToExtensions(fresh);
		const onFile2 = JSON.parse(readFileSync(freshSpawnPath, "utf8")) as Record<string, unknown>;
		assert.equal(onFile2.enabled, true);
		assert.deepEqual(onFile2.allowedTemplates, ["research", "general"]);
		assert.equal(onFile2.requireApproval, true);
		// 5. Off again
		writeFileSync(
			freshManage,
			JSON.stringify({
				version: 1,
				managedBy: "superhive-pi-truth@1#0",
				lastModified: new Date().toISOString(),
				extensions: [],
			}),
		);
		await cascadeManageToExtensions(fresh);
		const offFile2 = JSON.parse(readFileSync(freshSpawnPath, "utf8")) as Record<string, unknown>;
		assert.equal(offFile2.enabled, false);
		assert.deepEqual(offFile2.allowedTemplates, ["research", "general"]);

		rmSync(fresh, { recursive: true, force: true });
	});
});

describe("cascadeSpawnExtensionFromManage — coexistence", () => {
	it("does not interfere with the orch cascade", async () => {
		// agent with both project block and spawn ext
		writeManage(
			["superhive-pi-spawn"],
			{
				project: { id: "p1", name: "Proj", description: "d", members: [] },
			},
		);
		await cascadeManageToExtensions(agentDir);
		// Both files should exist
		assert.ok(existsSync(spawnExtensionPathFor(agentDir)), "spawn file");
		assert.ok(
			existsSync(join(agentDir, "superhive-pi-orchestration.json")),
			"orch file",
		);
	});
});
