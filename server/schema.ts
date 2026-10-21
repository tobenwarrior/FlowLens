/** Versioned machine contract shared by the HTTP API and CLI. Register jsonSchema.$id before resolving contract refs. */
const SCHEMA_ID = "urn:flowlens:schema:v1";
type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const contractRef = (name: string) => ({ $ref: `${SCHEMA_ID}#/$defs/${name}` });
const text = (maxLength: number): Schema => ({ type: "string", maxLength });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({
  type: "integer",
  minimum,
  maximum,
});
const array = (items: Schema, maxItems: number): Schema => ({
  type: "array",
  items,
  maxItems,
});
function shape(
  properties: Record<string, Schema>,
  required: string[],
  unknownFields: "stripped" | "ignored" | "allowed" = "stripped",
): Schema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
    "x-unknownFields": unknownFields,
  };
}
const kinds = ["native", "erc20", "internal"];
const requestExpansion = (chains: number[], pageSize: number): Schema =>
  shape(
    {
      address: ref("Address"),
      chainId: { type: "integer", enum: chains },
      maxPages: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      pageSize: {
        type: "integer",
        minimum: 1,
        maximum: pageSize,
        default: pageSize === 10 ? 10 : 12,
      },
    },
    ["address", "chainId"],
    "ignored",
  );
const nodeKeys = array(
  { type: "string", pattern: "^\\d+:0x[0-9a-f]{40}$", maxLength: 4096 },
  1000,
);

