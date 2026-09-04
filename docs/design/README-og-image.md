# Regenerating the social preview image

`public/og-image.png` is the link-preview card (Open Graph / Twitter), 1200x630.
Its source is `og-image.card.html` in this folder. The card is drawn from the
Vibrant Tones HUD palette (`hud-palette.md`); the metro lines are an abstract
motif, not the real network.

The repo ships no SVG rasterizer or headless browser, so the PNG is captured by
drawing the card onto a canvas in a real browser and saving the result. To
regenerate after editing `og-image.card.html`:

1. Serve this folder and start a one-shot receiver that writes the PNG:

   ```sh
   # from the repo root
   python3 -m http.server 8920 --bind 127.0.0.1 -d docs/design &
   python3 - 8919 "$(pwd)/public/og-image.png" <<'PY' &
   import base64,sys
   from http.server import BaseHTTPRequestHandler,HTTPServer
   OUT=sys.argv[2]; PORT=int(sys.argv[1])
   class H(BaseHTTPRequestHandler):
       def _c(self): self.send_header("Access-Control-Allow-Origin","*")
       def do_OPTIONS(self): self.send_response(204); self._c(); self.end_headers()
       def do_POST(self):
           n=int(self.headers.get("Content-Length",0)); b=self.rfile.read(n).decode()
           if b.startswith("data:"): b=b.split(",",1)[1]
           open(OUT,"wb").write(base64.b64decode(b))
           self.send_response(200); self._c(); self.end_headers(); print("wrote",OUT)
       def log_message(self,*a): pass
   HTTPServer(("127.0.0.1",PORT),H).serve_forever()
   PY
   ```

2. Open `http://localhost:8920/og-image.card.html`, and in the page console run
   the canvas draw + `fetch('http://127.0.0.1:8919/save', {method:'POST', body:
   canvas.toDataURL('image/png')})`. The draw routine mirrors the card markup
   (background gradient, metro lines, station dots, threat blip, wordmark,
   tagline). Confirm the saved file is 1200x630.

3. Stop both background servers.

If the project later adds a headless renderer (Playwright, `@resvg/resvg-js`,
etc.), replace this manual step with a script under `scripts/`.
