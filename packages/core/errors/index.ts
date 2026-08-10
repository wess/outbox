import { type HttpError, httpError } from "@wess/atlas/server"

// Mirrors Resend's error envelope: { statusCode, name, message }.
// `name` is the machine-readable slug clients switch on.
export type OutboxErrorName =
  | "missing_required_field"
  | "invalid_idempotency_key"
  | "invalid_idempotent_request"
  | "concurrent_idempotent_requests"
  | "invalid_attachment"
  | "invalid_from_address"
  | "invalid_access"
  | "invalid_parameter"
  | "invalid_region"
  | "rate_limit_exceeded"
  | "missing_api_key"
  | "invalid_api_key"
  | "invalid_user_agent"
  | "validation_error"
  | "not_found"
  | "method_not_allowed"
  | "application_error"
  | "internal_server_error"
  | "daily_quota_exceeded"
  | "security_error"
  | "restricted_api_key"

const err = (
  status: number,
  name: OutboxErrorName,
  message: string,
  headers?: Record<string, string>,
) => httpError(status, message, { code: name, headers })

export const missingRequiredField = (message: string) => err(422, "missing_required_field", message)

export const validationError = (message: string) => err(400, "validation_error", message)

export const invalidParameter = (message: string) => err(400, "invalid_parameter", message)

export const invalidFromAddress = (message: string) => err(403, "invalid_from_address", message)

export const invalidAccess = (message: string) => err(422, "invalid_access", message)

export const missingApiKey = () =>
  err(
    401,
    "missing_api_key",
    "Missing API key in the authorization header, it should be provided as an Authorization header with the value `Bearer OUTBOX_API_KEY`.",
  )

export const invalidApiKey = () =>
  err(403, "invalid_api_key", "API key is invalid. Generate a new one at /api-keys.")

export const restrictedApiKey = () =>
  err(
    401,
    "restricted_api_key",
    "This API key is restricted to only send emails. Use a full access key for this operation.",
  )

export const invalidUserAgent = () =>
  err(
    403,
    "invalid_user_agent",
    "The User-Agent header is required. Set it to identify your application, e.g. `my-app/1.0`.",
  )

export const notFound = (message = "The requested resource was not found.") =>
  err(404, "not_found", message)

export const methodNotAllowed = () =>
  err(405, "method_not_allowed", "This endpoint does not support that HTTP method.")

export const rateLimitExceeded = (retryAfterSeconds: number, limit: number) =>
  err(
    429,
    "rate_limit_exceeded",
    "Too many requests. Please limit the number of requests per second.",
    {
      "retry-after": String(retryAfterSeconds),
      "ratelimit-limit": String(limit),
      "ratelimit-remaining": "0",
      "ratelimit-reset": String(retryAfterSeconds),
    },
  )

export const invalidAttachment = (message: string) => err(422, "invalid_attachment", message)

export const invalidIdempotencyKey = (message: string) =>
  err(400, "invalid_idempotency_key", message)

export const invalidIdempotentRequest = () =>
  err(
    400,
    "invalid_idempotent_request",
    "Same idempotency key used with a different request payload.",
  )

export const concurrentIdempotentRequests = () =>
  err(
    409,
    "concurrent_idempotent_requests",
    "Same idempotency key used while the original request is still in progress.",
  )

export const applicationError = (message = "Something went wrong.") =>
  err(500, "application_error", message)

// Serialised body for any HttpError raised above.
export const errorBody = (e: HttpError): { statusCode: number; name: string; message: string } => ({
  statusCode: e.status,
  name: (e.code as string) ?? "application_error",
  message: e.message,
})

// Dashboard endpoints answer with 401 rather than the API's missing-key text.
export const unauthorizedDashboard = () =>
  err(401, "invalid_access", "You must be signed in to perform this action.")
