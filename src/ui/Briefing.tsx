/**
 * The Briefing panel: the Scenario's Hunt text. It sits above the Algorithm
 * editor so the player reads the objective before writing the Rule.
 */
interface BriefingProps {
  text: string;
}

export function Briefing({ text }: BriefingProps) {
  return (
    <div className="briefing">
      <div className="briefing-title">Briefing</div>
      <p className="briefing-text">{text}</p>
    </div>
  );
}
