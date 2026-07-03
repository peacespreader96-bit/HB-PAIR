import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'session');
const PUBLIC_PATH = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1kb' }));
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  })
);
app.use((_, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(
  express.static(PUBLIC_PATH, {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
    },
  })
);

// ── STATE ────────────────────────────────────────────────────────────────
let current = { status: 'idle', code: null, sock: null, error: null, syncTimer: null };

function ensureSessionDirectory() {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function safeCloseSocket(sock) {
  if (!sock) return;
  try {
    sock.end?.();
  } catch {
    // Ignore socket shutdown errors while resetting state.
  }
}

function clearSession() {
  if (current.syncTimer) clearTimeout(current.syncTimer);
  safeCloseSocket(current.sock);
  current = { status: 'idle', code: null, sock: null, error: null, syncTimer: null };
  fs.rmSync(SESSION_PATH, { recursive: true, force: true });
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function normalizePhone(input) {
  const raw = String(input || '').trim();

  // Keep the old behavior compatible: final value must be 10-15 digits.
  // This also allows users to paste formatted numbers; symbols are stripped.
  if (!/^\+?[\d\s().-]{10,24}$/.test(raw)) return null;

  const digits = raw.replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return null;

  return digits;
}

function readCreds() {
  const credsPath = path.join(SESSION_PATH, 'creds.json');
  if (!fs.existsSync(credsPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasBasicCreds() {
  const creds = readCreds();
  return Boolean(creds?.registered && creds?.me?.id);
}

// ── PAIRING LOGIC ────────────────────────────────────────────────────────
// This intentionally mirrors the original working Baileys flow closely.
async function startPairing(phone) {
  clearSession();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  current.sock = sock;

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();

      // Original behavior: myAppStateKeyId means app state sync completed.
      const creds = readCreds();
      if (creds?.myAppStateKeyId && current.status === 'connected') {
        if (current.syncTimer) clearTimeout(current.syncTimer);
        current.syncTimer = null;
        current.status = 'ready';
        current.error = null;
        console.log('✅ Fully synced — creds ready for download');
      }
    } catch (error) {
      current.status = 'error';
      current.error = 'Could not save session credentials. Start over.';
      console.error('Could not save credentials:', error);
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('🔗 Connected — waiting for sync...');
      current.status = 'connected';
      current.error = null;

      // Original behavior: if myAppStateKeyId never comes in, mark ready anyway.
      current.syncTimer = setTimeout(() => {
        if (current.status === 'connected') {
          console.log('⚡ Sync timeout — marking ready with available creds');
          current.status = 'ready';
          current.error = null;
        }
      }, 20_000);
    }

    if (connection === 'close') {
      if (current.status === 'ready') return;

      // Original Render-specific behavior: Render can drop connection quickly,
      // but creds may already be valid enough to download.
      if (hasBasicCreds()) {
        if (current.syncTimer) clearTimeout(current.syncTimer);
        current.syncTimer = null;
        current.status = 'ready';
        current.error = null;
        console.log('✅ Connection dropped but creds are valid — marking ready');
        return;
      }

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        current.error = 'Logged out. Start over.';
      } else {
        current.error = 'Connection closed before sync. Start over.';
      }
      current.status = 'error';
    }
  });

  // Keep the original 2 second wait. Changing this can make pairing codes fail.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const code = await sock.requestPairingCode(phone);
  current.code = code;
  current.status = 'pairing';
  current.error = null;
  console.log('📱 Pairing code generated');
  return code;
}

ensureSessionDirectory();

// ── ROUTES ───────────────────────────────────────────────────────────────
app.get('/', (_, res) => {
  res.sendFile(path.join(PUBLIC_PATH, 'index.html'));
});

app.get('/healthz', (_, res) => {
  res.status(200).json({ ok: true, status: current.status });
});

app.post('/pair', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Invalid number. Use country code, for example 919876543210.' });
    }

    const code = await startPairing(phone);
    return res.status(200).json({ code });
  } catch (error) {
    current.status = 'error';
    current.error = error?.message || 'Could not generate pairing code. Start over.';
    console.error('Pairing failed:', error);
    return res.status(500).json({ error: current.error });
  }
});

app.get('/status', (_, res) => {
  res.status(200).json({ status: current.status, error: current.error });
});

app.get('/download', (_, res) => {
  const credsPath = path.join(SESSION_PATH, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    return res.status(404).json({ error: 'Not ready' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.download(credsPath, 'creds.json');
});

app.post('/reset', (_, res) => {
  try {
    clearSession();
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Reset failed:', error);
    res.status(500).json({ error: 'Could not reset session.' });
  }
});

app.use((_, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, _, res, __) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║            Hannan Mariyam            ║');
  console.log('  ║     Made In Love By Afroz Khan  🤍   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log('');
});
