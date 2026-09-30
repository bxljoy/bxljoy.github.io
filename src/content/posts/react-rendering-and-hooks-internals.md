---
title: "React rendering and hooks internals: fibers, the diff, and hook slots"
description: "What actually happens on a React re-render: elements vs. the fiber tree vs. the real DOM, render and commit, reconciliation, hooks as ordered slots on a fiber, why referential identity drives useMemo/useCallback, and how to stop child re-renders."
pubDatetime: 2026-09-30T12:33:00+02:00
tags: [frontend, react, rendering, hooks]
sourceNotes: [react-rendering-and-hooks-internals]
---

> A re-render doesn't mutate the virtual DOM in place — it produces a fresh, throwaway element tree, diffs it against the previous one, and commits the minimal real-DOM change. State persists on the **fiber tree**, and hooks are **ordered slots on a fiber, matched by call order** (not by name), with `Object.is` deps comparisons deciding what's stale. This is the mechanism behind useState/useEffect/useMemo/useCallback/useRef and the "rules of hooks."

## Table of contents

## Overview

For a backend engineer who can _use_ hooks but doesn't know what they do under the hood: React's hooks are a data-structure trick, not magic.

Understanding the three trees (elements / fiber / real DOM), the render → commit pipeline, and the per-fiber ordered hook list explains _why_ renders happen, why referential identity matters, why the rules of hooks exist, and why `useMemo`/`useCallback` are identity-stabilizers rather than a generic "speed" tool.

## Key points

- **Three distinct things, not two.** React _elements_ (the "virtual DOM") are immutable plain objects `{type, props, key}`, thrown away on every render. The _fiber tree_ is React's persistent internal mirror that holds state, hooks, and DOM pointers. The _real DOM_ is the browser's nodes. State lives on the fiber, not in your closure.
- **Render = calling your function.** It returns elements; it does **not** touch the DOM. A component can render many times with zero DOM mutations.
- **A re-render produces a NEW element tree**, which React _diffs_ (reconciliation) against the previous one, and then commits only the minimal real-DOM mutations. The virtual DOM is disposable; the fiber tree is the memory.
- **Hooks are matched by call order**, stored as an ordered list on the fiber and walked by a cursor that resets to 0 on each render. The Nth hook call = the Nth slot. This is the entire reason for the rules of hooks.
- **`useRef` returns the same object on every render, and React never reads it** → mutating `.current` triggers nothing. Refs = instance memory that survives renders but is invisible to rendering.
- **`useMemo` is a one-entry cache keyed by deps; `useCallback(fn, deps)` is `useMemo(() => fn, deps)`.** Both stabilize _identity_ across renders.
- **Objects/arrays/functions created during render are new identities on every render.** That's why memoized children re-render and effect deps re-fire — and it's the actual reason `useMemo`/`useCallback` exist.
- **Re-rendering a component re-renders all its children by default** (calling the function calls theirs); `React.memo` opts out via a shallow prop comparison.

## The three trees

| Thing                              | What it is                                                                                                                 | Lifetime                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **React elements** ("virtual DOM") | Immutable JS objects `{ type, props, key }`; `<div/>` → `React.createElement('div', …)` returns one                        | Re-created and discarded on every render      |
| **Fiber tree**                     | React's persistent mirror of the component tree; each fiber holds state, the hook list, and a pointer to the real DOM node | Persists across renders — the actual "memory" |
| **Real DOM**                       | Browser nodes                                                                                                              | Persists; expensive to mutate                 |

A component's state "sticks" because React identifies it by **type + position (+ `key`)** in the tree. Change the `key` → React treats it as a different component → it unmounts the old one and resets its state (the legitimate "reset the form when the id changes" trick).

## The render pipeline

```
state change
   │
   ▼
[ RENDER phase ]   call component fn(s) → new element tree → diff vs old (reconciliation)
   │               interruptible in concurrent React; NO side effects allowed here
   ▼
[ COMMIT phase ]   apply computed DOM mutations (synchronous, not interruptible)
   │
   ▼
effects            useLayoutEffect (sync, before paint) → browser paints → useEffect (async, after paint)
```

This split is why effects don't run during render, and why `useEffect` fires after the user sees the paint.

## Reconciliation (the diff) — O(n) via two heuristics

- **A different `type`** at a position → tear down the old DOM subtree and build a new one (state is destroyed).
- **The same `type`** → keep the DOM node and update only the changed props (state is preserved).
- **Lists are matched by `key`.** The index-as-key bug: on a reorder, React sees "same key/position" and applies the _wrong_ row's props to the wrong DOM node → a state/DOM mismatch.

## What triggers a re-render, and the cascade

There are three triggers: **a state update**, **a parent re-rendering**, and **a consumed context value changing**.

