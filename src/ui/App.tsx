/**
 * The app shell. A useEffect starts the engine once on mount and returns its
 * stop for cleanup, so render never drives the pipeline. React Strict Mode's
 * mount/unmount/mount cycle is safe: each start is self-contained and each stop
 * fully tears down.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";
import { start } from "../game/engine";
import { getGraph, getRate, useGameStore } from "../game/store";
import { Hud } from "./hud/Hud";
import { Pipeline } from "./Pipeline";

export function App() {
  useEffect(() => {
    const engine = start({
      getGraph,
      getRate,
      setSnapshot: useGameStore.getState().setSnapshot,
      onError: (error) => {
        console.error("Detection Dash engine stopped on an error:", error);
      },
    });
    return engine.stop;
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Detection Dash</h1>
        <span className="slice-tag">Slice 0 &mdash; Living stream</span>
      </header>
      <Hud />
      <ReactFlowProvider>
        <Pipeline />
      </ReactFlowProvider>
    </div>
  );
}
