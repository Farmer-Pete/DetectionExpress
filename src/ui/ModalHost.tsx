/**
 * Owns the `.app` / `.app-shell` structure and the browse-mode isolation invariant
 * (GH105-PLAN.md): while a modal is open, the shell goes `inert`, and every overlay
 * renders as a sibling of the inert shell, not a descendant of it. That split is what
 * keeps a screen reader's browse mode out of the shell: `inert` removes a subtree from
 * both the accessibility tree and keyboard focus at once, and a sibling overlay is
 * never part of that subtree in the first place.
 *
 * Dumb and presentational: no state, no logic beyond the two class-name branches.
 * Every overlay — `TraceOverlay`, `PlaceDialog`/`EventDialog`, and the side panel —
 * routes through it, so "the shell is inert while a modal is open" is one tested
 * invariant, not several copies of it.
 */
import type { ReactNode } from "react";

interface ModalHostProps {
  /** True while any overlay is open. Makes the shell inert, so AT browse mode and the
      keyboard cannot reach content behind the overlay. */
  modalOpen: boolean;
  /** An additive shell modifier class, e.g. "shake" (#106). "app-shell" is always present.
      Typed `| undefined`, not just optional, so a caller with `exactOptionalPropertyTypes`
      (this repo's tsconfig) can pass a conditional expression that evaluates to
      `undefined` directly, matching the convention at `ActorLayer.tsx` and
      `widgets.tsx`'s `WidgetList`, instead of omitting the prop key entirely. */
  shellExtraClass?: string | undefined;
  /** The overlays. Rendered as siblings of the inert shell, so they stay live. */
  overlays: ReactNode;
  children: ReactNode;
}

export function ModalHost({ modalOpen, shellExtraClass, overlays, children }: ModalHostProps) {
  const shellClass = shellExtraClass ? `app-shell ${shellExtraClass}` : "app-shell";
  return (
    <div className="app">
      <div className={shellClass} inert={modalOpen}>
        {children}
      </div>
      {overlays}
    </div>
  );
}
