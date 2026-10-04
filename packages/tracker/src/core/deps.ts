import { Graph } from "effect";

/**
 * Dependency logic for tracker items: reference parsing, cycle detection, and
 * readiness.
 *
 * Pure and free of the store and of any Effect runtime, so both the mutation
 * path (the store) and the read path (rendering) can share it.
 */

/** One item as the dependency helpers see it. */
export interface DependencyItem {
  /**
   * Absent in an encoded snapshot whose `id` default has not been applied yet;
   * the live store always sets it, and `restore` migrates older snapshots.
   */
  readonly id?: number | undefined;
  readonly done: boolean;
  readonly deps?: readonly string[] | undefined;
}

/**
 * A list and its items, as the read path sees it. Declared structurally so both
 * the live `TodoList` and the encoded snapshot in tool details fit, and so this
 * module stays free of the domain classes. Generic in the item type so callers
 * keep their own item shape (the domain class, an encoded item, a test stub).
 */
export interface DependencyListView<T extends DependencyItem> {
  readonly name: string;
  readonly items: readonly T[];
}

/** A list of plain items, as the dependency helpers need it. */
export type DependencyList = DependencyListView<DependencyItem>;

/** A parsed `listName:id` reference. */
export interface ItemRef {
  readonly name: string;
  readonly id: number;
}

/**
 * Parse a `listName:id` reference. Splits on the last colon so list names may
 * contain colons; the id must be a positive integer. Returns null for anything
 * that is not a well-formed reference.
 */
export const parseItemRef = (ref: string): ItemRef | null => {
  const colon = ref.lastIndexOf(":");
  if (colon <= 0 || colon === ref.length - 1) return null;
  const idText = ref.slice(colon + 1);
  if (!/^[1-9]\d*$/.test(idText)) return null;
  return { name: ref.slice(0, colon), id: Number(idText) };
};

/** Format a reference the way the list action shows it. */
export const formatItemRef = (listName: string, id: number): string => `${listName}:${id}`;

/** Resolve a same-list reference to its 0-based index, or undefined. */
export const resolveRef = (list: DependencyList, ref: string): number | undefined => {
  const parsed = parseItemRef(ref);
  if (parsed === null || parsed.name !== list.name) return undefined;
  const index = list.items.findIndex((item) => item.id === parsed.id);
  return index === -1 ? undefined : index;
};

/**
 * Candidate edges as `[dependencyIndex, dependentIndex]`, with `deps` standing
 * in for the item at `targetIndex` and every other item keeping its stored
 * deps. References that do not resolve to a same-list item are skipped: they
 * cannot close a cycle, and the store rejects them separately.
 */
const candidateEdges = (
  list: DependencyList,
  targetIndex: number,
  deps: readonly string[],
): Array<readonly [number, number]> => {
  const edges: Array<readonly [number, number]> = [];
  list.items.forEach((item, dependent) => {
    for (const ref of dependent === targetIndex ? deps : (item.deps ?? [])) {
      const dependency = resolveRef(list, ref);
      if (dependency !== undefined) edges.push([dependency, dependent]);
    }
  });
  return edges;
};

/**
 * Follow the candidate edges depth-first from `targetIndex` and return the
 * first path that comes back to it, as item indexes. Empty when no cycle
 * passes through the target.
 */
const findCyclePath = (
  edges: ReadonlyArray<readonly [number, number]>,
  targetIndex: number,
): readonly number[] => {
  // dependency → its dependents, so a walk follows what each item unblocks.
  const dependents = new Map<number, number[]>();
  for (const [dependency, dependent] of edges) {
    const existing = dependents.get(dependency);
    if (existing === undefined) dependents.set(dependency, [dependent]);
    else existing.push(dependent);
  }

  const path: number[] = [];
  const onPath = new Set<number>();
  const walk = (node: number): boolean => {
    path.push(node);
    onPath.add(node);
    for (const next of dependents.get(node) ?? []) {
      if (next === targetIndex) {
        // The loop is closed; name the target again at the end of the path.
        path.push(next);
        return true;
      }
      if (onPath.has(next)) continue;
      if (walk(next)) return true;
    }
    path.pop();
    onPath.delete(node);
    return false;
  };

  return walk(targetIndex) ? path : [];
};

/**
 * The cycle that giving `deps` to the item at `targetIndex` would close, as
 * display refs that start and end at that item. Null when the candidate set
 * stays acyclic, which is the common case.
 *
 * The decision comes from `Graph.isAcyclic`; the path is then walked so the
 * error can name the items involved. An empty array means a cycle exists in
 * the list but not through the target, which only a hand-edited snapshot can
 * produce.
 */
