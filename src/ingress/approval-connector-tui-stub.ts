/**
 * TUI / web approval connector stub.
 *
 * A future terminal UI or web dashboard connector should consume the same HTTP
 * endpoints exposed by `src/routes/approval-routes.ts`:
 *
 * - GET  /api/approvals/pending
 * - GET  /api/approvals/:requestId
 * - POST /api/approvals/:requestId/decision
 * - GET  /api/approvals/bindings/pending
 *
 * It should authenticate with the configured `API_SECRET` via the
 * `x-api-secret` header and provide a human-facing list/detail/decision UI.
 *
 * This phase intentionally does not implement TUI polling or rendering; that
 * work is deferred until the TUI exists and can reuse the HTTP approval ingress.
 */

export interface TuiApprovalConnectorStub {
  /**
   * Reserved marker for the future TUI connector implementation.
   */
  readonly __futureTuiConnector: true;
}

export const tuiApprovalConnectorStub: TuiApprovalConnectorStub = {
  __futureTuiConnector: true,
};
