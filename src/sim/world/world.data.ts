/**
 * The world data: trust zones, lines, stations, staff sites, the control center,
 * and the doors. `world.ts` imports this and builds the frozen `world` singleton
 * over it. Ported from the former `docs/world/world.json`, `$schema` stripped,
 * with one addition: each line carries an authored `trainName` (GH127-PLAN.md
 * M1), since the UI must not generate a train's display name.
 */
import type { World } from "./world";

export const worldData = {
  zones: [
    {
      id: "z0",
      name: "Public",
      trustLevel: 0,
      area: "Ticket halls and the open concourse, before the fare gates.",
      whoBelongs: "Anyone off the street. Riders, buskers, pigeons, lost tourists.",
      securityParallel: "The public internet and the DMZ edge.",
      description:
        "Anyone can stand here, so trust nothing that happens here. The concourse is where trouble buys its ticket.",
    },
    {
      id: "z1",
      name: "Paid",
      trustLevel: 1,
      area: "Platforms and trains, past the fare gates.",
      whoBelongs: "Riders who tapped a valid fare.",
      securityParallel:
        "The authenticated user network. You proved who you are, so now you may ride.",
      description:
        "One tap buys the platform. The turnstile is the only thing between order and a free-for-all.",
    },
    {
      id: "z2",
      name: "Staff",
      trustLevel: 2,
      area: "Back rooms, mess rooms, and equipment closets inside a station.",
      whoBelongs: "Station staff with a badge.",
      securityParallel: "The internal corporate network behind the login.",
      description:
        "Staff only, in theory. In practice, a propped door and a confident nod get you a long way.",
    },
    {
      id: "z3",
      name: "Operational",
      trustLevel: 3,
      area: "Depots, tunnels, signal cabins, and power rooms.",
      whoBelongs: "Operations and maintenance crews on shift.",
      securityParallel: "The restricted operational technology network that runs the machines.",
      description:
        "Where the heavy machinery lives. High voltage, moving trains, and safety rules written in blood.",
    },
    {
      id: "z4",
      name: "Control",
      trustLevel: 4,
      area: "The Operations Control Center floor.",
      whoBelongs: "Dispatchers and the duty manager.",
      securityParallel: "The management plane and the crown jewels.",
      description:
        "One room commands every train, signal, and gate. Guard it like the last slice of cake at a birthday party.",
    },
  ],
  lines: [
    {
      id: "red",
      name: "Red Line",
      color: "#e6394a",
      stations: ["har", "mkt", "cen", "riv", "end"],
      loop: false,
      description:
        "The workhorse. Longest, busiest, and always a minute late. Runs coast to coast, Harbor to World's End.",
      trainName: "Red Line train",
    },
    {
      id: "blue",
      name: "Blue Line",
      color: "#2b6cff",
      stations: ["mkt", "cen", "prk", "bay"],
      loop: false,
      description:
        "The commuter's line. Reliable, tidy, and proud of it. Market to Bayside with no surprises and no fun.",
      trainName: "Blue Line train",
    },
    {
      id: "green",
      name: "Green Line",
      color: "#28a745",
      stations: ["sum", "jct", "cen"],
      loop: false,
      description:
        "The scenic detour. Fewer stops, better views, and one permanently broken lift at Summit.",
      trainName: "Green Line train",
    },
    {
      id: "circle",
      name: "Circle Line",
      color: "#f2a900",
      stations: ["cen", "jct", "cen"],
      loop: true,
      description:
        "The loop that never ends. A gift to tourists, a curse to anyone trying to count laps.",
      trainName: "Circle Line train",
    },
  ],
  stations: [
    {
      id: "har",
      name: "Harbor",
      lines: ["red"],
      interchange: false,
      connections: [
        {
          to: "mkt",
          line: "red",
          minutes: 3,
        },
      ],
      description:
        "The end of the Red Line and the first coffee of the day. Salt air, loud gulls, and commuters who have not woken up yet.",
    },
    {
      id: "mkt",
      name: "Market",
      lines: ["red", "blue"],
      interchange: true,
      connections: [
        {
          to: "har",
          line: "red",
          minutes: 3,
        },
        {
          to: "cen",
          line: "red",
          minutes: 2,
        },
        {
          to: "cen",
          line: "blue",
          minutes: 2,
        },
      ],
      description:
        "Where the Red and Blue lines shake hands. Two lines, one very confused tourist map, three buskers.",
    },
    {
      id: "cen",
      name: "Central",
      lines: ["red", "blue", "green", "circle"],
      interchange: true,
      connections: [
        {
          to: "mkt",
          line: "red",
          minutes: 2,
        },
        {
          to: "mkt",
          line: "blue",
          minutes: 2,
        },
        {
          to: "riv",
          line: "red",
          minutes: 3,
        },
        {
          to: "prk",
          line: "blue",
          minutes: 4,
        },
        {
          to: "jct",
          line: "green",
          minutes: 3,
        },
        {
          to: "jct",
          line: "circle",
          minutes: 3,
        },
      ],
      description:
        "The beating heart. Four lines cross here. If Central sneezes, the whole network catches a cold.",
    },
    {
      id: "riv",
      name: "Riverside",
      lines: ["red"],
      interchange: false,
      connections: [
        {
          to: "cen",
          line: "red",
          minutes: 3,
        },
        {
          to: "end",
          line: "red",
          minutes: 4,
        },
      ],
      description:
        "Pretty views and damp platforms. The substation next door hums a note only dogs enjoy.",
    },
    {
      id: "end",
      name: "World's End",
      lines: ["red"],
      interchange: false,
      connections: [
        {
          to: "riv",
          line: "red",
          minutes: 4,
        },
      ],
      description:
        "The last stop on the Red Line. Nobody means to come here. Everybody eventually does.",
    },
    {
      id: "prk",
      name: "Parkside",
      lines: ["blue"],
      interchange: false,
      connections: [
        {
          to: "cen",
          line: "blue",
          minutes: 4,
        },
        {
          to: "bay",
          line: "blue",
          minutes: 3,
        },
      ],
      description:
        "Leafy, quiet, and faintly smug. The kind of station with strong opinions about litter.",
    },
    {
      id: "bay",
      name: "Bayside",
      lines: ["blue"],
      interchange: false,
      connections: [
        {
          to: "prk",
          line: "blue",
          minutes: 3,
        },
      ],
      description:
        "End of the Blue Line, start of the wind. Hold onto your hat and your fare card.",
    },
    {
      id: "sum",
      name: "Summit",
      lines: ["green"],
      interchange: false,
      connections: [
        {
          to: "jct",
          line: "green",
          minutes: 5,
        },
      ],
      description:
        "The high point of the Green Line, in altitude and in self-regard. The lift has been broken since spring.",
    },
    {
      id: "jct",
      name: "Junction",
      lines: ["green", "circle"],
      interchange: true,
      connections: [
        {
          to: "sum",
          line: "green",
          minutes: 5,
        },
        {
          to: "cen",
          line: "green",
          minutes: 3,
        },
        {
          to: "cen",
          line: "circle",
          minutes: 3,
        },
      ],
      description: "Where Green meets the Circle. Trains loiter here and schedules come to die.",
    },
  ],
  sites: [
    {
      id: "dep",
      name: "Eastyard Depot",
      type: "depot",
      zonesPresent: ["z2", "z3"],
      nearestStation: "jct",
      description:
        "Where trains sleep and mechanics swear. Badge in, or the guard dogs introduce themselves.",
    },
    {
      id: "sig",
      name: "Junction Signal Cabin",
      type: "signal-cabin",
      zonesPresent: ["z3"],
      nearestStation: "jct",
      description: "A shed full of levers that decide who lives. Please do not touch the levers.",
    },
    {
      id: "sub",
      name: "Riverside Substation",
      type: "substation",
      zonesPresent: ["z3"],
      nearestStation: "riv",
      description: "It hums, it sparks, it powers the line. It does not forgive a careless hand.",
    },
  ],
  controlCenter: {
    id: "occ",
    name: "Operations Control Center",
    type: "control-center",
    zonesPresent: ["z2", "z3", "z4"],
    description:
      "The brain of the network. One room runs every train, signal, and gate. If an attacker reaches this floor, the run is already lost.",
  },
  doors: [
    {
      location: "dep",
      locationType: "site",
      name: "STORE",
      zone: "z2",
    },
    {
      location: "dep",
      locationType: "site",
      name: "YARD",
      zone: "z3",
    },
    {
      location: "sig",
      locationType: "site",
      name: "CABIN",
      zone: "z3",
    },
    {
      location: "sub",
      locationType: "site",
      name: "ROOM",
      zone: "z3",
    },
    {
      location: "occ",
      locationType: "control-center",
      name: "OFFICE",
      zone: "z2",
    },
    {
      location: "occ",
      locationType: "control-center",
      name: "OPS",
      zone: "z3",
    },
    {
      location: "occ",
      locationType: "control-center",
      name: "MAIN",
      zone: "z4",
    },
  ],
} as const satisfies World;
