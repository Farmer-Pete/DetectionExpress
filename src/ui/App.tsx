/**
 * The app shell. A useEffect builds the run controller, runs it on mount, and
 * disposes it on unmount, so render never drives the pipeline. React Strict Mode's
 * mount/unmount/mount cycle is safe: each effect builds a fresh controller and the
 * cleanup disposes it. The Run button reloads the current Algorithm source.
 *
 * Tests inject a controller through the `controller` prop, so the app never calls
 * the real loader or engine under test.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { createRunController, type RunController } from "../game/run-controller";
import { getGraph, useGameStore } from "../game/store";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { AlgorithmEditor } from "./AlgorithmEditor";
import { Briefing } from "./Briefing";
import { Hud } from "./hud/Hud";
import { Pipeline } from "./Pipeline";

function buildController(): RunController {
  return createRunController({
    scenario: kioskPinAttack,
    getGraph,
    getSource: () => useGameStore.getState().source,
    getSeed: () => useGameStore.getState().seed,
    setSnapshot: useGameStore.getState().setSnapshot,
    setError: useGameStore.getState().setError,
  });
}

export function App({ controller }: { controller?: RunController } = {}) {
  const controllerRef = useRef<RunController | null>(null);

  useEffect(() => {
    const active = controller ?? buildController();
    controllerRef.current = active;
    active.run();
    return () => {
      active.dispose();
      controllerRef.current = null;
    };
  }, [controller]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Detection Express</h1>
        <span className="slice-tag">Slice 1 &mdash; Spot the threat</span>
      </header>
      <Hud />
      <ReactFlowProvider>
        <Pipeline />
      </ReactFlowProvider>
      <Briefing text={kioskPinAttack.briefing} />
      <AlgorithmEditor onRun={() => controllerRef.current?.run()} />
    </div>
  );
}
