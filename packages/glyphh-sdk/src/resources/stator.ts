/**
 * resources/stator.ts — the org memory plane (the FACT SUBSTRATE). recall is
 * the runtime path; browse/graph/create/forget/amend are the curation surface
 * (the Memory panel).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  StatorRecallInput, StatorRecallResult,
  StatorBrowseInput, StatorBrowseResult,
  StatorCreateInput, StatorCreateResult,
  StatorGraphInput, StatorGraphResult,
  StatorForgetInput, StatorForgetResult,
  StatorAmendInput, StatorAmendResult,
} from "../contract/stator.js";

export class StatorClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Cosine-gated fact hits for a query, plus their fact-block rendering. */
  recall(input: StatorRecallInput = {}): Promise<StatorRecallResult> {
    return this.http.post<StatorRecallResult>("/api/stator/recall", input, { raw: true });
  }

  /** Every live fact for the caller — the review surface. */
  browse(input: StatorBrowseInput = {}): Promise<StatorBrowseResult> {
    return this.http.post<StatorBrowseResult>("/api/stator/browse", input, { raw: true });
  }

  /** Append a NEW fact glyphh to the org ledger. */
  create(input: StatorCreateInput): Promise<StatorCreateResult> {
    return this.http.post<StatorCreateResult>("/api/stator/create", input, { raw: true });
  }

  /** The fact space as data: nodes, 3D PCA coords, banded similarity edges. */
  graph(input: StatorGraphInput = {}): Promise<StatorGraphResult> {
    return this.http.post<StatorGraphResult>("/api/stator/graph", input, { raw: true });
  }

  /** Tombstone a fact by id — it leaves every future turn; the row stays for audit. */
  forget(input: StatorForgetInput): Promise<StatorForgetResult> {
    return this.http.post<StatorForgetResult>("/api/stator/forget", input, { raw: true });
  }

  /** Correct a fact — appends a new version and supersedes the old id. */
  amend(input: StatorAmendInput): Promise<StatorAmendResult> {
    return this.http.post<StatorAmendResult>("/api/stator/amend", input, { raw: true });
  }
}
