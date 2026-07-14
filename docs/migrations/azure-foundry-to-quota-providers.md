# Migration Handoff: azure-foundry → quota-providers

**Status:** pending user action. Both extensions currently coexist; `extensions/azure-foundry/` is intentionally still in the tree so your live Foundry access keeps working until this migration is done.

## Goal

Move Azure Foundry off the bespoke `extensions/azure-foundry/` extension and onto the generic `extensions/quota-providers/` framework, where Foundry becomes an *out-of-repo* implementation module plugged in through typed seams. The generic extension already ships in this repo; what's missing is (1) a Foundry implementation module living outside this repo, and (2) a `~/.pi/agent/quota-providers.json` config pointing at it. Only after those are verified do you delete `extensions/azure-foundry/`.

Why the impl lives out-of-repo: this repo keeps only the generic, provider-agnostic core. Provider-specific logic (the `az` calls) is yours to own at a path of your choosing.

## Background: how the pieces fit

- The `quota-providers` extension reads `~/.pi/agent/quota-providers.json`, loads each configured implementation module via **jiti** (so it can be TypeScript), and registers pi providers from the models the impl discovers.
- Discovery, token fetch, and usage polling run **out-of-band** in `extensions/quota-providers/runner.mjs` (a plain-node child process), never on pi's startup path. The runner loads your impl module and calls its seam functions. Because the runner is an ordinary Node process, your impl may freely use `node:child_process` to shell out to `az`.
- The core owns all caching, token soft/hard expiry margins, background refresh, the spend ledger, and quota enforcement. Your impl only supplies raw facts.
- Config keys `module`, `enabled`, `bypassAllowed`, `lookaheadHours`, `maxPollSeconds`, `enforceHardCap` are consumed as policy. **Every other key** in a provider's config block passes through verbatim as `ctx.settings` to your seam functions. This is how Foundry's endpoint/account/resource-group reach the impl — as settings, not env vars.

## The seam contract

Your module's default export must satisfy `ProviderImplementation` (see `extensions/quota-providers/lib/types.ts`). Import it type-only so there's no runtime coupling to this repo:

```ts
import type {
  ProviderImplementation,
  ImplContext,
  ModelEntry,
  TokenResult,
  UsageSnapshot,
} from "<path-to-repo>/extensions/quota-providers/lib/types.ts";
```

