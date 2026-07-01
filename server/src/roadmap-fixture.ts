// A trimmed copy of the design project's roadmap.json sample — enough
// structure to exercise every op: three zones populated, nested initiatives,
// metrics and features. Shared by roadmap-store.test.ts and roadmap-api.test.ts.
import type { RoadmapDoc } from './roadmap-store.ts'

export const ROADMAP_FIXTURE: RoadmapDoc = {
	meta: { title: 'Product Roadmap', revision: 'rev 01', updated: '2026-07-01' },
	outcomes: [
		{
			key: 'O1',
			zone: 'done',
			status: 'done',
			title: 'Reliable Nightly Sync',
			why: 'Stale source data means every report is second-guessed.',
			initiatives: [
				{
					key: 'O1.I1',
					title: 'Ingest one source end-to-end',
					status: 'done',
					statement: 'FOR: analysts. OUTCOME: data present at 09:00 untouched.',
					metrics: [
						{ key: 'O1.I1.M1', text: 'Sync completes by 09:00 unattended', done: true },
						{ key: 'O1.I1.M2', text: 'Failed runs alert within 15 minutes', done: true },
					],
					features: [
						{ key: 'O1.I1.F1', text: 'Connector framework + registry', status: 'done' },
						{ key: 'O1.I1.F2', text: 'Retry + checkpoint resume', status: 'done' },
					],
				},
			],
		},
		{
			key: 'O3',
			zone: 'now',
			status: 'in-progress',
			title: 'Broad Source Coverage',
			why: 'One connector covers a fraction of the estate.',
			initiatives: [
				{
					key: 'O3.I1',
					title: 'Abstract the connector layer',
					status: 'in-progress',
					statement: 'FOR: platform team. OUTCOME: a new source is a config entry.',
					metrics: [{ key: 'O3.I1.M1', text: 'Two source categories working', done: true }],
					features: [
						{ key: 'O3.I1.F1', text: 'Connector SDK', status: 'in-progress' },
						{ key: 'O3.I1.F2', text: 'Schema-mapping assistant', status: 'in-progress' },
					],
				},
			],
		},
		{
			key: 'O4',
			zone: 'next',
			status: 'planned',
			title: 'Self-Serve Onboarding',
			why: 'Setup time is measured in days, not minutes.',
			initiatives: [],
		},
	],
}
