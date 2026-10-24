import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/app/html";
const PORT = 8080;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  let file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(ROOT, "index.html");
    const ext = path.extname(file).toLowerCase();
    res.setHeader("Content-Type", TYPES[ext] || "application/octet-stream");
    if (file.includes("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    else if (file.includes("/models/")) res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, "0.0.0.0", () => console.log("whale listening on", PORT));
