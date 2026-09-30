---
title: "React Context vs. a store (Zustand): a pipe vs. a container"
description: "Why Context is dependency injection rather than state management, how a Zustand store subscribes components to slices, the re-render granularity that decides between them, and how they compose."
pubDatetime: 2026-09-30T13:23:00+02:00
tags: [frontend, react, state-management]
sourceNotes: [react-context-vs-store-state-management]
---

> Context is **dependency injection** — a pipe that carries a value through the tree without prop-drilling; it holds no state, and it re-renders **every** consumer when its value changes. A store (Zustand) is an **external state container** outside the React tree that lets components **subscribe to slices** via selectors, so only the components whose slice changed re-render. Use Context for stable, ambient values (auth, theme, locale); use a store for frequently changing or widely shared state (cart, checkout flow, filters). They compose.

## Table of contents

## Overview

These two are constantly conflated, because Context is often paired with `useState` and called "state management". The reframe that settles it: Context's real job is _transport / DI_; a store's job is _owning state, with efficient subscriptions_.

The decisive practical difference is re-render granularity — **all consumers** (Context) vs. **only the changed slice** (store) — which falls straight out of how each one propagates updates.

## Key points

- **Context is a pipe, not a container.** It carries a value; it doesn't hold state. You pair it with `useState`/`useReducer` in a provider to give it something to carry.
- **A store (Zustand) is a container** — a singleton living _outside_ the React tree that owns state and exposes it via a hook + selectors.
- **Re-render granularity is the whole decision:** Context re-renders **every consumer** when its `value` changes (`Object.is`); a store re-renders **only** the components whose selected slice changed.
- **A Context value comes from the nearest `Provider` above** (falling back to `createContext`'s default only if there's no provider). **A store value comes from a module-level singleton** created once at import; no provider is needed by default.
- **Context has no selectors** — consuming it subscribes you to the whole value. Stores subscribe per slice.
- **Choose Context** for stable, low-frequency, ambient values (auth, theme, locale, feature flags, a client instance). **Choose a store** for state that changes often or has many independent slices.
- **The anti-pattern that decides it:** frequently changing state in one big Context → a re-render storm across the subtree. Split the contexts, memoize the value, or move to a store.
- **They compose:** Context for DI (auth/theme) + Zustand for app state is a common combination.

## Context — initialization, and where the value comes from

```tsx
// 1. CREATE — the channel + a no-provider fallback
const AuthContext = createContext<AuthValue | null>(null);

// 2. PROVIDE — a provider component holds the state and supplies the value
function AuthProvider({ children }) {
  const [user, setUser] = useState<User | null>(null);
  const value = useMemo(() => ({ user, setUser }), [user]); // memoize or all consumers re-render every render
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// 3. CONSUME
function Header() {
  const { user } = useContext(AuthContext);
}
```

- **Value source:** the nearest `<AuthContext.Provider>` above in the tree. With no provider above → `createContext`'s default (a fallback only, not "initial state").
- **The re-render mechanism (gotcha):** when the provider's `value` changes by `Object.is`, **every consumer re-renders**, even those using an unchanged field — there are no selectors. So (a) memoize the `value` object, and (b) don't put frequently changing state in one big context. A mitigation: split it into separate contexts (e.g., state vs. dispatch).

## Zustand store — initialization, and where the value comes from

```tsx
// 1. CREATE — a module-level singleton, OUTSIDE React; runs once at import
const useCartStore = create((set, get) => ({
  items: [], // initial state
  addItem: item => set(s => ({ items: [...s.items, item] })), // action; set() shallow-merges
  clear: () => set({ items: [] }),
  total: () => get().items.reduce((n, i) => n + i.price, 0), // derived via get()
}));

// 2. CONSUME with a SELECTOR — subscribe to a slice
function CartCount() {
  const count = useCartStore(s => s.items.length);
} // re-renders only when count changes
function AddButton() {
  const addItem = useCartStore(s => s.addItem);
} // actions stable → no re-render on state change
```

- **Value source:** a single store object held in a module-level closure, outside the React tree. `create(...)` runs once at module load (that's the initialization). There's no Provider by default — you just import the hook; it's a singleton.
- **The re-render mechanism (the advantage):** each `useStore(selector)` subscribes to the slice the selector returns; on any change, Zustand re-renders the component only if its slice changed (`Object.is`). It's built on React 18's `useSyncExternalStore`.
- **Gotcha:** a selector that returns a _new object_ on each call (`s => ({a: s.a, b: s.b})`) fails `Object.is` every time → it always re-renders. Use `useShallow(s => ({...}))` for multi-field selections (the same referential-identity issue explained in [React rendering and hooks internals](/posts/react-rendering-and-hooks-internals/)).
- **Per-instance stores:** the default is a global singleton; for SSR or isolated instances, use `createStore` + a context provider to inject a per-tree store.

## The differences

| Dimension             | Context (`useContext`)                   | Store (Zustand)                           |
| --------------------- | ---------------------------------------- | ----------------------------------------- |
| What it _is_          | Transport / DI for a value               | External state container + subscriptions  |
| Holds state?          | No (paired with `useState`/`useReducer`) | Yes (owns the state)                      |
| Where the value lives | A `Provider` inside the React tree       | A singleton outside the React tree        |
| Re-render granularity | **All consumers** on a value change      | **Only the changed slice's** subscribers  |
| Selectors             | No (the whole value)                     | Yes (per slice)                           |
| Provider needed       | Yes                                      | No (by default)                           |
| Best for              | Low-frequency ambient values             | Frequently changing / widely shared state |

## When to choose which

- **Context:** dependency injection of stable, low-frequency values — theme, locale, the authenticated user, feature flags, a configured client/service. "Re-render all consumers" is a non-issue when the value rarely changes.
- **Store:** application state that changes often or has many independent slices — a cart, a multi-step checkout/payment flow, filters, real-time data, cross-page UI state. Selectors prevent re-render storms.
- **Compose, not either/or:** Context for auth/theme DI + Zustand for app state; or Context to inject a per-tree store instance.

## Gotchas

- **Context's default value is a no-provider fallback, not initial state.** Forgetting the provider silently yields the default (a `useX` wrapper that throws is the common guard).
- **An inline provider `value={{...}}` re-renders all consumers on every render** — memoize it.
- **Zustand selectors that return new objects always re-render** — use `useShallow`, or select primitives.
- **Context is not inherently "slow"** — it's slow when it carries frequently changing state to many consumers. For stable values, it's perfect.

## References

- Previous in this topic: [React rendering and hooks internals](/posts/react-rendering-and-hooks-internals/) — the re-render and referential-identity mechanism underneath both.
- React docs: [Passing Data Deeply with Context](https://react.dev/learn/passing-data-deeply-with-context) · [Scaling Up with Reducer and Context](https://react.dev/learn/scaling-up-with-reducer-and-context) · [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- [Zustand documentation](https://zustand.docs.pmnd.rs/) (`create`, selectors, `useShallow`)
