/**
 * The door reducer: an engine projection over the frozen world, NOT a scheduler
 * actor. The scheduler gives an actor only immutable env, its rng, and its tick, and
 * ADR-0007 freezes the env, so a door that reacts to a staff grant cannot be an actor.
 * Instead the engine folds each tick's `door-reader` grants through this reducer after
 * all transitions: a grant opens the matching door, and the reducer closes it after a
 * dwell, emitting the `door-contact` open/close events the engine turns into readings.
 *
 * Door state is an engine projection over the frozen env, never a mutation of it. The
 * reducer is order-independent and deterministic: within a tick it closes expired
 * doors first, then opens the tick's grants, and it sorts both the close sweep and the
 * grants by `(location, door)` so the emitted events do not depend on the order the
 * grants arrived in. It reads no wall clock (ARCHITECTURE rule 8).
 */

/** A grant that opens a door, keyed by its location and door name. */
export interface DoorGrant {
  location: string;
  door: string;
}

/** A door open or close the reducer emits, which the engine turns into a reading. */
interface DoorContactEvent {
  location: string;
  door: string;
  event: "open" | "close";
}

/** One currently-open door in the projection. */
interface OpenDoor {
  location: string;
  door: string;
}

/** The stateful door projection the engine steps once per tick. */
export interface DoorReducer {
  /**
   * Fold one tick's grants into the projection at `tick`: close every door whose
   * dwell has elapsed, then open each granted door not already open. Returns the
   * close/open events in a deterministic order (closes first, each sorted), whatever
   * order the grants arrived in.
   */
  step(grants: readonly DoorGrant[], tick: number): DoorContactEvent[];
  /** The doors currently open, in a stable `(location, door)` order. */
  openDoors(): readonly OpenDoor[];
}

/** The projection's key for a door: `location::door`, unique across the world. */
function keyOf(grant: DoorGrant): string {
  return `${grant.location}::${grant.door}`;
}

/** Stable order for events and open doors: by location, then door name. */
function byLocationDoor(a: DoorGrant, b: DoorGrant): number {
  return a.location === b.location
    ? a.door.localeCompare(b.door)
    : a.location.localeCompare(b.location);
}

export function createDoorReducer(dwellTicks: number): DoorReducer {
  // Each open door keyed by `location::door` -> the tick it opened on.
  const open = new Map<string, { location: string; door: string; openedTick: number }>();

  return {
    step: (grants, tick) => {
      const events: DoorContactEvent[] = [];

      // 1. Close every door whose dwell has elapsed, in a stable order.
      const expired = [...open.values()]
        .filter((record) => tick - record.openedTick >= dwellTicks)
        .sort(byLocationDoor);
      for (const record of expired) {
        open.delete(keyOf(record));
        events.push({ location: record.location, door: record.door, event: "close" });
      }

      // 2. Open each granted door not already open, in a stable order. Sorting the
      //    grants first makes the emitted opens independent of arrival order.
      const sorted = [...grants].sort(byLocationDoor);
      for (const grant of sorted) {
        const key = keyOf(grant);
        if (!open.has(key)) {
          open.set(key, { location: grant.location, door: grant.door, openedTick: tick });
          events.push({ location: grant.location, door: grant.door, event: "open" });
        }
      }

      return events;
    },
    openDoors: () =>
      [...open.values()]
        .sort(byLocationDoor)
        .map((record) => ({ location: record.location, door: record.door })),
  };
}
