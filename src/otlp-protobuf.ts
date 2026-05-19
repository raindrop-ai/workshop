import * as protobuf from "protobufjs";

const OTLP_PROTO = `
syntax = "proto3";
package otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}
message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}
message Status {
  reserved 1;
  string message = 2;
  enum StatusCode {
    STATUS_CODE_UNSET = 0;
    STATUS_CODE_OK = 1;
    STATUS_CODE_ERROR = 2;
  }
  StatusCode code = 3;
}
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  fixed32 flags = 16;
  string name = 5;
  enum SpanKind {
    SPAN_KIND_UNSPECIFIED = 0;
    SPAN_KIND_INTERNAL = 1;
    SPAN_KIND_SERVER = 2;
    SPAN_KIND_CLIENT = 3;
    SPAN_KIND_PRODUCER = 4;
    SPAN_KIND_CONSUMER = 5;
  }
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }
  message Link {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
    fixed32 flags = 6;
  }
}
message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}
message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}
message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}
`;

const root = protobuf.parse(OTLP_PROTO, { keepCase: false }).root;
const ExportTraceServiceRequest = root.lookupType("otlp.ExportTraceServiceRequest");

function bytesToHex(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// With `{ defaults: false, oneofs: true }`, protobufjs drops scalar oneof
// fields equal to the proto3 default (false, 0, "") but still sets the virtual
// `v.value` to the selected alternative name. Check both so zero/false survive.
function convertAnyValue(v: any): any {
  if (v == null) return undefined;
  if (v.stringValue !== undefined || v.value === "stringValue") return { stringValue: v.stringValue ?? "" };
  if (v.boolValue !== undefined || v.value === "boolValue") return { boolValue: v.boolValue ?? false };
  if (v.intValue !== undefined || v.value === "intValue") return { intValue: String(v.intValue ?? 0) };
  if (v.doubleValue !== undefined || v.value === "doubleValue") return { doubleValue: v.doubleValue ?? 0 };
  if (v.bytesValue !== undefined || v.value === "bytesValue") return { stringValue: bytesToHex(v.bytesValue) ?? "" };
  if (v.arrayValue !== undefined || v.value === "arrayValue") {
    return { arrayValue: { values: (v.arrayValue?.values ?? []).map(convertAnyValue) } };
  }
  if (v.kvlistValue !== undefined || v.value === "kvlistValue") {
    return { kvlistValue: { values: (v.kvlistValue?.values ?? []).map(convertKeyValue) } };
  }
  return undefined;
}

function convertKeyValue(kv: any): any {
  return { key: kv.key ?? "", value: convertAnyValue(kv.value) };
}

function convertSpan(s: any): any {
  return {
    traceId: bytesToHex(s.traceId) ?? "",
    spanId: bytesToHex(s.spanId) ?? "",
    parentSpanId: bytesToHex(s.parentSpanId),
    traceState: s.traceState,
    name: s.name ?? "",
    kind: typeof s.kind === "number" ? s.kind : 0,
    startTimeUnixNano: String(s.startTimeUnixNano ?? "0"),
    endTimeUnixNano: String(s.endTimeUnixNano ?? "0"),
    attributes: (s.attributes ?? []).map(convertKeyValue),
    events: (s.events ?? []).map((e: any) => ({
      timeUnixNano: String(e.timeUnixNano ?? "0"),
      name: e.name ?? "",
      attributes: (e.attributes ?? []).map(convertKeyValue),
    })),
    links: (s.links ?? []).map((l: any) => ({
      traceId: bytesToHex(l.traceId) ?? "",
      spanId: bytesToHex(l.spanId) ?? "",
      attributes: (l.attributes ?? []).map(convertKeyValue),
    })),
    status: s.status
      ? { code: typeof s.status.code === "number" ? s.status.code : 0, message: s.status.message }
      : undefined,
  };
}

export function decodeOtlpProtobuf(buf: Buffer | Uint8Array): { resourceSpans: any[] } {
  const decoded = ExportTraceServiceRequest.decode(buf);
  const obj = ExportTraceServiceRequest.toObject(decoded, {
    longs: String,
    bytes: Array,
    defaults: false,
    oneofs: true,
  });
  const resourceSpans = (obj.resourceSpans ?? []).map((rs: any) => ({
    resource: rs.resource
      ? { attributes: (rs.resource.attributes ?? []).map(convertKeyValue) }
      : { attributes: [] },
    scopeSpans: (rs.scopeSpans ?? []).map((ss: any) => ({
      scope: ss.scope
        ? { name: ss.scope.name ?? "", version: ss.scope.version }
        : undefined,
      spans: (ss.spans ?? []).map(convertSpan),
    })),
  }));
  return { resourceSpans };
}
