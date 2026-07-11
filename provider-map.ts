/**
 * Provider-name <-> API-shape lookup table.
 *
 * The Pi runtime expects each registered model to carry an `api` field that
 * tells it which wire protocol to use when calling the provider. Without this
 * the runtime rejects the constructed Model with "No API key for that model"
 * or fails at the HTTP layer.
 *
 * This table is the single source of truth for the mapping. Keep it small;
 * unknown providers fall back to `openai-completions` (the most common
 * OpenAI-compatible shape).
 *
 * Used by:
 *   - `applier.ts` (`applyModel`) to build a valid Model object.
 *   - `electron/ipc/runtime.ts` (`bootstrapEnvProviders`) via `envVarToProvider`.
 */

export const PROVIDER_API: Record<string, string> = {
	minimax: "openai-completions",
	anthropic: "anthropic-messages",
	openai: "openai-responses",
	google: "google-generative-ai",
	deepseek: "openai-completions",
};

/**
 * Look up the Pi `api` shape for a provider name. Falls back to
 * `openai-completions` for unknown providers, which works for most
 * OpenAI-compatible third-party providers.
 */
export function apiForProvider(name: string): string {
	return PROVIDER_API[name] ?? "openai-completions";
}

/**
 * Map an environment-variable name to a provider name.
 * Used to bootstrap the `providers` block from `process.env.*_API_KEY`
 * at agent start.
 *
 * Examples:
 *   "MINIMAX_API_KEY"        -> "minimax"
 *   "ANTHROPIC_API_KEY"      -> "anthropic"
 *   "AZURE_OPENAI_API_KEY"   -> null   (custom mapping needed; falls through)
 *
 * Unknown vars fall back to a lowercase-strip-suffix rule, so a hypothetical
 * `MY_PROVIDER_API_KEY` would map to `my_provider` (the user can correct this
 * via the Settings → Models UI).
 */
export function envVarToProvider(envVar: string): string | null {
	if (!envVar.endsWith("_API_KEY")) return null;
	const stem = envVar.slice(0, -"_API_KEY".length);
	const lower = stem.toLowerCase();
	// Explicit aliases for vars that don't follow the simple strip-suffix rule.
	const aliases: Record<string, string> = {
		openai: "openai",
		anthropic: "anthropic",
		minimax: "minimax",
		gemini: "google",
		deepseek: "deepseek",
	};
	return aliases[lower] ?? lower;
}
