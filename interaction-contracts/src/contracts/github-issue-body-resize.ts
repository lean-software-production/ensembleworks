/** The BB Canvas plugin owns the cache and DOM for this resize behavior.
 * plugins/canvas/tests/github-issue.test.ts plays this contract through its renderer. */
export interface GithubIssueBodyResizeObservation {
  readonly smallLines: number
  readonly mediumLines: number
  readonly largeLines: number
  readonly mediumText: string
  readonly largeText: string
}

export const githubIssueBodyResize = {
  name: 'github-issue-body-resize',
  bodyText: 'A useful issue description',
  heights: [170, 256, 420] as const,
  check(obs: GithubIssueBodyResizeObservation): string | null {
    if (obs.smallLines !== 0) return 'minimum issue card must keep its description hidden'
    if (obs.mediumLines < 1 || !obs.mediumText.includes(this.bodyText)) return 'medium issue card must show a description preview'
    if (obs.largeLines <= obs.mediumLines || !obs.largeText.includes(this.bodyText)) return 'enlarging the issue card must reveal more description lines'
    return null
  },
} as const
