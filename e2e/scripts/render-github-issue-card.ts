import { createRequire } from 'node:module'
import { GithubIssueCard, GithubIssueShape } from '../../plugins/canvas/canvas/shapes/GithubIssueShape.js'

const pluginRequire = createRequire(new URL('../../plugins/canvas/package.json', import.meta.url))
const { createElement } = pluginRequire('react') as typeof import('react')
const { renderToStaticMarkup } = pluginRequire('react-dom/server') as typeof import('react-dom/server')

const shape = { id: 'shape:issue', kind: 'github-issue', parentId: 'page:p', index: 'a1', x: 0, y: 0,
  rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { w: Number(process.argv[3] ?? 260), h: Number(process.argv[4] ?? 170), schemaVersion: 1, repo: 'Owner/Repo', number: 42 } } as any
const issue = { number: 42, title: 'A long issue title that should remain readable on the smallest supported card size and across every freely resized intermediate card height without slicing any metadata',
  state: 'OPEN', author: 'morgan', labels: ['bug', 'urgent'], assignees: ['alex'], updatedAt: '2026-09-23T09:15:00Z',
  bodyPreview: 'The issue description should reveal more context as the card grows while keeping every other visible row readable. '.repeat(50) }
const ready = { state: 'ready', lastSyncedAt: '2026-09-23T12:00:00Z', issues: [issue] }
const state = process.argv[2]
if (state === 'unlinked') {
  process.stdout.write(renderToStaticMarkup(createElement(GithubIssueShape, {
    shape: { ...shape, props: { w: shape.props.w, h: shape.props.h, schemaVersion: 2 } },
  } as any)))
  process.exit(0)
}
const current = state === 'ready' ? ready : state === 'stale' || state === 'auth' ? { state: state === 'auth' ? 'needs_configuration' : 'cache_error', lastSyncedAt: ready.lastSyncedAt, issues: [] }
  : state === 'cache-miss' ? { ...ready, issues: [] } : null
const lastGood = state === 'stale' || state === 'auth' ? ready : null
process.stdout.write(renderToStaticMarkup(createElement(GithubIssueCard, {
  shape, repoSnapshot: { current, lastGood, loading: current === null },
} as any)))
