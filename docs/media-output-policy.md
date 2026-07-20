# Media output policy

Image and video generation use one server-authoritative policy in
`apps/web/src/shared/media-output-policy.js`. Clients submit intent; only the server maps that intent
to provider parameters.

## Intent and precedence

The public intent is an aspect ratio plus `draft`, `standard`, `high`, or `ultra`. Image quality is
an independent `low`, `medium`, or `high` value. Effective settings are merged in this order:

1. platform defaults from `MEDIA_*` environment settings;
2. user defaults, copied when a project is created;
3. the project's `mediaSettings` snapshot;
4. an optional generation request `outputIntent`.

User preferences are never consulted for an existing project. Changing them only changes projects
created afterward.

Legacy projects without `mediaSettings` retain the former effective defaults: 1024x1024 standard,
medium-quality images and 640x480 draft LTX video. Once a shared project aspect ratio is selected,
both modalities use it.

## Resolution and provider execution

The policy returns `{ requested, resolved }`. `resolved` contains provider/model/mode, actual
dimensions, quality, duration, and the exact provider settings. Unsupported tuples throw
`UNSUPPORTED_MEDIA_OUTPUT`; there is no downgrade path.

Provider adapters require the resolved selection. The old `OPENAI_IMAGE_SIZE`, `VIDEO_WIDTH`, and
`VIDEO_HEIGHT` adapter defaults are no longer used. Requested and resolved values are stored in:

- image/video versions and generation manifests;
- video attempt recovery snapshots;
- generation-request input metadata and usage events;
- billing estimates and provider-cost snapshots;
- manifest hashes used for stale-output detection.

`POST /api/media-output/quote` resolves a selection and returns unit and batch estimates. `GET
/api/media-output/policy` exposes the intent vocabulary and current platform defaults.

## Billing

Resolution tiers do not have site-token prices. A quote is calculated from the resolved provider
usage tuple. Existing token-component and step-based rate cards remain supported; the `matrix` rate
card prices discrete tuples such as model + `1080P` + six seconds.

```json
{
  "type": "matrix",
  "entries": [
    {
      "when": { "resolution": "1080P", "seconds": 6 },
      "quantityKey": "videos",
      "nanoUsdPerUnit": 1000000000
    }
  ]
}
```

Before a provider call, billing calculates the resolved-output estimate and reserves site credits.
The configured static reservation remains a conservative floor for prompt/reference usage that is
unknown before execution. Completion settles against observed or provider-estimated usage, charging
any difference or refunding unused reserved credits. New provider/model/output tuples must receive a
validated price-card version before customer charging is enabled.

## User and project APIs

- `GET /api/auth/preferences/media` reads the authenticated user's defaults.
- `PUT /api/auth/preferences/media` replaces those defaults.
- New projects copy the current user defaults into `project.mediaSettings`.
- Existing projects store their own media settings in the project document.

The studio settings panel shows resolved image/video dimensions and batch token estimates and can
save the current selection as the user's defaults for future projects.
