/**
 * The sensor reference data: what each sensor reads, where it sits, and the
 * vendors that build it. `sensor-catalogue.ts` (M2) and the integrity test read
 * this. Ported from the former `docs/world/sensors.json`, `$schema` stripped.
 */
import type { SensorData } from "./sensor.types";

export const sensorsData = {
  sensors: [
    {
      id: "kiosk",
      name: "Account kiosk",
      description:
        "The touchscreen where riders sign in, check a balance, or reset a PIN. Wash your hands after using it, because everyone touches this thing.",
      foundAt: {
        summary: "In the public concourse of every station, before the fare gates.",
        zones: ["z0"],
        stations: ["all"],
      },
      normalizedExample: {
        ts: 1756433643,
        account: "river.k",
        station: "har",
        terminal: "K3",
        outcome: "wrong_pin",
      },
      manufacturers: [
        {
          manufacturerId: "gatekeep",
          model: "Gatekeep AccessPoint 200",
          quirk:
            "ISO timestamp string and loud SCREAMING_SNAKE keys. You parse a date before you can do anything.",
          exampleRaw: {
            EVENT_TIME: "2025-08-29T02:14:03Z",
            ACCOUNT_ID: "river.k",
            STATION_CODE: "HAR",
            TERMINAL_NO: "K3",
            AUTH_RESULT: "WRONG_PIN",
          },
        },
        {
          manufacturerId: "veritap",
          model: "VeriTap Portal",
          quirk:
            "Epoch milliseconds, and the failure reason hides in a second field. 'declined' plus reason 'pin' means wrong PIN.",
          exampleRaw: {
            ts: 1756433643000,
            acctRef: "river.k",
            stn: "HAR",
            kioskId: "K3",
            result: "declined",
            reason: "pin",
          },
        },
      ],
    },
    {
      id: "fare-gate",
      name: "Fare gate",
      description:
        "The turnstile that guards the paid area. You must have a sufficient balance or no train for you.",
      foundAt: {
        summary: "At the paid-area boundary of every station.",
        zones: ["z0", "z1"],
        stations: ["all"],
      },
      normalizedExample: {
        ts: 1756433643,
        card: "C09",
        station: "cen",
        line: "red",
        direction: "in",
        result: "ok",
        balance: 250,
      },
      manufacturers: [
        {
          manufacturerId: "gatekeep",
          model: "Gatekeep TurnKey 5",
          quirk:
            "Direction is the word ENTRY or EXIT, result is PERMIT or REJECT, and the card is a MEDIA_SERIAL.",
          exampleRaw: {
            EVENT_TIME: "2025-08-29T02:14:03Z",
            MEDIA_SERIAL: "C09",
            STATION_CODE: "CEN",
            LINE_ID: "RED",
            DIRECTION: "ENTRY",
            GATE_RESULT: "PERMIT",
            STORED_VALUE: 250,
          },
        },
        {
          manufacturerId: "veritap",
          model: "VeriTap FlowGate",
          quirk:
            "Balance is in integer cents, not currency units. 25000 here is 250.00, the same balance the others write as 250.",
          exampleRaw: {
            ts: 1756433643000,
            mediaToken: "C09",
            stn: "CEN",
            line: "red",
            dir: "in",
            res: "ok",
            balanceCents: 25000,
          },
        },
        {
          manufacturerId: "railsense",
          model: "RailSense GateNode",
          quirk: "Everything is a code. You need the lookup table to read a single event.",
          exampleRaw: {
            t: 1756433643000,
            card: "C09",
            st: "CEN",
            ln: 3,
            d: 1,
            rc: 0,
            bal: 250,
          },
        },
      ],
    },
    {
      id: "tvm",
      name: "Ticket vending machine",
      description:
        "The machine that sells fares, tops up cards, and issues refunds. It handles money, so it draws fraud like ants to a picnic.",
      foundAt: {
        summary: "In the public concourse of every station.",
        zones: ["z0"],
        stations: ["all"],
      },
      normalizedExample: {
        ts: 1756433643,
        card: "4111XXXX0001",
        station: "end",
        machine: "T7",
        amount: 100,
        kind: "topup",
      },
      manufacturers: [
        {
          manufacturerId: "veritap",
          model: "VeriTap Vend",
          quirk:
            "The only maker of this sensor, so at least it is consistent. Amounts in cents, transaction type in UPPERCASE, card as a mediaToken.",
          exampleRaw: {
            ts: 1756433643000,
            mediaToken: "4111XXXX0001",
            stn: "END",
            tvmId: "T7",
            amountCents: 10000,
            txnType: "TOPUP",
          },
        },
      ],
    },
    {
      id: "door-reader",
      name: "Door reader",
      description:
        "The badge reader on a staff or restricted door. If you don't have the right badge, it hates you. If you have the right one, it'll let you in, but it still hates you.",
      foundAt: {
        summary:
          "On every door between the paid area and the control zone, at stations, depots, signal cabins, the substation, and the control center.",
        zones: ["z1", "z2", "z3", "z4"],
        stations: ["all"],
        sites: ["dep", "sig", "sub", "occ"],
      },
      normalizedExample: {
        ts: 1756433643,
        badge: "B204",
        site: "occ",
        door: "MAIN",
        zone: "z4",
        result: "grant",
      },
      manufacturers: [
        {
          manufacturerId: "gatekeep",
          model: "Gatekeep DoorWatch",
          quirk:
            "The badge holder is CARD_HOLDER, the decision is GRANTED or DENIED, and the zone is bare like Z4 with no lowercase.",
          exampleRaw: {
            EVENT_TIME: "2025-08-29T02:14:03Z",
            CARD_HOLDER: "B204",
            SITE_CODE: "OCC",
            DOOR_NAME: "MAIN",
            ZONE: "Z4",
            ACCESS_DECISION: "GRANTED",
          },
        },
        {
          manufacturerId: "sentinel",
          model: "Sentinel Grid Portal Sensor",
          quirk:
            "Sentinel calls a door a PORTAL and a site a FACILITY, so its location codes never line up with Gatekeep's. Decision is ALLOW or DENY.",
          exampleRaw: {
            EVENT_TS: 1756433643000,
            CREDENTIAL_ID: "B204",
            FACILITY: "OCC",
            PORTAL: "MAIN",
            TRUST_ZONE: "Z4",
            DECISION: "ALLOW",
          },
        },
      ],
    },
    {
      id: "door-contact",
      name: "Door contact sensor",
      description:
        "The magnetic sensor that reports whether a door is open, closed, forced, or propped. It feels lonely and unseen.",
      foundAt: {
        summary: "On the same doors as the readers, at stations and staff sites.",
        zones: ["z1", "z2", "z3", "z4"],
        stations: ["all"],
        sites: ["dep", "sig", "sub", "occ"],
      },
      normalizedExample: {
        ts: 1756433643,
        site: "dep",
        door: "D1",
        event: "forced",
      },
      manufacturers: [
        {
          manufacturerId: "railsense",
          model: "RailSense ContactNode",
          quirk:
            "The event is a number. 0 close, 1 open, 3 forced, 4 held. A forced door reads as ev:3 and nothing more.",
          exampleRaw: {
            t: 1756433643000,
            st: "DEP",
            dr: "D1",
            ev: 3,
          },
        },
        {
          manufacturerId: "sentinel",
          model: "Sentinel Grid Contact",
          quirk:
            "Spells the state out as FORCED_OPEN or HELD_OPEN, but glues two ideas into one field, so 'forced' and 'open' arrive together.",
          exampleRaw: {
            EVENT_TS: 1756433643000,
            FACILITY: "DEP",
            PORTAL: "D1",
            CONTACT_STATE: "FORCED_OPEN",
          },
        },
      ],
    },
    {
      id: "platform-camera",
      name: "Platform camera",
      description:
        "The camera over a fare gate that counts people vs grants. Remember to wave and say 'cheese'!",
      foundAt: {
        summary: "Above the fare gates of every station.",
        zones: ["z0", "z1"],
        stations: ["all"],
      },
      normalizedExample: {
        ts: 1756433643,
        station: "cen",
        gate: "G6",
        grants: 1,
        persons: 2,
      },
      manufacturers: [
        {
          manufacturerId: "railsense",
          model: "RailSense CountCam",
          quirk:
            "Grants is gr and people is px. Two letters, no explanation, and easy to swap by accident.",
          exampleRaw: {
            t: 1756433643000,
            st: "CEN",
            g: "G6",
            gr: 1,
            px: 2,
          },
        },
        {
          manufacturerId: "sentinel",
          model: "Sentinel Grid VisionCount",
          quirk:
            "Verbose and clear, but the counts are GRANT_COUNT and PERSON_COUNT while RailSense uses gr and px. Same reading, opposite spelling.",
          exampleRaw: {
            EVENT_TS: 1756433643000,
            STATION: "CEN",
            GATE_ID: "G6",
            GRANT_COUNT: 1,
            PERSON_COUNT: 2,
          },
        },
      ],
    },
    {
      id: "train-tracker",
      name: "Train tracker",
      description:
        "The trackside sensor that logs a train arriving and leaving a station. It helps you know how far behind schedule the trains are running.",
      foundAt: {
        summary: "Along every line, at platforms and on the operational tracks.",
        zones: ["z1", "z3"],
        stations: ["all"],
        sites: ["dep", "sig"],
      },
      normalizedExample: {
        ts: 1756433643,
        train: "T14",
        line: "green",
        station: "sum",
        event: "dep",
        track: "CLOSED-2",
      },
      manufacturers: [
        {
          manufacturerId: "railsense",
          model: "RailSense TrackNode",
          quirk:
            "Line is a numeric code again, and the event is a short string. Consistent with RailSense gates, which is the one small mercy.",
          exampleRaw: {
            t: 1756433643000,
            train: "T14",
            ln: 2,
            st: "SUM",
            ev: "DEP",
            trk: "CLOSED-2",
          },
        },
        {
          manufacturerId: "tetsudo",
          model: "Tetsudo ShindaiSense",
          quirk:
            "Every key is romaji. jikoku is time, ressha is train, rosen is line, eki is station, idou is the movement. Precise, and unlike anything else on the wire.",
          exampleRaw: {
            jikoku: 1756433643,
            ressha: "T14",
            rosen: "GRN",
            eki: "SUM",
            idou: "departure",
            senro: "CLOSED-2",
          },
        },
      ],
    },
    {
      id: "occ-console",
      name: "Control console",
      description:
        "The dispatcher's console on the control floor. It logs every command sent to a signal, switch, or data store. This is the most sensitive telemetry in the system, and it has no sense of humor.",
      foundAt: {
        summary: "Only on the control floor of the Operations Control Center.",
        zones: ["z4"],
        sites: ["occ"],
      },
      normalizedExample: {
        ts: 1756433643,
        operator: "green.disp",
        host: "OCC-3",
        command: "EXPORT",
        target: "ALL-RIDER-DB",
      },
      manufacturers: [
        {
          manufacturerId: "sentinel",
          model: "Sentinel Grid CommandLog",
          quirk:
            "Clear enough, but the operator is OPERATOR and the console is CONSOLE, while Tetsudo names the same two things in romaji.",
          exampleRaw: {
            EVENT_TS: 1756433643000,
            OPERATOR: "green.disp",
            CONSOLE: "OCC-3",
            COMMAND: "EXPORT",
            TARGET: "ALL-RIDER-DB",
          },
        },
        {
          manufacturerId: "tetsudo",
          model: "Tetsudo ShireiLog",
          quirk:
            "tantosha is the operator in charge, tanmatsu is the terminal, meirei is the command, taisho is the target. A dictionary is required.",
          exampleRaw: {
            jikoku: 1756433643,
            tantosha: "green.disp",
            tanmatsu: "OCC-3",
            meirei: "EXPORT",
            taisho: "ALL-RIDER-DB",
          },
        },
      ],
    },
    {
      id: "network-relay",
      name: "Network relay",
      description:
        "A node on the control backbone that links a station to the control center. It reports which host talked to which destination. Voted most likely to spill the tea.",
      foundAt: {
        summary:
          "At every station and staff site, on the network that carries departure boards, signals, and staff traffic.",
        zones: ["z2", "z3", "z4"],
        stations: ["all"],
        sites: ["dep", "sig", "sub", "occ"],
      },
      normalizedExample: {
        ts: 1756433643,
        site: "riv",
        host: "BOARD-4",
        dest: "ext-9.211",
        bytes: 512,
      },
      manufacturers: [
        {
          manufacturerId: "sentinel",
          model: "Sentinel Grid FlowTap",
          quirk:
            "Source is SRC_HOST, destination is DST_ADDR, and the byte count is BYTES_OUT. Long keys, easy to misread under load.",
          exampleRaw: {
            EVENT_TS: 1756433643000,
            FACILITY: "RIV",
            SRC_HOST: "BOARD-4",
            DST_ADDR: "ext-9.211",
            BYTES_OUT: 512,
          },
        },
        {
          manufacturerId: "tetsudo",
          model: "Tetsudo TsushinTap",
          quirk:
            "kyoten is the site, soshin is the source, atesaki is the destination, baito is bytes. Romaji again, so the two relay vendors share no key at all.",
          exampleRaw: {
            jikoku: 1756433643,
            kyoten: "RIV",
            soshin: "BOARD-4",
            atesaki: "ext-9.211",
            baito: 512,
          },
        },
      ],
    },
  ],
} as const satisfies SensorData;
