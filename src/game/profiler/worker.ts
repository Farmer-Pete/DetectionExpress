/**
 * The profiler Web Worker: a thin shell over the pure modules. It loads the
 * player's module off the sim, adapts it, profiles it, and posts the outcome
 * back. All real logic lives in worker-support.ts, profile.ts, and calibrate.ts,
 * so this shell needs no test and holds no branching of its own.
 *
 * Browser only, and effectful: it imports and runs the player's code, exactly as
 * `loadAlgorithm` does. The main-thread wiring (spawn, terminate on a stale
 * generation) lands with the M2 run-controller changes, not here.
 */
import { loadAlgorithm } from "../algorithm";
import { profile } from "./profile";
import { adaptLoaded, parseRequest } from "./worker-support";

addEventListener("message", (event: MessageEvent) => {
  const request = parseRequest(event.data);
  void loadAlgorithm(request.source).then((algorithm) => {
    postMessage(profile(adaptLoaded(algorithm), { hidden: request.hidden }));
  });
});