export const jsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_ID,
  title: "Flowlens v1 requests and investigation evidence",
  $comment:
    "Known-field schemas match the importer and API. Unknown request fields are ignored; unknown snapshot fields are stripped recursively. Runtime also enforces cross-field invariants declared with x-invariants. JSON Schema format assertions depend on the validator. Budgets are per explicit operation, not an account quota.",
  $defs: {
    Address: {
      type: "string",
      pattern: "^\\s*0[xX][0-9a-fA-F]{40}\\s*$",
      "x-normalizedTo": "trimmed lowercase 0x address",
    },
    Timestamp: {
      type: "string",
      maxLength: 40,
      format: "date-time",
      pattern:
        "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$",
      "x-normalizedTo": "UTC ISO timestamp",
    },
    RawAmount: {
      type: "string",
      pattern: "^\\d+$",
      maxLength: 1000,
      description:
        "Exact unsigned integer units; apply asset.decimals. Never parse as a JavaScript floating-point quantity.",
    },
    RawTotal: {
      type: "string",
      pattern: "^\\d+$",
      description:
        "Exact unsigned aggregate units. Totals can have more digits than one transfer.",
    },
    PathParameters: shape(
      { id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" } },
      ["id"],
      "ignored",
    ),
    EvidencePathParameters: shape(
      {
        id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
        evidenceId: {
          ...text(300),
          description:
            "Percent-encode the full canonical evidence ID as one URL path segment.",
        },
      },
      ["id", "evidenceId"],
      "ignored",
    ),
    CreateRequest: {
      ...shape(
        {
          root: ref("Address"),
          mode: { type: "string", enum: ["demo", "live"] },
          title: text(200),
          historyMode: {
            enum: ["indexed", "evidence-only"],
            default: "indexed",
          },
        },
        ["root", "mode"],
        "ignored",
      ),
      allOf: [
        {
          if: { properties: { mode: { const: "demo" } }, required: ["mode"] },
          then: {
            properties: {
              root: { type: "string", pattern: "^\\s*0[xX]1{40}\\s*$" },
            },
          },
        },
      ],
      description:
        "Demo uses only the synthetic 0x1111…1111 root. Live indexed mode requires an existing server-side permitted key and initially fetches one Ethereum page. Explicit live evidence-only mode creates an empty case with unsupported history coverage and no provider query. No key field is consumed or retained.",
    },
    AcquireRequest: {
      type: "object",
      additionalProperties: false,
      properties: {
        caseId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
        kind: { enum: ["safe", "bridge", "internal"] },
        chainId: { enum: [1, 8453, 42161] },
        address: ref("Address"),
        hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
        maxCalls: { ...integer(1, 64), default: 32 },
        blockNumber: integer(),
        maxPages: integer(1, 3),
        cursor: text(4096),
        includeHistory: { type: "boolean" },
        verifySignatures: { type: "boolean" },
        maxSignatures: integer(1, 5),
        maxLogs: integer(1, 2000),
        maxTraces: integer(1, 2000),
      },
      required: ["kind", "chainId"],
      oneOf: [
        {
          properties: {
            kind: { const: "safe" },
            chainId: { enum: [1, 42161] },
          },
          required: ["address"],
          not: {
            anyOf: [
              { required: ["hash"] },
              { required: ["maxLogs"] },
              { required: ["maxTraces"] },
            ],
          },
        },
        {
          properties: { kind: { const: "bridge" } },
          required: ["hash"],
          not: {
            anyOf: [
              "address",
              "blockNumber",
              "maxPages",
              "cursor",
              "includeHistory",
              "verifySignatures",
              "maxSignatures",
              "maxTraces",
            ].map((key) => ({ required: [key] })),
          },
        },
        {
          properties: { kind: { const: "internal" } },
          required: ["hash"],
          not: {
            anyOf: [
              "blockNumber",
              "maxPages",
              "cursor",
              "includeHistory",
              "verifySignatures",
              "maxSignatures",
              "maxLogs",
            ].map((key) => ({ required: [key] })),
          },
        },
      ],
      description:
        "Explicit bounded read-only query to fixed public providers, disclosing supplied identifiers. Optional live caseId merges private observations without changing graph totals. Runtime enforces per-kind options and budgets before outbound calls. Inspect errors, warnings, acquisition capability and component coverage even on success.",
    },
    ExpandRequest: {
      ...requestExpansion([1, 8453, 42161], 100),
      description:
        "Use ExpandLiveRequest for live cases and ExpandDemoRequest for demo cases. Resume state is read from the case coverage record; raw cursors are not accepted by this API body.",
    },
    ExpandLiveRequest: requestExpansion([1, 42161], 10),
    ExpandDemoRequest: requestExpansion([1, 8453], 100),
    GraphFilters: shape(
      {
        chainId: {
          type: "string",
          enum: ["1", "8453", "42161"],
          description:
            "HTTP query values are strings. Omit to include all loaded chains.",
        },
        direction: {
          type: "string",
          enum: ["all", "in", "out"],
          default: "all",
          description:
            "In/out are relative to the investigation root. Expanded paths remain visible with all.",
        },
        asset: {
          type: "string",
          description:
            "Prefer the exact chainId:contract asset key (chainId:native for ETH). Symbols and all are also accepted; same-symbol contracts still aggregate separately.",
        },
        from: {
          type: "string",
          description:
            "YYYY-MM-DD or a parseable timestamp. Date-only starts at 00:00:00 UTC.",
        },
        to: {
          type: "string",
          description:
            "YYYY-MM-DD or a parseable timestamp. Date-only ends inclusively at 23:59:59.999 UTC.",
        },
      },
      [],
      "ignored",
    ),
    Asset: shape(
      {
        chainId: integer(1),
        symbol: text(40),
        decimals: integer(0, 255),
        contract: { anyOf: [ref("Address"), { type: "null" }] },
      },
      ["chainId", "symbol", "decimals", "contract"],
    ),
    Label: shape(
      {
        text: text(200),
        source: text(200),
        kind: {
          type: "string",
          enum: ["service", "entity", "prediction", "user", "demo"],
        },
        confidence: {
          type: "string",
          enum: ["verified", "reported", "unverified", "synthetic"],
        },
        retrievedAt: ref("Timestamp"),
        sourceUrl: {
          type: "string",
          maxLength: 2048,
          format: "uri",
          pattern: "^https://",
        },
      },
      ["text", "source", "kind", "confidence", "retrievedAt"],
    ),
    WalletNode: shape(
      {
        address: ref("Address"),
        chainId: integer(1),
        label: ref("Label"),
        category: {
          type: "string",
          enum: ["wallet", "exchange", "bridge", "protocol"],
        },
      },
      ["address", "chainId"],
    ),
    Transfer: {
      ...shape(
        {
          id: text(300),
          chainId: integer(1),
          hash: {
            type: "string",
            pattern: "^0[xX][0-9a-fA-F]{64}$",
            maxLength: 66,
          },
          kind: { type: "string", enum: kinds },
          eventIndex: {
            type: "string",
            maxLength: 100,
            pattern: "^[\\w.:-]+$",
          },
          from: ref("Address"),
          to: ref("Address"),
          asset: ref("Asset"),
          rawAmount: ref("RawAmount"),
          timestamp: ref("Timestamp"),
          blockNumber: integer(),
          status: { type: "string", enum: ["success"] },
          source: text(200),
          retrievedAt: ref("Timestamp"),
          synthetic: { type: "boolean" },
        },
        [
          "id",
          "chainId",
          "hash",
          "kind",
          "eventIndex",
          "from",
          "to",
          "asset",
          "rawAmount",
          "timestamp",
          "blockNumber",
          "status",
          "source",
          "retrievedAt",
        ],
      ),
      allOf: [
        {
          if: { properties: { kind: { const: "erc20" } }, required: ["kind"] },
          then: {
            properties: { asset: { properties: { contract: ref("Address") } } },
          },
          else: {
            properties: {
              asset: { properties: { contract: { type: "null" } } },
            },
          },
        },
      ],
      "x-identityFields": [
        "chainId",
        "hash",
        "kind",
        "eventIndex",
        "asset.contract",
      ],
      "x-invariants": [
        "asset.chainId equals chainId",
        "id equals chainId:lowercase(hash):kind:eventIndex:lowercase(asset.contract), using native for a null contract",
        "Receipt-derived ERC20 eventIndex is the actual log index; internal transfer paths may use dotted event indices",
      ],
    },
    Coverage: {
      ...shape(
        {
          key: text(300),
          address: ref("Address"),
          chainId: integer(1),
          provider: text(100),
          status: {
            type: "string",
            enum: ["partial", "exhausted", "error", "unsupported"],
          },
          pagesLoaded: integer(0, 1_000_000),
          cursor: { anyOf: [text(4096), { type: "null" }] },
          warnings: array(text(4096), 100),
          streams: array({ type: "string", enum: kinds }, 3),
          updatedAt: ref("Timestamp"),
          error: text(500),
          errorCode: {
            type: "string",
            pattern: "^[A-Z0-9_]{1,64}$",
            maxLength: 64,
          },
          retryable: { type: "boolean" },
        },
        [
          "key",
          "address",
          "chainId",
          "provider",
          "status",
          "pagesLoaded",
          "cursor",
          "warnings",
          "streams",
          "updatedAt",
        ],
      ),
      allOf: [
        {
          if: {
            properties: { status: { const: "exhausted" } },
            required: ["status"],
          },
          then: { properties: { cursor: { type: "null" } } },
        },
      ],
      "x-invariants": [
        "key equals provider:chainId:lowercase(address)",
        "exhausted applies only to configured provider streams, not all wallet history; inspect warnings",
      ],
    },
    ProtocolEvidenceBundle: {
      type: "object",
      required: ["version", "mode"],
      additionalProperties: true,
      "x-unknownFields": "stripped",
      anyOf: [
        { required: ["safe"] },
        { required: ["bridges"] },
        { required: ["internal"] },
      ],
      properties: {
        version: { const: 1 },
        mode: { enum: ["synthetic", "private"] },
        safe: {
          type: "object",
          required: [
            "version",
            "mode",
            "configurations",
            "executions",
            "configurationEvents",
            "coverage",
            "labels",
          ],
          description:
            "Strict Safe observation model; genesis/current/at-block configs and observed execution signatures remain distinct. See docs/safe-evidence.md and the synthetic replay example.",
          additionalProperties: true,
        },
        bridges: {
          type: "object",
          required: [
            "version",
            "mode",
            "observations",
            "assetMappings",
            "coverage",
          ],
          description:
            "Strict protocol-ID bridge observation model with exact asset mappings and separate beneficiary-credit evidence. See docs/bridge-internal-evidence.md.",
          additionalProperties: true,
        },
        internal: {
          type: "object",
          required: ["version", "mode", "traces", "coverage"],
          description:
            "Strict typed trace-path observations and supplied bounded provider coverage. Transaction-specific callTracer acquisition probes endpoint support; no complete wallet internal-history index is provided.",
          additionalProperties: true,
        },
      },
      "x-invariants": [
        "All component modes and per-record provenance flags agree with bundle mode.",
        "Demo cases require synthetic replay; live cases require private replay.",
        "Runtime parsers additionally validate every observation field, list/byte bound, identity and cross-field consistency.",
        "Replay does not authenticate sources or silently modify the indexed transfer ledger.",
      ],
    },
    ReplayRequest: {
      type: "object",
      additionalProperties: false,
      properties: {
        caseId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
        fixture: { const: "protocols-v1" },
        bundle: ref("ProtocolEvidenceBundle"),
      },
      oneOf: [
        { required: ["fixture"], not: { required: ["bundle"] } },
        { required: ["bundle"], not: { required: ["fixture"] } },
      ],
    },
    Investigation: {
      ...shape(
        {
          version: { type: "integer", const: 1 },
          id: text(100),
          title: text(200),
          root: ref("Address"),
          mode: { type: "string", enum: ["demo", "live"] },
          createdAt: ref("Timestamp"),
          updatedAt: ref("Timestamp"),
          transfers: array(ref("Transfer"), 20_000),
          nodes: array(ref("WalletNode"), 2000),
          coverage: array(ref("Coverage"), 2000),
          expanded: nodeKeys,
          pinned: nodeKeys,
          hidden: nodeKeys,
          notes: text(100_000),
          protocolEvidence: ref("ProtocolEvidenceBundle"),
        },
        [
          "version",
          "id",
          "title",
          "root",
          "mode",
          "createdAt",
          "updatedAt",
          "transfers",
          "nodes",
          "coverage",
          "expanded",
          "pinned",
          "hidden",
          "notes",
        ],
      ),
      allOf: [
        {
          if: { properties: { mode: { const: "live" } }, required: ["mode"] },
          then: {
            properties: {
              transfers: {
                items: { properties: { synthetic: { const: false } } },
              },
            },
          },
        },
      ],
      "x-demoTransferRequirement":
        "Demo ledger transfers must explicitly set synthetic:true. Private transfers cannot be relabeled by changing case mode.",
      "x-maxSerializedBytes": 5_000_000,
      "x-invariants": [
        "Evidence IDs, node chain/address pairs and coverage keys are unique",
        "One chain/asset contract cannot have conflicting decimals",
        "One evidence identity cannot change amount, participants, block, asset or timestamp",
        "HTTP persistence requires an id matching PathParameters and an unchanged updatedAt revision; success returns a newer revision",
      ],
    },
    FlowEdge: shape(
      {
        id: { type: "string" },
        from: ref("Address"),
        to: ref("Address"),
        chainId: integer(1),
        transfers: array(ref("Transfer"), 20_000),
      },
      ["id", "from", "to", "chainId", "transfers"],
      "allowed",
    ),
    AssetFlow: shape(
      {
        asset: ref("Asset"),
        inflow: ref("RawTotal"),
        outflow: ref("RawTotal"),
        net: {
          type: "string",
          pattern: "^-?\\d+$",
          description: "Signed exact raw units: inflow minus outflow.",
        },
      },
      ["asset", "inflow", "outflow", "net"],
      "allowed",
    ),
    GraphResponse: shape(
      {
        root: ref("Address"),
        transfers: array(ref("Transfer"), 20_000),
        edges: array(ref("FlowEdge"), 20_000),
        flows: array(ref("AssetFlow"), 20_000),
        coverage: array(ref("Coverage"), 2000),
      },
      ["root", "transfers", "edges", "flows", "coverage"],
      "allowed",
    ),
    ErrorResponse: {
      type: "object",
      additionalProperties: false,
      required: ["error"],
      properties: {
        error: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message", "retryable"],
          properties: {
            code: { type: "string" },
            message: text(500),
            retryable: { type: "boolean" },
          },
        },
      },
    },
  },
};