The cascade: re-rendering a component re-renders **all its children by default** (calling the parent function calls the children's functions), regardless of whether their props changed. `React.memo` shallow-compares props to skip the call. `setState` is **batched** (React 18+ auto-batches, even in async code), and setting the same value (`Object.is`) can **bail out** of the render.

## What is a hook? (and custom hooks)

A **hook is a `use`-prefixed function that lets a component tap into its fiber's slot list** — state, effects, refs, context: things that must persist across renders and belong to a specific component instance. It has two defining properties:

1. It reads/writes fiber slots (directly, or by calling something that does).
2. Its name starts with `use`, which the linter and compiler rely on to enforce the ordering rules.

Hooks are the _only_ sanctioned way for a function component to get memory and side effects — without them, the component function is pure and amnesiac.

A **custom hook is just a JS function named `useSomething` that calls one or more other hooks** (built-in or custom). There's no special API — it's pure composition and extraction. Mechanically, it does **not** get its own slots: its `useState`/`useEffect` calls occupy slots in the **calling component's** fiber list, in call order (it's effectively "inlined" into the caller's hook sequence). That's why the rules of hooks apply to custom hooks too.

**The key insight — custom hooks share logic, not state.** Each _call_ to a custom hook gets its own isolated slots:

```tsx
function useCounter() {
  const [c, setC] = useState(0);
  return { c, inc: () => setC(x => x + 1) };
}
function A() {
  const a = useCounter(); /* a.c independent */
}
function B() {
  const b = useCounter(); /* b.c totally separate */
}
```

A custom hook is a **logic template**, not a shared data container. If you need shared _state_ across components, that's Context or a store (Zustand), **not** a custom hook.

**Why create custom hooks:** to reuse stateful logic (DRY for behavior, replacing the old HOC/render-props "wrapper hell"); to separate concerns (the component body renders, the hook handles behavior/data); to name an intent; to test in isolation (`renderHook`); and to encapsulate wiring (effect setup + cleanup, subscriptions) behind a clean return value.

**When to create one:**

1. The same hook wiring is repeated in 2+ components → extract it (`useUser(id)`).
2. A **context-consumption wrapper** (very common): `useAuth()` = `useContext(AuthContext)` + a guard that throws outside the provider.
3. Subscribing to a browser API or external store, with cleanup → `useOnlineStatus`, `useMediaQuery`, `useLocalStorage`.
4. Timers / debounce / throttle → `useDebounce(value, ms)`, `useInterval`.
5. Reusable interactions → `useClickOutside`, `useKeyPress`, `useFocusTrap` (a11y for modals).
6. Data fetching with loading/error/cache → conceptually `useFetch`; in production this is TanStack Query's `useQuery`, _which is itself a custom hook_.
7. Coordinating a cluster of related state or a small state machine → `usePayment()` returning `{ status, pay, reset }`.

**When NOT to:**

- **If it calls no hooks, it's a plain function — don't prefix it with `use`.** The `use` name promises hook state/effects inside; misusing it confuses the linter and readers (e.g., `formatPrice(cents)` is not a hook).
- Don't use a custom hook to share _state_ (that's Context or a store).
- Don't over-abstract a single trivial `useState`.

In one line: _a hook taps a component's fiber slots; a custom hook composes other hooks to reuse stateful logic, with each call getting its own isolated state — never shared data._

## The key mechanism — hooks are ordered slots on the fiber

```js
// Each fiber instance:
fiber.hooks = []; // ordered slots
let cursor = 0; // reset to 0 at the start of every render of this fiber

function useState(initial) {
  const slot = (fiber.hooks[cursor] ??= { state: initial }); // first render: create
  cursor++; // advance cursor
  const setState = next => {
    slot.state = typeof next === "function" ? next(slot.state) : next;
    scheduleRerender(fiber); // mark dirty
  };
  return [slot.state, setState];
}
```

Hooks are matched by **call order, not by name** — it's an array index, not a hashmap key. Consequences:

- **The rules of hooks** exist because a changed call order (hooks inside `if`s or loops) misaligns the indices → a `useState` reads another hook's slot.
- **State lives on the fiber**, not in the closure. Your function is called fresh on each render (new locals), but `useState` reaches into the persistent slot for the latest value.

## Each hook as a slot shape

- **`useState`** — a value slot + a scheduler. `setState` writes the slot and schedules a render; the next render returns the new value. The functional updater `setX(prev => …)` reads the slot's latest value → it avoids stale-closure bugs.
- **`useRef`** — returns the **same `{ current }` object** on every render; React never reads it, so mutating `.current` schedules nothing. It survives renders but is invisible to rendering. (This is why a stable idempotency key uses `useRef`; a fresh `crypto.randomUUID()` in the function body would not be stable — it runs during render, not in a slot.)
- **`useMemo(factory, deps)`** — a one-entry cache: `if deps changed (Object.is) → recompute & cache, else return cached`.
- **`useCallback(fn, deps)`** — literally `useMemo(() => fn, deps)`; it caches the _function reference_.
- **`useEffect(effect, deps)`** — the same deps mechanism, but it queues the effect to run **after commit/paint**: run the previous cleanup, then the new effect. `[]` → on mount only (+ cleanup on unmount); no array → after every render. `useLayoutEffect` runs synchronously after DOM mutation, before paint.

## The unifying idea — referential identity + `Object.is`

Every hook compares deps with `Object.is`. And **objects/arrays/functions created during render are new identities on each render**:

