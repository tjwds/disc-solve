import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Node, ScanResult, TimeMachineStatus } from "./lib/types";
import { squarify, type Tile } from "./lib/treemap";
import { fmtBytes } from "./lib/format";
import { reclaimable, type Suggestion } from "./lib/suggestions";
import { typeStats, buildColorMap, colorForNode, type LegendEntry } from "./lib/filetypes";
import { makeDemoTree } from "./lib/demo";
import * as api from "./lib/api";

/** Raw progress event from the backend. `total` is the volume's used bytes. */
interface ScanEvent {
  files: number;
  bytes: number;
  total: number;
}
/** What the UI shows: counts plus a monotonic completion fraction. */
interface ScanProgress {
  files: number;
  bytes: number;
  pct: number;
}

/** Build the chain root..target by matching unique paths. */
function findChain(root: Node, targetPath: string): Node[] {
  const chain: Node[] = [];
  const dfs = (node: Node): boolean => {
    chain.push(node);
    if (node.path === targetPath) return true;
    for (const c of node.children) if (dfs(c)) return true;
    chain.pop();
    return false;
  };
  return dfs(root) ? chain : [root];
}

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [stack, setStack] = useState<Node[]>([]);
  const [hover, setHover] = useState<Node | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [tm, setTm] = useState<TimeMachineStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ranOnce = useRef(false);

  const runScan = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const result = await api.scanPath(path);
      setScan(result);
      setStack([result.tree]);
      setSelected(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, []);

  // Live scan progress. bytes/total is a real, monotonic fraction of the volume's
  // used space (it undershoots for a subfolder scan, which is fine — we show GB too).
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<ScanEvent>("scan-progress", (e) => {
      const { files, bytes, total } = e.payload;
      const pct = total > 0 ? Math.min(0.99, bytes / total) : 0;
      setProgress({ files, bytes, pct });
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // First scan: the home directory.
  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    if (!api.isTauri()) {
      // Browser preview: render a representative demo tree (no real filesystem).
      const demo = makeDemoTree();
      setScan({ tree: demo, files: demo.item_count, dirs: 0, errors: 0 });
      setStack([demo]);
      setTm({ local_snapshots: 3, latest_backup: "/Volumes/Backups" });
      return;
    }
    (async () => {
      const home = await api.homeDir();
      api.timeMachineStatus().then(setTm).catch(() => {});
      if (home) await runScan(home);
      else setError("Could not locate your home directory.");
    })();
  }, [runScan]);

  // Esc = up one level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tree = scan?.tree ?? null;
  const root = stack[stack.length - 1] ?? null;
  const focus = hover ?? selected ?? root;

  // Colors are assigned from the full tree so a type keeps its color while drilling.
  const { map: colorMap, legend } = useMemo(
    () => buildColorMap(tree ? typeStats(tree) : []),
    [tree],
  );

  const drill = useCallback(
    (node: Node) => {
      if (!tree || node.children.length === 0) return;
      setStack(findChain(tree, node.path));
      setSelected(null);
    },
    [tree],
  );

  const onTrash = useCallback(async () => {
    if (!selected || !selected.path || stack.length === 0) return;
    const ok = window.confirm(
      `Move to Trash?\n\n${selected.path}\n${fmtBytes(selected.size)}\n\n` +
        `It goes to the macOS Trash (recoverable) — nothing is permanently deleted.`,
    );
    if (!ok) return;
    try {
      await api.moveToTrash(selected.path);
      await runScan(stack[0].path);
    } catch (e) {
      setError(String(e));
    }
  }, [selected, stack, runScan]);

  // Clicking a recommendation gives a "view into it": drill the treemap into the
  // relevant folder, or open the Trash in Finder. Never deletes anything.
  const onRecommend = useCallback(
    (s: Suggestion) => {
      if (s.action === "openTrash") {
        api.openTrash().catch((e) => setError(String(e)));
        return;
      }
      if (s.action === "drill" && s.path && tree) {
        const chain = findChain(tree, s.path);
        setStack(chain);
        setSelected(chain[chain.length - 1] ?? null);
      }
    },
    [tree],
  );

  return (
    <div className="app">
      <Toolbar root={stack[0] ?? null} loading={loading} onRescan={() => stack[0] && runScan(stack[0].path)} />
      <div className="body">
        <Sidebar root={root} tm={tm} colorMap={colorMap} onRecommend={onRecommend} />
        <main className="content">
          <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
          {error ? (
            <div className="state">{error}</div>
          ) : loading || !root ? (
            <Scanning progress={progress} />
          ) : (
            <Treemap root={root} colorMap={colorMap} selected={selected} onHover={setHover} onSelect={setSelected} onDrill={drill} />
          )}
          <Legend legend={legend} />
        </main>
      </div>
      <Inspector node={focus} selected={selected} onTrash={onTrash} />
    </div>
  );
}

