import { randomId } from '../util/ids'
import type { Logger } from '../logging/logger'
import type {
  ApprovalField,
  PendingAction,
  PendingActionStatus,
  PendingActionType,
  RiskLevel
} from '../../shared/communication'

/** How long a prepared action stays approvable before it must be re-prepared. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000

/**
 * The payload an executor receives. Held only inside the engine — it never
 * crosses IPC, so the renderer cannot construct one and hand it back.
 */
export interface ActionRecord<P = unknown> {
  action: PendingAction
  payload: P
}

export type ActionExecutor<P = unknown> = (payload: P, action: PendingAction) => Promise<string>

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalError'
  }
}

export interface ProposeInput<P> {
  type: PendingActionType
  riskLevel: RiskLevel
  description: string
  /** The user's own words that led here, for the audit trail. */
  source: string
  accountId: string
  accountLabel: string
  preview: ApprovalField[]
  warning?: string
  payload: P
}

/**
 * The approval engine.
 *
 * Every consequential action in Jarvis — sending an email, creating, changing
 * or cancelling a calendar event — exists first as a PROPOSED record that has
 * done nothing, and can only be carried out by {@link approve}, which is
 * reachable solely from an explicit user gesture in the UI.
 *
 * Two properties make this hard to subvert:
 *
 *  - The executor functions are registered here and held privately. Nothing
 *    in the conversational path holds a reference to them, so no wording —
 *    "send it now", "I approve", "skip the confirmation" — can reach one.
 *    A conversation can only ever produce a PROPOSED record.
 *  - `approve` accepts an action id and nothing else. The payload that gets
 *    executed is the one stored when the action was proposed, so what the user
 *    saw in the approval panel is necessarily what runs.
 */
export class ApprovalEngine {
  private readonly actions = new Map<string, ActionRecord>()
  private readonly executors = new Map<PendingActionType, ActionExecutor>()
  private readonly logger: Logger
  private readonly now: () => number

  constructor(logger: Logger, now: () => number = () => Date.now()) {
    this.logger = logger
    this.now = now
  }

  /** Wire up how an action type is actually carried out. Main process only. */
  registerExecutor<P>(type: PendingActionType, executor: ActionExecutor<P>): void {
    this.executors.set(type, executor as ActionExecutor)
  }

  /**
   * Prepare an action. Nothing happens outside Jarvis as a result of this call.
   */
  propose<P>(input: ProposeInput<P>): PendingAction {
    const createdAt = this.now()
    const action: PendingAction = {
      id: randomId(),
      type: input.type,
      status: 'PROPOSED',
      riskLevel: input.riskLevel,
      description: input.description,
      source: input.source,
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      preview: input.preview,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS
    }
    if (input.warning) action.warning = input.warning

    this.actions.set(action.id, { action, payload: input.payload })
    this.logger.info('approval.proposed', {
      id: action.id,
      type: action.type,
      accountLabel: action.accountLabel,
      riskLevel: action.riskLevel
    })
    return { ...action }
  }

  get(id: string): PendingAction | undefined {
    const record = this.actions.get(id)
    return record ? { ...record.action } : undefined
  }

  /** Every action still awaiting a decision. */
  pending(): PendingAction[] {
    const now = this.now()
    return [...this.actions.values()]
      .map((r) => r.action)
      .filter((a) => a.status === 'PROPOSED' && a.expiresAt > now)
      .map((a) => ({ ...a }))
  }

  /** The user declined. Terminal — the action can never be executed after this. */
  reject(id: string): PendingAction {
    const record = this.requireRecord(id)
    if (record.action.status !== 'PROPOSED') {
      throw new ApprovalError(`This action is already ${record.action.status.toLowerCase()}.`)
    }
    record.action.status = 'REJECTED'
    record.action.completedAt = this.now()
    this.logger.info('approval.rejected', { id, type: record.action.type })
    return { ...record.action }
  }

  /**
   * Carry out an action the user has explicitly approved.
   *
   * This is the only method in Jarvis that causes a change in Microsoft 365.
   */
  async approve(id: string): Promise<PendingAction> {
    const record = this.requireRecord(id)
    const action = record.action

    if (action.status !== 'PROPOSED') {
      throw new ApprovalError(
        action.status === 'COMPLETED'
          ? 'That action has already been carried out.'
          : `This action cannot be approved because it is ${action.status.toLowerCase()}.`
      )
    }
    if (action.expiresAt <= this.now()) {
      action.status = 'FAILED'
      action.error = 'This action expired before it was approved. Prepare it again.'
      throw new ApprovalError(action.error)
    }

    const executor = this.executors.get(action.type)
    if (!executor) {
      action.status = 'FAILED'
      action.error = `Jarvis has no way to carry out a ${action.type} action.`
      throw new ApprovalError(action.error)
    }

    action.status = 'APPROVED'
    this.logger.info('approval.approved', { id, type: action.type, accountLabel: action.accountLabel })

    action.status = 'EXECUTING'
    try {
      // The stored payload is used, never anything supplied at approval time,
      // so what ran is exactly what the user was shown.
      const summary = await executor(record.payload, { ...action })
      action.status = 'COMPLETED'
      action.completedAt = this.now()
      action.resultSummary = summary
      this.logger.info('approval.completed', { id, type: action.type })
    } catch (error) {
      action.status = 'FAILED'
      action.completedAt = this.now()
      action.error = error instanceof Error ? error.message : String(error)
      this.logger.error('approval.failed', { id, type: action.type, error: action.error })
    }

    return { ...action }
  }

  /** Drop expired and finished actions so the store does not grow unbounded. */
  prune(): void {
    const now = this.now()
    for (const [id, record] of this.actions) {
      const finished: PendingActionStatus[] = ['COMPLETED', 'REJECTED', 'FAILED']
      const isFinished = finished.includes(record.action.status)
      const isStale = record.action.expiresAt + APPROVAL_TTL_MS < now
      if (isFinished && isStale) this.actions.delete(id)
    }
  }

  private requireRecord(id: string): ActionRecord {
    const record = this.actions.get(id)
    if (!record) {
      throw new ApprovalError('That action is no longer available. Prepare it again.')
    }
    return record
  }
}
