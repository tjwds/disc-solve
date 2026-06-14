import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Category, DupReport, Node, ScanResult, TimeMachineStatus } from "./lib/types";
import { squarify, type Tile } from "./lib/treemap";
import { fmtBytes, fmtRelTime, isStale } from "./lib/format";
import { reclaimable, largestDirNamed, largestDirOfCategory, type Suggestion } from "./lib/suggestions";
import { typeStats, buildColorMap, colorForNode, type LegendEntry } from "./lib/filetypes";
import { sortItems, resolveFilter, collectByName, withoutAggregates, parentName, shortenPath, type SortKey, type SortDir } from "./lib/listview";
import { removePaths } from "./lib/tree";
import { baseName, keeperOf, pruneDupReport } from "./lib/dups";
import { makeDemoTree, demoDuplicates } from "./lib/demo";
import * as api from "./lib/api";

const CAT_COLOR: Record<Category, string> = {
  dev: "#5b8def", video: "#e8716d", audio: "#c189d6", photo: "#f0a35e", docs: "#3fb0a4",
  apps: "#76c269", system: "#9aa1ad", cache: "#c5cad3", archive: "#d8b65c", trash: "#b8939c", other: "#b9bfca",
};
const ICON_REVEAL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h6l2 2h10v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
);
const ICON_TRASH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
);
const ICON_OPEN = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6" /></svg>
);

interface ScanEvent { files: number; bytes: number; total: number }
interface ScanProgress { files: number; bytes: number; pct: number }
interface DupEvent { hashed: number; total: number; bytes: number }
type ViewMode = "treemap" | "list" | "dups";
interface ListSource { key: string; label: string; nameFromParent: boolean }
interface ConfirmData { title: string; detail: string; confirmLabel: string; onOk: () => void }

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

