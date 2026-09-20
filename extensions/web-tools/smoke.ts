/**
 * Live smoke test — real network, run manually (not part of vitest):
 *
 *   npx tsx extensions/web-tools/smoke.ts
 *
 * Requires BRAVE_API_KEY. Run twice: the second run's fetches must report
 * cached: true (disk page cache persists across invocations).
 */

import { TtlLruCache } from "./cache.js";
import { openFetchStore } from "./fetch-store.js";
import type { SearchResponse } from "./types.js";
import { runWebSearch } from "./web-search.js";
import { runWebFetch } from "./web-fetch.js";

const searchCache = new TtlLruCache<{ response: SearchResponse; dropped: number }>(60_000, 100);
const fetchStore = openFetchStore();

function section(title: string): void {
	console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

async function main(): Promise<void> {
	if (!process.env.BRAVE_API_KEY) {
		console.error("BRAVE_API_KEY is not set.");
		process.exit(1);
	}

	section("1. web_search");
	const search = await runWebSearch(
		{ query: "Node.js streams backpressure", maxResults: 3 },
		{ cache: searchCache },
	);
	console.log(search.text);

	section("2. web_fetch — plain article");
	const article = await runWebFetch({ url: "https://example.com" }, { store: fetchStore });
	console.log(article.text.slice(0, 400));

	section("3. web_fetch — long docs page, first slice");
	const docs = await runWebFetch(
		{ url: "https://docs.astral.sh/uv/guides/scripts/", maxCharacters: 1000 },
		{ store: fetchStore },
	);
	const first = docs.details[0];
	console.log(docs.text.slice(0, 600));
	console.log(`\n[chars=${first.charCount} truncated=${first.truncated} nextOffset=${first.nextOffset}]`);

	section("4. web_fetch — offset continuation");
	if (first.nextOffset !== undefined) {
		const cont = await runWebFetch(
			{ url: "https://docs.astral.sh/uv/guides/scripts/", offset: first.nextOffset, maxCharacters: 1000 },
			{ store: fetchStore },
		);
		console.log(cont.text.slice(0, 600));
	}

	section("5. web_fetch — findText over the same page");
	const found = await runWebFetch(
		{ url: "https://docs.astral.sh/uv/guides/scripts/", findText: ["dependencies", "inline"] },
		{ store: fetchStore },
	);
	console.log(found.text.slice(0, 900));
	console.log(`\n[findText served fromCache=${found.details[0].fromCache}]`);

	section("Cache flags this invocation");
	console.log(`article fromCache: ${article.details[0].fromCache}`);
	console.log(`docs fromCache: ${docs.details[0].fromCache}`);
	console.log("\nRun this script again — both fetches should report cached: true.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
