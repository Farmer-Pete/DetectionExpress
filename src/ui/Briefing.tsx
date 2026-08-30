/**
 * The Briefing panel: the live scenario's tagline above its briefing text. It sits
 * above the engine so the player reads what the chaos is, and how the engine
 * answers it, before watching the run. The tagline is UI prose from `narrative.ts`;
 * the briefing string belongs to the Scenario contract.
 */
interface BriefingProps {
  tagline: string;
  text: string;
}

export function Briefing({ tagline, text }: BriefingProps) {
  return (
    <div className="briefing">
      <div className="briefing-title">Briefing</div>
      <p className="briefing-tagline">{tagline}</p>
      <p className="briefing-text">{text}</p>
    </div>
  );
}
