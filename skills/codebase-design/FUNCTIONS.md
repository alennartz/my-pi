# Function-Level Principles

Non-negotiable defaults for writing and reviewing implementation code. Prefer these over cleverer alternatives. When existing code violates them, call it out — don't propagate the pattern. Part of the [codebase-design](SKILL.md) doctrine: these rules make the *inside* of a deep module testable and safe to change.

## 1. Pure functions returning values are the default

A function that takes inputs and returns an output is testable, composable, and local to reason about. A function that reads shared state, mutates it, and returns nothing is none of those things.

Side-effecting functions should be the minority, concentrated at the edges of the system ("functional core, imperative shell"). Default shape: a pure helper computes the new value; the caller decides what to do with it. When you reach for a side-effecting function, there should be a reason you can name.

## 2. Be deliberate about points of mutation

Domain model and core algorithm data: immutable by default. Use the language's native immutable types (records, frozen value types, persistent collections, `readonly`, `const`) where they exist. "Mutating" produces a new value.

State holders — caches, queues, buffers, in-flight builders, form state, ORM entities — are allowed to mutate. That's normal infrastructure. For state holders that participate in business logic, the mutation API should be explicit (a typed wrapper, an observable, an atomic ref, a mutex-guarded class). For pure infrastructure types whose only job is to interact with something external — serialization DTOs, wire formats, framework-required value bags — raw mutable fields are fine; wrapping them buys nothing.

The payoff is concrete: immutable domain values pass between threads, tasks, and actors without locks, and become the natural unit of message passing. Don't push immutability so far that it hurts legibility or performance — concentrate the mutation points, don't eliminate them at all costs.

## 3. Global mutable state is rare and dangerous

Process-wide state that changes during the application's lifecycle is almost always a mistake. The carve-out is init-time mutation then freeze: load config, register handlers, build pools at startup; after that, the state is effectively immutable.

Banned: module-level mutable variables holding business state, service-locator singletons whose fields drift over time, registries that arbitrary code reaches into and mutates. If two pieces of code need to share state, pass it in explicitly so the dependency is visible at the call site.

## 4. Closures must not bind to reassignable outer slots

The hazard is a lifecycle mismatch between a closure and the slot it read from. If code does `x = a; schedule { use(x) }; x = b`, the closure captured `a` and keeps acting on it, while the surrounding code's intent when it reassigned was "everyone should now use `b`." Two parties silently disagree about the current value.

Rule: the outer slot a closure captures from must not be reassignable after the closure is created. The standard fix is to extract a function and pass the value as a parameter, so the closure captures a parameter binding that the language guarantees is final.

The object behind the captured reference can be internally mutable — that's its own concern. If you genuinely need the closure to observe later updates, the indirection must be explicit at the type level (an observable, an atomic ref, a state channel), not a bare mutable slot.

Even with this carve-out, the preferred shape is still the same as #1 and #2: constructor injection, parameter passing, pure functions returning values.

## 5. Function names must not lie

Two naming paradigms exist:

- **What the function does** — `endCall`, `disconnectPeer`, `freezeConfig`. This is the default. Almost every function should be named this way.
- **When the function should be called** — `onClick`, `onPeerDisconnected`, `onTick`. Legitimate only at event-handler boundaries dictated by a framework or event source.

Rules for mixing them:

- `on*` functions are thin shims at the edge. Their body translates "the event happened" into one or more calls to what-it-does functions.
- Business code calls what-it-does functions. Business code never calls `on*`.
- No `onA → onB → onC` chains. Event handlers fan out into what-it-does calls; they don't fan into each other.

The common failure mode is a what-it-does name whose body has grown beyond what the name promises — `setX` that also tears down a connection, `markY` that also fires a network message. If you can't name a function precisely, it probably should be split. Vague verbs (`handle`, `process`, `manage`) you chose yourself are a smell; framework-dictated names are not.

## 6. Each business operation lives in one function

If the same logical operation — "end a call," "open a session," "apply a discount" — is reachable from multiple code paths, the logic for *doing* it lives in exactly one function. Each entry path routes to that function with the right arguments.

The rule is structural, not textual: "three blocks that happen to look the same" is not the violation. "The same business operation reachable two ways" is. Even when the duplicated blocks are currently identical, they will drift — one path gets a fix the other doesn't, and the bug surfaces only on the rarer path.

When extraction is hard because the branches differ in small ways, those differences become parameters of the one function, not justification for two copies.

## Applying these in review

Flag violations directly, in plain language. Don't soften. Don't introduce a new violation to paper over an old one — if existing code is built on a bad foundation, name the structural fix even if it's bigger than the immediate change.
