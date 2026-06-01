const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');

// Set path FFmpeg biar jalan di Vercel Linux/Serverless
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();

// Konfigurasi Multer buat nyimpen file upload di folder /tmp (wajib di Vercel)
const upload = multer({ dest: '/tmp/' });

app.post('/api/convert', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('File ga ada cuy!');

    const targetExt = req.body.targetExt || 'mp3';
    const inputPath = req.file.path;
    const outputPath = `/tmp/${req.file.filename}_converted.${targetExt}`;

    console.log(`Konversi dari ${req.file.originalname} ke ${targetExt}`);

    ffmpeg(inputPath)
        .toFormat(targetExt)
        .on('end', () => {
            console.log('Konversi kelar!');
            // Kirim file ke browser buat otomatis di-download
            res.download(outputPath, `hasil_konversi.${targetExt}`, (err) => {
                // Hapus file sementara dari /tmp biar ga menuhin memori server
                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
            });
        })
        .on('error', (err) => {
            console.error('Error konversi:', err);
            fs.unlinkSync(inputPath); // Hapus file input kalau gagal
            res.status(500).send('Gagal konversi bro: ' + err.message);
        })
        .save(outputPath);
});

module.exports = app;
