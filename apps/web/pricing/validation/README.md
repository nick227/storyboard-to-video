# Provider pricing validation evidence

Files in this directory freeze the provider usage and documented pricing inputs used by a controlled validation run. They are audit evidence, not runtime billing configuration.

A manifest may be used to seed an active `ProviderPriceVersion` only after its `reconciliation.status` is `reconciled`. Dashboard amounts, rounding behavior, minimum charges, and reporting delay must be recorded without changing the original observed usage or documented rates. Corrections require a new manifest; historical manifests are append-only evidence.

Classification vocabulary:

- `observed`: returned by the provider API or directly visible in provider billing records.
- `documented`: copied from a dated provider pricing page.
- `estimated`: calculated from observed usage and documented inputs, but not confirmed by a per-request billing record.

Dezgo validation remains estimated unless a provider billing record can be tied to the request. Its seed is not a billing request ID.
