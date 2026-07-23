# Stylesheet architecture

The files in this directory are the only authored CSS source. Every file under
`public/css/` is generated and must not be edited directly.

## Commands

- `npm run css:build` bundles and minifies the source manifests.
- `npm run css:check` builds the bundles, validates module order, rejects
  duplicate declarations, and enforces source/output size budgets.

`npm start` rebuilds CSS before startup and whenever Nodemon restarts after a
stylesheet change.

## Source layout

- Numbered root modules build the shared studio bundle through `index.css`.
- `auth-index.css` builds the authentication bundle.
- `pages/` owns page-specific styles.
- `shared/` owns styles used across otherwise independent pages.
- `shared/tokens.css` is the single theme surface (`:root` colors, type, space).
- `components/` owns portable component styles.

`scripts/build-css.js` is the bundle manifest and maps these sources to the
nine generated files under `public/css/`. Add new bundles there and give each
one an explicit output-size budget.

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
6. Keep bundle manifests import-only so cascade order remains visible and reviewable.
7. Never remove selectors based only on a text search: runtime JavaScript
   constructs state and component classes. Confirm removal with browser
   coverage and relevant UI tests.
8. Never hand-edit `public/css/`; change the owning source and rebuild.
