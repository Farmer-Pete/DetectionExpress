import { describe, expect, it } from "vitest";
import { LEVEL_SEED } from "../game/tuning";
import { detect as defaultDetect, normalize as defaultNormalize } from "./default-engine";
import { isRawKioskV1, type RawKioskV1 } from "./endpoints/kiosk/formats/kiosk-v1";
import type { PipeEvent } from "./event";
import type { Finding } from "./finding";
import {
  buildReferenceAlgorithm,
  type ReferenceAlgorithm,
} from "./scenarios/kiosk-pin-attack/reference";
import { kioskPinAttack } from "./scenarios/kiosk-pin-attack/scenario";

/** Read an Event's kiosk-v1 payload, narrowing at the boundary. */
function raw(ev: PipeEvent): RawKioskV1 {
  if (!isRawKioskV1(ev.payload)) {
    throw new Error("expected a kiosk-v1 payload");
  }
  return ev.payload;
}

/**
 * Drive an Algorithm over the whole stream and collect its Findings, mirroring how the
 * engine runs Normalize then Detect: Normalize shapes the raw payload, then Detect reads
 * that shape plus the engine's `id`/`ts`/`endpoint` fields and returns a `Finding[]`.
 */
function collectFindings(algo: ReferenceAlgorithm, events: PipeEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const ev of events) {
    const norm = algo.normalize(raw(ev));
    const view = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
    findings.push(...algo.detect(view));
  }
  return findings;
}

describe("default engine parity with the reference Algorithm", () => {
  it("raises the same Findings as the reference twin on the kiosk stream", () => {
    const { events, attacks } = kioskPinAttack.generate(LEVEL_SEED);

    // The default engine holds module-level state, so this single pass is one clean run,
    // the way a fresh module import would replay it. The reference twin is a fresh
    // per-instance build, the independent source of truth.
    const defaultFindings = collectFindings(
      { normalize: defaultNormalize, detect: defaultDetect },
      events,
    );
    const referenceFindings = collectFindings(buildReferenceAlgorithm(), events);

    expect(defaultFindings).toEqual(referenceFindings);
    // Guard against a vacuous pass: both engines catch every Attack, one Finding each.
    expect(defaultFindings).toHaveLength(attacks.length);
  });
});
