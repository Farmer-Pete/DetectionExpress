import { describe, expect, it } from "vitest";
import type { Alert } from "../sim/alert";
import { isRawKioskV1, type RawKioskV1 } from "../sim/endpoints/kiosk/formats/kiosk-v1";
import type { PipeEvent } from "../sim/event";
import {
  buildReferenceAlgorithm,
  type ReferenceAlgorithm,
} from "../sim/scenarios/kiosk-pin-attack/reference";
import { kioskPinAttack } from "../sim/scenarios/kiosk-pin-attack/scenario";
import { match as defaultMatch, normalize as defaultNormalize } from "./default-engine";
import { LEVEL_SEED } from "./tuning";

/** Read an Event's kiosk-v1 payload, narrowing at the boundary. */
function raw(ev: PipeEvent): RawKioskV1 {
  if (!isRawKioskV1(ev.payload)) {
    throw new Error("expected a kiosk-v1 payload");
  }
  return ev.payload;
}

/**
 * Drive an Algorithm over the whole stream and collect its Alerts, mirroring how
 * the engine runs Normalize then Match: Normalize shapes the raw payload, then
 * Match reads that shape plus the engine's `id`/`ts`/`endpoint` fields.
 */
function collectAlerts(algo: ReferenceAlgorithm, events: PipeEvent[]): Alert[] {
  const alerts: Alert[] = [];
  for (const ev of events) {
    const norm = algo.normalize(raw(ev));
    const view = { ...norm, id: ev.id, ts: ev.ts, endpoint: ev.endpoint };
    const alert = algo.match(view);
    if (alert) {
      alerts.push(alert);
    }
  }
  return alerts;
}

describe("default engine parity with the reference Algorithm", () => {
  it("raises the same Alerts as the reference twin on the kiosk stream", () => {
    const { events, attacks } = kioskPinAttack.generate(LEVEL_SEED);

    // The default engine holds module-level state, so this single pass is one
    // clean run, the way a fresh module import would replay it. The reference twin
    // is a fresh per-instance build, the independent source of truth.
    const defaultAlerts = collectAlerts(
      { normalize: defaultNormalize, match: defaultMatch },
      events,
    );
    const referenceAlerts = collectAlerts(buildReferenceAlgorithm(), events);

    expect(defaultAlerts).toEqual(referenceAlerts);
    // Guard against a vacuous pass: both engines catch every Attack, one Alert each.
    expect(defaultAlerts).toHaveLength(attacks.length);
  });
});
