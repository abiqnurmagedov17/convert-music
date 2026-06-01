const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Store job data
const jobs = new Map();

// Cleanup old jobs every hour
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
        if (now - job.createdAt > 3600000) { // 1 hour
            jobs.delete(id);
            // Cleanup files
            if (job.outputPath && fs.existsSync(job.outputPath)) {
                fs.unlinkSync(job.outputPath);
            }
        }
    }
}, 3600000);

// Configure multer for file upload
const upload = multer({ 
    dest: '/tmp/',
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// ============================================
// ENDPOINT 1: Upload & Start Conversion
// Langsung balikin jobId, ga nunggu FFmpeg
// ============================================
app.post('/api/convert', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'File ga ada cuy!' });
    }

    const targetExt = req.body.targetExt || 'mp3';
    const jobId = uuidv4();
    const inputPath = req.file.path;
    const outputPath = `/tmp/${jobId}.${targetExt}`;
    
    // Store job info
    jobs.set(jobId, {
        id: jobId,
        status: 'uploaded',
        progress: 0,
        timemark: '00:00:00',
        inputPath: inputPath,
        outputPath: outputPath,
        targetExt: targetExt,
        originalName: req.file.originalname,
        createdAt: Date.now(),
        totalDuration: 0
    });
    
    console.log(`[${jobId}] File uploaded: ${req.file.originalname} → ${targetExt}`);
    
    // Start conversion in background (don't await!)
    startConversion(jobId);
    
    // Return jobId immediately
    res.json({ 
        jobId: jobId,
        message: 'Konversi dimulai',
        status: 'processing'
    });
});

// ============================================
// BACKGROUND CONVERSION FUNCTION
// ============================================
function startConversion(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    job.status = 'converting';
    jobs.set(jobId, job);
    
    console.log(`[${jobId}] Starting FFmpeg conversion...`);
    
    ffmpeg(job.inputPath)
        .toFormat(job.targetExt)
        .on('codecData', (data) => {
            // Get total duration from codec data
            if (data.duration) {
                const parts = data.duration.split(':');
                const totalDuration = 
                    (+parts[0] * 3600) +
                    (+parts[1] * 60) +
                    (+parts[2]);
                
                job.totalDuration = totalDuration;
                jobs.set(jobId, job);
                console.log(`[${jobId}] Total duration: ${totalDuration}s (${data.duration})`);
            }
        })
        .on('progress', (progress) => {
            // Calculate progress manually from timemark (more reliable)
            let percent = 0;
            
            if (job.totalDuration > 0 && progress.timemark) {
                const parts = progress.timemark.split(':');
                const current = 
                    (+parts[0] * 3600) +
                    (+parts[1] * 60) +
                    (+parts[2]);
                
                percent = Math.min(100, Math.floor((current / job.totalDuration) * 100));
            } else if (progress.percent) {
                // Fallback to percent if available
                percent = Math.floor(progress.percent);
            }
            
            job.progress = percent;
            job.timemark = progress.timemark || '00:00:00';
            jobs.set(jobId, job);
            
            // Log every 10%
            if (percent % 10 === 0 && percent !== job.lastLogged) {
                job.lastLogged = percent;
                console.log(`[${jobId}] Progress: ${percent}% (${job.timemark})`);
            }
        })
        .on('end', () => {
            console.log(`[${jobId}] Conversion finished!`);
            job.status = 'completed';
            job.progress = 100;
            jobs.set(jobId, job);
            
            // Cleanup input file
            try {
                fs.unlinkSync(job.inputPath);
            } catch(e) {
                console.log(`[${jobId}] Cleanup input error:`, e.message);
            }
        })
        .on('error', (err) => {
            console.error(`[${jobId}] FFmpeg error:`, err.message);
            job.status = 'error';
            job.error = err.message;
            jobs.set(jobId, job);
            
            // Cleanup files
            try {
                if (fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath);
                if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
            } catch(e) {}
        })
        .save(job.outputPath);
}

// ============================================
// ENDPOINT 2: Check Progress
// ============================================
app.get('/api/progress/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ 
            status: 'not_found', 
            progress: 0,
            message: 'Job not found or expired'
        });
    }
    
    // Calculate ETA
    let eta = null;
    if (job.status === 'converting' && job.progress > 0 && job.createdAt) {
        const elapsed = (Date.now() - job.createdAt) / 1000;
        const totalEstimate = (elapsed / job.progress) * 100;
        const remaining = totalEstimate - elapsed;
        
        if (isFinite(remaining) && remaining > 0 && remaining < 3600) {
            eta = Math.round(remaining);
        }
    }
    
    res.json({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        timemark: job.timemark,
        eta: eta,
        error: job.error
    });
});

// ============================================
// ENDPOINT 3: Download Result
// ============================================
app.get('/api/download/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status !== 'completed') {
        return res.status(400).json({ 
            error: `Conversion not ready. Status: ${job.status}`,
            progress: job.progress
        });
    }
    
    if (!fs.existsSync(job.outputPath)) {
        return res.status(404).json({ error: 'Output file not found' });
    }
    
    const originalName = job.originalName.replace(/\.[^/.]+$/, '');
    const downloadName = `${originalName}_converted.${job.targetExt}`;
    
    res.download(job.outputPath, downloadName, (err) => {
        if (err) {
            console.error(`[${job.id}] Download error:`, err);
        }
        
        // Don't delete immediately, let cleanup handle it
        // But mark for cleanup sooner
        job.downloaded = true;
        jobs.set(job.id, job);
        
        // Delete after 5 minutes
        setTimeout(() => {
            if (jobs.has(job.id)) {
                try {
                    if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
                    jobs.delete(job.id);
                    console.log(`[${job.id}] Cleaned up after download`);
                } catch(e) {}
            }
        }, 300000);
    });
});

// ============================================
// ENDPOINT 4: Health Check
// ============================================
app.get('/api/health', (req, res) => {
    const activeJobs = Array.from(jobs.values()).filter(j => 
        j.status === 'converting' || j.status === 'uploaded'
    ).length;
    
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeJobs: activeJobs,
        totalJobs: jobs.size
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`   POST   /api/convert   - Upload & start conversion`);
    console.log(`   GET    /api/progress/:id - Check progress`);
    console.log(`   GET    /api/download/:id  - Download result`);
    console.log(`   GET    /api/health       - Health check`);
});

module.exports = app;