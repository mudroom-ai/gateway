// Thin HTTP/JSON adapter over the core ops.
// Success: 200 (201 for book) with the op's data. Failure: HTTP_STATUS[code]
// with the GatewayError body.
//
//   GET  /api/services        list_services
//   POST /api/slots           find_slots   (FindSlotsRequest body)
//   POST /api/quote           quote        (QuoteRequest body)
//   slots and quote take optional booking_id + phone|email when moving a booking.
//   POST /api/book            book         (BookRequest body)
//   POST /api/cancel          cancel       (CancelRequest body)
//   POST /api/reschedule      reschedule   (RescheduleRequest body)
//   Only when an owner channel is configured (src/messages.ts):
//   POST /api/messages              leave_message (LeaveMessageRequest body)
//   GET  /api/threads/:id[?wait=N]  get_thread    (X-Thread-Token header; wait holds up to N s for the owner)
//   POST /api/threads/:id/messages  follow_up     (X-Thread-Token header, {message, idempotency_key?, done?})
//   POST /api/threads/:id/close     close_thread  (X-Thread-Token header; idempotent)
//   The read token is accepted in the header only: the access log prints the URL, so a
//   token in a query string would land in the logs.

import { Router, type NextFunction, type Request, type Response } from "express";
import { err, HTTP_STATUS, type GatewayError, type Result } from "../errors.js";
import type {
  BookRequest,
  Booking,
  CancelRequest,
  FindSlotsRequest,
  FindSlotsResult,
  ListServicesResult,
  Quote,
  QuoteRequest,
  RescheduleRequest,
} from "../types.js";
import type { LeaveMessageRequest, MessageOps } from "../messages.js";

/** Core ops bound to their dependencies (see buildOps in server.ts). */
export interface Ops {
  listServices: () => Promise<Result<ListServicesResult>>;
  findSlots: (req: FindSlotsRequest) => Promise<Result<FindSlotsResult>>;
  quote: (req: QuoteRequest) => Promise<Result<Quote>>;
  book: (req: BookRequest) => Promise<Result<Booking>>;
  cancel: (req: CancelRequest) => Promise<Result<Booking>>;
  reschedule: (req: RescheduleRequest) => Promise<Result<Booking>>;
  /** Undefined when no owner channel is configured: the message routes do not exist. */
  messages?: MessageOps;
}

export function sendError(res: Response, e: GatewayError): void {
  if (e.retry_after_s !== undefined) res.set("Retry-After", String(e.retry_after_s));
  res.status(HTTP_STATUS[e.code] ?? 500).json(e);
}

export function sendResult<T>(res: Response, r: Result<T>, okStatus = 200): void {
  if (r.ok) res.status(okStatus).json(r.data);
  else sendError(res, r.error);
}

/**
 * Run an op; a thrown error becomes `internal` instead of escaping the adapter. The error is
 * logged with the op name first, or a thrown SQLite error would leave no trace. Only the
 * error is logged, never the request (it can hold a read token or a customer's message).
 */
export async function runOp<T>(
  name: string,
  fn: () => Result<T> | Promise<Result<T>>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    log(`[gateway] op ${name} threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return err("internal", "Unexpected error");
  }
}

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

export function apiRouter(ops: Ops): Router {
  const r = Router();
  r.get("/services", async (_req, res) => sendResult(res, await runOp("list_services", () => ops.listServices())));
  r.post("/slots", async (req, res) =>
    sendResult(res, await runOp("find_slots", () => ops.findSlots(body(req) as unknown as FindSlotsRequest))),
  );
  r.post("/quote", async (req, res) => sendResult(res, await runOp("quote", () => ops.quote(body(req) as unknown as QuoteRequest))));
  r.post("/book", async (req, res) => sendResult(res, await runOp("book", () => ops.book(body(req) as unknown as BookRequest)), 201));
  r.post("/cancel", async (req, res) => sendResult(res, await runOp("cancel", () => ops.cancel(body(req) as unknown as CancelRequest))));
  r.post("/reschedule", async (req, res) =>
    sendResult(res, await runOp("reschedule", () => ops.reschedule(body(req) as unknown as RescheduleRequest))),
  );
  const messages = ops.messages;
  if (messages) {
    const token = (req: Request) => req.get("x-thread-token") ?? "";
    r.post("/messages", async (req, res) =>
      sendResult(res, await runOp("leave_message", () => messages.leaveMessage(body(req) as LeaveMessageRequest)), 201),
    );
    r.get("/threads/:id", async (req, res) => {
      // wait: one whole number of seconds, 0 to 3600 (clamped to the configured max in messages.ts).
      const w = req.query.wait;
      if (w !== undefined && (typeof w !== "string" || !/^\d{1,4}$/.test(w) || Number(w) > 3600)) {
        return sendError(res, err("invalid_request", "wait must be a whole number of seconds from 0 to 3600").error);
      }
      // A client that goes away (agent timeout, proxy cut) ends the hold; it never closes the thread.
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) gone.abort();
      });
      const r2 = await runOp("get_thread", () =>
        messages.getThread({ thread_id: req.params.id, read_token: token(req), wait_s: w === undefined ? undefined : Number(w), signal: gone.signal }),
      );
      if (!gone.signal.aborted) sendResult(res, r2);
    });
    r.post("/threads/:id/messages", async (req, res) => {
      const b = body(req);
      const r2 = await runOp("follow_up", () =>
        messages.agentFollowUp({
          thread_id: req.params.id,
          read_token: token(req),
          message: b.message as string | undefined,
          idempotency_key: b.idempotency_key as string | undefined,
          done: b.done as boolean | undefined,
        }),
      );
      sendResult(res, r2, 201);
    });
    r.post("/threads/:id/close", async (req, res) =>
      sendResult(res, await runOp("close_thread", () => messages.closeThread({ thread_id: req.params.id, read_token: token(req) }))),
    );
  }
  r.use((_req, res) => sendError(res, err("invalid_request", "Unknown endpoint").error));
  return r;
}

/** Final error handler: malformed JSON and anything else thrown in middleware -> GatewayError body. */
export function jsonErrorHandler() {
  return (e: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(e);
    const status = (e as { status?: number; type?: string } | null)?.status;
    if (status !== undefined && status >= 400 && status < 500) {
      return sendError(res, err("invalid_request", "Request body must be valid JSON").error);
    }
    sendError(res, err("internal", "Unexpected error").error);
  };
}
