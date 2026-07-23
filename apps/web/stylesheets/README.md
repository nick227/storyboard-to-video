# Stylesheet architecture

The files in this directory are the authored CSS source. The files in
`public/` are generated browser assets and must not be edited directly.

## Commands

- `npm run css:build` bundles and minifies the source manifests.
- `npm run css:check` builds the bundles, validates module order, rejects
  duplicate declarations, and enforces source/output size budgets.

`npm start` rebuilds CSS before startup and whenever Nodemon restarts after a
stylesheet change.

## Bundles

- `index.css` produces `public/styles.css` for the studio and shared legacy
  pages.
- `auth-index.css` produces the small, page-specific `public/auth.css` bundle.

Additional page bundles should import only their shared foundations and owned
feature modules. Do not make a page import the full studio bundle for one
component.

## Ownership rules

1. Each selector has one owning module. Responsive and state variants belong
   with the component whenever a module is reorganized.
2. Preserve semantic component names. State uses `.is-*`, ARIA attributes, or
   `data-*` attributes.
3. Prefer design tokens for repeated system values. Do not create a token for
   a one-off measurement.
4. Reuse a component or a small layout object only when the same pattern
   occurs at least three times. Avoid spacing and typography utility classes.
5. Avoid IDs and `!important` in new selectors. Existing exceptions can be
   removed incrementally when their cascade dependencies are understood.
6. Keep `index.css` import-only so cascade order remains visible and reviewable.
7. Never remove selectors based only on a text search: runtime JavaScript
   constructs state and component classes. Confirm removal with browser
   coverage and relevant UI tests.
