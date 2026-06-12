interface HairlineDividerProps {
  label?: string;
  surface?: "canvas" | "void";
}

export function HairlineDivider({ label, surface = "canvas" }: HairlineDividerProps) {
  const lineClass =
    surface === "void" ? "border-white/20" : "border-scout-hairline-faint";
  const labelClass =
    surface === "void" ? "text-white/50" : "text-scout-muted";

  if (!label) {
    return <hr className={`border-0 border-t ${lineClass}`} />;
  }

  return (
    <div className="relative flex items-center w-full">
      <div className={`flex-1 border-t ${lineClass}`} />
      <span className={`px-3 text-caption text-xs ${labelClass}`}>{label}</span>
      <div className={`flex-1 border-t ${lineClass}`} />
    </div>
  );
}