function Toolbar({ root, loading, onRescan }: { root: Node | null; loading: boolean; onRescan: () => void }) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="app-name">
        disc<span className="dot">·</span>solve
      </div>
      <div className="toolbar">
        <div className="vol">{root ? root.name : "—"}</div>
        <button className="btn primary" onClick={onRescan} disabled={loading}>
          {loading ? "Scanning…" : "Rescan"}
        </button>
      </div>
    </div>
  );
}

function Scanning({ progress }: { progress: ScanProgress | null }) {
  const pct = progress ? Math.round(progress.pct * 100) : 0;
  const text = progress
    ? `Scanned ${progress.files.toLocaleString()} files · ${fmtBytes(progress.bytes)}${progress.pct > 0 ? ` · ${pct}%` : ""}`
    : "Scanning…";
  return (
    <div className="state">
      <div className="scanning">
        <div className={"scanbar" + (progress && progress.pct > 0 ? "" : " indet")}>
          <div className="scanbar-fill" style={progress && progress.pct > 0 ? { width: `${pct}%` } : undefined} />
        </div>
        <div className="scan-count">{text}</div>
      </div>
    </div>
  );
}

function Sidebar({
  root,
  tm,
  colorMap,
  onRecommend,
}: {
  root: Node | null;
  tm: TimeMachineStatus | null;
  colorMap: Map<string, string>;
  onRecommend: (s: Suggestion) => void;
}) {
  const suggestions = useMemo(() => (root ? reclaimable(root) : []), [root]);
  const segments = useMemo(() => {
    if (!root) return [];
    const stats = typeStats(root);
    const top = stats.slice(0, 16);
    const rest = stats.slice(16).reduce((s, t) => s + t.bytes, 0);
    const segs = top.map((t) => ({ ext: t.ext, bytes: t.bytes, color: colorMap.get(t.ext) ?? "var(--neutral)" }));
    if (rest > 0) segs.push({ ext: "other", bytes: rest, color: "var(--neutral)" });
    return segs;
  }, [root, colorMap]);

  return (
    <aside className="sidebar">
      <div className="side-sec">
        <div className="gauge-top">
          <span className="disk">{root ? root.name : "—"}</span>
          <span className="cap">{fmtBytes(root?.size ?? 0)}</span>
        </div>
        <div className="bar">
          {segments.map((s) => (
            <div key={s.ext} style={{ flexGrow: s.bytes, background: s.color }} title={`${s.ext} · ${fmtBytes(s.bytes)}`} />
          ))}
        </div>
        <div className="gauge-key">{root?.item_count.toLocaleString() ?? 0} items</div>
      </div>

      <div className="side-sec">
        <h3 className="side-h">Time Machine</h3>
        <div className="status">
          <div className="txt">
            <div className="t1">{tm?.latest_backup ? "Backed up" : "No backup detected"}</div>
            <div className="t2">{tm ? `${tm.local_snapshots} local snapshot${tm.local_snapshots === 1 ? "" : "s"}` : "…"}</div>
          </div>
        </div>
      </div>

      <div className="side-sec" style={{ paddingBottom: 0 }}>
        <h3 className="side-h">Recommended</h3>
      </div>
      <div className="recs">
        {suggestions.map((s) => (
          <div className="rec" key={s.key} onClick={() => onRecommend(s)} title={s.action === "openTrash" ? "Open the Trash in Finder" : "Show in the treemap"}>
            <div className="rbody">
              <div className="r1">{s.title}</div>
              <div className="r2">
                <span className="r2t">{s.subtitle}</span>
                <span className="amt">{fmtBytes(s.bytes)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Breadcrumb({ stack, onJump }: { stack: Node[]; onJump: (i: number) => void }) {
  return (
    <div className="crumbs">
      {stack.map((node, i) => {
        const isCur = i === stack.length - 1;
        return (
          <span key={node.path} className="crumb-wrap">
            {i > 0 && <span className="sep">›</span>}
            <span className={"crumb" + (isCur ? " cur" : "")} onClick={() => !isCur && onJump(i)}>
              {node.name}
            </span>
          </span>
        );
      })}
      {stack.length > 1 && <span className="crumb-hint">Esc to go up</span>}
      {stack.length > 0 && (
        <span className="right">
          {fmtBytes(stack[stack.length - 1].size)} · {stack[stack.length - 1].item_count.toLocaleString()} items
        </span>
      )}
    </div>
  );
}

function Treemap({
  root,
  colorMap,
  selected,
  onHover,
  onSelect,
  onDrill,
}: {
  root: Node;
  colorMap: Map<string, string>;
  selected: Node | null;
  onHover: (n: Node | null) => void;
  onSelect: (n: Node) => void;
  onDrill: (n: Node) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hoverFolder, setHoverFolder] = useState<Tile | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const tiles = useMemo(() => squarify(root, dims.w, dims.h), [root, dims]);
  useEffect(() => setHoverFolder(null), [root]);

  const selTile = useMemo(
    () => (selected && selected.path ? tiles.find((t) => !t.group && t.node.path === selected.path) : undefined),
    [tiles, selected],
  );

  return (
    <div className="treemap" ref={ref} onMouseLeave={() => onHover(null)}>
      {tiles.map((t, i) => {
        const color = colorForNode(t.node, colorMap);
        const isAgg = t.node.path === "";
        // Directory backings are invisible — no fill, no frame; folders read from
        // the gaps, labels, and the translucent hover overlay.
        const cls = "cell" + (t.group ? " grp" : isAgg ? " agg" : color ? "" : " neutral");
        const showLabel = !t.group && t.w > 46 && t.h > 20;
        return (
          <div
            key={i}
            className={cls}
            style={{ left: t.x, top: t.y, width: Math.max(0, t.w), height: Math.max(0, t.h), background: t.group ? undefined : (color ?? undefined) }}
            title={t.group ? "Double-click to open" : t.node.name}
            onMouseEnter={() => onHover(t.node)}
            onClick={() => !t.group && onSelect(t.node)}
            onDoubleClick={() => t.group && onDrill(t.node)}
          >
            {showLabel && (
              <span className={"lbl" + (isAgg ? " agg-lbl" : "")}>
                <span className="n">{t.node.name}</span>
                {t.h > 34 && <span className="s">{fmtBytes(t.node.size)}</span>}
              </span>
            )}
          </div>
        );
      })}

      {/* Selection + folder-hover highlights (translucent overlays, no borders). */}
      {selTile && (
        <div className="tm-overlay sel" style={{ left: selTile.x, top: selTile.y, width: selTile.w, height: selTile.h }} />
      )}
      {hoverFolder && (
        <div className="tm-overlay folder" style={{ left: hoverFolder.x, top: hoverFolder.y, width: hoverFolder.w, height: hoverFolder.h }} />
      )}

      {tiles
        .filter((t) => t.labeled)
        .map((t, i) => (
          <div
            key={"g" + i}
            className="glabel"
            style={{ left: t.x + 5, top: t.y + 4, maxWidth: Math.max(42, t.w - 10) }}
            onMouseEnter={() => {
              onHover(t.node);
              setHoverFolder(t);
            }}
            onMouseLeave={() => setHoverFolder(null)}
            onClick={() => onDrill(t.node)}
          >
            <span className="gn">{t.node.name}</span>
            <span className="gs">{fmtBytes(t.node.size)}</span>
          </div>
        ))}
    </div>
  );
}

function Legend({ legend }: { legend: LegendEntry[] }) {
  if (legend.length === 0) return <div className="legend" />;
  return (
    <div className="legend">
      {legend.slice(0, 12).map((l) => (
        <span key={l.ext}>
          <i style={{ background: l.color }} />
          {l.ext === "(none)" ? "no ext" : l.ext}
        </span>
      ))}
    </div>
  );
}

/** The directory to open at: the node itself if a folder, else its parent. */
function dirOf(node: Node): string {
  if (node.is_dir) return node.path;
  const parent = node.path.replace(/\/[^/]*$/, "");
  return parent.length > 0 ? parent : "/";
}

function Inspector({ node, selected, onTrash }: { node: Node | null; selected: Node | null; onTrash: () => void }) {
  const target = selected ?? node;
  const canAct = !!target && target.path.length > 0;
  const canTrash = !!selected && selected.path.length > 0;
  return (
    <div className="inspector">
      <div className="insp-meta">
        <div className="insp-path">{node ? node.path || node.name : "—"}</div>
        <div className="insp-sub">{node ? `${fmtBytes(node.size)} · ${node.item_count.toLocaleString()} items` : ""}</div>
      </div>
      <div className="insp-actions">
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.revealInFinder(target!.path)}>
          Reveal in Finder
        </button>
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.openTerminalHere(dirOf(target!))}>
          Open Terminal Here
        </button>
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.quickLook(target!.path)}>
          Quick Look
        </button>
        <button className="btn danger" disabled={!canTrash} onClick={onTrash}>
          Move to Trash
        </button>
      </div>
    </div>
  );
}
