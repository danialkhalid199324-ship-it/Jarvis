/**
 * Keeping Jarvis inside what it can actually see.
 *
 * Jarvis reads mail and a connected calendar. It cannot see a bank account, an
 * accounting system, a filing cabinet, a colleague's inbox, or the user's own
 * memory of what they dealt with last week. So an email saying an invoice is
 * due is evidence that the email says so — never evidence that the money is
 * still owed. An empty calendar is evidence that nothing is on that calendar —
 * never evidence that the day is free.
 *
 * Telling a model this in prose is necessary but not sufficient: the rule sits
 * among a dozen formatting instructions, and under pressure to sound useful a
 * model reaches for "pay the outstanding amount" anyway. So the rule is also
 * enforced after the fact. Output is checked, a failure is sent back once to be
 * rewritten, and if it fails again the prose is discarded rather than shown.
 *
 * The check is deliberately not a filter that edits the model's words. Rewriting
 * someone else's sentences to remove a claim tends to produce text that says
 * something different from what was meant, which is its own kind of dishonesty.
 */

/**
 * The evidence rules, shared verbatim by every prompt that writes prose about
 * the user's mail or calendar, so the analysis and the brief cannot drift apart.
 */
export const EVIDENCE_RULES = `EVIDENCE BOUNDARY — this outranks every other instruction.

You can see the emails and calendar entries given to you. You can see NOTHING else: not the user's bank, accounting system, records, filing, or what they have already dealt with.

Therefore:
- Attribute, never assert. Write "the invoice states an amount of $X was due on 30 September", not "you owe $X" or "$X is outstanding".
- Never claim that money is still owed, that a bill is unpaid, that a payment is due now, that a form was not submitted, that a deadline was missed, or that anything remains outstanding. You have no way to know any of it.
- Never instruct a payment outright. The correct next step for anything financial is: review the invoice, reconcile it against the user's own records, confirm its current status, and arrange payment only if it turns out to still be outstanding.
- Never say the user's day, afternoon or schedule is clear, free or open. No meetings on the connected calendar means exactly that — nothing about what else the day holds.
- Apply the same care to compliance and deadlines: "confirm this was submitted", never "you have not submitted this".

A sentence that states current real-world status you cannot verify is wrong even when it sounds helpful. Attribute it to the email, or make it conditional, or leave it out.`

/**
 * Phrasings that assert a state of the world Jarvis cannot check.
 *
 * Each is only a problem when stated flatly. The same words are fine when the
 * sentence attributes them to a source ("the invoice states…") or makes them
 * conditional ("if it is still outstanding…"), which is exactly the behaviour
 * the rules above ask for — so the escape hatch below is not a loophole, it is
 * the target.
 */
const ASSERTIONS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\b(?:unpaid|outstanding|owing|in arrears|payable now|still due|past due|overdue)\b/i,
    label: 'states that an amount is still owed'
  },
  {
    pattern: /\b(?:pay|paying)\s+(?:the|this|that|these|those|it|them|both|all|your)\b/i,
    label: 'instructs a payment without confirming its status'
  },
  {
    pattern: /\b(?:settle|clear|discharge)\s+(?:the|this|these|those|it|them|both|all)\b/i,
    label: 'instructs settling a balance'
  },
  {
    pattern: /\breleas\w+\s+(?:any|the|a)\s+payment\b/i,
    label: 'implies a payment is pending'
  },
  {
    pattern: /\b(?:your|the)\s+(?:whole\s+|entire\s+|rest of the\s+)?(?:day|morning|afternoon|evening|schedule|diary)\s+is\s+(?:clear|free|open|empty|wide open)\b/i,
    label: 'claims the day is free'
  },
  {
    pattern: /\bwith\s+(?:the|your)\s+(?:day|afternoon|morning|schedule)\s+(?:clear|free|open)\b/i,
    label: 'claims the day is free'
  },
  {
    pattern: /\byou\s+(?:have|'ve|has)\s+(?:not|never|yet to)\s+(?:paid|submitted|responded|replied|sent|actioned)\b/i,
    label: 'claims the user did not do something'
  },
  {
    pattern: /\b(?:has|have|had)\s+not\s+been\s+(?:paid|submitted|actioned|resolved|sent|responded to)\b/i,
    label: 'claims something was not done'
  },
  {
    pattern: /\bnothing\s+(?:else\s+)?(?:booked|scheduled|on)\b.{0,40}\bso\b/i,
    label: 'reasons from an empty calendar to a free day'
  }
]

