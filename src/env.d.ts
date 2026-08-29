// Ambient module declarations so TypeScript accepts non-code imports that
// Vite's bundler handles at build time.
declare module "*.css";
declare module "*.svg";

// The dev-kit flag is read as `process.env.PUBLIC_DEV_KIT` (dot form), which Vite
// inlines at build time via `define`. Declaring it a real property lets TypeScript
// accept the dot access under `noPropertyAccessFromIndexSignature`, and Vite still
// replaces the literal expression.
declare namespace NodeJS {
  interface ProcessEnv {
    PUBLIC_DEV_KIT?: string;
  }
}
