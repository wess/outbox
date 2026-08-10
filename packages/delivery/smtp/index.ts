import type { Socket } from "bun"

export type SmtpSecurity = "none" | "starttls" | "tls"

export type SmtpOptions = {
  host: string
  port: number
  secure?: SmtpSecurity
  username?: string | undefined
  password?: string | undefined
  /** Name announced in EHLO. Receivers check it against the connecting IP. */
  clientName?: string
  timeoutMs?: number
  /** Accept self-signed certs. Only for local relays you control. */
  rejectUnauthorized?: boolean
}

export type SmtpReply = { code: number; lines: string[]; text: string }

export class SmtpError extends Error {
  readonly code: number
  readonly permanent: boolean
  constructor(message: string, code: number) {
    super(message)
    this.name = "SmtpError"
    this.code = code
    // 5xx is a hard failure; 4xx means try again later.
    this.permanent = code >= 500 && code < 600
  }
}

const CRLF = "\r\n"

// A reply ends at the first line whose 4th character is a space (RFC 5321 §4.2).
const isComplete = (buffer: string): boolean => {
  const lines = buffer.split(CRLF).filter((l) => l.length > 0)
  if (lines.length === 0) return false
  const last = lines[lines.length - 1]!
  return /^\d{3} /.test(last)
}

const parseReply = (buffer: string): SmtpReply => {
  const lines = buffer.split(CRLF).filter((l) => l.length > 0)
  const last = lines[lines.length - 1] ?? ""
  const code = Number(last.slice(0, 3))
  return {
    code,
    lines: lines.map((l) => l.slice(4)),
    text: lines.join("\n"),
  }
}

type Waiter = { resolve: (r: SmtpReply) => void; reject: (e: Error) => void }

export type SmtpSession = {
  readonly capabilities: Set<string>
  command: (line: string, expect?: number[]) => Promise<SmtpReply>
  sendData: (raw: string) => Promise<SmtpReply>
  close: () => void
}

// Lines beginning with a period must be escaped so they are not read as the
// end-of-data marker (RFC 5321 §4.5.2).
export const dotStuff = (raw: string): string => raw.replace(/\r?\n/g, CRLF).replace(/^\./gm, "..")

