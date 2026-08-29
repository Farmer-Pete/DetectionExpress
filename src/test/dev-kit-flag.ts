// Vitest setup file. Sets `PUBLIC_DEV_KIT` in `process.env` before any test file
// imports `dev-flag.ts`, so the flag reads `true` and the test run exercises the
// dev-kit branch. The Vitest config carries no build-time define (unlike the Vite
// build), so this runtime env stands in for it, scoped to tests alone.
process.env.PUBLIC_DEV_KIT = "true";
