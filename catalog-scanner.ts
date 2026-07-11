/**
 * Catalog scanner.
 *
 * Scans the workspace for addable skills (`.md`), extensions (`.ts` or
 * `index.ts` in a subdirectory), and prompts (`.md`) and writes the result
 * into the settings file's `catalog` block.
 *
 * The catalog tells Superhive (or any external reader) what could be enabled,
 * even if it isn't currently active in the manifest. The active subset is
 * also marked, so the UI can show toggles.
 *
 * Default scan roots: `./skills`, `./extensions`, `./prompts` (relative to
 * the workspace root). Configurable via the file's `catalog.scanRoots` field.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Catalog, CatalogEntry, SettingsFile } from "./settings-schema.ts";

const DEFAULT_SCAN_ROOTS = ["./skills", "./extensions", "./prompts"];

export interface CatalogScannerOptions {
	workspace: string;
	getSettings(): SettingsFile;
	setSettings(settings: SettingsFile): void;
	notify?(message: string, level?: "info" | "warning" | "error"): void;
}

export interface CatalogScanner {
	refresh(): void;
	dispose(): void;
}

export function createCatalogScanner(options: CatalogScannerOptions): CatalogScanner {
	function scanDir(dir: string, type: "skills" | "extensions" | "prompts"): CatalogEntry[] {
		const out: CatalogEntry[] = [];
		if (!existsSync(dir)) return out;
		let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
				name: e.name,
				isFile: e.isFile(),
				isDirectory: e.isDirectory(),
			}));
		} catch {
			return out;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			const rel = relative(options.workspace, full);
			const activeSet = new Set(
				type === "skills"
					? options.getSettings().skills ?? []
					: type === "extensions"
						? options.getSettings().extensions ?? []
						: options.getSettings().prompts ?? [],
			);
			const isActive = activeSet.has(rel) || activeSet.has(`./${rel}`);

			if (type === "extensions") {
				// Extensions: a directory with index.ts (or a .ts file directly)
				if (entry.isDirectory) {
					const indexPath = join(full, "index.ts");
					if (existsSync(indexPath)) {
						let size: number | undefined;
						try {
							size = statSync(indexPath).size;
						} catch {
							// ignore
						}
						out.push({ path: `./${rel}`, size, active: isActive });
					}
				} else if (entry.isFile && entry.name.endsWith(".ts")) {
					let size: number | undefined;
					try {
						size = statSync(full).size;
					} catch {
						// ignore
					}
					out.push({ path: `./${rel}`, size, active: isActive });
				}
			} else {
				// Skills / prompts: .md files (and .md in subdirectories)
				if (entry.isFile && entry.name.endsWith(".md")) {
					let size: number | undefined;
					try {
						size = statSync(full).size;
					} catch {
						// ignore
					}
					out.push({ path: `./${rel}`, size, active: isActive });
				} else if (entry.isDirectory) {
					// Recurse one level for nested skills/prompts
					const nested = scanDir(full, type);
					out.push(...nested);
				}
			}
		}
		return out;
	}

	function scanAll(): Catalog {
		const roots = options.getSettings().catalog?.scanRoots ?? DEFAULT_SCAN_ROOTS;
		const skillsRoots = roots.filter((r) => r.includes("skill"));
		const extRoots = roots.filter((r) => r.includes("extension"));
		const promptRoots = roots.filter((r) => r.includes("prompt"));

		const skillsEntries: CatalogEntry[] = [];
		for (const root of skillsRoots.length > 0 ? skillsRoots : ["./skills"]) {
			skillsEntries.push(...scanDir(resolve(options.workspace, root), "skills"));
		}
		const extensionsEntries: CatalogEntry[] = [];
		for (const root of extRoots.length > 0 ? extRoots : ["./extensions"]) {
			extensionsEntries.push(...scanDir(resolve(options.workspace, root), "extensions"));
		}
		const promptsEntries: CatalogEntry[] = [];
		for (const root of promptRoots.length > 0 ? promptRoots : ["./prompts"]) {
			promptsEntries.push(...scanDir(resolve(options.workspace, root), "prompts"));
		}

		return {
			lastScanned: new Date().toISOString(),
			scanRoots: roots,
			skills: skillsEntries,
			extensions: extensionsEntries,
			prompts: promptsEntries,
		};
	}

	function writeCatalog() {
		const catalog = scanAll();
		const current = options.getSettings();
		options.setSettings({ ...current, catalog });
		if (options.notify) {
			options.notify(
				`Catalog: ${catalog.skills?.length ?? 0} skill(s), ${catalog.extensions?.length ?? 0} extension(s), ${catalog.prompts?.length ?? 0} prompt(s)`,
				"info",
			);
		}
	}

	return {
		refresh() {
			writeCatalog();
		},
		dispose() {
			// No-op
		},
	};
}
