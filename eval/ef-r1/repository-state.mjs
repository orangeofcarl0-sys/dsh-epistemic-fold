#!/usr/bin/env node
/**
 * EF-R1 WP0 evidence: what the repository protects, and where it is.
 *
 * The archive package carries the bytes; this record answers the questions a
 * reader has before trusting it: which commit is the line, which archive tags
 * exist, whether each is backed by a remote, what the open PR says, and which
 * worktrees still hold ignored evidence.
 *
 * It is read-only. No branch, tag, worktree or PR is changed.
 *
 *   node eval/ef-r1/repository-state.mjs
 *
 * @module eval/ef-r1/repository-state
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const gitOr = (...args) => {
  try {
    return git(...args)
  } catch {
    return ''
  }
}
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function tags() {
  const listing = gitOr('tag', '-l', 'archive/*', '--format=%(refname:short)')
  return listing.split('\n').filter(Boolean).map(name => {
    const commit = git('rev-parse', `${name}^{commit}`)
    const remotes = gitOr('for-each-ref', 'refs/remotes', '--contains', commit, '--format=%(refname:short)')
      .split('\n').filter(Boolean)
    return {
      name,
      type: git('cat-file', '-t', name),
      commit,
      subject: git('log', '-1', '--format=%s', commit),
      remoteBacked: remotes.length > 0,
      remotes,
    }
  })
}

function pr() {
  try {
    const text = execFileSync('gh', [
      'pr', 'view', '5',
      '--json', 'number,state,isDraft,mergeable,headRefName,baseRefName,title,commits',
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const value = JSON.parse(text)
    return {
      number: value.number,
      state: value.state,
      draft: value.isDraft,
      mergeable: value.mergeable,
      head: value.headRefName,
      base: value.baseRefName,
      title: value.title,
      commits: value.commits?.length ?? null,
    }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message.split('\n')[0] : String(error) }
  }
}

function main() {
  mkdirSync(OUT, { recursive: true })
  const pointerPath = join(ROOT, 'eval', 'e2e', 'out', 'research-archive.json')
  const pointer = existsSync(pointerPath) ? JSON.parse(readFileSync(pointerPath, 'utf8')) : null
  const archiveTags = tags()
  const state = {
    schemaVersion: 1,
    work: 'EF-R1 WP0',
    generatedAt: new Date().toISOString(),
    head: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current') || '(detached)',
    localAheadOfPushedBranch: Number(gitOr('rev-list', '--count', 'origin/chore/ef-c1-evaluation-foundation..HEAD') || 0),
    refs: {
      localMain: gitOr('rev-parse', 'main'),
      originMain: gitOr('rev-parse', 'origin/main'),
      originRc38: gitOr('rev-parse', 'origin/rc38-mechanism-validation'),
    },
    archiveTags,
    archiveTagsRemoteBacked: archiveTags.filter(tag => tag.remoteBacked).length,
    archiveTagsLocalOnly: archiveTags.filter(tag => !tag.remoteBacked).map(tag => tag.name),
    pullRequest: pr(),
    worktrees: gitOr('worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).map(block => {
      const lines = block.split('\n')
      return {
        path: lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length),
        head: lines.find(line => line.startsWith('HEAD '))?.slice('HEAD '.length),
        branch: lines.find(line => line.startsWith('branch '))?.slice('branch '.length) ?? '(detached)',
      }
    }),
    workingTree: {
      dirty: gitOr('status', '--porcelain').split('\n').filter(Boolean),
      note: 'The heartbeat file is appended by a long-running local watchdog; it is not part of this round and is not staged.',
    },
    researchArchive: pointer === null ? null : {
      path: pointer.archiveRoot,
      manifestSha256: pointer.archiveManifestSha256,
      sumsSha256: pointer.archiveSumsSha256,
      bundleSha256: pointer.archiveBundleSha256,
      counts: pointer.counts,
      scan: pointer.scan,
      pointerSha256: sha256File(pointerPath),
    },
    note: 'No branch, tag, worktree, remote or PR was changed by this script.',
  }
  writeFileSync(join(OUT, 'repository-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  process.stdout.write(`repository state: ${state.head.slice(0, 12)} on ${state.branch}\n`)
  process.stdout.write(`archive tags: ${archiveTags.length}, local-only: ${state.archiveTagsLocalOnly.length}\n`)
  process.stdout.write(`pr: ${state.pullRequest.state ?? 'unavailable'} ${state.pullRequest.mergeable ?? ''}\n`)
  process.stdout.write(`research archive: ${state.researchArchive?.counts.files ?? 0} files, safeToShare=${state.researchArchive?.scan.safeToShare ?? 'n/a'}\n`)
}

main()
