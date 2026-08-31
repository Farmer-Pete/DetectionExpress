import { describe, expect, it } from "vitest";
import { LEVEL_SEED } from "../game/tuning";
import { detect as defaultDetect, normalize as defaultNormalize } from "./default-engine";
import { isRawKioskV1, type RawKioskV1 } from "./endpoints/kiosk/formats/kiosk-v1";
import type { PipeEvent } from "./event";
import type { DetectView, Finding } from "./finding";
import {
  buildReferenceAlgorithm,
  type ReferenceAlgorithm,
} from "./scenarios/pin-brute-force/reference";
import { pinBruteForce } from "./scenarios/pin-brute-force/scenario";

/** Read an Event's kiosk-v1 payload, narrowing at the boundary. */
function raw(ev: PipeEvent): RawKioskV1 {
  if (!isRawKioskV1(ev.payload)) {
    throw new Error("expected a kiosk-v1 payload");
  }
  return ev.payload;
}

/**
 * Drive the composed default engine over the whole stream. It parses each payload
 * through the endpoint-dispatching `normalize(raw, endpoint)`, then reads the flat
 * `DetectView` the engine builds and returns a `Finding[]`.
 */
function collectDefault(events: PipeEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const ev of events) {
    const norm = defaultNormalize(raw(ev), ev.endpoint);
    const view: DetectView = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
    findings.push(...defaultDetect(view));
  }
  return findings;
}

/** Drive the single-endpoint twin over the stream; its `normalize` takes just the raw. */
function collectTwin(twin: ReferenceAlgorithm, events: PipeEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const ev of events) {
    const norm = twin.normalize(raw(ev));
    const view = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
    findings.push(...twin.detect(view));
  }
  return findings;
}

describe("default engine parity with the reference Algorithm", () => {
  it("raises the same Findings as the reference twin on the kiosk stream", () => {
    const { events, attacks } = pinBruteForce.generate(LEVEL_SEED);

    // The default engine composes one rule instance at module load, so this single pass
    // is one clean run, the way a fresh module import would replay it. The reference twin
    // is a fresh per-instance build, the independent source of truth.
    const defaultFindings = collectDefault(events);
    const referenceFindings = collectTwin(buildReferenceAlgorithm(), events);

    expect(defaultFindings).toEqual(referenceFindings);
    // Guard against a vacuous pass: both engines catch every Attack, one hit each.
    // Watches (isPartial) also emit now, so count only the hits against the attacks.
    const hits = defaultFindings.filter((f) => f.isPartial !== true);
    expect(hits).toHaveLength(attacks.length);
  });
});

/** The concrete flat view both detect shapes read, event by event. */
interface KioskView {
  account: string;
  terminal: string;
  outcome: "success" | "fail";
  id: number;
  ts: number;
  endpoint: string;
}

/** One fail Event on account "amy" in the flat view detect() reads. */
function fail(id: number, ts: number): KioskView {
  return { account: "amy", terminal: "KIOSK-01", outcome: "fail", id, ts, endpoint: "kiosk-v1" };
}

describe.each([
  // The composed engine's detect reads the engine's `DetectView`; the concrete view
  // widens to it through a fresh spread at this boundary.
  ["default engine", () => ({ detect: (v: KioskView) => defaultDetect({ ...v }) })],
  ["reference twin", () => buildReferenceAlgorithm()],
])("%s watch-to-hit promotion", (_name, build) => {
  it("emits four anchored watches, then one hit on the same anchor and reason", () => {
    const algo = build();
    const perStep: Finding[][] = [];
    for (let i = 0; i < 5; i++) {
      perStep.push(algo.detect(fail(i, i * 10)));
    }

    // Fails 1..4: a watch each, anchored on the first fail (id 0), grouped by account,
    // partial, with an "N of 5 wrong PINs" text widget.
    for (let n = 1; n <= 4; n++) {
      const findings = perStep[n - 1] ?? [];
      expect(findings).toHaveLength(1);
      const watch = findings[0];
      expect(watch?.isPartial).toBe(true);
      expect(watch?.eventId).toBe(0);
      expect(watch?.subjectType).toBe("account");
      expect(watch?.alert.reason).toBe("pin_brute_force");
      expect(watch?.context).toEqual([{ type: "text", text: `${n} of 5 wrong PINs` }]);
    }

    // The 5th fail: a hit on the same anchor and reason, no isPartial, a kv widget
    // summarizing the burst (wrong PINs, threshold, window) so a fresh run demos the
    // Judge node.
    const hitFindings = perStep[4] ?? [];
    expect(hitFindings).toHaveLength(1);
    const hit = hitFindings[0];
    expect(hit?.isPartial).toBeUndefined();
    expect(hit?.eventId).toBe(0);
    expect(hit?.subjectType).toBe("account");
    expect(hit?.alert.reason).toBe("pin_brute_force");
    expect(hit?.context).toEqual([
      {
        type: "kv",
        entries: [
          { label: "wrong PINs", value: 5 },
          { label: "threshold", value: 5 },
          { label: "window", value: "5:00" },
        ],
      },
    ]);
    expect(hit?.alert.eventIds).toEqual([0, 1, 2, 3, 4]);
  });
});
