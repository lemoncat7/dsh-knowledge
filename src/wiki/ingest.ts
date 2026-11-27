export * from './ingest-types.js'
import { JobSupport } from './jobs.js'

/**
 * Wiki ingest coordinator: scanning lives in scan.ts, change detection in changes.ts,
 * receipts in receipts.ts, job lifecycle/execution in jobs.ts, shared state/types in
 * ingest-base.ts and ingest-types.ts. The public surface is unchanged.
 */
export class WikiIngest extends JobSupport {}
