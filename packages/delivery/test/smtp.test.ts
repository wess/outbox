import { describe, expect, test } from "bun:test"
import { connectSmtp, dotStuff, SmtpError, sendMessage } from "../smtp/index.ts"

const CRLF = "\r\n"

describe("dotStuff", () => {
  test("escapes a leading period so it is not read as end-of-data", () => {
    expect(dotStuff(`a${CRLF}.${CRLF}b`)).toBe(`a${CRLF}..${CRLF}b`)
  })

  test("normalises bare newlines to CRLF", () => {
    expect(dotStuff("a\nb")).toBe(`a${CRLF}b`)
  })

  test("leaves an interior period alone", () => {
    expect(dotStuff("a.b")).toBe("a.b")
  })
})

describe("SmtpError", () => {
  test("classifies 5xx as permanent", () => {
    expect(new SmtpError("no", 550).permanent).toBe(true)
  })

  test("classifies 4xx as transient", () => {
    expect(new SmtpError("later", 451).permanent).toBe(false)
  })
})

/**
 * A scripted SMTP server: each client line is answered from a table, so the
 * client can be exercised without touching the network.
 */
const startFakeServer = async (
  script: { on: RegExp; reply: string }[],
  onData?: (raw: string) => void,
) => {
  let collecting = false
  let buffer = ""
  let message = ""

  const server = Bun.listen<{ dummy: true }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.write(`220 fake.test ESMTP${CRLF}`)
      },
      data(socket, chunk) {
        buffer += chunk.toString()

        if (collecting) {
          const end = buffer.indexOf(`${CRLF}.${CRLF}`)
          if (end === -1) return
          message = buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          collecting = false
          onData?.(message)
          socket.write(`250 2.0.0 Ok: queued${CRLF}`)
          return
        }

        for (;;) {
          const idx = buffer.indexOf(CRLF)
          if (idx === -1) break
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const rule = script.find((r) => r.on.test(line))
          const reply = rule?.reply ?? `500 Unrecognised: ${line}`
          if (/^DATA/i.test(line) && reply.startsWith("354")) {
            collecting = true
            socket.write(reply + CRLF)
            return
          }
          socket.write(reply + CRLF)
          if (/^QUIT/i.test(line)) socket.end()
        }
      },
    },
  })

  return { port: server.port, stop: () => server.stop(true), message: () => message }
}

const BASE_SCRIPT = [
  { on: /^EHLO/i, reply: "250-fake.test greets you\r\n250-8BITMIME\r\n250 SIZE 10485760" },
  { on: /^MAIL FROM/i, reply: "250 2.1.0 Ok" },
  { on: /^RCPT TO/i, reply: "250 2.1.5 Ok" },
  { on: /^DATA/i, reply: "354 End data with <CR><LF>.<CR><LF>" },
  { on: /^QUIT/i, reply: "221 Bye" },
]

describe("connectSmtp", () => {
  test("completes a full send transaction", async () => {
    const server = await startFakeServer(BASE_SCRIPT)
    try {
      const session = await connectSmtp({
        host: "127.0.0.1",
        port: server.port,
        clientName: "test",
      })
      const result = await sendMessage(session, {
        returnPath: "bounce@acme.com",
        recipients: ["user@example.com"],
        raw: `Subject: Hi${CRLF}${CRLF}Body`,
      })
      expect(result.accepted).toEqual(["user@example.com"])
      expect(result.response).toContain("250")
      session.close()
    } finally {
      server.stop()
    }
  })

  test("parses multi-line EHLO capabilities", async () => {
    const server = await startFakeServer(BASE_SCRIPT)
    try {
      const session = await connectSmtp({
        host: "127.0.0.1",
        port: server.port,
        clientName: "test",
      })
      expect(session.capabilities.has("8BITMIME")).toBe(true)
      expect(session.capabilities.has("SIZE")).toBe(true)
      session.close()
    } finally {
      server.stop()
    }
  })

  test("dot-stuffs the message it transmits", async () => {
    const server = await startFakeServer(BASE_SCRIPT)
    try {
      const session = await connectSmtp({
        host: "127.0.0.1",
        port: server.port,
        clientName: "test",
      })
      await sendMessage(session, {
        returnPath: "b@acme.com",
        recipients: ["user@example.com"],
        raw: `Subject: Hi${CRLF}${CRLF}line1${CRLF}.${CRLF}line2`,
      })
      expect(server.message()).toContain(`${CRLF}..${CRLF}`)
      session.close()
    } finally {
      server.stop()
    }
  })

  test("records a rejected recipient but still delivers to the rest", async () => {
    let seen = 0
    const server = await startFakeServer([
      ...BASE_SCRIPT.filter((r) => !/RCPT/.test(r.on.source)),
      {
        on: /^RCPT TO/i,
        get reply() {
          seen++
          return seen === 1 ? "550 5.1.1 No such user" : "250 2.1.5 Ok"
        },
      },
    ])
    try {
      const session = await connectSmtp({
        host: "127.0.0.1",
        port: server.port,
        clientName: "test",
      })
      const result = await sendMessage(session, {
        returnPath: "b@acme.com",
        recipients: ["gone@example.com", "ok@example.com"],
        raw: `Subject: Hi${CRLF}${CRLF}Body`,
      })
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]!.code).toBe(550)
      expect(result.accepted).toEqual(["ok@example.com"])
      session.close()
    } finally {
      server.stop()
    }
  })

  test("throws when every recipient is rejected", async () => {
    const server = await startFakeServer([
      ...BASE_SCRIPT.filter((r) => !/RCPT/.test(r.on.source)),
      { on: /^RCPT TO/i, reply: "550 5.1.1 No such user" },
    ])
    try {
      const session = await connectSmtp({
        host: "127.0.0.1",
        port: server.port,
        clientName: "test",
      })
      await expect(
        sendMessage(session, {
          returnPath: "b@acme.com",
          recipients: ["gone@example.com"],
          raw: "Subject: Hi\r\n\r\nBody",
        }),
      ).rejects.toThrow(/All recipients rejected/)
      session.close()
    } finally {
      server.stop()
    }
  })

  test("surfaces a 4xx from MAIL FROM as a transient error", async () => {
    const server = await startFakeServer([
      ...BASE_SCRIPT.filter((r) => !/MAIL/.test(r.on.source)),
      { on: /^MAIL FROM/i, reply: "451 4.3.0 Try again later" },
    ])
    try {
      const session = await connectSmtp({
        host: "127.0.0.1",
        port: server.port,
        clientName: "test",
      })
      try {
        await sendMessage(session, {
          returnPath: "b@acme.com",
          recipients: ["a@example.com"],
          raw: "Subject: Hi\r\n\r\nBody",
        })
        throw new Error("expected a throw")
      } catch (err) {
        expect(err).toBeInstanceOf(SmtpError)
        expect((err as SmtpError).permanent).toBe(false)
      }
      session.close()
    } finally {
      server.stop()
    }
  })
})
