// First test preload (see bunfig.toml [test] preload). Registers happy-dom's
// DOM globals. This must run before any test file imports @testing-library,
// because Testing Library binds to `document` at import time.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
