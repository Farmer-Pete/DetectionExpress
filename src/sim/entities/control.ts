/**
 * The control-room reference data: the small, CURATED, benign lists the M6 control
 * center and network actors read from `env.control`. Unlike the seeded pools in
 * `account.ts` / `badge.ts`, this is not drawn from an rng: it is a fixed, hand-authored
 * roster of authorized operators, their OCC consoles, the routine control-room commands
 * they issue, the site network hosts, and the internal destinations those hosts talk to.
 *
 * Every value is a genuine normalized value in the `sensors.json` domain (the console
 * example is `operator: "green.disp", host: "OCC-3", command: "EXPORT"`; the relay
 * example is `host: "BOARD-4", dest`, `bytes`), NOT invented flavor text (view notes
 * hazard 4). The commands are ordinary control-floor operations — a status check on a
 * signal, a departure-board refresh, a routine timetable export — never the Phantom
 * Signal / Dispatcher Overreach attack (that ships with a later hunt, out of scope).
 */

/** One authorized OCC console: the operator login seated at it and its console host id. */
export interface Console {
  /** The authorized operator login, e.g. `"green.disp"` (a line dispatcher). */
  readonly operator: string;
  /** The console host id on the control floor, e.g. `"OCC-3"`. */
  readonly host: string;
}

/** One benign control-room command and the routine target it acts on. */
interface ConsoleCommand {
  /** A routine control-floor command, e.g. `"STATUS"`, `"REFRESH"`, `"EXPORT"`. */
  readonly command: string;
  /** The benign operational target, e.g. a signal, a departure board, the timetable. */
  readonly target: string;
}

/** One site's network host: which site it sits at and its host id on the backbone. */
interface SiteHost {
  /** The site id the host lives at, e.g. `"dep"`. */
  readonly site: string;
  /** The host id on the control network, e.g. `"YARD-NET-1"`. */
  readonly host: string;
}

/** The inclusive whole-byte range a benign relay transfer stays within. */
interface ByteRange {
  readonly min: number;
  readonly max: number;
}

/** The whole control-room reference the M6 actors read from `env.control`. */
export interface ControlReference {
  /** The authorized consoles; the controller seats one operator fixture at each. */
  readonly consoles: readonly Console[];
  /** The benign command/target pairs an operator draws from. */
  readonly commands: readonly ConsoleCommand[];
  /** The site network hosts; the controller seats one host fixture at each. */
  readonly hosts: readonly SiteHost[];
  /** The benign internal destinations a host relays to. */
  readonly destinations: readonly string[];
  /** The benign whole-byte range a relay transfer stays within. */
  readonly byteRange: ByteRange;
}

/**
 * The authorized consoles: one per line dispatcher, each a `line.disp` login on its own
 * control-floor host. The operator names follow the `sensors.json` `"green.disp"` style.
 */
const CONSOLES: readonly Console[] = [
  { operator: "red.disp", host: "OCC-1" },
  { operator: "blue.disp", host: "OCC-2" },
  { operator: "green.disp", host: "OCC-3" },
];

/**
 * The benign command set. Each is a routine control-floor operation on a benign target:
 * a status check on a signal, a departure-board refresh, a routine timetable export.
 * None touch the rider database or a signal override, so no command here is the
 * Dispatcher Overreach attack.
 */
const COMMANDS: readonly ConsoleCommand[] = [
  { command: "STATUS", target: "SIGNAL-CEN" },
  { command: "STATUS", target: "SIGNAL-JCT" },
  { command: "REFRESH", target: "BOARD-CEN" },
  { command: "REFRESH", target: "BOARD-HAR" },
  { command: "EXPORT", target: "TIMETABLE" },
];

/** The site network hosts, one per staff site (matches `world.json`'s dep/sig/sub). */
const HOSTS: readonly SiteHost[] = [
  { site: "dep", host: "YARD-NET-1" },
  { site: "sig", host: "SIG-NET-1" },
  { site: "sub", host: "PWR-NET-1" },
];

/**
 * The benign internal destinations. A relay on the backbone links a site to the control
 * center, so benign traffic goes to internal OCC-core and control services, never an
 * external address (the `sensors.json` `"ext-9.211"` example is a wire illustration; a
 * benign backbone transfer stays inside the control network).
 */
const DESTINATIONS: readonly string[] = [
  "occ-core.1",
  "occ-core.2",
  "board-svc.10",
  "signal-svc.20",
];

/** Benign relay transfers: small whole-byte payloads (the `sensors.json` example is 512). */
const BYTE_RANGE: ByteRange = { min: 128, max: 1024 };

/** The single curated control-room reference the world controller puts in `env.control`. */
export const controlReference: ControlReference = {
  consoles: CONSOLES,
  commands: COMMANDS,
  hosts: HOSTS,
  destinations: DESTINATIONS,
  byteRange: BYTE_RANGE,
};
