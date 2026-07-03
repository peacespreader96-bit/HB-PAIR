import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_PATH = path.join(__dirname, 'session');
const app = express();
app.use(express.json());

// ── STATE ────────────────────────────────────────────────────────────────
let current = { status: 'idle', code: null, sock: null, error: null, syncTimer: null };

function clearSession() {
  if (current.syncTimer) clearTimeout(current.syncTimer);
  if (current.sock) try { current.sock.end(); } catch {}
  current = { status: 'idle', code: null, sock: null, error: null, syncTimer: null };
  if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true });
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

// ── PAIRING LOGIC ────────────────────────────────────────────────────────
async function startPairing(phone) {
  clearSession();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  current.sock = sock;

  sock.ev.on('creds.update', async () => {
    await saveCreds();

    // Check if fully synced (myAppStateKeyId present = sync complete)
    try {
      const credsRaw = fs.readFileSync(path.join(SESSION_PATH, 'creds.json'), 'utf-8');
      const creds = JSON.parse(credsRaw);
      if (creds.myAppStateKeyId && current.status === 'connected') {
        if (current.syncTimer) clearTimeout(current.syncTimer);
        current.status = 'ready';
        console.log('✅ Fully synced — creds ready for download');
      }
    } catch {}
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('🔗 Connected — waiting for sync...');
      current.status = 'connected';

      // Fallback: if myAppStateKeyId never comes in 20s, mark ready anyway
      current.syncTimer = setTimeout(() => {
        if (current.status === 'connected') {
          console.log('⚡ Sync timeout — marking ready with available creds');
          current.status = 'ready';
        }
      }, 20_000);
    }

    if (connection === 'close') {
      if (current.status === 'ready') return;

      // Key fix: Render drops connection fast but creds may already be saved.
      // If registered + me exist, treat as ready even if connection dropped.
      try {
        const credsPath = path.join(SESSION_PATH, 'creds.json');
        if (fs.existsSync(credsPath)) {
          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
          if (creds.registered && creds.me?.id) {
            if (current.syncTimer) clearTimeout(current.syncTimer);
            current.status = 'ready';
            console.log('✅ Connection dropped but creds are valid — marking ready');
            return;
          }
        }
      } catch {}

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        current.error = 'Logged out. Start over.';
      } else {
        current.error = 'Connection closed before sync. Start over.';
      }
      current.status = 'error';
    }
  });

  // Small delay so socket initialises before requesting code
  await new Promise(r => setTimeout(r, 2000));
  const code = await sock.requestPairingCode(phone);
  current.code = code;
  current.status = 'pairing';
  console.log(`📱 Pairing code for ${phone}: ${code}`);
  return code;
}