export const connectSmtp = async (opts: SmtpOptions): Promise<SmtpSession> => {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const clientName = opts.clientName ?? "localhost"
  const secure = opts.secure ?? "none"

  let buffer = ""
  let waiter: Waiter | null = null
  let closed = false
  let failure: Error | null = null

  const settle = () => {
    if (!waiter || !isComplete(buffer)) return
    const reply = parseReply(buffer)
    buffer = ""
    const w = waiter
    waiter = null
    w.resolve(reply)
  }

  const handlers = {
    data(_s: Socket<undefined>, data: Buffer) {
      buffer += data.toString("utf8")
      settle()
    },
    error(_s: Socket<undefined>, error: Error) {
      failure = error
      waiter?.reject(error)
      waiter = null
    },
    close() {
      closed = true
      if (waiter) {
        waiter.reject(failure ?? new Error("SMTP connection closed unexpectedly"))
        waiter = null
      }
    },
    // Bun requires these to be present.
    open() {},
    drain() {},
  }

  let socket: Socket<undefined> = (await Bun.connect({
    hostname: opts.host,
    port: opts.port,
    socket: handlers,
    ...(secure === "tls"
      ? { tls: { rejectUnauthorized: opts.rejectUnauthorized ?? true, serverName: opts.host } }
      : {}),
  })) as Socket<undefined>

  const receive = (): Promise<SmtpReply> =>
    new Promise<SmtpReply>((resolve, reject) => {
      if (failure) return reject(failure)
      if (closed) return reject(new Error("SMTP connection is closed"))
      waiter = { resolve, reject }
      // A reply may already be buffered from a previous read.
      settle()
      setTimeout(() => {
        if (waiter?.resolve === resolve) {
          waiter = null
          reject(new Error(`SMTP timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)
    })

  const expectCode = (reply: SmtpReply, expect: number[], what: string): SmtpReply => {
    if (expect.length && !expect.includes(reply.code)) {
      throw new SmtpError(`${what} failed: ${reply.text}`, reply.code)
    }
    return reply
  }

  const command = async (line: string, expect: number[] = []): Promise<SmtpReply> => {
    socket.write(line + CRLF)
    const reply = await receive()
    return expectCode(reply, expect, line.split(" ")[0] ?? line)
  }

  // Greeting
  expectCode(await receive(), [220], "greeting")

  const capabilities = new Set<string>()
  const ehlo = async () => {
    capabilities.clear()
    const reply = await command(`EHLO ${clientName}`, [250])
    for (const line of reply.lines.slice(1)) {
      capabilities.add(line.trim().toUpperCase().split(" ")[0] ?? "")
      if (line.toUpperCase().startsWith("AUTH")) {
        for (const mech of line.slice(5).trim().split(/\s+/))
          capabilities.add(`AUTH=${mech.toUpperCase()}`)
      }
    }
  }
  await ehlo()

  if (secure === "starttls") {
    if (!capabilities.has("STARTTLS")) {
      throw new SmtpError("Server does not advertise STARTTLS", 0)
    }
    await command("STARTTLS", [220])
    socket = socket.upgradeTLS({
      tls: { rejectUnauthorized: opts.rejectUnauthorized ?? true, serverName: opts.host },
      socket: handlers,
    })[1] as unknown as Socket<undefined>
    // The session resets after the upgrade, so EHLO again.
    await ehlo()
  }

  if (opts.username && opts.password) {
    if (capabilities.has("AUTH=PLAIN")) {
      const token = Buffer.from(`\0${opts.username}\0${opts.password}`).toString("base64")
      await command(`AUTH PLAIN ${token}`, [235])
    } else if (capabilities.has("AUTH=LOGIN")) {
      await command("AUTH LOGIN", [334])
      await command(Buffer.from(opts.username).toString("base64"), [334])
      await command(Buffer.from(opts.password).toString("base64"), [235])
    } else {
      throw new SmtpError("Server does not support PLAIN or LOGIN authentication", 0)
    }
  }

  const sendData = async (raw: string): Promise<SmtpReply> => {
    await command("DATA", [354])
    socket.write(dotStuff(raw))
    if (!raw.endsWith("\n")) socket.write(CRLF)
    socket.write(`.${CRLF}`)
    return expectCode(await receive(), [250], "DATA")
  }

  return {
    capabilities,
    command,
    sendData,
    close: () => {
      try {
        if (!closed) {
          socket.write(`QUIT${CRLF}`)
          socket.end()
        }
      } catch {
        // The peer may already be gone; nothing to salvage.
      }
    },
  }
}

export type SendResult = {
  accepted: string[]
  rejected: { address: string; code: number; message: string }[]
  response: string
}

/** Runs one MAIL FROM / RCPT TO / DATA transaction over an open session. */
export const sendMessage = async (
  session: SmtpSession,
  input: { returnPath: string; recipients: string[]; raw: string },
): Promise<SendResult> => {
  await session.command(`MAIL FROM:<${input.returnPath}>`, [250])

  const accepted: string[] = []
  const rejected: SendResult["rejected"] = []
  for (const address of input.recipients) {
    try {
      await session.command(`RCPT TO:<${address}>`, [250, 251])
      accepted.push(address)
    } catch (err) {
      const e = err as SmtpError
      rejected.push({ address, code: e.code ?? 0, message: e.message })
    }
  }

  if (accepted.length === 0) {
    throw new SmtpError(
      `All recipients rejected: ${rejected.map((r) => `${r.address} (${r.code})`).join(", ")}`,
      rejected[0]?.code ?? 550,
    )
  }

  const reply = await session.sendData(input.raw)
  return { accepted, rejected, response: reply.text }
}
