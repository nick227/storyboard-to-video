require('dotenv').config();
process.env.DATABASE_URL ||= 'postgresql://storyboard:storyboard@localhost:5432/storyboard';
// Must be set before any test file requires ../server (AuthService reads AUTH_TOKENS at
// construction). Per-file assignment in integration/library tests races with server.test.js.
process.env.AUTH_TOKENS ||= 'alice-token:alice,bob-token:bob';
process.env.ADMIN_OWNER_IDS ||= 'alice';
// Tests assert payments-disabled behavior (e.g. webhook 503s without Stripe configured); don't
// let a developer's real .env Stripe keys leak in and change that. Empty-string (not delete) is
// required: server.js's own dotenv.config() call (via `require('../server')` in test files) only
// fills in keys absent from process.env, so a deleted key would just get reloaded from .env.
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';