// ── HTML ─────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WA Pair — Hannan Mariyam Bot</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#eee;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
    .card{background:#141414;border:1px solid #222;border-radius:20px;padding:32px;width:100%;max-width:400px}
    .logo{font-size:28px;margin-bottom:4px}
    h1{font-size:18px;font-weight:700;color:#fff;margin-bottom:4px}
    .sub{font-size:13px;color:#555;margin-bottom:28px}
    label{font-size:12px;color:#666;font-weight:600;letter-spacing:.5px;text-transform:uppercase;display:block;margin-bottom:6px}
    input{width:100%;padding:13px 16px;border-radius:10px;border:1px solid #2a2a2a;background:#1a1a1a;color:#eee;font-size:15px;outline:none;transition:.2s}
    input:focus{border-color:#25D366}
    input::placeholder{color:#444}
    .btn{width:100%;padding:13px;border-radius:10px;border:none;background:#25D366;color:#000;font-size:15px;font-weight:700;cursor:pointer;margin-top:12px;transition:.2s}
    .btn:hover{background:#20bd5a}
    .btn:disabled{background:#1e1e1e;color:#444;cursor:not-allowed}
    .btn.blue{background:#1a73e8;color:#fff}
    .btn.blue:hover{background:#1557b0}
    .btn.ghost{background:#1e1e1e;color:#aaa}
    .btn.ghost:hover{background:#252525}
    .code-box{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:24px;text-align:center;margin:20px 0}
    .code{font-size:38px;font-weight:800;letter-spacing:10px;color:#25D366;font-family:'Courier New',monospace}
    .code-hint{font-size:12px;color:#555;margin-top:8px}
    .steps{background:#111;border-radius:10px;padding:16px;margin:16px 0;font-size:13px;color:#666;line-height:2}
    .steps b{color:#aaa}
    .status{text-align:center;font-size:13px;padding:10px;border-radius:8px;margin:12px 0}
    .status.waiting{background:#1a1a00;color:#888}
    .status.connected{background:#0a1f0e;color:#25D366}
    .status.ready{background:#0a1f0e;color:#25D366;font-weight:700}
    .status.error{background:#1f0a0a;color:#ff5555}
    .spinner{display:inline-block;animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .hidden{display:none}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">🤍</div>
  <h1>Hannan Mariyam Bot</h1>
  <p class="sub">Made with love by Afroz Khan — Self-hosted pairing</p>

  <!-- Step 1: Phone input -->
  <div id="step1">
    <label>WhatsApp Number</label>
    <input id="phone" type="tel" placeholder="919876543210 (no + or spaces)"/>
    <button class="btn" onclick="startPair()">Generate Pairing Code</button>
  </div>

  <!-- Step 2: Code + status -->
  <div id="step2" class="hidden">
    <div class="code-box">
      <div class="code" id="codeText">– – – –</div>
      <div class="code-hint">Enter this code in WhatsApp</div>
    </div>

    <div class="steps">
      1. Open <b>WhatsApp</b><br>
      2. Go to <b>Linked Devices</b><br>
      3. Tap <b>Link a Device</b><br>
      4. Tap <b>Link with Phone Number</b><br>
      5. Enter the code above
    </div>

    <div class="status waiting" id="statusBox">
      <span class="spinner">⏳</span> Waiting for you to enter the code…
    </div>

    <button class="btn blue hidden" id="downloadBtn" onclick="downloadCreds()">⬇️ Download creds.json</button>
    <button class="btn ghost" style="margin-top:8px" onclick="reset()">🔄 Start Over</button>
  </div>
</div>

<script>
  let poll = null;

  async function startPair() {
    const phone = document.getElementById('phone').value.replace(/\\s+/g,'');
    if (!/^\\d{10,15}$/.test(phone)) { alert('Enter a valid number e.g. 919876543210'); return; }

    const btn = document.querySelector('#step1 .btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';

    try {
      const res = await fetch('/pair', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone}) });
      const data = await res.json();
      if (!data.code) throw new Error(data.error || 'Failed');

      document.getElementById('codeText').textContent = data.code;
      document.getElementById('step1').classList.add('hidden');
      document.getElementById('step2').classList.remove('hidden');
      startPolling();
    } catch(e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Generate Pairing Code';
    }
  }

  function startPolling() {
    poll = setInterval(async () => {
      try {
        const res = await fetch('/status');
        const { status, error } = await res.json();
        const box = document.getElementById('statusBox');
        const dlBtn = document.getElementById('downloadBtn');

        if (status === 'pairing') {
          box.className = 'status waiting';
          box.innerHTML = '<span class="spinner">⏳</span> Waiting for you to enter the code…';
        } else if (status === 'connected') {
          box.className = 'status connected';
          box.innerHTML = '<span class="spinner">🔄</span> Connected! Syncing account…';
        } else if (status === 'ready') {
          box.className = 'status ready';
          box.innerHTML = '✅ Fully synced! Your creds.json is ready.';
          dlBtn.classList.remove('hidden');
          clearInterval(poll);
        } else if (status === 'error') {
          box.className = 'status error';
          box.innerHTML = '❌ ' + (error || 'Something went wrong. Start over.');
          clearInterval(poll);
        }
      } catch {}
    }, 2000);
  }

  function downloadCreds() { window.location.href = '/download'; }

  async function reset() {
    clearInterval(poll);
    await fetch('/reset', { method:'POST' });
    location.reload();
  }
</script>
</body>
</html>`;

// ── ROUTES ───────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.send(HTML));

app.post('/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^\d{10,15}$/.test(phone)) return res.json({ error: 'Invalid number' });
    const code = await startPairing(phone);
    res.json({ code });
  } catch (err) {
    current.status = 'error';
    current.error = err.message;
    res.json({ error: err.message });
  }
});

app.get('/status', (_, res) => {
  res.json({ status: current.status, error: current.error });
});

app.get('/download', (_, res) => {
  const credsPath = path.join(SESSION_PATH, 'creds.json');
  if (!fs.existsSync(credsPath)) return res.status(404).json({ error: 'Not ready' });
  res.download(credsPath, 'creds.json');
});

app.post('/reset', (_, res) => {
  clearSession();
  res.json({ ok: true });
});

// ── START ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       Hannan Mariyam Bot Pair        ║');
  console.log('  ║   Made with love by Afroz Khan  🤍   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log('');
});