// Re-anchor a navigation stack into a freshly edited tree by path. Nodes present
// in the (pruned) tree are re-anchored so their sizes update; folders that only
// exist in the full tree (reached by drilling a fetched list row) are kept as-is.
// Stops at an ancestor that was itself trashed.
function remapStack(tree: Node, old: Node[], removed: string[] = []): Node[] {
  const out: Node[] = [];
  for (const node of old) {
    if (removed.includes(node.path)) break;
    const chain = findChain(tree, node.path);
    const hit = chain[chain.length - 1];
    out.push(hit.path === node.path ? hit : node);
  }
  return out.length ? out : [tree];
}

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [stack, setStack] = useState<Node[]>([]);
  const [hover, setHover] = useState<Node | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [tm, setTm] = useState<TimeMachineStatus | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("treemap");
  const [listSource, setListSource] = useState<ListSource | null>(null);
  const [listItems, setListItems] = useState<Node[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "size", dir: "desc" });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);
  const [dups, setDups] = useState<DupReport | null>(null);
  const [dupScanning, setDupScanning] = useState(false);
  const [dupProgress, setDupProgress] = useState<{ hashed: number; total: number } | null>(null);
  const ranOnce = useRef(false);
  const dupRunRef = useRef(0); // ignore results from a superseded duplicate scan

  // Kick off duplicate detection in the background, after the tree is on screen.
  const runDups = useCallback((demoTree?: Node) => {
    const id = ++dupRunRef.current;
    setDups(null);
    setDupScanning(true);
    setDupProgress(null);
    const work = api.isTauri() ? api.findDuplicates() : Promise.resolve(demoDuplicates(demoTree!));
    work
      .then((report) => {
        if (id !== dupRunRef.current) return; // a newer scan started
        setDups(report);
        setDupScanning(false);
      })
      .catch((e) => {
        if (id !== dupRunRef.current) return;
        setDupScanning(false);
        setError(String(e));
      });
  }, []);

  const runScan = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      setProgress(null);
      dupRunRef.current++; // invalidate any in-flight duplicate scan
      setDups(null);
      setDupScanning(false);
      try {
        const result = await api.scanPath(path);
        setScan(result);
        setStack([result.tree]);
        setSelected(null);
        setListSource(null);
        setChecked(new Set());
        runDups(); // background; never blocks the tree we just rendered
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
        setProgress(null);
      }
    },
    [runDups],
  );

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<ScanEvent>("scan-progress", (e) => {
      const { files, bytes, total } = e.payload;
      setProgress({ files, bytes, pct: total > 0 ? Math.min(0.99, bytes / total) : 0 });
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<DupEvent>("dup-progress", (e) => {
      setDupProgress({ hashed: e.payload.hashed, total: e.payload.total });
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    if (!api.isTauri()) {
      const demo = makeDemoTree();
      setScan({ tree: demo, files: demo.item_count, dirs: 0, errors: 0 });
      setStack([demo]);
      setHome("/demo");
      setTm({ local_snapshots: 3, latest_backup: "/Volumes/Backups" });
      runDups(demo);
      // Demo-only: the screenshot generator opens a view via URL hash
      // (#list, #filter=node_modules, #dups). Ignored by the real (Tauri) app.
      const f = /filter=([\w-]+)/.exec(window.location.hash);
      if (f) { setListSource(resolveFilter(f[1])); setView("list"); }
      else if (window.location.hash.includes("dups")) setView("dups");
      else if (window.location.hash.includes("list")) setView("list");
      return;
    }
    (async () => {
      const h = await api.homeDir();
      setHome(h);
      api.timeMachineStatus().then(setTm).catch(() => {});
      if (h) await runScan(h);
      else setError("Could not locate your home directory.");
    })();
  }, [runScan, runDups]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Selection resets when the visible set changes.
  useEffect(() => setChecked(new Set()), [listSource, stack]);

  const tree = scan?.tree ?? null;
  const root = stack[stack.length - 1] ?? null;
  const focus = hover ?? selected ?? root;

  const { map: colorMap, legend } = useMemo(() => buildColorMap(tree ? typeStats(tree) : []), [tree]);

  const drill = useCallback(
    (node: Node) => {
      if (!tree || !node.is_dir) return;
      const chain = findChain(tree, node.path);
      // Folders not in the pruned tree (reached via a fetched list row) aren't in
      // `chain`; navigate to the fetched node directly so the list can load it.
      if (chain[chain.length - 1].path === node.path) setStack(chain);
      else setStack((s) => [...s, node]);
      setSelected(null);
      setListSource(null);
    },
    [tree],
  );

  // Fetch a folder's full, unpruned children for the list view. In Tauri this
  // comes from the backend (the UI holds only the pruned tree); in the browser
  // demo the client tree is already complete, so read it directly.
  const loadChildren = useCallback(
    async (path: string): Promise<Node[]> => {
      if (api.isTauri()) return api.listChildren(path);
      if (!tree) return [];
      const chain = findChain(tree, path);
      const node = chain[chain.length - 1];
      return node.path === path ? node.children : [];
    },
    [tree],
  );

  // Load the list view's rows whenever the view, active filter, or folder changes.
  useEffect(() => {
    if (view !== "list") return;
    let cancelled = false;
    (async () => {
      setListLoading(true);
      try {
        let items: Node[] = [];
        if (tree && listSource?.key === "node_modules") {
          items = collectByName(tree, "node_modules"); // the folders to reclaim
        } else {
          const target =
            listSource?.key === "caches" ? (tree ? largestDirOfCategory(tree, "cache")?.path : undefined)
            : listSource?.key === "derived" ? (tree ? largestDirNamed(tree, "DerivedData")?.path : undefined)
            : root?.path;
          if (target) items = await loadChildren(target);
        }
        if (!cancelled) setListItems(withoutAggregates(items));
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, listSource, root?.path, tree, loadChildren]);

  const setViewMode = useCallback((m: ViewMode) => {
    setView(m);
    if (m === "list") setListSource(null); // manual List = current folder
  }, []);

  const onRecommend = useCallback((s: Suggestion) => {
    if (s.action === "openTrash") {
      api.openTrash().catch((e) => setError(String(e)));
      return;
    }
    if (s.action === "list") {
      setListSource(resolveFilter(s.key));
      setView("list");
    }
  }, []);

  const onSort = useCallback((key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }, []);

  const checkedNodes = listItems.filter((n) => n.path && checked.has(n.path));
  const checkedBytes = checkedNodes.reduce((s, n) => s + n.size, 0);

  const toggleCheck = useCallback((path: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    const paths = listItems.filter((n) => n.path).map((n) => n.path);
    setChecked((s) => (paths.every((p) => s.has(p)) ? new Set() : new Set(paths)));
  }, [listItems]);

  // Prune trashed paths from the in-memory tree (no re-scan), drop them from the
  // visible list, and re-anchor the navigation stack into the updated tree. The
  // backend prunes its retained tree too, so a re-fetch stays consistent.
  const applyTrashed = useCallback(
    (paths: string[]) => {
      if (!scan || paths.length === 0) return;
      const next = removePaths(scan.tree, paths);
      setScan({ ...scan, tree: next, files: next.item_count });
      setStack((s) => remapStack(next, s, paths));
      setListItems((items) => items.filter((n) => !paths.includes(n.path)));
      setSelected((sel) => (sel && paths.includes(sel.path) ? null : sel));
      setDups((d) => (d ? pruneDupReport(d, paths) : d));
    },
    [scan],
  );

  const trashPaths = useCallback(
    (paths: string[], label: string) => {
      if (paths.length === 0 || stack.length === 0) return;
      setConfirm({
        title: `Move ${label} to the Trash?`,
        detail: "It goes to the macOS Trash (recoverable) — nothing is permanently deleted.",
        confirmLabel: "Move to Trash",
        onOk: async () => {
          // Apply whatever actually reached the Trash, even on a mid-loop error.
          const done: string[] = [];
          try {
            for (const p of paths) {
              await api.moveToTrash(p);
              done.push(p);
            }
          } catch (e) {
            setError(String(e));
          } finally {
            if (done.length) applyTrashed(done);
          }
        },
      });
    },
    [stack, applyTrashed],
  );

  const onTreemapTrash = useCallback(() => {
    if (selected?.path) trashPaths([selected.path], `${selected.name} (${fmtBytes(selected.size)})`);
  }, [selected, trashPaths]);

  return (
    <div className="app">
      <Toolbar root={stack[0] ?? null} loading={loading} view={view} onSetView={setViewMode} onRescan={() => stack[0] && runScan(stack[0].path)} />
      <div className="body">
        <Sidebar root={root} tm={tm} colorMap={colorMap} onRecommend={onRecommend} dups={dups} dupScanning={dupScanning} dupProgress={dupProgress} onOpenDups={() => setView("dups")} />
        <main className="content">
          {error ? (
            <>
              <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              <div className="state">{error}</div>
            </>
          ) : loading || !root ? (
            <>
              <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              <Scanning progress={progress} />
            </>
          ) : view === "list" ? (
            <>
              {listSource ? (
                <FilterBar label={listSource.label} count={listItems.length} bytes={listItems.reduce((s, n) => s + n.size, 0)} onClear={() => setListSource(null)} />
              ) : (
                <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              )}
              <ListView
                items={listItems}
                loading={listLoading}
                sort={sort}
                onSort={onSort}
                checked={checked}
                nameFromParent={listSource?.nameFromParent ?? false}
                home={home}
                onToggleCheck={toggleCheck}
                onToggleAll={toggleAll}
                onDrill={drill}
                onReveal={(n) => api.revealInFinder(n.path)}
                onTrashOne={(n) => trashPaths([n.path], `${n.name} (${fmtBytes(n.size)})`)}
              />
            </>
          ) : view === "dups" ? (
            <DupsView
              report={dups}
              scanning={dupScanning}
              progress={dupProgress}
              home={home}
              onReveal={(p) => api.revealInFinder(p)}
              onTrashPaths={trashPaths}
            />
          ) : (
            <>
              <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              <Treemap root={root} colorMap={colorMap} selected={selected} onHover={setHover} onSelect={setSelected} onDrill={drill} />
              <Legend legend={legend} />
            </>
          )}
        </main>
      </div>
      {view === "dups" ? (
        <DupsInspector report={dups} scanning={dupScanning} />
      ) : view === "list" ? (
        <ListInspector
          count={checkedNodes.length}
          bytes={checkedBytes}
          onReveal={() => checkedNodes[0] && api.revealInFinder(checkedNodes[0].path)}
          onTrash={() => trashPaths(checkedNodes.map((n) => n.path), `${checkedNodes.length} item${checkedNodes.length === 1 ? "" : "s"} (${fmtBytes(checkedBytes)})`)}
        />
      ) : (
        <Inspector node={focus} selected={selected} onTrash={onTreemapTrash} />
      )}
      {confirm && <ConfirmModal data={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function ConfirmModal({ data, onClose }: { data: ConfirmData; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{data.title}</div>
        <div className="modal-detail">{data.detail}</div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={() => { data.onOk(); onClose(); }}>{data.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Toolbar({ root, loading, view, onSetView, onRescan }: { root: Node | null; loading: boolean; view: ViewMode; onSetView: (m: ViewMode) => void; onRescan: () => void }) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="app-name">disc<span className="dot">·</span>solve</div>
      <div className="toolbar">
        <div className="vol">{root ? root.name : "—"}</div>
        <div className="seg">
          <button className={view === "treemap" ? "on" : ""} onClick={() => onSetView("treemap")}>Treemap</button>
          <button className={view === "list" ? "on" : ""} onClick={() => onSetView("list")}>List</button>
          <button className={view === "dups" ? "on" : ""} onClick={() => onSetView("dups")}>Duplicates</button>
        </div>
        <button className="btn primary" onClick={onRescan} disabled={loading}>{loading ? "Scanning…" : "Rescan"}</button>
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

function Sidebar({ root, tm, colorMap, onRecommend, dups, dupScanning, dupProgress, onOpenDups }: {
  root: Node | null;
  tm: TimeMachineStatus | null;
  colorMap: Map<string, string>;
  onRecommend: (s: Suggestion) => void;
  dups: DupReport | null;
  dupScanning: boolean;
  dupProgress: { hashed: number; total: number } | null;
  onOpenDups: () => void;
}) {
  const suggestions = useMemo(() => (root ? reclaimable(root) : []), [root]);
  const segments = useMemo(() => {
    if (!root) return [] as { ext: string; bytes: number; color: string }[];
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

      <div className="side-sec">
        <h3 className="side-h">Duplicates</h3>
        {dupScanning ? (
          <div className="status">
            <div className="txt">
              <div className="t1">Scanning…</div>
              <div className="t2">
                {dupProgress && dupProgress.total > 0
                  ? `${Math.round((dupProgress.hashed / dupProgress.total) * 100)}% · ${dupProgress.hashed.toLocaleString()}/${dupProgress.total.toLocaleString()} files`
                  : "hashing files in the background"}
              </div>
            </div>
          </div>
        ) : dups && dups.groups.length > 0 ? (
          <div className="rec" onClick={onOpenDups} title="Review duplicate files">
            <div className="rbody">
              <div className="r1">{dups.groups.length} duplicate set{dups.groups.length === 1 ? "" : "s"}</div>
              <div className="r2">
                <span className="r2t">Identical files</span>
                <span className="amt">{fmtBytes(dups.reclaimable)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="status">
            <div className="txt">
              <div className="t2">{dups ? "None found" : "…"}</div>
            </div>
          </div>
        )}
      </div>

      <div className="side-sec" style={{ paddingBottom: 0 }}>
        <h3 className="side-h">Recommended</h3>
      </div>
      <div className="recs">
        {suggestions.map((s) => (
          <div className="rec" key={s.key} onClick={() => onRecommend(s)} title={s.action === "openTrash" ? "Open the Trash in Finder" : "Show all in a list"}>
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
            <span className={"crumb" + (isCur ? " cur" : "")} onClick={() => !isCur && onJump(i)}>{node.name}</span>
          </span>
        );
      })}
      {stack.length > 1 && <span className="crumb-hint">Esc to go up</span>}
      {stack.length > 0 && (
        <span className="right">{fmtBytes(stack[stack.length - 1].size)} · {stack[stack.length - 1].item_count.toLocaleString()} items</span>
      )}
    </div>
  );
}

function FilterBar({ label, count, bytes, onClear }: { label: string; count: number; bytes: number; onClear: () => void }) {
  return (
    <div className="crumbs">
      <span className="crumb cur">Filtered</span>
      <span className="sep">›</span>
      <span className="filterchip">
        {label}
        <button className="x" title="Clear filter" onClick={onClear}>✕</button>
      </span>
      <span className="right">{count} item{count === 1 ? "" : "s"} · {fmtBytes(bytes)}</span>
    </div>
  );
}

function SortHead({ label, col, sort, onSort, cls }: { label: string; col: SortKey; sort: { key: SortKey; dir: SortDir }; onSort: (k: SortKey) => void; cls: string }) {
  const active = sort.key === col;
  return (
    <span className={cls + (active ? " sorted" : "")} onClick={() => onSort(col)}>
      {label}
      {active && <span className="arr">{sort.dir === "desc" ? " ▾" : " ▴"}</span>}
    </span>
  );
}

function ListView({
  items, loading, sort, onSort, checked, nameFromParent, home, onToggleCheck, onToggleAll, onDrill, onReveal, onTrashOne,
}: {
  items: Node[];
  loading: boolean;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  checked: Set<string>;
  nameFromParent: boolean;
  home: string | null;
  onToggleCheck: (path: string) => void;
  onToggleAll: () => void;
  onDrill: (n: Node) => void;
  onReveal: (n: Node) => void;
  onTrashOne: (n: Node) => void;
}) {
  const sorted = useMemo(() => sortItems(items, sort.key, sort.dir), [items, sort]);
  const maxSize = sorted.reduce((m, n) => Math.max(m, n.size), 1);
  const checkable = sorted.filter((n) => n.path);
  const allChecked = checkable.length > 0 && checkable.every((n) => checked.has(n.path));

  return (
    <div className="listwrap">
      <div className="lhead">
        <span className="lh-check"><input type="checkbox" checked={allChecked} onChange={onToggleAll} /></span>
        <SortHead label="Name" col="name" sort={sort} onSort={onSort} cls="lh-name" />
        <SortHead label="Size" col="size" sort={sort} onSort={onSort} cls="lh-size" />
        <SortHead label="Items" col="items" sort={sort} onSort={onSort} cls="lh-items" />
        <SortHead label="Last modified" col="mtime" sort={sort} onSort={onSort} cls="lh-used" />
      </div>
      <div className="lbody">
        {sorted.length === 0 && <div className="state">{loading ? "Loading…" : "Nothing here."}</div>}
        {sorted.map((n, i) => {
          const name = nameFromParent ? parentName(n.path) : n.name;
          const isChecked = !!n.path && checked.has(n.path);
          const stale = isStale(n.mtime);
          return (
            <div
              key={n.path || i}
              className={"lrow" + (isChecked ? " sel" : "")}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("input,button")) return;
                if (n.path) onToggleCheck(n.path);
              }}
              onDoubleClick={() => n.is_dir && onDrill(n)}
            >
              <span className="l-check"><input type="checkbox" checked={isChecked} disabled={!n.path} onChange={() => n.path && onToggleCheck(n.path)} /></span>
              <span className="l-name">
                <i className="dot" style={{ background: CAT_COLOR[n.category] }} />
                <span className="nm"><span className="t">{name}</span><small>{shortenPath(n.path, home) || "aggregated"}</small></span>
              </span>
              <span className="l-size">
                <span className="szbar"><span className="szfill" style={{ width: `${Math.round((n.size / maxSize) * 100)}%`, background: CAT_COLOR[n.category] }} /></span>
                <b>{fmtBytes(n.size)}</b>
              </span>
              <span className="l-items">{n.item_count.toLocaleString()}</span>
              <span className={"l-used" + (stale ? " stale" : "")}>{fmtRelTime(n.mtime)}</span>
              {n.path && (
                <span className="l-act">
                  {n.is_dir && (
                    <button className="iact" title="Open folder" onClick={(e) => { e.stopPropagation(); onDrill(n); }}>{ICON_OPEN}</button>
                  )}
                  <button className="iact" title="Reveal in Finder" onClick={(e) => { e.stopPropagation(); onReveal(n); }}>{ICON_REVEAL}</button>
                  <button className="iact danger" title="Move to Trash" onClick={(e) => { e.stopPropagation(); onTrashOne(n); }}>{ICON_TRASH}</button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Treemap({
  root, colorMap, selected, onHover, onSelect, onDrill,
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
        const cls = "cell" + (t.group ? " grp" : isAgg ? " agg" : color ? "" : " neutral");
        const showLabel = !t.group && t.w > 46 && t.h > 20;
        return (
          <div
            key={i}
            className={cls}
            style={{ left: t.x, top: t.y, width: Math.max(0, t.w), height: Math.max(0, t.h), background: t.group ? undefined : color ?? undefined }}
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
      {selTile && <div className="tm-overlay sel" style={{ left: selTile.x, top: selTile.y, width: selTile.w, height: selTile.h }} />}
      {hoverFolder && <div className="tm-overlay folder" style={{ left: hoverFolder.x, top: hoverFolder.y, width: hoverFolder.w, height: hoverFolder.h }} />}
      {tiles.filter((t) => t.labeled).map((t, i) => (
        <div
          key={"g" + i}
          className="glabel"
          style={{ left: t.x + 5, top: t.y + 4, maxWidth: Math.max(42, t.w - 10) }}
          onMouseEnter={() => { onHover(t.node); setHoverFolder(t); }}
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
        <span key={l.ext}><i style={{ background: l.color }} />{l.ext === "(none)" ? "no ext" : l.ext}</span>
      ))}
    </div>
  );
}

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
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.revealInFinder(target!.path)}>Reveal in Finder</button>
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.openTerminalHere(dirOf(target!))}>Open Terminal Here</button>
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.quickLook(target!.path)}>Quick Look</button>
        <button className="btn danger" disabled={!canTrash} onClick={onTrash}>Move to Trash</button>
      </div>
    </div>
  );
}

function ListInspector({ count, bytes, onReveal, onTrash }: { count: number; bytes: number; onReveal: () => void; onTrash: () => void }) {
  return (
    <div className={"inspector" + (count === 0 ? " empty" : "")}>
      <div className="insp-meta">
        <div className="insp-path">{count === 0 ? "Select items to reclaim" : `${count} item${count === 1 ? "" : "s"} selected`}</div>
        <div className="insp-sub">{count === 0 ? "Tick rows to act on them" : `${fmtBytes(bytes)} · recoverable`}</div>
      </div>
      <div className="insp-actions">
        <button className="btn" disabled={count === 0} onClick={onReveal}>Reveal in Finder</button>
        <button className="btn danger" disabled={count === 0} onClick={onTrash}>Move {count} to Trash · {fmtBytes(bytes)}</button>
      </div>
    </div>
  );
}

function DupsView({ report, scanning, progress, home, onReveal, onTrashPaths }: {
  report: DupReport | null;
  scanning: boolean;
  progress: { hashed: number; total: number } | null;
  home: string | null;
  onReveal: (path: string) => void;
  onTrashPaths: (paths: string[], label: string) => void;
}) {
  const groups = report?.groups ?? [];

  if (scanning) {
    const has = progress && progress.total > 0;
    const pct = has ? Math.round((progress!.hashed / progress!.total) * 100) : 0;
    return (
      <div className="state">
        <div className="scanning">
          <div className={"scanbar" + (has ? "" : " indet")}>
            <div className="scanbar-fill" style={has ? { width: `${pct}%` } : undefined} />
          </div>
          <div className="scan-count">
            {has ? `Hashing ${progress!.hashed.toLocaleString()} / ${progress!.total.toLocaleString()} candidates · ${pct}%` : "Looking for duplicate files…"}
          </div>
        </div>
      </div>
    );
  }
  if (groups.length === 0) {
    return <div className="state">No duplicate files found ({fmtBytes(1 << 20)} and larger).</div>;
  }

  return (
    <div className="dupwrap">
      <div className="crumbs">
        <span className="crumb cur">Duplicates</span>
        <span className="right">{groups.length} set{groups.length === 1 ? "" : "s"} · {fmtBytes(report!.reclaimable)} reclaimable</span>
      </div>
      <div className="dupbody">
        {groups.map((g, gi) => {
          const keep = keeperOf(g);
          const extras = g.paths.filter((p) => p !== keep);
          return (
            <div className="dupgroup" key={gi}>
              <div className="dg-head">
                <span className="dg-name">{baseName(keep)}</span>
                <span className="dg-meta">{fmtBytes(g.size)} each · {g.paths.length} copies · reclaim {fmtBytes(g.reclaimable)}</span>
                <button className="btn danger sm" onClick={() => onTrashPaths(extras, `${extras.length} extra cop${extras.length === 1 ? "y" : "ies"} of ${baseName(keep)} (${fmtBytes(g.reclaimable)})`)}>
                  Trash {extras.length} extra{extras.length === 1 ? "" : "s"}
                </button>
              </div>
              {g.paths.map((p) => {
                const isKeep = p === keep;
                return (
                  <div className={"dupfile" + (isKeep ? " keep" : "")} key={p}>
                    <span className="df-path">{shortenPath(p, home)}</span>
                    {isKeep ? (
                      <span className="df-tag">Keep</span>
                    ) : (
                      <span className="df-act">
                        <button className="iact" title="Reveal in Finder" onClick={() => onReveal(p)}>{ICON_REVEAL}</button>
                        <button className="iact danger" title="Move to Trash" onClick={() => onTrashPaths([p], `${baseName(p)} (${fmtBytes(g.size)})`)}>{ICON_TRASH}</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DupsInspector({ report, scanning }: { report: DupReport | null; scanning: boolean }) {
  const sets = report?.groups.length ?? 0;
  const title = scanning ? "Scanning for duplicates…" : sets === 0 ? "No duplicates found" : `${sets} duplicate set${sets === 1 ? "" : "s"}`;
  const sub = sets > 0 ? `${fmtBytes(report!.reclaimable)} reclaimable · keeps one copy of each` : scanning ? "Reading and hashing files in the background" : "Nothing to reclaim here";
  return (
    <div className={"inspector" + (sets === 0 ? " empty" : "")}>
      <div className="insp-meta">
        <div className="insp-path">{title}</div>
        <div className="insp-sub">{sub}</div>
      </div>
    </div>
  );
}
