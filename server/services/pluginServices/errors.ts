import { randomUUID } from "node:crypto";
import { PaidCallError } from "./CallPolicy";
import type {
  PluginServiceError,
  PluginServiceErrorCode,
} from "../../../shared/lib/pluginServices/v1";

const messages: Record<PluginServiceErrorCode, string> = {
  INTERNAL_ERROR: "The service failed internally.",
  UNAUTHENTICATED: "Authentication required.",
  FORBIDDEN: "This operation is not permitted.",
  INVALID_INPUT: "Invalid service input.",
  NOT_FOUND_OR_FORBIDDEN: "Note not found or unavailable.",
  INDEX_NOT_READY: "The index is not ready.",
  SOURCE_NOT_INDEXED: "The source has no verified body index.",
  SOURCE_INDEX_STALE: "The source index does not match the current note.",
  LEGACY_INDEX_UNVERIFIED: "The legacy index has not been verified.",
  EMBEDDING_SPACE_MISMATCH: "The embedding space does not match.",
  INDEX_CHANGED: "The index changed during the request.",
  MODEL_UNAVAILABLE: "The requested model is unavailable.",
  CAPABILITY_UNSUPPORTED: "The capability is unavailable.",
  QUERY_BUDGET_EXCEEDED: "The query exceeds the computation budget.",
  RATE_LIMITED: "The request limit was reached.",
  BUDGET_EXCEEDED: "The account budget was reached.",
  IDEMPOTENCY_CONFLICT: "The key was used for different input.",
  REQUEST_IN_PROGRESS: "The original request is still running.",
  RESULT_NOT_RETAINED: "The original result was not retained.",
  OUTCOME_UNKNOWN:
    "The provider outcome is unknown; the request will not be repeated.",
  TIMEOUT: "The request timed out.",
  ABORTED: "The request was stopped.",
  PROVIDER_ERROR: "The provider request failed.",
};
export class ServiceError extends Error {
  readonly code: PluginServiceErrorCode;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(
    code: PluginServiceErrorCode,
    options: {
      requestId?: string;
      retryable?: boolean;
      retryAfterMs?: number;
    } = {},
  ) {
    super(messages[code]);
    this.name = "ServiceError";
    this.code = code;
    this.requestId = options.requestId ?? randomUUID();
    this.retryable = options.retryable ?? false;
    this.retryAfterMs =
      options.retryAfterMs === undefined
        ? undefined
        : Math.max(0, Math.min(60000, options.retryAfterMs));
  }
  toPublic(): PluginServiceError {
    return {
      code: this.code,
      requestId: this.requestId,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: this.retryAfterMs }),
    };
  }
}
export function toPublicError(error: unknown): PluginServiceError {
  if (error instanceof ServiceError) return error.toPublic();
  if (
    error instanceof PaidCallError &&
    Object.prototype.hasOwnProperty.call(messages, error.code)
  )
    return new ServiceError(error.code, {
      requestId: error.requestId,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    }).toPublic();
  return new ServiceError("INTERNAL_ERROR").toPublic();
}
