// Test preload. Sets `PUBLIC_DEV_KIT` in `process.env` before any test file imports
// `dev-flag.ts`, so the flag reads `true` and `bun test` exercises the dev-kit branch.
// `bun test` does not apply a bundler define, so this stands in for it, scoped to
// tests alone.
process.env.PUBLIC_DEV_KIT = "true";
