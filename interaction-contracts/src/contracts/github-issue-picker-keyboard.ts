/** The BB Canvas plugin mounts this control; the shared web Canvas runner does not.
 * Its DOM contract is played by plugins/canvas/tests/github-issue-picker.test.tsx. */
export interface GithubIssuePickerObservation {
  readonly combobox: boolean
  readonly options: readonly string[]
  readonly listInsideCard: boolean
  readonly linkedUrl: string | null
}

export const githubIssuePickerKeyboard = {
  name: 'github-issue-picker-keyboard',
  query: 'fix selection',
  option: 'Fix selection',
  issueUrl: 'https://github.com/owner/repo/issues/42',
  keys: ['ArrowDown', 'Enter'] as const,
  check(obs: GithubIssuePickerObservation): string | null {
    if (!obs.combobox) return 'unlinked card must expose an issue search combobox'
    if (!obs.options.includes(this.option)) return `cached issue ${this.option} must appear in the listbox`
    if (!obs.listInsideCard) return 'issue choices must remain inside the canvas card'
    if (obs.linkedUrl !== this.issueUrl) return `Enter must link ${this.issueUrl}, got ${String(obs.linkedUrl)}`
    return null
  },
} as const
