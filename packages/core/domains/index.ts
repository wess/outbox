import { resolveCname, resolveMx, resolveTxt } from "node:dns/promises"
import { config } from "@outbox/config"
import { type Domain, type DomainRecord, domainRecords, domains } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { allColumns, db } from "../db/index.ts"
import { dkimRecordValue, generateDkimKeys } from "../dkim/index.ts"

export type PlannedRecord = {
  record: string
  name: string
  type: string
  value: string
  ttl: string
  priority: number | null
}

/**
 * Outbox delivers mail itself rather than fronting SES, so the record *values*
 * point at this installation. The record set is otherwise the same shape Resend
 * publishes: SPF, DKIM, DMARC, a return-path MX, and an optional tracking CNAME.
 */
export const planRecords = (domain: Domain, publicKeyPem: string): PlannedRecord[] => {
  const host = config.hostname
  const returnPath = domain.custom_return_path || "send"
  const records: PlannedRecord[] = [
    {
      record: "SPF",
      name: returnPath,
      type: "MX",
      value: `feedback-smtp.${host}`,
      ttl: "Auto",
      priority: 10,
    },
    {
      record: "SPF",
      name: returnPath,
      type: "TXT",
      value: `"v=spf1 include:${host} ~all"`,
      ttl: "Auto",
      priority: null,
    },
    {
      record: "SPF",
      name: "@",
      type: "TXT",
      value: `"v=spf1 include:${host} ~all"`,
      ttl: "Auto",
      priority: null,
    },
    {
      record: "DKIM",
      name: `${domain.dkim_selector}._domainkey`,
      type: "TXT",
      value: dkimRecordValue(publicKeyPem),
      ttl: "Auto",
      priority: null,
    },
    {
      record: "DMARC",
      name: "_dmarc",
      type: "TXT",
      value: `"v=DMARC1; p=none; rua=mailto:dmarc@${domain.name}"`,
      ttl: "Auto",
      priority: null,
    },
  ]

  if (domain.click_tracking || domain.open_tracking) {
    records.push({
      record: "Tracking",
      name: `${domain.tracking_subdomain}.${domain.name}`,
      type: "CNAME",
      value: `track.${host}`,
      ttl: "Auto",
      priority: null,
    })
  }

  if (domain.receiving === "enabled") {
    records.push({
      record: "MX",
      name: "@",
      type: "MX",
      value: `inbound.${host}`,
      ttl: "Auto",
      priority: 10,
    })
  }

  return records
}

export const createDomain = async (input: {
  teamId: string
  name: string
  region?: string
  customReturnPath?: string
  openTracking?: boolean
  clickTracking?: boolean
  trackingSubdomain?: string
  tls?: string
  sending?: string
  receiving?: string
}): Promise<{ domain: Domain; records: DomainRecord[] }> => {
  const conn = db()
  const keys = generateDkimKeys(1024)

  const domain = (await conn.one<Domain>(
    from(domains)
      .insert({
        team_id: input.teamId,
        name: input.name.toLowerCase().trim(),
        region: input.region ?? "us-east-1",
        custom_return_path: input.customReturnPath ?? "send",
        open_tracking: input.openTracking ?? false,
        click_tracking: input.clickTracking ?? false,
        tracking_subdomain: input.trackingSubdomain ?? "links",
        tls: input.tls ?? "opportunistic",
        sending: input.sending ?? "enabled",
        receiving: input.receiving ?? "disabled",
        dkim_selector: "outbox",
        dkim_private_key: keys.privateKey,
        dkim_public_key: keys.publicKey,
      })
      .returning(...allColumns(domains)),
  ))!

  const records = await syncRecords(domain)
  return { domain, records }
}

