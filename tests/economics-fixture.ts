/**
 * The shipped economics profiles the evaluation suites price against.
 *
 * These were declared fifteen times across the suite: `profile(id)` byte-identical
 * in six files, and a `flash()`/`flashProfile()` hardcoding
 * `deepseek-flash-2026-09.json` in the rest. A copied fixture is a fixture that
 * can drift — two suites pricing "the same" model from two readings of the same
 * file is a difference that surfaces as a changed result rather than as a
 * failure, which is the expensive way to find it.
 *
 * @module tests/economics-fixture
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'

/** The model every `flash()` call site meant. */
export const FLASH_PROFILE_ID = 'deepseek-flash-2026-09'

/** Load one shipped economics profile by id. */
export function profile(id: string): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', `${id}.json`), 'utf8'),
  ))
}

/** The DeepSeek Flash profile, which most pricing and billing suites assume. */
export function flash(): ContextEconomicsProfile {
  return profile(FLASH_PROFILE_ID)
}
