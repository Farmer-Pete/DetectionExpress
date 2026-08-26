// Removes the dev-only guard block from the built HTML, so the production
// bundle never carries the "dev server not running" fallback. Runs after
// `bun build` (see the build script in package.json).
const file = "dist/index.html";
const html = await Bun.file(file).text();
const stripped = html.replace(/\s*<!-- dev-guard:start[\s\S]*?dev-guard:end -->/g, "");
await Bun.write(file, stripped);
console.log(`postbuild: stripped dev guard from ${file}`);