/**
 * Attribution and conditionals, which make any of the above acceptable.
 *
 * "If it is still outstanding, arrange payment" is correct writing, not a
 * violation, and so is "the email states the invoice is overdue".
 *
 * Only epistemic markers belong here. "Review" and "check" were listed at
 * first, being the words the rules ask for — but they are imperatives, not
 * attribution, and they let "Review the invoice online and pay it." through
 * untouched. A verb that tells the user to do something says nothing about
 * where the claim came from.
 */
const ATTRIBUTED =
  /\b(?:if|whether|unless|once|should it|provided|assuming|confirm\w*|reconcil\w+|verif\w+|states?|stated|says?|said|according to|claims?|indicates?|appears?|reportedly|may|might|could)\b/i

/** Payment directions need their own, stricter conditional check. Attribution
 * elsewhere in a sentence does not make "confirm X before paying" safe. */
const PAYMENT_ACTION =
  /\b(?:pay(?:ing)?|settle|clear|discharge|release)\b[^.!?]{0,100}\b(?:invoice|bill|amount|balance|payment|it|them|both|all|aud|usd|gbp|eur|\$)\b|\b(?:invoice|bill|amount|balance|payment)\b[^.!?]{0,100}\b(?:pay(?:ing)?|settle|clear|discharge|release)\b/i
const CONDITIONAL_PAYMENT =
  /\b(?:if|whether|unless|only if|should)\b[^.!?]{0,120}\b(?:pay(?:ing)?|settle|clear|discharge|release|arrange payment)\b/i

/** Split into sentences, keeping enough of each to quote back. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export interface UnsupportedClaim {
  sentence: string
  label: string
}

/**
 * Sentences that assert something Jarvis has no way to know.
 *
 * Pure and synchronous, so it costs nothing and can be run on every answer.
 */
export function findUnsupportedClaims(text: string): UnsupportedClaim[] {
  const found: UnsupportedClaim[] = []
  for (const sentence of sentences(text)) {
    if (PAYMENT_ACTION.test(sentence) && !CONDITIONAL_PAYMENT.test(sentence)) {
      found.push({
        sentence: sentence.slice(0, 200),
        label: 'instructs or recommends payment without making it conditional on verified status'
      })
      continue
    }
    if (ATTRIBUTED.test(sentence)) continue
    for (const { pattern, label } of ASSERTIONS) {
      if (pattern.test(sentence)) {
        found.push({ sentence: sentence.slice(0, 200), label })
        break
      }
    }
  }
  return found
}

/**
 * What to send back when the first attempt overstepped.
 *
 * Quotes the offending sentences so the correction is specific: a general
 * "try again, be careful" produces another general answer.
 */
export function correctionInstruction(claims: readonly UnsupportedClaim[]): string {
  const list = claims
    .map((c) => `- "${c.sentence}" — ${c.label}.`)
    .join('\n')

  return `Your previous answer stated things you cannot know from the emails and calendar you were given:

${list}

Rewrite the whole answer. Keep every fact that came from the material, and keep the same structure and length. Replace each sentence above with one that either attributes the claim to the email ("the invoice states that ...") or makes it conditional ("if it is still outstanding, arrange payment"). Do not add a disclaimer; fix the sentences themselves.`
}
