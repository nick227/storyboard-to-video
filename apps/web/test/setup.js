require('dotenv').config();
process.env.DATABASE_URL ||= 'postgresql://storyboard:storyboard@localhost:5432/storyboard';
// Must be set before any test file requires ../server (AuthService reads AUTH_TOKENS at
// construction). Per-file assignment in integration/library tests races with server.test.js.
process.env.AUTH_TOKENS ||= 'alice-token:alice,bob-token:bob';
process.env.ADMIN_OWNER_IDS ||= 'alice';
