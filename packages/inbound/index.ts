import { config } from "@outbox/config"
import { dispatch, domainOf, normalizeEmail } from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import {
  type Domain,
  domains,
  type ReceivedEmail,
  receivedEmailAttachments,
  receivedEmails,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { parseMessage } from "./parser/index.ts"

export * from "./parser/index.ts"

const CRLF = "\r\n"
const MAX_MESSAGE_BYTES = 30 * 1024 * 1024

type SessionState = {
  greeted: boolean
  from: string | null
  recipients: string[]
  collecting: boolean
  data: string
  buffer: string
}

const newState = (): SessionState => ({
  greeted: false,
  from: null,
  recipients: [],
  collecting: false,
  data: "",
  buffer: "",
})

const addressIn = (line: string): string | null => {
  const match = line.match(/<([^>]*)>/)
  if (match) return match[1] ?? null
  const parts = line.split(/\s+/)
  return parts[1] ?? null
}

/** Stores a received message and fires the email.received webhook. */
export const storeReceived = async (input: {
  teamId: string
  domainId: string | null
  raw: string
  envelopeFrom: string
  envelopeTo: string[]
}): Promise<ReceivedEmail> => {
  const parsed = parseMessage(input.raw)
  const conn = db()

  const row = (await conn.one<ReceivedEmail>(
    from(receivedEmails)
      .insert({
        team_id: input.teamId,
        domain_id: input.domainId,
        message_id: parsed.headers["message-id"] ?? null,
        in_reply_to: parsed.headers["in-reply-to"] ?? null,
        reference_ids: parsed.headers.references ? parsed.headers.references.split(/\s+/) : null,
        from_address: parsed.headers.from ?? input.envelopeFrom,
        to_addresses: parsed.to.length ? parsed.to : input.envelopeTo,
        cc: parsed.cc.length ? parsed.cc : null,
        received_for: input.envelopeTo,
        subject: parsed.headers.subject ?? null,
        html: parsed.html,
        text: parsed.text,
        headers: parsed.headers,
        raw: input.raw,
        size_bytes: Buffer.byteLength(input.raw),
      })
      .returning(...allColumns(receivedEmails)),
  ))!

  if (parsed.attachments.length) {
    await conn.execute(
      from(receivedEmailAttachments).insertMany(
        parsed.attachments.map((a) => ({
          received_email_id: row.id,
          team_id: input.teamId,
          filename: a.filename,
          content_type: a.contentType,
          content_id: a.contentId,
          size: a.content.byteLength,
          content: a.content.toString("base64"),
        })),
      ),
    )
  }

  await dispatch(input.teamId, "email.received", {
    email_id: row.id,
    from: row.from_address,
    to: row.to_addresses,
    subject: row.subject,
    created_at: row.created_at,
    attachment_count: parsed.attachments.length,
  })

  return row
}

// Only accept mail for a domain a team has enabled receiving on.
const routeRecipient = async (
  address: string,
): Promise<{ teamId: string; domainId: string } | null> => {
  const host = domainOf(address)
  const domain = await db().one<Domain>(
    from(domains).where((q) => [q("name").equals(host), q("receiving").equals("enabled")]),
  )
  return domain ? { teamId: domain.team_id, domainId: domain.id } : null
}

export type InboundServer = { stop: () => void; port: number }

/**
 * A minimal ESMTP receiver. It speaks enough of RFC 5321 for real MTAs to hand
 * mail over: EHLO, MAIL FROM, RCPT TO, DATA, RSET, QUIT.
 */
export const startInbound = async (port = config.inbound.port): Promise<InboundServer> => {
  const server = Bun.listen<SessionState>({
    hostname: "0.0.0.0",
    port,
    socket: {
      open(socket) {
        socket.data = newState()
        socket.write(`220 ${config.hostname} Outbox ESMTP ready${CRLF}`)
      },

      async data(socket, chunk) {
        const state = socket.data
        state.buffer += chunk.toString("utf8")

        if (state.collecting) {
          // The message ends at a lone dot on its own line.
          const terminator = state.buffer.indexOf(`${CRLF}.${CRLF}`)
          if (terminator === -1) {
            if (state.buffer.length > MAX_MESSAGE_BYTES) {
              state.buffer = ""
              state.collecting = false
              socket.write(`552 Message too large${CRLF}`)
            }
            return
          }
          const raw = (state.data + state.buffer.slice(0, terminator)).replace(/^\.\./gm, ".")
          state.buffer = state.buffer.slice(terminator + 5)
          state.collecting = false
          state.data = ""

          try {
            const byTeam = new Map<string, { domainId: string; recipients: string[] }>()
            for (const rcpt of state.recipients) {
              const route = await routeRecipient(rcpt)
              if (!route) continue
              const entry = byTeam.get(route.teamId) ?? { domainId: route.domainId, recipients: [] }
              entry.recipients.push(rcpt)
              byTeam.set(route.teamId, entry)
            }
            for (const [teamId, entry] of byTeam) {
              await storeReceived({
                teamId,
                domainId: entry.domainId,
                raw,
                envelopeFrom: state.from ?? "",
                envelopeTo: entry.recipients,
              })
            }
            socket.write(`250 2.0.0 Ok: queued${CRLF}`)
          } catch (err) {
            console.error("[outbox] inbound store failed:", (err as Error).message)
            socket.write(`451 Local error storing message${CRLF}`)
          }
          state.from = null
          state.recipients = []
          return
        }

        for (;;) {
          const index = state.buffer.indexOf(CRLF)
          if (index === -1) break
          const line = state.buffer.slice(0, index)
          state.buffer = state.buffer.slice(index + 2)
          const upper = line.toUpperCase()

          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
            state.greeted = true
            socket.write(
              [
                `250-${config.hostname} greets you`,
                "250-8BITMIME",
                "250-SMTPUTF8",
                `250-SIZE ${MAX_MESSAGE_BYTES}`,
                "250 OK",
              ].join(CRLF) + CRLF,
            )
          } else if (upper.startsWith("MAIL FROM")) {
            if (!state.greeted) {
              socket.write(`503 Send EHLO first${CRLF}`)
              continue
            }
            state.from = addressIn(line)
            state.recipients = []
            socket.write(`250 2.1.0 Ok${CRLF}`)
          } else if (upper.startsWith("RCPT TO")) {
            if (!state.from) {
              socket.write(`503 Send MAIL FROM first${CRLF}`)
              continue
            }
            const address = addressIn(line)
            if (!address) {
              socket.write(`501 Bad recipient${CRLF}`)
              continue
            }
            const route = await routeRecipient(normalizeEmail(address))
            if (!route) {
              socket.write(`550 5.1.1 No such recipient here${CRLF}`)
              continue
            }
            state.recipients.push(normalizeEmail(address))
            socket.write(`250 2.1.5 Ok${CRLF}`)
          } else if (upper.startsWith("DATA")) {
            if (state.recipients.length === 0) {
              socket.write(`503 No valid recipients${CRLF}`)
              continue
            }
            state.collecting = true
            state.data = ""
            socket.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`)
            // Anything already buffered belongs to the message body.
            return
          } else if (upper.startsWith("RSET")) {
            socket.data = { ...newState(), greeted: state.greeted }
            socket.write(`250 2.0.0 Ok${CRLF}`)
          } else if (upper.startsWith("NOOP")) {
            socket.write(`250 2.0.0 Ok${CRLF}`)
          } else if (upper.startsWith("QUIT")) {
            socket.write(`221 2.0.0 Bye${CRLF}`)
            socket.end()
            return
          } else if (upper.startsWith("VRFY") || upper.startsWith("EXPN")) {
            socket.write(`252 Cannot verify${CRLF}`)
          } else {
            socket.write(`500 5.5.2 Command not recognised${CRLF}`)
          }
        }
      },

      error(_socket, error) {
        console.error("[outbox] inbound socket error:", error.message)
      },
    },
  })

  console.log(`[outbox] inbound SMTP listening on port ${server.port}`)
  return { stop: () => server.stop(), port: server.port }
}
