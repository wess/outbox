import { resolveMx } from "node:dns/promises"
import { config } from "@outbox/config"
import { domainOf } from "@outbox/core"
import { connectSmtp, type SendResult, SmtpError, sendMessage } from "./smtp/index.ts"

export * from "./smtp/index.ts"

export type Outcome = {
  ok: boolean
  /** false means the failure is permanent and the job should not be retried. */
  retryable: boolean
  response: string
  accepted: string[]
  rejected: { address: string; code: number; message: string }[]
  bounceType?: "hard" | "soft" | undefined
}

export type DeliveryInput = {
  returnPath: string
  recipients: string[]
  raw: string
  /** enforced refuses to deliver unless the hop is encrypted. */
  tls?: "opportunistic" | "enforced"
}

export type Transport = {
  readonly name: string
  readonly deliver: (input: DeliveryInput) => Promise<Outcome>
}

const groupByDomain = (recipients: string[]): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  for (const address of recipients) {
    const host = domainOf(address)
    const list = out.get(host)
    if (list) list.push(address)
    else out.set(host, [address])
  }
  return out
}

const asOutcome = (result: SendResult): Outcome => ({
  ok: true,
  retryable: false,
  response: result.response,
  accepted: result.accepted,
  rejected: result.rejected,
})

const failure = (err: unknown, recipients: string[]): Outcome => {
  const smtp = err instanceof SmtpError ? err : null
  const permanent = smtp?.permanent ?? false
  return {
    ok: false,
    retryable: !permanent,
    response: (err as Error).message,
    accepted: [],
    rejected: recipients.map((address) => ({
      address,
      code: smtp?.code ?? 0,
      message: (err as Error).message,
    })),
    bounceType: permanent ? "hard" : "soft",
  }
}

/** Prints the message instead of sending it. The default for local development. */
export const consoleTransport = (): Transport => ({
  name: "console",
  deliver: async (input) => {
    const preview =
      input.raw.length > 2000 ? `${input.raw.slice(0, 2000)}\n… (truncated)` : input.raw
    console.log(
      [
        "",
        "──────────── outbox: console transport ────────────",
        `return-path: ${input.returnPath}`,
        `recipients:  ${input.recipients.join(", ")}`,
        "───────────────────────────────────────────────────",
        preview,
        "───────────────────────────────────────────────────",
        "",
      ].join("\n"),
    )
    return {
      ok: true,
      retryable: false,
      response: "250 Logged by console transport",
      accepted: input.recipients,
      rejected: [],
    }
  },
})

/** Hands every message to one upstream SMTP server. */
export const relayTransport = (): Transport => ({
  name: "relay",
  deliver: async (input) => {
    if (!config.relay.host) {
      return {
        ok: false,
        retryable: false,
        response: "SMTP_RELAY_HOST is not configured",
        accepted: [],
        rejected: input.recipients.map((address) => ({
          address,
          code: 0,
          message: "relay not configured",
        })),
      }
    }
    let session: Awaited<ReturnType<typeof connectSmtp>> | null = null
    try {
      session = await connectSmtp({
        host: config.relay.host,
        port: config.relay.port,
        secure: config.relay.secure as "none" | "starttls" | "tls",
        username: config.relay.user || undefined,
        password: config.relay.pass || undefined,
        clientName: config.hostname,
      })
      return asOutcome(await sendMessage(session, input))
    } catch (err) {
      return failure(err, input.recipients)
    } finally {
      session?.close()
    }
  },
})

/**
 * Talks to each recipient domain's MX hosts directly. This is the real
 * self-hosted path and needs outbound port 25 plus matching forward/reverse DNS.
 */
export const smtpTransport = (): Transport => ({
  name: "smtp",
  deliver: async (input) => {
    const groups = groupByDomain(input.recipients)
    const accepted: string[] = []
    const rejected: Outcome["rejected"] = []
    const responses: string[] = []
    let retryable = false
    let ok = true

    for (const [host, recipients] of groups) {
      let hosts: string[]
      try {
        const mx = await resolveMx(host)
        hosts = mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange)
        // RFC 5321 §5.1: with no MX, fall back to the A record.
        if (hosts.length === 0) hosts = [host]
      } catch {
        hosts = [host]
      }

      let delivered = false
      let lastError: unknown = new Error(`No MX host answered for ${host}`)

      for (const exchange of hosts) {
        let session: Awaited<ReturnType<typeof connectSmtp>> | null = null
        try {
          session = await connectSmtp({
            host: exchange,
            port: 25,
            secure: input.tls === "enforced" ? "starttls" : "none",
            clientName: config.hostname,
            timeoutMs: 60_000,
          })
          // Opportunistic TLS: upgrade when offered, carry on when not.
          if (input.tls !== "enforced" && session.capabilities.has("STARTTLS")) {
            session.close()
            session = await connectSmtp({
              host: exchange,
              port: 25,
              secure: "starttls",
              clientName: config.hostname,
              timeoutMs: 60_000,
              rejectUnauthorized: false,
            })
          }
          const result = await sendMessage(session, { ...input, recipients })
          accepted.push(...result.accepted)
          rejected.push(...result.rejected)
          responses.push(`${host}: ${result.response}`)
          delivered = true
          break
        } catch (err) {
          lastError = err
        } finally {
          session?.close()
        }
      }

      if (!delivered) {
        ok = false
        const outcome = failure(lastError, recipients)
        rejected.push(...outcome.rejected)
        responses.push(`${host}: ${outcome.response}`)
        retryable = retryable || outcome.retryable
      }
    }

    return {
      ok: ok && accepted.length > 0,
      retryable,
      response: responses.join(" | "),
      accepted,
      rejected,
      bounceType: ok ? undefined : retryable ? "soft" : "hard",
    }
  },
})

export const transportFor = (name = config.transport): Transport => {
  switch (name) {
    case "smtp":
      return smtpTransport()
    case "relay":
      return relayTransport()
    default:
      return consoleTransport()
  }
}
