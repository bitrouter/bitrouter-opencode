# @bitrouter/opencode

An [opencode plugin](https://opencode.ai/docs/plugins/) that wires
[BitRouter](https://github.com/bitrouter/bitrouter) in as a provider. It
declares the provider for you, discovers the available models from your
BitRouter instance instead of shipping a hard-coded list, and adds a BitRouter
Cloud device login to `/connect`.

BitRouter can run two ways:

- **Local daemon** (`http://127.0.0.1:4356`) — BYOK, your keys, your machine.
- **BitRouter Cloud** (`https://api.bitrouter.ai/v1`) — managed proxy, one bill.

By default the plugin picks for you: if a local daemon is serving models it uses
that (zero-login dev flow), otherwise it falls back to cloud. Set
`BITROUTER_TARGET` to force one.

## Install

Add the package to the `plugin` array in `opencode.json` — opencode fetches and
caches it automatically:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@bitrouter/opencode"]
}
```

That is the whole configuration. The plugin contributes the `provider.bitrouter`
block itself, so you do not need to write one.

Then authenticate:

```bash
opencode auth login
```

Pick **BitRouter** and choose either **BitRouter Cloud (device login)** — a
browser device-code flow, new accounts get free credits — or **API key** to
paste a `brvk_` key.

### Local development

Drop a checkout into a plugin directory opencode loads at startup —
`.opencode/plugins/` for one project, `~/.config/opencode/plugins/` globally.

## How it works

The plugin returns three [hooks](https://opencode.ai/docs/plugins/), one per
stage of the provider's life:

| Hook | What it does |
|---|---|
| `config` | Declares the `bitrouter` provider (`@ai-sdk/openai-compatible`, the resolved base URL) seeded with whatever catalog is reachable at load time. A `provider.bitrouter` block you wrote yourself always wins — the hook only fills in what you left out. |
| `auth` | Offers the device login and the API-key method, and turns whichever credential is stored into provider options. An expired OAuth grant is refreshed per request and written back through `client.auth.set`. |
| `provider` | Re-discovers the live catalog via `GET ${baseUrl}/models` once a credential exists, so the model list reflects your account rather than the seed. If discovery fails it keeps the current list rather than blanking it. |

Before you authenticate on cloud there is no token to discover with, so the
provider is seeded with a single placeholder model. That is deliberate:
without at least one model the provider would not be selectable and you could
not reach `/connect` at all. It is replaced by the real catalog on first use.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BITROUTER_TARGET` | _(auto)_ | `local` → daemon at `http://127.0.0.1:4356/v1`; `cloud` → `https://api.bitrouter.ai/v1`. Unset means: use local if it answers `/models`, else cloud. |
| `BITROUTER_BASE_URL` | _(derived from target)_ | Override the base URL for either mode. Takes precedence over the target default. |
| `BITROUTER_API_KEY` | _(unset)_ | Use this token directly and skip `/connect` entirely. Handy for CI. |
| `BITROUTER_OAUTH_AS` | `https://api.bitrouter.ai` | Authorization-server origin for device login. |
| `BITROUTER_OAUTH_CLIENT_ID` | `bitrouter-cli` | Public OAuth client id. |
| `BITROUTER_OAUTH_SCOPE` | _(CLI default set)_ | Space-separated scope string. |

### Local target

The local daemon defaults to `skip_auth: true`, so loopback requests are
admitted without a key — the plugin supplies a filler key so opencode surfaces
the provider anyway. To enable key-based auth, mint a virtual key:

```bash
bitrouter key sign --user <id>
```

Then paste the resulting `brvk_...` into `opencode auth login` → BitRouter →
API key, or export it as `BITROUTER_API_KEY`.

## Configuring by hand instead

If you would rather not run a plugin, [`examples/opencode.json`](examples/opencode.json)
declares the same provider statically. You lose dynamic model discovery and the
device login, and you maintain the model list yourself.

## Troubleshooting

**The model list only shows `kimi-k2.5`**

That is the placeholder — the catalog has not been fetched yet. Run
`opencode auth login` and connect BitRouter; the real list appears on the next
request.

**`model refresh failed at .../models: HTTP 401`**

The stored credential is rejected. Re-run `opencode auth login`, or check that
`BITROUTER_API_KEY` holds a valid `brvk_` key for a local target.

**Nothing reaches BitRouter at all**

Confirm the daemon is up with `bitrouter status` (start it with
`bitrouter start`), and that `BITROUTER_BASE_URL`, if set, points at a reachable
instance. The plugin logs to opencode's structured log under the `bitrouter`
service.

## Development

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

Logic lives in [`src/`](src) as pure, dependency-injected modules — target
resolution, catalog discovery, model mapping, the OAuth device flow — with
[`src/index.ts`](src/index.ts) as the thin opencode-facing composition layer.
BitRouter's cloud endpoints are in [`src/constants.ts`](src/constants.ts).

## License

Apache-2.0
