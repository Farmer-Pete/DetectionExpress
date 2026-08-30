/**
 * The single source of the onboarding prose. This is UI copy, not simulation
 * logic, so it lives in `ui/`. It holds the intro overlay text, the Hire Me pitch,
 * the five-level chaos ladder, the one live scenario's presentation, and the source
 * repo link. No React. Each type is consumed by a component through its props, so
 * the values reach the screen and Knip stays clean.
 *
 * The live scenario's briefing string is not here. It belongs to the Scenario
 * contract, so it stays on the sim scenario. Display name and tagline are UI prose,
 * so they live here.
 */

/** A ladder rung: one level of rising chaos. Used by the exported content types. */
type ChaosLevelNumber = 1 | 2 | 3 | 4 | 5;

/** The intro overlay copy: premise, invitation, and the action and link labels. */
export interface IntroCopy {
  title: string;
  paragraphs: string[];
  invitation: string;
  observeLabel: string;
  chaosLabel: string;
  sourceLabel: string;
  editLabel: string;
}

/** The Hire Me card copy: heading, body paragraphs, and the contact email. */
export interface HireMeCopy {
  heading: string;
  body: string[];
  email: string;
}

/** One rung of the chaos ladder. `playable` marks a level a player can run today. */
export interface ChaosLevel {
  level: ChaosLevelNumber;
  label: string;
  blurb: string;
  playable: boolean;
}

/** The one runtime scenario, in its ladder context. */
export interface LiveScenario {
  id: string;
  displayName: string;
  tagline: string;
  level: ChaosLevelNumber;
}

/** The source repository. The intro's "Get the source" link points here. */
export const REPO_URL = "https://github.com/Farmer-Pete/DetectionExpress";

export const introCopy: IntroCopy = {
  title: "Detection Express",
  paragraphs: [
    "This is a working metro, modeled down to the last detail. Every rider, every fare tap, every door, every camera. It all runs live.",
    "Watching over it is a finished detection Engine. It reads the whole stream of sensor data and finds the threats hiding inside ordinary traffic. It stays fast under heavy load.",
  ],
  invitation: "Watch it run clean. Then cause chaos and see it hold.",
  observeLabel: "Observe the simulation",
  chaosLabel: "Cause chaos",
  sourceLabel: "Get the source",
  editLabel: "Edit the Engine",
};

export const hireMe: HireMeCopy = {
  heading: "Hire me",
  body: [
    "I am Peter Naudus. I have spent 25 years building calculation and detection engines. This simulation is one of them, running in your browser.",
    "If you need someone who builds engines like this, I am open to work.",
  ],
  email: "peter@naud.us",
};

export const chaosLevels: readonly ChaosLevel[] = [
  {
    level: 1,
    label: "First Cracks",
    blurb: "One bad actor. One sensor. A quiet probe against the crowd.",
    playable: true,
  },
  {
    level: 2,
    label: "Under Load",
    blurb: "More attackers arrive. The Engine holds state and leans in.",
    playable: false,
  },
  {
    level: 3,
    label: "Heavy Load",
    blurb: "Timed patterns per rider. The stream thickens and speeds up.",
    playable: false,
  },
  {
    level: 4,
    label: "Overload",
    blurb: "Attacks cross sensors. The network map itself is in play.",
    playable: false,
  },
  {
    level: 5,
    label: "Nightmare",
    blurb: "Everything at once. The Engine learns normal and scores the drift.",
    playable: false,
  },
];

export const liveScenario: LiveScenario = {
  id: "kiosk-pin-attack",
  displayName: "PIN Brute Force",
  tagline: "One angry rider, one PIN pad, a thousand guesses.",
  level: 1,
};