export const cyclePath = (
  list: DependencyList,
  targetIndex: number,
  deps: readonly string[],
): readonly string[] | null => {
  const edges = candidateEdges(list, targetIndex, deps);
  const graph = Graph.directed<number, string>((mutable) => {
    const nodes = list.items.map((_, index) => Graph.addNode(mutable, index));
    for (const [dependency, dependent] of edges) {
      Graph.addEdge(mutable, nodes[dependency]!, nodes[dependent]!, "dep");
    }
  });
  if (Graph.isAcyclic(graph)) return null;
  return findCyclePath(edges, targetIndex).map((index) =>
    formatItemRef(list.name, list.items[index]!.id ?? 0),
  );
};

/**
 * Display refs of the dependencies of the item at `index` that are not done.
 * Independent of the item's own state, so a done item whose prerequisite was
 * reopened still reports it.
 *
 * An unresolvable dependency counts as unsatisfied and is reported as `?`, so a
 * hand-edited snapshot cannot silently unblock work.
 */
export const unsatisfiedDeps = (list: DependencyList, index: number): readonly string[] => {
  const item = list.items[index];
  if (item === undefined) return [];
  const unsatisfied: string[] = [];
  for (const ref of item.deps ?? []) {
    const dependency = resolveRef(list, ref);
    if (dependency === undefined) unsatisfied.push("?");
    else if (!list.items[dependency]!.done) unsatisfied.push(ref);
  }
  return unsatisfied;
};

/**
 * What stops the item at `index` from being completed. Empty for a done item:
 * completion is gated only on open work, so re-marking a done item done is
 * never refused. The reading surfaces use `unsatisfiedDeps` when they need the
 * fact for a done row.
 */
export const blockersOf = (list: DependencyList, index: number): readonly string[] =>
  list.items[index]?.done === true ? [] : unsatisfiedDeps(list, index);

/** Derived readiness of one item. `ready` means "open and unblocked". */
export interface ItemReadiness {
  readonly index: number;
  readonly id: number;
  readonly ready: boolean;
  /**
   * The not-done dependencies, as display refs, or `?` when unresolvable.
   * Reported for a done item too, so a row whose prerequisite reopened can be
   * marked; `ready` is false whenever the item is done.
   */
  readonly blockers: readonly string[];
}

/**
 * Readiness for every item in list order. Derived on read and never stored, so
 * it cannot go stale next to the items it describes.
 */
export const readiness = (list: DependencyList): readonly ItemReadiness[] =>
  list.items.map((item, index) => {
    const blockers = unsatisfiedDeps(list, index);
    return { index, id: item.id ?? 0, ready: !item.done && blockers.length === 0, blockers };
  });

/**
 * Index of the first ready item in list order, or undefined when nothing is
 * ready (every item is done, or every open item is blocked).
 */
export const firstReadyIndex = (list: DependencyList): number | undefined => {
  const index = list.items.findIndex(
    (item, candidate) => !item.done && blockersOf(list, candidate).length === 0,
  );
  return index === -1 ? undefined : index;
};

/** Indexes of the items that depend on the item at `index`. */
export const dependentsOf = (list: DependencyList, index: number): readonly number[] =>
  list.items.flatMap((item, dependent) =>
    (item.deps ?? []).some((ref) => resolveRef(list, ref) === index) ? [dependent] : [],
  );

/**
 * The items in derived display order: every dependency before the items that
 * wait for it, in a stable order otherwise.
 *
 * A list without dependencies returns its stored order unchanged, so nothing
 * moves until dependencies exist. A list whose graph is cyclic (only a
 * hand-edited snapshot can produce one) also falls back to the stored order,
 * so rendering never throws and never drops an item.
 */
export const orderedItems = <T extends DependencyItem>(
  list: DependencyListView<T>,
): readonly T[] => {
  if (!list.items.some((item) => (item.deps ?? []).length > 0)) return list.items;
  const graph = Graph.directed<number, string>((mutable) => {
    const nodes = list.items.map((_, index) => Graph.addNode(mutable, index));
    list.items.forEach((item, dependent) => {
      for (const ref of item.deps ?? []) {
        const dependency = resolveRef(list, ref);
        // A self-reference orders nothing; the store rejects it separately.
        if (dependency !== undefined && dependency !== dependent) {
          Graph.addEdge(mutable, nodes[dependency]!, nodes[dependent]!, "dep");
        }
      }
    });
  });
  if (!Graph.isAcyclic(graph)) return list.items;
  return [...Graph.indices(Graph.topo(graph))].map((index) => list.items[index]!);
};