export const operationSchema = {
  version: 1,
  operations: [
    "status",
    "create",
    "inspect",
    "expand",
    "evidence",
    "graph",
    "export",
    "replay",
    "acquire",
  ],
  limits: {
    chains: [1, 8453, 42161],
    demoChains: [1, 8453],
    liveChains: [1, 42161],
    maxPagesPerExpansion: 3,
    maxNodes: 80,
    liveRowsPerStream: 10,
    maxBodyBytes: 5_000_000,
    publicRpcChains: [1, 8453, 42161],
    maxRpcCallsPerAcquisition: 64,
    defaultRpcCallsPerAcquisition: 32,
    rpcIntervalMs: 1000,
    defaultRpcDurationMs: 45_000,
  },
  errorShape: {
    error: { code: "string", message: "string", retryable: "boolean" },
  },
  pagination:
    "Provider cursors are stored in coverage records. Expanding the same address resumes its last committed page. No recursive expansion.",
  evidenceIdentity: ["chainId", "hash", "kind", "eventIndex", "asset.contract"],
  grossFlows:
    "Per-chain asset raw units. Inflow, outflow and net are separate; these are transfers, not trades.",
  schemaResolution:
    "Register jsonSchema under its $id (urn:flowlens:schema:v1), then resolve contracts' bodySchema/querySchema/responseSchema refs. All local refs inside jsonSchema resolve against that document.",
  jsonSchema,
  contracts: {
    acquire: {
      method: "POST",
      path: "/api/acquire",
      bodySchema: contractRef("AcquireRequest"),
      cli: "acquire --kind safe|bridge|internal --chain N --address EVM|--hash TX [--file LIVE_CASE_PATH]",
      description:
        "Read-only external acquisition; optional local attachment. Transaction-scoped bridge/internal evidence never implies complete wallet history. Per-case POST /api/investigations/{id}/acquire also supported.",
    },
    replay: {
      method: "POST",
      path: "/api/replay",
      bodySchema: contractRef("ReplayRequest"),
      description:
        "Replay supplied protocol evidence. Optional caseId attaches it locally; indexed history is unchanged. Per-case route POST /api/investigations/{id}/replay also supported.",
    },
    status: {
      method: "GET",
      path: "/api/status",
      cli: "status",
      description:
        "Provider availability and limits; no secrets. liveAvailable is a boolean.",
    },
    create: {
      method: "POST",
      path: "/api/investigations",
      bodySchema: contractRef("CreateRequest"),
      responseSchema: contractRef("Investigation"),
      successStatus: 201,
      cli: "create --mode MODE --file PATH [--address EVM] [--title TEXT]",
    },
    inspect: {
      method: "GET",
      path: "/api/investigations/{id}",
      pathSchema: contractRef("PathParameters"),
      responseSchema: contractRef("Investigation"),
      cli: "inspect --file PATH",
      cliResponse:
        "CLI inspect returns a summary with evidenceCount, nodeCount, coverage and per-asset flows; use export for the full snapshot.",
    },
    expand: {
      method: "POST",
      path: "/api/investigations/{id}/expand",
      pathSchema: contractRef("PathParameters"),
      bodySchema: contractRef("ExpandRequest"),
      modeSchemas: {
        live: contractRef("ExpandLiveRequest"),
        demo: contractRef("ExpandDemoRequest"),
      },
      responseSchema: contractRef("Investigation"),
      cli: "expand --file PATH --address EVM --chain CHAIN_ID [--pages 1..3] [--page-size N]",
      description:
        "A successful HTTP response may still contain coverage errors. Inspect every coverage status; CLI saves this state and exits 2 if any coverage error exists.",
    },
    evidence: {
      method: "GET",
      path: "/api/investigations/{id}/evidence/{evidenceId}",
      pathSchema: contractRef("EvidencePathParameters"),
      responseSchema: contractRef("Transfer"),
      cli: "evidence --file PATH --id EVIDENCE_ID",
    },
    graph: {
      method: "GET",
      path: "/api/investigations/{id}/graph",
      pathSchema: contractRef("PathParameters"),
      querySchema: contractRef("GraphFilters"),
      responseSchema: contractRef("GraphResponse"),
      cli: "graph --file PATH [--chain CHAIN_ID] [--asset ASSET_KEY] [--direction all|in|out] [--from DATE] [--to DATE]",
    },
    export: {
      method: "GET",
      path: "/api/investigations/{id}/export",
      pathSchema: contractRef("PathParameters"),
      responseSchema: contractRef("Investigation"),
      cli: "export --file PATH",
    },
    save: {
      method: "PUT",
      path: "/api/investigations/{id}",
      pathSchema: contractRef("PathParameters"),
      bodySchema: contractRef("Investigation"),
      responseSchema: contractRef("Investigation"),
      concurrency: {
        revisionField: "updatedAt",
        staleStatus: 409,
        staleCode: "CASE_CONFLICT",
        busyStatus: 409,
        busyCode: "CASE_BUSY",
        rule: "For an existing case, send the unchanged updatedAt from the last fetched snapshot. Adopt the returned timestamp after saving. New imported case IDs may be saved if absent.",
      },
    },
  },
};
