import type { AssistantReply, ConversationTurn } from '../../shared/types'
import { randomId } from '../util/ids'

/** How many turns of back-and-forth Jarvis keeps in view. */
const MAX_TURNS = 20
/** How many documents stay "in focus" for follow-up questions. */
const MAX_FOCUS_DOCUMENTS = 4

/**
 * Session-scoped conversation memory.
 *
 * This is intentionally the simplest thing that makes follow-ups work: the
 * documents from the last useful answer stay in focus, so "summarise it" and
 * "what are the outstanding priorities?" continue from the same files.
 *
 * It lives in memory only and is discarded when Jarvis closes. Persistent,
 * cross-session memory is a later version — building it now would mean storing
 * the user's questions on disk before there is a good reason to.
 */
export class Session {
  private turns: ConversationTurn[] = []
  private focusDocumentIds: string[] = []

  history(): ConversationTurn[] {
    return this.turns
  }

  /** Document ids the next question should be interpreted against. */
  focus(): string[] {
    return this.focusDocumentIds
  }

  hasFocus(): boolean {
    return this.focusDocumentIds.length > 0
  }

  /** Short descriptions of the in-focus documents, for the query planner. */
  focusLabels(): string[] {
    const labels: string[] = []
    for (const turn of [...this.turns].reverse()) {
      for (const hit of turn.reply?.results ?? []) {
        if (this.focusDocumentIds.includes(hit.document.id) && !labels.includes(hit.document.fileName)) {
          labels.push(hit.document.fileName)
        }
      }
    }
    return labels
  }

  addUserTurn(text: string): ConversationTurn {
    const turn: ConversationTurn = { id: randomId(), role: 'user', text, at: Date.now() }
    this.push(turn)
    return turn
  }

  addJarvisTurn(text: string, reply: AssistantReply): ConversationTurn {
    const turn: ConversationTurn = { id: randomId(), role: 'jarvis', text, at: Date.now(), reply }
    this.push(turn)

    // Only results worth referring back to become the new focus. A reply that
    // found nothing leaves the previous focus intact, so "summarise it" after a
    // failed search still means the document from before.
    if (reply.results.length > 0) {
      this.focusDocumentIds = reply.results.slice(0, MAX_FOCUS_DOCUMENTS).map((r) => r.document.id)
    }
    return turn
  }

  /** Pin specific documents, e.g. when the user clicks a result. */
  setFocus(documentIds: string[]): void {
    this.focusDocumentIds = documentIds.slice(0, MAX_FOCUS_DOCUMENTS)
  }

  clear(): void {
    this.turns = []
    this.focusDocumentIds = []
  }

  private push(turn: ConversationTurn): void {
    this.turns.push(turn)
    if (this.turns.length > MAX_TURNS) this.turns = this.turns.slice(-MAX_TURNS)
  }
}
