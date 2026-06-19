// The view switcher shown on every page: the three disk views plus Organize.
// Rendered by the main toolbar (App) and the sort flow's titlebar (SortFlow), so
// both share one control and one selection handler.

export type SegView = "treemap" | "list" | "dups" | "organize";

const TABS: [SegView, string][] = [
  ["treemap", "Treemap"],
  ["list", "List"],
  ["dups", "Duplicates"],
  ["organize", "Organize"],
];

export function ViewSeg({ view, onSelect }: { view: SegView; onSelect: (m: SegView) => void }) {
  return (
    <div className="seg">
      {TABS.map(([k, label]) => (
        <button key={k} className={view === k ? "on" : ""} onClick={() => onSelect(k)}>{label}</button>
      ))}
    </div>
  );
}
