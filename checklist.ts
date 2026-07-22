/**
 * In-memory checklist store + journal emitter.
 *
 * The agent's "active checklist" is the plan the agent is currently working
 * through on the current turn. The truth extension owns this — when the
 * agent calls the `update_checklist` tool, we mutate the in-memory snapshot
 * and stream a ChecklistEvent to the telemetry journal so the renderer
 * can mirror the progress live.
 *
 * Storage strategy: the journal is the source of truth. The in-memory copy
 * here is the most-recent snapshot, used for tool responses and for the
 * restart path (which re-derives from disk via `getChecklistFromJournal`).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ChecklistItem {
	text: string;
	done: boolean;
}

export interface ChecklistState {
	taskName: string;
	items: ChecklistItem[];
}

let current: ChecklistState | null = null;

export function getChecklist(): ChecklistState | null {
	return current;
}

export function setChecklist(next: ChecklistState): void {
	current = {
		taskName: next.taskName,
		items: next.items.map((i) => ({ text: i.text, done: i.done })),
	};
}

export function clearChecklist(): void {
	current = null;
}

/**
 * Mark a single item done by its text. Returns true on hit, false otherwise.
 * No-op when no checklist is set.
 */
export function markItemDone(text: string): boolean {
	if (!current) return false;
	const item = current.items.find((i) => i.text === text);
	if (!item) return false;
	item.done = true;
	return true;
}

/**
 * Append a ChecklistEvent to the agent's telemetry journal.
 *
 * The journal path is `<agentDir>/telemetry.jsonl`. The renderer's
 * TelemetryTailer reads this file, so a single append lands in the
 * Overview tab's "Active checklist" accordion after the next debounce.
 *
 * Best-effort: I/O errors are swallowed (checklist updates are advisory
 * and must not crash the agent). The journal file path is owned by
 * superhive-pi-telemetry — we re-derive it here so the two extensions
 * stay decoupled (no cross-module import).
 */
export function emitChecklistToJournal(
	settingsFilePath: string,
	taskName: string,
	items: ChecklistItem[],
): void {
	try {
		const agentDir = dirname(settingsFilePath);
		const journalPath = `${agentDir}/telemetry.jsonl`;
		mkdirSync(agentDir, { recursive: true });
		const event = {
			ts: Date.now(),
			type: "checklist",
			taskName,
			items: items.map((i) => ({ text: i.text, done: i.done })),
		};
		appendFileSync(journalPath, `${JSON.stringify(event)}\n`);
	} catch {
		// best-effort; checklist updates are advisory
	}
}