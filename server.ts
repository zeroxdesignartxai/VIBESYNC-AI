import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import * as mm from 'music-metadata';
import fs from 'fs';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Configure multer for audio uploads
  const uploadDir = 'uploads/';
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }
  const upload = multer({ dest: uploadDir });

  app.use(express.json());

  // API Routes
  app.post('/api/analyze-audio', upload.single('audio'), async (req, res) => {
    try {
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }

      const metadata = await mm.parseFile(file.path);
      const duration = metadata.format.duration || 0;
      
      // Basic analysis - in a real app we'd use more advanced tools
      // Here we'll return the metadata and let the LLM do the "vibe" analysis later
      res.json({
        filename: file.filename,
        originalName: file.originalname,
        duration,
        format: metadata.format.container,
        sampleRate: metadata.format.sampleRate,
      });
    } catch (error) {
      console.error('Audio analysis error:', error);
      res.status(500).json({ error: 'Failed to analyze audio' });
    }
  });

  // Serve uploaded files (temporary)
  app.use('/uploads', express.static('uploads'));

  app.post('/api/save-image', async (req, res) => {
    try {
      const { base64Data } = req.body;
      if (!base64Data) {
        return res.status(400).json({ error: 'No image data provided' });
      }

      // Remove header if present
      const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Image, 'base64');
      const filename = `${uuidv4()}.png`;
      const filepath = path.join(uploadDir, filename);

      fs.writeFileSync(filepath, buffer);
      res.json({ url: `/uploads/${filename}` });
    } catch (error) {
      console.error('Image save error:', error);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
