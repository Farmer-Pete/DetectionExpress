/**
 * Which mode is on screen. Only the visible mode's loop runs (App.tsx,
 * usePipelineController, useWorldController). Shared here so the view toggle and
 * both lifecycle hooks agree on one union instead of each declaring its own copy.
 */
export type View = "pipeline" | "metro";
