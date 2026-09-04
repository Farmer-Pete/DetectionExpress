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

2. Open `http://localhost:8920/og-image.card.html`. In the page console, run the
   routine below. It draws the card onto a canvas and POSTs the PNG to the
   receiver. It mirrors the card markup: background gradient, metro lines,
   station dots, threat blip, wordmark, and tagline.

   ```js
   await document.fonts.load('700 92px "Chakra Petch"');
   await document.fonts.load('400 35px "IBM Plex Mono"');
   await document.fonts.ready;

   const W = 1200, H = 630;
   const c = document.createElement('canvas');
   c.width = W; c.height = H;
   const x = c.getContext('2d');

   // background gradient
   let g = x.createLinearGradient(0, 0, 0, H);
   g.addColorStop(0, '#0f303d');
   g.addColorStop(1, '#0b2530');
   x.fillStyle = g; x.fillRect(0, 0, W, H);

   // metro lines
   x.lineCap = 'round'; x.lineJoin = 'round';
   x.globalAlpha = 0.92; x.lineWidth = 9;
   const lines = [
     ['#f8961e', [[80,150],[360,150],[520,310],[520,560]]],
     ['#43aa8b', [[120,470],[400,470],[560,310],[900,310],[1080,130]]],
     ['#277da1', [[260,60],[260,360],[620,360],[780,520],[1120,520]]],
     ['#f94144', [[980,80],[820,240],[820,470],[1120,470]]],
   ];
   for (const [col, pts] of lines) {
     x.strokeStyle = col; x.beginPath();
     pts.forEach((p, i) => i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]));
     x.stroke();
   }
   x.globalAlpha = 1;

   // station dots
   const dots = [[360,150],[520,310],[560,310],[820,360],[620,360],[780,520],[260,360],[900,310]];
   x.fillStyle = '#0f303d'; x.strokeStyle = '#fbd57b'; x.lineWidth = 5;
   for (const [cx, cy] of dots) { x.beginPath(); x.arc(cx, cy, 11, 0, 7); x.fill(); x.stroke(); }

   // threat blip at 820,240
   x.beginPath(); x.arc(820, 240, 13, 0, 7); x.fillStyle = '#0f303d'; x.fill();
   x.strokeStyle = '#f94144'; x.lineWidth = 6; x.stroke();
   x.globalAlpha = 0.55; x.beginPath(); x.arc(820, 240, 27, 0, 7); x.lineWidth = 4; x.stroke();
   x.globalAlpha = 1;

   // bottom overlay scrim
   let og = x.createLinearGradient(0, H, 0, H - 320);
   og.addColorStop(0, 'rgba(9,28,36,0.97)');
   og.addColorStop(0.55, 'rgba(9,28,36,0.9)');
   og.addColorStop(1, 'rgba(9,28,36,0)');
   x.fillStyle = og; x.fillRect(0, H - 320, W, 320);

   // text
   x.textBaseline = 'alphabetic';
   x.letterSpacing = '2px';
   x.font = '700 92px "Chakra Petch", sans-serif';
   x.fillStyle = '#fbd57b';
   x.fillText('DETECTION ', 72, 510);
   const w1 = x.measureText('DETECTION ').width;
   x.fillStyle = '#f8961e';
   x.fillText('EXPRESS', 72 + w1, 510);

   x.letterSpacing = '0px';
   x.font = '400 35px "IBM Plex Mono", monospace';
   x.fillStyle = '#e4c575';
   x.fillText('Learn cybersecurity detection engineering.', 74, 566);

   await fetch('http://127.0.0.1:8919/save', {
     method: 'POST',
     body: c.toDataURL('image/png'),
   });
   ```

   Confirm the saved file is 1200x630.

3. Stop both background servers.

If the project later adds a headless renderer (Playwright, `@resvg/resvg-js`,
etc.), replace this manual step with a script under `scripts/`.
