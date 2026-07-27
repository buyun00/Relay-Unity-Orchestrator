import http from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3000", 10);
const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/shutdown") {
    response.writeHead(202);
    response.end();
    setImmediate(() => server.close(() => process.exit(0)));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Fixture Relay Web</title>");
});

server.listen(port, host);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
