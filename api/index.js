const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(cors());
app.use(express.static('public'));

// Store progress data
const jobs = new Map();

// Konfigurasi Multer
const upload = multer({ 
    dest: '/tmp/',
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Endpoint upload & konversi
app.post('/api/convert', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'File ga ada cuy!' });
    }

    const targetExt = req.body.targetExt || 'mp3';
    const jobId = Date.now().toString() + Math.random().toString(36);
    const inputPath = req.file.path;
    const outputPath = `/tmp/${jobId}_converted.${targetExt}`;
    
    // Init job
    jobs.set(jobId, {
        progress: 0,
        timemark: '00:00:00',
        status: 'converting',
        startTime: Date.now()
    });

    console.log(`[${jobId}] Konversi ${req.file.originalname} → ${targetExt}`);

    ffmpeg(inputPath)
        .toFormat(targetExt)
        .on('progress', (progress) => {
            const percent = Math.floor(progress.percent || 0);
            const timemark = progress.timemark;
            
            jobs.set(jobId, {
                progress: percent,
                timemark: timemark,
                status: 'converting',
                startTime: jobs.get(jobId).startTime
            });
            
            console.log(`[${jobId}] Progress: ${percent}% (${timemark})`);
        })
        .on('end', () => {
            console.log(`[${jobId}] Konversi kelar!`);
            jobs.set(jobId, { ...jobs.get(jobId), status: 'complete', progress: 100 });
            
            // Kirim file ke client
            res.download(outputPath, `hasil_konversi.${targetExt}`, (err) => {
                // Cleanup files
                try {
                    fs.unlinkSync(inputPath);
                    fs.unlinkSync(outputPath);
                } catch(e) { console.log('Cleanup error:', e); }
                
                // Hapus job setelah 10 detik
                setTimeout(() => jobs.delete(jobId), 10000);
            });
        })
        .on('error', (err) => {
            console.error(`[${jobId}] Error:`, err);
            jobs.set(jobId, { ...jobs.get(jobId), status: 'error', error: err.message });
            
            try { fs.unlinkSync(inputPath); } catch(e) {}
            
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        })
        .save(outputPath);
    
    // Kirim jobId ke client
    res.json({ jobId, message: 'Konversi dimulai' });
});

// Endpoint cek progress
app.get('/api/progress/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    
    if (!job) {
        return res.json({ status: 'not_found', progress: 0 });
    }
    
    // Hitung estimasi sisa waktu
    let eta = null;
    if (job.status === 'converting' && job.progress > 0 && job.startTime) {
        const elapsed = (Date.now() - job.startTime) / 1000; // detik
        const totalEstimate = (elapsed / job.progress) * 100;
        const remaining = totalEstimate - elapsed;
        
        if (isFinite(remaining) && remaining > 0) {
            eta = Math.round(remaining);
        }
    }
    
    res.json({
        status: job.status,
        progress: job.progress,
        timemark: job.timemark,
        eta: eta,
        error: job.error
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server jalan di http://localhost:${PORT}`);
});

module.exports = app;