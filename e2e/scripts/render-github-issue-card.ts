import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GithubIssueCard } from '../../plugins/canvas/canvas/shapes/GithubIssueShape.js'

const shape = { id: 'shape:issue', kind: 'github-issue', parentId: 'page:p', index: 'a1', x: 0, y: 0,
  rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { w: Number(process.argv[3] ?? 260), h: Number(process.argv[4] ?? 170), schemaVersion: 1, repo: 'Owner/Repo', number: 42 } } as any
const issue = { number: 42, title: 'A long issue title that should remain readable on the smallest supported card size and across every freely resized intermediate card height without slicing any metadata',
  state: 'OPEN', author: 'morgan', labels: ['bug', 'urgent'], assignees: ['alex'], updatedAt: '2026-09-23T09:15:00Z' }
const ready = { state: 'ready', lastSyncedAt: '2026-09-23T12:00:00Z', issues: [issue] }
const state = process.argv[2]
const current = state === 'ready' ? ready : state === 'stale' || state === 'auth' ? { state: state === 'auth' ? 'needs_configuration' : 'cache_error', lastSyncedAt: ready.lastSyncedAt, issues: [] }
  : state === 'cache-miss' ? { ...ready, issues: [] } : null
const lastGood = state === 'stale' || state === 'auth' ? ready : null
process.stdout.write(renderToStaticMarkup(createElement(GithubIssueCard, {
  shape, repoSnapshot: { current, lastGood, loading: current === null },
} as any)))