```js
function Parent() {
  const config = { mode: "pay" }; // NEW object every render
  const onClick = () => doThing(); // NEW function every render
  return <Child config={config} onClick={onClick} />;
}
```

→ `React.memo(Child)`'s shallow check always fails, and any effect/memo depending on `config`/`onClick` re-fires on every render. **That is the entire reason `useMemo`/`useCallback` exist** — to keep identity stable so memoization and deps arrays work. They are identity-stabilizers, not a generic speed tool.

The caveat: each one costs a slot + a deps comparison + retained memory → stabilize only where something downstream depends on identity (a memoized child, an effect dependency). Measure with the Profiler.

## End-to-end walk-through: `setCount(c => c + 1)`

1. React writes the new value to that `useState` slot on the fiber, and marks the fiber dirty.
2. **Render:** it calls `Counter()` again; `cursor` resets to 0; hooks read their slots in order; `useState` returns `1`; a new element tree is returned.
3. **Reconcile:** the diff against the old tree → "text node `0` → `1`".
4. **Commit:** mutate exactly that one text node. Nothing else.
5. Paint; then any `useEffect` with changed deps runs (after its previous cleanup).

## Application: stopping a child re-render — `React.memo` vs. `useMemo`/`useCallback`

By default, a parent re-render cascades through the **entire subtree** below it (children, grandchildren, …), regardless of whether their props changed — because rendering is "call the function", which calls the children's functions. The two tools that stop it do **different jobs**, and for object/function props you need **both together**:

- **`React.memo(Child)`** — the thing that actually _stops_ the re-render: it shallow-compares Child's props and skips re-rendering if they're unchanged.
- **`useMemo`/`useCallback` in the parent** — keep object/function props **referentially stable**, so `React.memo`'s shallow check passes (per the identity rule above: inline objects/functions are a new identity on every render).

```tsx
const Child = React.memo(function Child({ config, onClick }) {
  /* ... */
});

function Page() {
  const [count, setCount] = useState(0);
  const config = useMemo(() => ({ mode: "pay" }), []); // stable identity
  const onClick = useCallback(() => doThing(), []); // stable identity
  return (
    <>
      <button onClick={() => setCount(c => c + 1)}>{count}</button>
      <Child config={config} onClick={onClick} />{" "}
      {/* memo check passes → Child SKIPS re-render */}
    </>
  );
}
```

| Setup                                                   | When Page re-renders                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `React.memo` + memoized object/function props           | ✅ Child **skips** the re-render                                             |
| `React.memo` but **inline** `{{...}}` / `() => …` props | ❌ re-renders — a new prop identity every render, so the shallow check fails |
| `useMemo`/`useCallback` props but **no** `React.memo`   | ❌ re-renders — nothing checks the props; the cascade just flows down        |

Rules of thumb:

- **Primitive props** (string/number/boolean) that don't change → `React.memo` **alone** is enough; no `useMemo`/`useCallback` needed.
- **Object/array/function props** → `React.memo` **plus** memoized props; one without the other is a no-op.
- **A child re-rendering is usually cheap** (the diff commits nothing if the output is unchanged) — only reach for this when the Profiler shows a real cost (an expensive subtree, a long list).

**The no-hooks alternative — composition (`children`).** A subtree passed _into_ a component as `children`, from a parent that doesn't re-render, won't re-render when the in-between component's own state changes — because it was created by the non-re-rendering parent:

```tsx
function Page() {
  return (
    <Counter>
      <ExpensiveChild />
    </Counter>
  ); // Counter's state changes don't re-render ExpensiveChild
}
```

This "move state down / lift content up" pattern often beats `React.memo`.

**Related — why Context re-renders all consumers but a store doesn't.** Context propagates by re-rendering _every_ consumer on a `value` change (there are no selectors); a store (Zustand) subscribes per slice via `useSyncExternalStore`, so only the changed slice's subscribers re-render. The choice between them comes down to exactly this re-render granularity.

## Gotchas

- **"The virtual DOM sits on top of the real DOM and gets mutated" is wrong.** Each render makes a _fresh, throwaway_ element tree that gets _diffed_; the persistent memory is the fiber tree.
- **Hooks are positional, not named.** Conditionals/loops around hooks silently break the index alignment — this is the mechanism behind the rules-of-hooks lint rule.
- **`useMemo`/`useCallback` are about identity, not speed.** Adding them everywhere adds overhead and rarely helps; they matter only when a downstream consumer compares by identity.
- **Mutating a ref never re-renders.** Correct for instance memory; wrong if you actually wanted the UI to update (use state).
- **Stale closures:** a callback/effect captures the state value from the render it was created in. Fix this with functional updates or correct deps — not by removing deps to "make it work".
- **`useEffect` runs after paint (async); `useLayoutEffect` runs before paint (sync).** Use the latter only to avoid a visible flicker when measuring or mutating layout.

## References

- Earlier in this topic: [Node.js vs. Java vs. Python concurrency](/posts/nodejs-event-loop-vs-java-concurrency/) — the async / event-loop mental model (when effects and microtasks run).
- React docs: [Render and Commit](https://react.dev/learn/render-and-commit) · [Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state) · [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) · [Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)
