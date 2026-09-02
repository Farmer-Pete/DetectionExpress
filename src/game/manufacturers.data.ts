/**
 * The manufacturer reference data: the five vendors and their wire-format
 * quirks. `sensor-catalogue.ts` (M2) and the integrity test read this. Ported
 * from the former `docs/world/manufacturers.json`, `$schema` stripped.
 */
import type { ManufacturerData } from "./sensor.types";

export const manufacturersData = {
  manufacturers: [
    {
      id: "gatekeep",
      name: "Gatekeep Industries",
      tagline: "Bolted to the floor since 1974.",
      description:
        "The incumbent. Gatekeep has been screwing turnstiles into concrete since before most riders were born. The hardware outlives everyone. The firmware has not shipped a real update in a decade, and it shows.",
      dataStyle:
        "SCREAMING_SNAKE_CASE keys, every field spelled out in full, ISO 8601 timestamps in UTC. Results are loud words like PERMIT and WRONG_PIN. Verbose and old-fashioned, but at least it is readable.",
      makes: ["kiosk", "fare-gate", "door-reader"],
    },
    {
      id: "veritap",
      name: "VeriTap",
      tagline: "Tap. Ride. Disrupt.",
      description:
        "The fintech upstart that thinks a fare gate is just a payment terminal wearing a hat. Slick app, aggressive roadmap, and a habit of deprecating fields mid-contract. Calls every card a mediaToken and every amount a value in cents.",
      dataStyle:
        "camelCase keys, Unix epoch in milliseconds, lowercase result strings like ok and declined with a separate reason field. Money always in integer cents. Trendy and terse.",
      makes: ["kiosk", "fare-gate", "tvm"],
    },
    {
      id: "railsense",
      name: "RailSense",
      tagline: "Survives the flood.",
      description:
        "The rugged operational vendor. RailSense sensors keep reporting through tunnel floods, power dips, and abuse that would kill anything from Gatekeep. The trade is documentation written by engineers who resent you, and payloads coded down to the byte.",
      dataStyle:
        "Short abbreviated keys, Unix epoch in milliseconds, and numeric codes instead of words. A result is rc:0, a direction is d:1, a line is an integer. Compact, cryptic, and allergic to vowels.",
      makes: ["fare-gate", "door-contact", "platform-camera", "train-tracker"],
    },
    {
      id: "sentinel",
      name: "Sentinel Grid",
      tagline: "Total situational awareness.",
      description:
        "The enterprise surveillance giant. Sentinel does not sell cameras, it sells platforms, and it will stamp every event six ways for the audit trail. The branding is one focus group away from openly dystopian.",
      dataStyle:
        "SCREAMING_SNAKE_CASE keys with EVENT_TS epoch-millisecond timestamps, spelled-out decision words like ALLOW and FORCED_OPEN, and a FACILITY plus PORTAL naming scheme that never matches anyone else's station or door codes.",
      makes: ["door-reader", "door-contact", "platform-camera", "network-relay", "occ-console"],
    },
    {
      id: "tetsudo",
      name: "Nippon Tetsudo Systems",
      tagline: "On time, to the second.",
      description:
        "The imported precision vendor, known to everyone as Tetsudo. Runs rolling stock and signals to the second and assumes you read the manual cover to cover. The support line is excellent if you speak the field names.",
      dataStyle:
        "Romaji key names (jikoku for time, ressha for train, meirei for command), local-time seconds since epoch, and full words for events. Precise and orderly, but the keys look like nothing else on the network.",
      makes: ["train-tracker", "network-relay", "occ-console"],
    },
  ],
} as const satisfies ManufacturerData;
