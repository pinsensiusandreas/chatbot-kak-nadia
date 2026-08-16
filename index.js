// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const { GoogleGenAI } = require('@google/genai');
const persona = require('./config/persona');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Simpan file upload sementara di memori (bukan disimpan ke disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // maksimal 20MB per file
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.5-flash-lite';

// "Memory" sederhana: simpan riwayat chat per sessionId di memori server.
const sessions = new Map();

function getHistory(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, []);
  }
  return sessions.get(sessionId);
}

// Tipe file yang bisa langsung dikirim ke Gemini (native support)
const NATIVE_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aac', 'audio/ogg', 'audio/flac',
  'video/mp4', 'video/mov', 'video/webm', 'video/mpeg', 'video/avi',
];

const WORD_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
];

// Kadang Postman/browser kirim mimetype generik 'application/octet-stream'
// (terutama untuk file screenshot/hasil download WhatsApp). Kalau ini terjadi,
// tebak ulang tipe sebenarnya berdasarkan ekstensi nama file.
const EXTENSION_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mp3',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/mov',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
  '.avi': 'video/avi',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function resolveMimeType(file) {
  if (file.mimetype && file.mimetype !== 'application/octet-stream') {
    return file.mimetype;
  }
  const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
  return EXTENSION_TO_MIME[ext] || file.mimetype;
}

app.post('/chat', upload.single('file'), async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const file = req.file; // ada isinya kalau user upload file, undefined kalau tidak

    if (!sessionId || (!message && !file)) {
      return res.status(400).json({ error: 'sessionId wajib diisi, dan minimal ada message atau file' });
    }

    const history = getHistory(sessionId);

    // Susun "parts" untuk pesan user: teks + (opsional) file
    const userParts = [];

    if (message) {
      userParts.push({ text: message });
    }

    if (file) {
      const resolvedMimeType = resolveMimeType(file);

      if (NATIVE_MIME_TYPES.includes(resolvedMimeType)) {
        // Gambar, PDF, audio, video -> kirim langsung sebagai base64 ke Gemini
        userParts.push({
          inlineData: {
            mimeType: resolvedMimeType,
            data: file.buffer.toString('base64'),
          },
        });
      } else if (WORD_MIME_TYPES.includes(resolvedMimeType)) {
        // Word (.docx) -> ekstrak teksnya dulu pakai mammoth, kirim sebagai teks
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        userParts.push({
          text: `[Isi dokumen Word yang diupload user]:\n${result.value}`,
        });
      } else {
        return res.status(400).json({
          error: `Tipe file ${resolvedMimeType} (${file.originalname}) belum didukung. Gunakan gambar, PDF, audio, video, atau Word (.docx).`,
        });
      }
    }

    history.push({ role: 'user', parts: userParts });

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: history,
      config: {
        systemInstruction: persona.systemInstruction,
        temperature: persona.generationConfig.temperature,
        maxOutputTokens: persona.generationConfig.maxOutputTokens,
      },
    });

    const reply = response.text || '(tidak ada respons)';

    // Simpan balasan model ke history juga, supaya konteks nyambung
    history.push({ role: 'model', parts: [{ text: reply }] });

    res.json({ reply, sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Terjadi kesalahan di server' });
  }
});

// Endpoint bantu untuk reset memory session tertentu
app.post('/reset', (req, res) => {
  const { sessionId } = req.body;
  sessions.delete(sessionId);
  res.json({ message: `Session ${sessionId} direset` });
});

app.get('/', (req, res) => {
  res.send('Chatbot API jalan. POST ke /chat dengan { sessionId, message, file (opsional) }');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});