(Type-only imports are erased at runtime, so the path only matters to your editor/typechecker — pick whatever resolves for you. If you'd rather not point at this repo at all, copy the four interface declarations into your module.)

Seams:
- `discoverModels(ctx) → ModelEntry[]` — list the models. Runs in the runner.
- `getToken(ctx) → { token, expiresAt }` — fetch ONE fresh token. No caching here; the core caches with a 5-min soft / 30-s hard margin. `expiresAt` is epoch ms.
- `getUsage?(ctx) → UsageSnapshot` — optional. Omit it and Foundry simply gets no quota enforcement (discovery + auth still work). See "Usage seam" below.

## Step 1 — write the Foundry implementation module

This is a direct port of the logic currently in `extensions/azure-foundry/foundry-helper.mjs` and the backend/catalog mapping from `extensions/azure-foundry/index.ts`. Save it wherever you keep personal tooling, e.g. `~/providers/azure-foundry/impl.ts`.

```ts
import { execFileSync } from "node:child_process";
import type {
  ProviderImplementation,
  ImplContext,
  ModelEntry,
  TokenResult,
  UsageSnapshot,
} from "/home/alenna/repos/my-pi/extensions/quota-providers/lib/types.ts";

// --- settings shape (comes from the config block, minus policy keys) ---
interface FoundrySettings {
  endpoint: string;         // https://<x>.services.ai.azure.com  (no trailing slash)
  account: string;          // Cognitive Services account name
  resourceGroup: string;    // Azure resource group
  subscription?: string;    // optional subscription name/id
  tokenResource?: string;   // AAD audience; default below
}

function readSettings(ctx: ImplContext): FoundrySettings {
  const s = ctx.settings as Record<string, unknown>;
  const endpoint = String(s.endpoint ?? "").replace(/\/+$/, "");
  const account = String(s.account ?? "");
  const resourceGroup = String(s.resourceGroup ?? "");
  if (!endpoint || !account || !resourceGroup) {
    throw new Error("azure-foundry impl: endpoint, account, resourceGroup are required in config");
  }
  return {
    endpoint,
    account,
    resourceGroup,
    subscription: s.subscription ? String(s.subscription) : undefined,
    tokenResource: s.tokenResource ? String(s.tokenResource) : undefined,
  };
}

const DEFAULT_TOKEN_RESOURCE = "https://cognitiveservices.azure.com";

// az with no shell — avoids injection via account/rg/subscription strings.
function az(args: string[], timeoutMs: number): string {
  return execFileSync("az", args, { encoding: "utf-8", timeout: timeoutMs });
}

// Foundry deployment format/capabilities → pi api + pi-ai catalog provider + base path.
// Ported from foundry-helper.mjs resolveBackend + index.ts BACKENDS/PI_AI_PROVIDER.
function mapBackend(
  format: string | undefined,
  caps: Record<string, string>,
): Pick<ModelEntry, "api" | "catalogProvider" | "baseUrlPath" | "authHeader"> | null {
  if (format === "Anthropic") {
    return {
      api: "anthropic-messages",
      catalogProvider: "anthropic",
      baseUrlPath: "/anthropic",
      authHeader: true, // Azure Foundry rejects x-api-key-only for Anthropic
    };
  }
  if (format === "OpenAI") {
    if (caps.responses === "true") {
      return { api: "openai-responses", catalogProvider: "azure-openai-responses", baseUrlPath: "/openai/v1", authHeader: false };
    }
    if (caps.chatCompletion === "true") {
      return { api: "openai-completions", catalogProvider: "azure-openai-responses", baseUrlPath: "/openai/v1", authHeader: false };
    }
  }
  return null; // embeddings / non-chat / unknown
}

const impl: ProviderImplementation = {
  id: "azure-foundry",
  name: "Azure Foundry",
  // baseUrl is read per-call from settings; set a placeholder that the extension
  // combines with each model's baseUrlPath. It MUST match your endpoint.
  get baseUrl() {
    // If your endpoint is static you can hardcode it; otherwise the extension
    // reads this once at registration, so returning the env/settings value is fine.
    return process.env.AZURE_FOUNDRY_ENDPOINT?.replace(/\/+$/, "") ?? "";
  },

  async discoverModels(ctx: ImplContext): Promise<ModelEntry[]> {
    const { account, resourceGroup, subscription } = readSettings(ctx);
    const args = ["cognitiveservices", "account", "deployment", "list", "-n", account, "-g", resourceGroup];
    if (subscription) args.push("--subscription", subscription);
    args.push("-o", "json");

    const items = JSON.parse(az(args, 30_000)) as any[];
    const models: ModelEntry[] = [];
    for (const item of items) {
      const props = item?.properties ?? {};
      if (props.provisioningState !== "Succeeded") continue;
      const mapped = mapBackend(props.model?.format, props.capabilities ?? {});
      if (!mapped) continue;
      models.push({
        id: item.name,                 // deployment name → sent to the API
        modelName: props.model?.name,  // catalog key for metadata lookup
        ...mapped,
      });
    }
    return models;
  },

  async getToken(ctx: ImplContext): Promise<TokenResult> {
    const { tokenResource } = readSettings(ctx);
    const resource = tokenResource ?? DEFAULT_TOKEN_RESOURCE;
    const raw = az(["account", "get-access-token", "--resource", resource, "-o", "json"], 15_000).trim();
    const parsed = JSON.parse(raw) as { accessToken?: string; expiresOn?: string };
    if (!parsed.accessToken) throw new Error("azure-foundry impl: az returned no accessToken — is `az login` valid?");
    const expiresAt = new Date(parsed.expiresOn ?? "").getTime();
    if (Number.isNaN(expiresAt)) throw new Error(`azure-foundry impl: could not parse expiresOn: "${parsed.expiresOn}"`);
    return { token: parsed.accessToken, expiresAt };
  },

  // OPTIONAL — omit entirely if you don't want quota enforcement for Foundry.
  // async getUsage(ctx: ImplContext): Promise<UsageSnapshot> { ... see below ... },
};

export default impl;
```

Notes:
- **baseUrl.** The extension reads `impl.baseUrl` once at registration and prepends it to each model's `baseUrlPath`. If your endpoint is static, hardcode it as a plain string field instead of the getter above — simplest and clearest. The getter fallback to `AZURE_FOUNDRY_ENDPOINT` only helps if you still export that env var.
- The token stale-fallback, expiry margins, and background refresh that used to live in `foundry-helper.mjs` are **gone from your code** — the core runner owns them now. `getToken` just does one raw fetch.
- Keep `az` calls shell-free (`execFileSync`, not a shell string) so account/rg/subscription can't inject.

## Step 2 — write `~/.pi/agent/quota-providers.json`

```jsonc
{
  "providers": {
    "azure-foundry": {
      "module": "~/providers/azure-foundry/impl.ts",   // path to Step 1 module; ~ is expanded

      // --- policy (all optional; defaults shown) ---
      "enabled": true,
      "bypassAllowed": true,
      "lookaheadHours": 6,
      "maxPollSeconds": 300,
      "enforceHardCap": false,

      // --- everything below passes through as ctx.settings ---
      "endpoint": "https://YOUR-foundry.services.ai.azure.com",
      "account": "YOUR-cognitive-services-account",
      "resourceGroup": "YOUR-resource-group",
      "subscription": "OPTIONAL-sub-name-or-id",
      "tokenResource": "https://cognitiveservices.azure.com"
    }
  }
}
```

The provider id key (`"azure-foundry"`) must match `impl.id`; it's also the cache-dir name under `~/.pi/agent/cache/quota-providers/azure-foundry/`.

## Step 3 — verify (before deleting anything)

Run these; do not remove `extensions/azure-foundry/` until they pass. To avoid disturbing a live session, you can point at a throwaway agent dir with `PI_CODING_AGENT_DIR`, but the config path there must match.

1. **Models list** — `pi --list-models` shows `azure-foundry-anthropic-messages` / `azure-foundry-openai-responses` providers (now sourced from quota-providers, alongside the old ones — expect duplicates until Step 4).
2. **Token flows** — select a quota-providers Foundry model and send one prompt; it should complete. First run blocks briefly while the runner populates the token cache.
3. **Caches populate** — `ls ~/.pi/agent/cache/quota-providers/azure-foundry/` shows `models.json` and `token.json`.
4. **If you implemented `getUsage`** — `/quota` shows spend/quota/reset for azure-foundry, and a `usage.json` appears within one poll interval.

While both extensions are registered you'll see two copies of each Foundry provider (`azure-foundry-*` from the old extension AND from the new one). That's expected and harmless during verification; Step 4 removes the old copy.

## Step 4 — remove the old extension (the deferred plan Step 16)

Once Step 3 passes:

```
git rm -r extensions/azure-foundry
git commit -m "remove azure-foundry: superseded by quota-providers Foundry impl"
```

Then `/reload` (or restart pi) so the running process drops the old provider. Verify `pi --list-models` now shows exactly one set of `azure-foundry-*` providers.

Also drop the old cache dir if you like: `rm -rf ~/.pi/agent/cache/azure-foundry`.

> ⚠️ Deleting `extensions/azure-foundry/` while a pi process has it loaded breaks that process's Foundry token resolution immediately (this bit us during implementation). Reload/restart right after the commit, and don't delete it until Step 3 has actually passed on the new path.

## Usage seam (optional, the quota feature)

`getUsage` is what turns on pro-rated backpressure. It must return real provider facts:

```ts
interface UsageSnapshot {
  spend: number;       // window-to-date, dollars
  quota: number;       // window hard limit, dollars
  windowStart: number; // epoch ms
  windowEnd: number;   // epoch ms — reset time
  asOf: number;        // epoch ms — spend is authoritative up to here
}
```

For Azure, spend comes from Cost Management (e.g. `az costmanagement query ...`), which **lags hours to a day**. Set `asOf = Date.now() - lagMs` (your estimate of that lag) rather than `now`; the core keeps a local per-message ledger on top of the snapshot for costs newer than `asOf`, so lag doesn't let spend silently run past the line. `windowStart`/`windowEnd`/`quota` describe the upstream billing window and its hard cap — provider facts, not your policy. Leave `getUsage` unimplemented for now if you just want discovery+auth parity with the old extension; add it later when you want the quota behavior.

## Reference points in this repo

- Seam types: `extensions/quota-providers/lib/types.ts`
- Runner (how seams are invoked, caching): `extensions/quota-providers/runner.mjs`
- Registration/grouping/catalog lookup: `extensions/quota-providers/lib/registration.ts`
- A working reference impl exercising all three seams: `extensions/quota-providers/test/fake-impl.ts`
- Old logic being ported: `extensions/azure-foundry/foundry-helper.mjs`, `extensions/azure-foundry/index.ts`
- Design rationale: `docs/decisions/DR-040`…`DR-043`
