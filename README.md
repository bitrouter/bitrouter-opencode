# @bitrouter/opencode

An [opencode plugin](https://opencode.ai/docs/plugins/) that wires
[BitRouter](https://github.com/bitrouter/bitrouter) in as a provider. It
declares the provider for you, makes `bitrouter/auto` your default model,
discovers the available models from your BitRouter instance instead of shipping
a hard-coded list, and adds a BitRouter Cloud device login to `/connect`.

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
block itself, and sets `model` and `small_model` to `bitrouter/auto`, so you do
not need to write either one.

A `model` you set yourself always wins — the plugin only fills in what your
config leaves out.

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
| `config` | Declares the `bitrouter` provider (`@ai-sdk/openai-compatible`, the resolved base URL) seeded with whatever catalog is reachable at load time, and names `bitrouter/auto` as `model` and `small_model`. A `provider.bitrouter` block — or a `model` — you wrote yourself always wins; the hook only fills in what you left out. |
| `auth` | Offers the device login and the API-key method, and turns whichever credential is stored into provider options. An expired OAuth grant is refreshed per request and written back through `client.auth.set`. |
| `provider` | Re-discovers the live catalog via `GET ${baseUrl}/models` once a credential exists, so the model list reflects your account rather than the seed. The auto route leads the refreshed list too. If discovery fails it keeps the current list rather than blanking it. |

## The auto route

`bitrouter/auto` hands model choice back to BitRouter: the request carries
`auto` as its model and the gateway's routing policy picks the model per
request. It leads every catalog the plugin produces, and it is the default
`model` and `small_model`.

The rest of the catalog is still there. `bitrouter/auto` is the default, not
the only option — pin `bitrouter/anthropic/claude-opus-5` (or anything else
BitRouter serves) with `/models` or in `opencode.json` whenever you want one
specific model, and switch back whenever you do not.

Before you authenticate on cloud there is no token to discover with, so the
provider is seeded with the auto route alone. That is deliberate: without at
least one model the provider would not be selectable and you could not reach
`/connect` at all. The rest of the catalog fills in on first use.

Until BitRouter's own catalog lists `auto`, the plugin synthesizes the entry
with deliberately conservative capacities (128K context, 16K output). They are
the floor rather than the ceiling on purpose — `auto` may land on any model in
the ladder, and under-claiming compacts a session early where over-claiming
fails a request outright, mid-turn. The moment `/v1/models` serves an `auto`
entry of its own, that entry wins and carries the real numbers with no release
here.

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

**The model list only shows `bitrouter/auto`**

The catalog has not been fetched yet. Run `opencode auth login` and connect
BitRouter; the real list appears on the next request. `bitrouter/auto` itself
still works meanwhile — routing is the gateway's job, not the plugin's.

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
