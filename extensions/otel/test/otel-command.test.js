import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dashboardReadyEvent,
  endpointReachable,
} from "../dist/commands/otel.js";

test("a configured endpoint is probed at its own host, not loopback", async () => {
  const probes = [];
  const reachable = await endpointReachable(
    "https://collector.example.internal",
    (host, port, timeoutMs) => {
      probes.push({ host, port, timeoutMs });
      return Promise.resolve(true);
    },
  );
  assert.equal(reachable, true);
  assert.deepEqual(
    probes.map(({ host, port }) => ({ host, port })),
    [{ host: "collector.example.internal", port: 443 }],
  );
  // A remote collector needs more than a loopback-sized timeout.
  assert.ok(probes[0].timeoutMs >= 1000);
});

test("an explicit port and http scheme are honoured", async () => {
  const probes = [];
  await endpointReachable("http://collector.example.internal:4318/v1/traces", (host, port) => {
    probes.push({ host, port });
    return Promise.resolve(true);
  });
  assert.deepEqual(probes, [{ host: "collector.example.internal", port: 4318 }]);
});

test("an unparseable endpoint is reported unreachable without probing", async () => {
  for (const endpoint of ["", "   ", "http://"]) {
    let probed = false;
    const reachable = await endpointReachable(endpoint, () => {
      probed = true;
      return Promise.resolve(true);
    });
    assert.equal(reachable, false, `${JSON.stringify(endpoint)} must be unreachable`);
    assert.equal(probed, false, `${JSON.stringify(endpoint)} must not be probed`);
  }
});

test("an explicit non-HTTP scheme is rejected rather than probed at a bogus host", async () => {
  // Prepending http:// to these yields "http://ftp://collector", which parses as
  // the host "ftp" and would probe an unrelated address.
  for (const endpoint of [
    "ftp://collector",
    "unix:///var/run/otlp.sock",
    "grpc://collector:4317",
  ]) {
    let probed = false;
    const reachable = await endpointReachable(endpoint, () => {
      probed = true;
      return Promise.resolve(true);
    });
    assert.equal(reachable, false, `${endpoint} must be unreachable`);
    assert.equal(probed, false, `${endpoint} must not be probed`);
  }
});

test("a scheme-less host:port endpoint is still accepted", async () => {
  const probes = [];
  await endpointReachable("collector.example.internal:4317", (host, port) => {
    probes.push({ host, port });
    return Promise.resolve(true);
  });
  assert.deepEqual(probes, [
    { host: "collector.example.internal", port: 4317 },
  ]);
});

test("an IPv6 literal is probed as an address, not a bracketed hostname", async () => {
  const probes = [];
  await endpointReachable("http://[::1]:4317", (host, port) => {
    probes.push({ host, port });
    return Promise.resolve(true);
  });
  // net.createConnection resolves "[::1]" as a hostname and fails; the address
  // has to be unbracketed.
  assert.deepEqual(probes, [{ host: "::1", port: 4317 }]);
});

test("an unreachable probe is reported as unreachable", async () => {
  assert.equal(
    await endpointReachable("http://collector.example.internal:4317", () =>
      Promise.resolve(false),
    ),
    false,
  );
});

test("dashboard-ready is announced only after a successful start", () => {
  assert.equal(dashboardReadyEvent(false), null);
  assert.deepEqual(dashboardReadyEvent(true), {
    endpoint: "http://localhost:4317",
    // The dashboard speaks gRPC on 4317; omitting the protocol let a resolved
    // http/protobuf config apply to a gRPC endpoint on rewire.
    protocol: "grpc",
  });
});
