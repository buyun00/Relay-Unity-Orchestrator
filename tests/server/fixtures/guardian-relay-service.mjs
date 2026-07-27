import http from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PIPELINE_PORT || "4317", 10);
const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/shutdown") {
    response.writeHead(202);
    response.end();
    setImmediate(() => server.close(() => process.exit(0)));
    return;
  }
  if (request.url === "/api/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "fixture-relay" }));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, host);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
