/**
 * The Briefing panel: the live scenario's tagline above its briefing text. It sits
 * above the engine so the player reads what the chaos is, and how the engine
 * answers it, before watching the run. The tagline is UI prose from `narrative.ts`;
 * the briefing text is the registry's catalogue join, the one source of display
 * copy (GH42-PLAN.md "Registry and catalogue metadata"). Either way, this
 * component only renders whatever string its caller hands it.
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
