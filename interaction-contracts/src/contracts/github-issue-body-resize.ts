/** The BB Canvas plugin owns the cache and DOM for this resize behavior.
 * plugins/canvas/tests/github-issue.test.ts plays this contract through its renderer. */
export interface GithubIssueBodyResizeObservation {
  readonly previews: readonly { text: string | null; style: string | null }[]
}

export const githubIssueBodyResize = {
  name: 'github-issue-body-resize',
  bodyText: 'A useful issue description',
  heights: [170, 256, 420] as const,
  check(obs: GithubIssueBodyResizeObservation): string | null {
    if (obs.previews.length !== this.heights.length || obs.previews.some((preview) => preview.text === null)) {
      return 'the same description must stay mounted at every card size'
    }
    if (obs.previews.some((preview) => preview.text !== obs.previews[0]!.text || !preview.text?.includes(this.bodyText))) {
      return 'resizing must not change the attempted description text'
    }
    if (obs.previews.some((preview) => !preview.style?.includes('overflow:hidden') || !preview.style.includes('min-height:0')
      || !preview.style.includes('flex:1') || preview.style.includes('line-clamp'))) {
      return 'description must use a flexible clipping box rather than a size-based line clamp'
    }
    return null
  },
} as const
