// Shows the current branch's open PR URL in the footer status area, if one exists.
// Refreshed at session start and after each agent turn (e.g. right after `gh pr create`).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pr-link";

export default function (pi: ExtensionAPI) {
	async function refresh(ctx: any) {
		try {
			const result = await pi.exec("gh", ["pr", "view", "--json", "url", "-q", ".url"], {
				cwd: ctx.cwd,
				timeout: 5_000,
			});
			const url = result.code === 0 ? result.stdout.trim() : "";
			ctx.ui.setStatus(STATUS_KEY, url ? ctx.ui.theme.fg("dim", url) : undefined);
		} catch {
			// ponytail: no gh CLI / not a GitHub repo / not authenticated — just hide the status
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => refresh(ctx));
}
