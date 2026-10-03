/**
 * Ambient declarations for the browser client face (`client.js`).
 *
 * ## Why these exist
 *
 * `client.js` is the ONE file in this repository that no compiler has ever
 * looked at. It is not in `tsconfig.json`'s `include`, there is no lint config,
 * and the only thing that executes it is two test files that fake the module
 * loader. Measured: of the last seven defect rounds, all of them touched it, and
 * it is the largest single function in the codebase.
 *
 * It cannot simply be added to `tsconfig.json`, because that project resolves
 * `@deepseek-ai/*` through a 93-entry path table into the vendored DSH SOURCES
 * and compiles under full `strict` — a browser file that `require`s React from
 * the host loader has no business in that graph. So it gets its own project
 * (`tsconfig.client.json`) with `checkJs`, and these declarations stand in for
 * the two things the browser provides rather than the repository:
 *
 *   1. `react` and `react/jsx-runtime`, supplied by the host module loader as
 *      shared externals. They are NOT dependencies of this package — adding
 *      them would ship React to a plugin that only borrows it.
 *   2. `window.__ModuleLoader__`, the loader handshake every DSH client module
 *      is wrapped in.
 *
 * ## Why the return types are `unknown`
 *
 * The panel composes elements and hands them back to React; it never reads a
 * rendered element's fields. Typing `jsx` as `unknown` keeps the check focused
 * on the panel's OWN logic — the status fields it reads, the guards it applies,
 * the values it formats — instead of demanding a React type package to describe
 * trees this file never inspects.
 *
 * @module dsh-epistemic-fold/client-ambient
 */

declare module 'react' {
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useState<T>(initial: T | (() => T)): [T, (value: T) => void]
  export function useEffect(
    effect: () => (() => void) | undefined | void,
    deps?: readonly unknown[],
  ): void
}

declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown
  export const Fragment: unknown
}

interface Window {
  /** The loader handshake: a client module registers its factory here. */
  __ModuleLoader__: {
    load(module: {
      readonly id: string
      readonly factory: (require: (name: string) => unknown) => unknown
    }): void
  }
}
