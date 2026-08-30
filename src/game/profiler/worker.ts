/**
 * The profiler Web Worker: a thin shell over the pure modules. It loads the
 * player's module off the sim, adapts it, profiles it, and posts the outcome
 * back. All real logic lives in worker-support.ts, profile.ts, and calibrate.ts,
 * so this shell needs no test and holds no branching of its own.
 *
 * Browser only, and effectful: it imports and runs the player's code, exactly as
 * `loadAlgorithm` does.
 *
 * It must ALWAYS post a structured outcome the run controller can parse, or the
 * controller's pending measurement never settles and the Run hangs with no
 * feedback. A player rule that returns a wrong shape makes `profile()` throw, and a
 * bad module makes `loadAlgorithm` reject; an unhandled worker rejection does not
 * fire the main thread's `onerror`. So the whole handler is wrapped in try/catch
 * AND the load promise carries a `.catch`: any load or profile failure posts
 * `{ ok: false, error }` instead of dying silently.
 */
import { loadAlgorithm } from "../algorithm";
import { profile } from "./profile";
import { adaptLoaded, parseRequest } from "./worker-support";

addEventListener("message", (event: MessageEvent) => {
  try {
    const request = parseRequest(event.data);
    loadAlgorithm(request.target)
      .then((algorithm) => {
        // `profile` can throw synchronously (a rule that returns a wrong shape);
        // that lands in this promise chain and is caught below.
        postMessage(profile(adaptLoaded(algorithm), { hidden: request.hidden }));
      })
      .catch((error: unknown) => {
        postMessage({ ok: false, error: String(error) });
      });
  } catch (error) {
    postMessage({ ok: false, error: String(error) });
  }
});
