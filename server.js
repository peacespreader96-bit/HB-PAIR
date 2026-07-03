import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import helmet from 'helmet';
import archiver from 'archiver';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'session');
const PUBLIC_PATH = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000);
const PAIRING_READY_TIMEOUT_MS = Number(process.env.PAIRING_READY_TIMEOUT_MS || 35_000);

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1kb' }));
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
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

function createIdleState() {
  return {
    id: null,
    status: 'idle',
    code: null,
    sock: null,
    error: null,
    syncTimer: null,
    cleanupTimer: null,
    startedAt: null,
  };
}

let current = createIdleState();

function ensureSessionDirectory() {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

function safeCloseSocket(sock) {
  if (!sock) return;
  try {
    sock.end?.();
  } catch {
    // Ignore socket shutdown errors while resetting state.
  }
}

function readSessionCreds() {
  const credsPath = path.join(SESSION_PATH, 'creds.json');
  if (!fs.existsSync(credsPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasUsableSession() {
  const creds = readSessionCreds();
  return Boolean(creds?.registered && creds?.me?.id);
}

function setReadyIfUsable(id, logMessage) {
  if (current.id !== id || current.status === 'ready') return false;
  if (!hasUsableSession()) return false;

  clearTimer(current.syncTimer);
  current.syncTimer = null;
  current.status = 'ready';
  current.error = null;
  scheduleSessionCleanup(id);
  console.log(logMessage);
  return true;
}

function scheduleSessionCleanup(id) {
  clearTimer(current.cleanupTimer);
  current.cleanupTimer = setTimeout(() => {
    if (current.id === id && current.status === 'ready') {
      console.log('🧹 Session expired — cleaning up files');
      resetSession().catch((error) => console.error('Session cleanup failed:', error));
    }
  }, SESSION_TTL_MS);
}

async function resetSession() {
  clearTimer(current.syncTimer);
  clearTimer(current.cleanupTimer);
  safeCloseSocket(current.sock);

  current = createIdleState();

  await fs.promises.rm(SESSION_PATH, { recursive: true, force: true });
  await fs.promises.mkdir(SESSION_PATH, { recursive: true });
}

function normalizePhone(input) {
  const raw = String(input || '').trim();

  // Allow common phone-number formatting while rejecting letters and symbols.
  if (!/^\+?[\d\s().-]{10,24}$/.test(raw)) return null;

  const digits = raw.replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return null;

  return digits;
}

async function startPairing(phone) {
  await resetSession();

  const id = crypto.randomUUID();
  current = {
    ...createIdleState(),
    id,
    status: 'starting',
    startedAt: new Date().toISOString(),
  };

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false,
    browser: ['Hannan Mariyam', 'Chrome', '1.0.0'],
  });

  if (current.id !== id) {
    safeCloseSocket(sock);
    throw new Error('Pairing was reset. Please start again.');
  }

  current.sock = sock;

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      setReadyIfUsable(id, '✅ Session is ready for download');
    } catch (error) {
      if (current.id === id) {
        current.status = 'error';
        current.error = 'Could not save session credentials. Start over.';
      }
      console.error('Could not save credentials:', error);
    }
  });

  sock.ev.on('connection.update', (update) => {
    if (current.id !== id) return;

    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      current.status = 'connected';
      current.error = null;
      console.log('🔗 Connected — checking session readiness');

      if (setReadyIfUsable(id, '✅ Connected and session is ready')) return;

      clearTimer(current.syncTimer);
      current.syncTimer = setTimeout(() => {
        if (current.id !== id || current.status === 'ready') return;

        if (setReadyIfUsable(id, '✅ Session became usable after sync wait')) return;

        current.status = 'error';
        current.error = 'Connected, but the session was not fully saved. Keep WhatsApp open and start over.';
      }, PAIRING_READY_TIMEOUT_MS);
    }

    if (connection === 'close') {
      if (current.status === 'ready') return;
      if (setReadyIfUsable(id, '✅ Connection closed after valid session was saved')) return;

      clearTimer(current.syncTimer);
      current.syncTimer = null;

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      current.status = 'error';
      current.error =
        code === DisconnectReason.loggedOut
          ? 'Logged out. Start over and generate a fresh code.'
          : 'Connection closed before the session was ready. Start over.';
    }
  });

  // Give the socket a brief moment to initialise before requesting the pairing code.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (current.id !== id) {
    safeCloseSocket(sock);
    throw new Error('Pairing was reset. Please start again.');
  }

  const code = await sock.requestPairingCode(phone);

  if (current.id !== id) {
    safeCloseSocket(sock);
    throw new Error('Pairing was reset. Please start again.');
  }

  current.code = code;
  current.status = 'pairing';
  current.error = null;
  console.log('📱 Pairing code generated');

  return code;
}

ensureSessionDirectory();

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
      return res.status(400).json({ error: 'Enter a valid phone number with 10 to 15 digits.' });
    }

    const code = await startPairing(phone);
    return res.status(200).json({ code });
  } catch (error) {
    current.status = 'error';
    current.error = 'Could not generate a pairing code. Start over and try again.';
    console.error('Pairing failed:', error);
    return res.status(500).json({ error: current.error });
  }
});

app.get('/status', (_, res) => {
  res.status(200).json({
    status: current.status,
    error: current.error,
    ready: current.status === 'ready' && hasUsableSession(),
  });
});

app.get('/download', (req, res) => {
  if (current.status !== 'ready' || !hasUsableSession()) {
    return res.status(409).json({ error: 'Session is not ready yet.' });
  }

  if (!fs.existsSync(SESSION_PATH)) {
    return res.status(404).json({ error: 'Session folder not found.' });
  }

  const filename = 'hannan-mariyam-session.zip';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('error', (error) => {
    console.error('Archive failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not create session download.' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  archive.directory(SESSION_PATH, false);
  archive.finalize();
});

app.post('/reset', async (_, res) => {
  try {
    await resetSession();
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