// Rebuilds the record set after a settings change (tracking toggled, receiving
// enabled) while preserving verification status for records that did not move.
export const syncRecords = async (domain: Domain): Promise<DomainRecord[]> => {
  const conn = db()
  const existing = await conn.all<DomainRecord>(
    from(domainRecords).where((q) => q("domain_id").equals(domain.id)),
  )
  const planned = planRecords(domain, domain.dkim_public_key ?? "")
  const keyOf = (r: { name: string; type: string; record: string }) =>
    `${r.record}:${r.type}:${r.name}`
  const statusByKey = new Map(existing.map((r) => [keyOf(r), r.status]))

  await conn.execute(
    from(domainRecords)
      .where((q) => q("domain_id").equals(domain.id))
      .del(),
  )
  if (planned.length === 0) return []

  return conn.all<DomainRecord>(
    from(domainRecords)
      .insertMany(
        planned.map((r) => ({
          domain_id: domain.id,
          record: r.record,
          name: r.name,
          type: r.type,
          value: r.value,
          ttl: r.ttl,
          priority: r.priority,
          status: statusByKey.get(keyOf(r)) ?? "not_started",
        })),
      )
      .returning(...allColumns(domainRecords)),
  )
}

const fqdn = (name: string, domain: string): string =>
  name === "@" || name === "" ? domain : name.endsWith(domain) ? name : `${name}.${domain}`

const unquote = (v: string): string => v.replace(/^"|"$/g, "").trim()

const checkRecord = async (record: DomainRecord, domainName: string): Promise<boolean> => {
  const host = fqdn(record.name, domainName)
  try {
    if (record.type === "TXT") {
      const rows = await resolveTxt(host)
      const flat = rows.map((chunks) => chunks.join(""))
      const want = unquote(record.value)
      // DKIM keys are long enough to be chunked by resolvers; compare on the
      // p= tag rather than the whole string.
      if (record.record === "DKIM") {
        const wantKey = want.match(/p=([A-Za-z0-9+/=]+)/)?.[1]
        return flat.some((v) => wantKey && v.includes(wantKey))
      }
      return flat.some((v) => unquote(v) === want)
    }
    if (record.type === "MX") {
      const rows = await resolveMx(host)
      return rows.some((r) => r.exchange.replace(/\.$/, "") === record.value.replace(/\.$/, ""))
    }
    if (record.type === "CNAME") {
      const rows = await resolveCname(host)
      return rows.some((r) => r.replace(/\.$/, "") === record.value.replace(/\.$/, ""))
    }
  } catch {
    return false
  }
  return false
}

export type VerifyResult = { domain: Domain; records: DomainRecord[] }

/**
 * Resolves every planned record and updates status. A domain counts as verified
 * once SPF and DKIM check out; tracking and receiving records are advisory.
 */
export const verifyDomain = async (domain: Domain): Promise<VerifyResult> => {
  const conn = db()
  const records = await conn.all<DomainRecord>(
    from(domainRecords).where((q) => q("domain_id").equals(domain.id)),
  )

  const results = await Promise.all(
    records.map(async (record) => ({ record, ok: await checkRecord(record, domain.name) })),
  )

  for (const { record, ok } of results) {
    await conn.execute(
      from(domainRecords)
        .where((q) => q("id").equals(record.id))
        .update({ status: ok ? "verified" : "not_started" }),
    )
  }

  const required = results.filter(
    ({ record }) => record.record === "DKIM" || record.record === "SPF",
  )
  const dkimOk = required.some(({ record, ok }) => record.record === "DKIM" && ok)
  const spfOk = required.some(({ record, ok }) => record.record === "SPF" && ok)
  const status = dkimOk && spfOk ? "verified" : results.some((r) => r.ok) ? "pending" : "failed"

  const updated = (await conn.one<Domain>(
    from(domains)
      .where((q) => q("id").equals(domain.id))
      .update({
        status,
        verified_at: status === "verified" ? new Date() : domain.verified_at,
        last_checked_at: new Date(),
        updated_at: new Date(),
      })
      .returning(...allColumns(domains)),
  ))!

  const fresh = await conn.all<DomainRecord>(
    from(domainRecords).where((q) => q("domain_id").equals(domain.id)),
  )
  return { domain: updated, records: fresh }
}
