import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { postWebhook } from "../lib/webhook.js";

test("postWebhook reports successful and unsuccessful HTTP responses", async (t) => {
  const statuses = [204, 404];
  const server = createServer((_request, response) => {
    response.writeHead(statuses.shift());
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  assert.deepEqual(await postWebhook(url, "trade one"), { ok: true, status: 204, error: null });
  assert.deepEqual(await postWebhook(url, "trade two"), { ok: false, status: 404, error: null });
});

test("postWebhook reports a refused connection", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  const result = await postWebhook(`http://127.0.0.1:${port}/webhook`, "trade");
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.error, /fetch failed/i);
});
